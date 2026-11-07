// IncidentStore — persistence + lifecycle for runtime_incidents.
//
// The store is deliberately dumb: it owns state transitions and the audit row,
// never policy. RuntimeSupervisor decides *when* to open/dispatch/resolve;
// ActionExecutor decides *how* a decision lands.

import type Database from "better-sqlite3"
import { randomUUID } from "crypto"
import type {
  Decision,
  Incident,
  IncidentRecord,
  IncidentStatus,
  SupervisorKind,
} from "@octopus/shared"

interface IncidentRow {
  id: string
  execution_id: string
  workspace_id: string
  node_id: string
  display_node_id: string | null
  phase: string
  severity: string
  kind: string
  status: string
  owner_kind: string | null
  owner_ref: string | null
  summary: string | null
  incident_json: string
  decision_json: string | null
  resolution_source: string | null
  created_at: number
  dispatched_at: number | null
  resolved_at: number | null
  deadline_at: number | null
}

const TERMINAL: IncidentStatus[] = ["resolved", "expired"]
const OPEN_STATUSES: IncidentStatus[] = ["open", "dispatched", "waiting_human", "unowned"]

export interface OpenIncidentInput {
  executionId: string
  workspaceId: string
  nodeId: string
  displayNodeId?: string
  phase: Incident["phase"]
  severity: Incident["severity"]
  kind: string
  summary: string
  evidence: Array<Record<string, unknown>>
  contextRef: string
  allowedActions: Incident["allowedActions"]
  deadlineAt?: number
}

export class IncidentStore {
  constructor(private db: Database.Database) {}

  /** Open an incident, reusing an existing non-terminal one for the same signal. */
  open(input: OpenIncidentInput): IncidentRecord {
    const existing = this.findOpen(input.executionId, input.nodeId, input.kind)
    if (existing) return existing

    const id = `inc_${randomUUID()}`
    const now = Date.now()
    const incident: Incident = {
      id,
      executionId: input.executionId,
      workspaceId: input.workspaceId,
      nodeId: input.nodeId,
      displayNodeId: input.displayNodeId,
      phase: input.phase,
      severity: input.severity,
      kind: input.kind,
      summary: input.summary,
      evidence: input.evidence,
      contextRef: input.contextRef,
      allowedActions: input.allowedActions,
      createdAt: now,
      deadlineAt: input.deadlineAt,
    }
    this.db
      .prepare(
        `INSERT INTO runtime_incidents
          (id, execution_id, workspace_id, node_id, display_node_id, phase, severity, kind,
           status, owner_kind, owner_ref, summary, incident_json, decision_json,
           resolution_source, created_at, dispatched_at, resolved_at, deadline_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, NULL, ?, ?, NULL, NULL, ?, NULL, NULL, ?)`,
      )
      .run(
        incident.id,
        incident.executionId,
        incident.workspaceId,
        incident.nodeId,
        incident.displayNodeId ?? null,
        incident.phase,
        incident.severity,
        incident.kind,
        incident.summary,
        JSON.stringify(incident),
        now,
        incident.deadlineAt ?? null,
      )
    return this.findById(id)!
  }

  findById(id: string): IncidentRecord | null {
    const row = this.db
      .prepare("SELECT * FROM runtime_incidents WHERE id = ?")
      .get(id) as IncidentRow | undefined
    return row ? this.toRecord(row) : null
  }

  findOpen(executionId: string, nodeId: string, kind: string): IncidentRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM runtime_incidents
         WHERE execution_id = ? AND node_id = ? AND kind = ?
           AND status IN ('open','dispatched','waiting_human','unowned')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(executionId, nodeId, kind) as IncidentRow | undefined
    return row ? this.toRecord(row) : null
  }

  listByExecution(executionId: string): IncidentRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM runtime_incidents WHERE execution_id = ? ORDER BY created_at ASC",
      )
      .all(executionId) as IncidentRow[]
    return rows.map((r) => this.toRecord(r))
  }

  listOpenByExecution(executionId: string): IncidentRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM runtime_incidents
         WHERE execution_id = ? AND status IN ('open','dispatched','waiting_human','unowned')
         ORDER BY created_at ASC`,
      )
      .all(executionId) as IncidentRow[]
    return rows.map((r) => this.toRecord(r))
  }

  /** Open incidents for one node (used by the failure hook to choose pause). */
  findOpenForNode(executionId: string, nodeId: string): IncidentRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM runtime_incidents
         WHERE execution_id = ? AND node_id = ?
           AND status IN ('open','dispatched','waiting_human','unowned')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(executionId, nodeId) as IncidentRow | undefined
    return row ? this.toRecord(row) : null
  }

  markDispatched(id: string, owner: { kind: SupervisorKind; ref: string }): void {
    this.db
      .prepare(
        `UPDATE runtime_incidents
         SET status = 'dispatched', owner_kind = ?, owner_ref = ?, dispatched_at = ?
         WHERE id = ? AND status = 'open'`,
      )
      .run(owner.kind, owner.ref, Date.now(), id)
  }

  markWaitingHuman(id: string, ownerRef: string | null): void {
    this.db
      .prepare(
        `UPDATE runtime_incidents
         SET status = 'waiting_human', owner_kind = 'human', owner_ref = ?
         WHERE id = ? AND status IN ('open','dispatched','unowned')`,
      )
      .run(ownerRef, id)
  }

  markUnowned(id: string): void {
    // TODO(manual-queue-next-iteration): unowned incidents should enter a
    // human claim queue. This iteration only makes them visible.
    this.db
      .prepare(
        `UPDATE runtime_incidents SET status = 'unowned' WHERE id = ? AND status = 'open'`,
      )
      .run(id)
  }

  /**
   * Resolve exactly once. Returns false when the incident was already terminal
   * or does not exist — callers surface that as an idempotent no-op.
   */
  resolve(
    id: string,
    decision: Decision,
    source: "agent" | "user" | "policy",
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE runtime_incidents
         SET status = 'resolved', decision_json = ?, resolution_source = ?, resolved_at = ?
         WHERE id = ? AND status NOT IN ('resolved','expired')`,
      )
      .run(JSON.stringify(decision), source, Date.now(), id)
    return result.changes > 0
  }

  expire(id: string): void {
    this.db
      .prepare(
        `UPDATE runtime_incidents SET status = 'expired', resolved_at = ?
         WHERE id = ? AND status NOT IN ('resolved','expired')`,
      )
      .run(Date.now(), id)
  }

  /** Expire incidents whose owner missed the deadline; returns affected ids. */
  expireDue(now = Date.now()): string[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM runtime_incidents
         WHERE status IN ('open','dispatched','waiting_human','unowned')
           AND deadline_at IS NOT NULL AND deadline_at < ?`,
      )
      .all(now) as Array<{ id: string }>
    for (const row of rows) this.expire(row.id)
    return rows.map((r) => r.id)
  }

  /** Same sweep scoped to one execution (used by read paths). */
  expireOverdueForExecution(executionId: string, now = Date.now()): string[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM runtime_incidents
         WHERE execution_id = ?
           AND status IN ('open','dispatched','waiting_human','unowned')
           AND deadline_at IS NOT NULL AND deadline_at < ?`,
      )
      .all(executionId, now) as Array<{ id: string }>
    for (const row of rows) this.expire(row.id)
    return rows.map((r) => r.id)
  }

  /** Expire every non-terminal incident of an execution (run is terminal). */
  expireOpenForExecution(executionId: string, now = Date.now()): string[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM runtime_incidents
         WHERE execution_id = ? AND status IN ('open','dispatched','waiting_human','unowned')`,
      )
      .all(executionId) as Array<{ id: string }>
    for (const row of rows) this.expire(row.id)
    return rows.map((r) => r.id)
  }

  isTerminal(status: string): boolean {
    return TERMINAL.includes(status as IncidentStatus)
  }

  isOpen(status: string): boolean {
    return OPEN_STATUSES.includes(status as IncidentStatus)
  }

  private toRecord(row: IncidentRow): IncidentRecord {
    const incident = JSON.parse(row.incident_json) as Incident
    return {
      ...incident,
      status: row.status as IncidentStatus,
      ownerKind: (row.owner_kind as SupervisorKind | null) ?? null,
      ownerRef: row.owner_ref,
      decision: row.decision_json ? (JSON.parse(row.decision_json) as Decision) : null,
      resolutionSource:
        (row.resolution_source as IncidentRecord["resolutionSource"]) ?? null,
      dispatchedAt: row.dispatched_at,
      resolvedAt: row.resolved_at,
    }
  }
}
