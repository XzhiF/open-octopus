// SupervisionService — per-lifecycle facade + the process-wide active registry.
//
// ExecutionLifecycle owns one instance per workspace. Chat tools and REST routes
// resolve incidents through `resolveIncident()`: if the execution is live they
// reach its in-memory supervisor (so pending hook decisions land); otherwise a
// transient supervisor drives the paused/failed execution through the public
// ExecutionService surface.

import type Database from "better-sqlite3"
import type {
  Decision,
  DecisionType,
  IncidentRecord,
} from "@octopus/shared"
import type { EngineCallbacks } from "@octopus/engine"
import type { SSEService } from "../sse"
import { HarnessDAO } from "../../db/dao/harness-dao"
import { IncidentStore } from "./incident-store"
import { OwnerResolver, type OwnerTarget } from "./owner-resolver"
import { ActionExecutor } from "./action-executor"
import { createDefaultHardGuards } from "./hard-guards"
import { RuntimeSupervisor, type ResolveResult } from "./runtime-supervisor"

type SseLike = Pick<SSEService, "emit"> | null

const active = new Map<string, RuntimeSupervisor>()

export interface CreateSupervisorInput {
  db: Database.Database
  sse?: SseLike
  executionId: string
  /** DB workspace id (UUID). */
  workspaceId: string
  /** SSE channel id (org:path composite). */
  sseWorkspaceId?: string
  workspacePath?: string
  hostPid?: string
  hostPorts?: string[]
  actionExecutor?: ActionExecutor
}

export function createRuntimeSupervisor(input: CreateSupervisorInput): RuntimeSupervisor {
  return new RuntimeSupervisor({
    executionId: input.executionId,
    workspaceId: input.workspaceId,
    db: input.db,
    dao: new HarnessDAO(input.db),
    sse: input.sse ?? null,
    workspacePath: input.workspacePath,
    hostPid: input.hostPid,
    hostPorts: input.hostPorts,
    hardGuards: createDefaultHardGuards(),
    actionExecutor: input.actionExecutor ?? new ActionExecutor(),
    ownerResolver: new OwnerResolver(input.db),
    incidentStore: new IncidentStore(input.db),
  })
}

export function getActiveSupervisor(executionId: string): RuntimeSupervisor | undefined {
  return active.get(executionId)
}

export class SupervisionService {
  constructor(
    private db: Database.Database,
    private sse: SseLike,
  ) {}

  onExecutionStart(
    executionId: string,
    workspaceId: string,
    callbacks: EngineCallbacks,
    opts?: {
      hostPid?: string
      hostPorts?: string[]
      workspacePath?: string
      sseWorkspaceId?: string
    },
  ): EngineCallbacks {
    this.onExecutionEnd(executionId)
    const supervisor = createRuntimeSupervisor({
      db: this.db,
      sse: this.sse,
      executionId,
      workspaceId,
      sseWorkspaceId: opts?.sseWorkspaceId,
      workspacePath: opts?.workspacePath,
      hostPid: opts?.hostPid,
      hostPorts: opts?.hostPorts,
    })
    active.set(executionId, supervisor)
    return supervisor.onExecutionStart(callbacks)
  }

  onExecutionEnd(executionId: string): void {
    // A terminal execution can no longer be acted on: close any incident still
    // waiting for an owner. Paused executions never reach here, so a delegate
    // pause keeps its incident actionable.
    try {
      new IncidentStore(this.db).expireOpenForExecution(executionId)
    } catch {
      /* non-fatal */
    }
    const supervisor = active.get(executionId)
    if (!supervisor) return
    try {
      supervisor.onExecutionEnd()
    } catch (err) {
      console.warn(`[SupervisionService] end failed for ${executionId}:`, err)
    }
    active.delete(executionId)
  }

  getActive(executionId: string): RuntimeSupervisor | undefined {
    return active.get(executionId)
  }

  isActive(executionId: string): boolean {
    return active.has(executionId)
  }

  get activeCount(): number {
    return active.size
  }

  destroyAll(): void {
    for (const [executionId, supervisor] of active) {
      try {
        supervisor.onExecutionEnd()
      } catch {
        /* non-fatal */
      }
      active.delete(executionId)
    }
  }
}

export interface IncidentQueryDeps {
  db: Database.Database
  sse?: SseLike
}

export function listIncidents(
  deps: IncidentQueryDeps,
  executionId: string,
): IncidentRecord[] {
  const store = new IncidentStore(deps.db)
  store.expireOverdueForExecution(executionId)
  return store.listByExecution(executionId)
}

export function getIncident(
  deps: IncidentQueryDeps,
  incidentId: string,
): IncidentRecord | null {
  const store = new IncidentStore(deps.db)
  const record = store.findById(incidentId)
  if (record && !store.isTerminal(record.status) && record.deadlineAt && record.deadlineAt < Date.now()) {
    store.expire(record.id)
    return store.findById(incidentId)
  }
  return record
}

export function incidentOwner(
  deps: IncidentQueryDeps,
  executionId: string,
): OwnerTarget | null {
  return new OwnerResolver(deps.db).resolve(executionId)
}

/**
 * Resolve an incident from a tool / REST route. Idempotent and whitelist
 * checked. Live executions use their in-memory supervisor so the decision is
 * consumed by the next engine hook; paused/failed executions are driven
 * out-of-band by ActionExecutor.
 */
export async function resolveIncident(input: {
  db: Database.Database
  sse?: SseLike
  incidentId: string
  decision: Decision
  source: "agent" | "user" | "policy"
}): Promise<ResolveResult> {
  const store = new IncidentStore(input.db)
  const record = store.findById(input.incidentId)
  if (!record) {
    return { ok: false, detail: `事件 ${input.incidentId} 不存在`, status: "missing" }
  }
  const live = active.get(record.executionId)
  if (live) return live.resolve(input.incidentId, input.decision, input.source)

  const supervisor = createRuntimeSupervisor({
    db: input.db,
    sse: input.sse ?? null,
    executionId: record.executionId,
    workspaceId: record.workspaceId,
  })
  return supervisor.resolve(input.incidentId, input.decision, input.source)
}

export async function escalateIncident(input: {
  db: Database.Database
  sse?: SseLike
  incidentId: string
  reason: string
  options: string[]
}): Promise<ResolveResult> {
  const store = new IncidentStore(input.db)
  const record = store.findById(input.incidentId)
  if (!record) {
    return { ok: false, detail: `事件 ${input.incidentId} 不存在`, status: "missing" }
  }
  const live = active.get(record.executionId)
  if (live) return live.escalate(input.incidentId, input.reason, input.options)

  const supervisor = createRuntimeSupervisor({
    db: input.db,
    sse: input.sse ?? null,
    executionId: record.executionId,
    workspaceId: record.workspaceId,
  })
  return supervisor.escalate(input.incidentId, input.reason, input.options)
}

/** Narrow a JSON decision payload from an HTTP body / tool args. */
export function parseDecision(input: {
  type: string
  message?: string
  reason?: string
  hint?: string
  varPoolPatches?: Record<string, string>
  /** snake_case alias accepted from REST bodies. */
  var_pool_patches?: Record<string, string>
  model?: string
  continueSubsequent?: boolean
  continue_subsequent?: boolean
  yaml?: string
  options?: string[]
}): Decision | null {
  const type = input.type as DecisionType
  switch (type) {
    case "proceed":
      return { type: "proceed" }
    case "inject":
      return input.message ? { type: "inject", message: input.message } : null
    case "retry":
      return {
        type: "retry",
        hint: input.hint,
        varPoolPatches: input.varPoolPatches ?? input.var_pool_patches,
        model: input.model,
      }
    case "pause":
      return { type: "pause", reason: input.reason ?? "supervisor paused" }
    case "abort":
      return { type: "abort", reason: input.reason ?? "supervisor aborted" }
    case "block":
      return {
        type: "block",
        reason: input.reason ?? "blocked by supervisor",
        continueSubsequent: input.continueSubsequent ?? input.continue_subsequent,
      }
    case "reload":
      return input.yaml ? { type: "reload", yaml: input.yaml } : null
    case "escalate":
      return { type: "escalate", reason: input.reason ?? "needs human", options: input.options }
    default:
      return null
  }
}
