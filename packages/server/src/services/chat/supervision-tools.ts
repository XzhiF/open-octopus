// Supervision tools — the chat owner's intervention surface (2026-11-07).
//
// These are spread into the existing `octopus-workflow` MCP server so the main
// chat agent sees them in the same turn it runs a workflow. A tool never
// bypasses the runtime whitelist: `resolve_incident` rejects actions the
// incident did not offer.

import { z } from "zod"
import type Database from "better-sqlite3"
import { tool } from "@octopus/providers"
import {
  escalateIncident,
  getIncident,
  listIncidents,
  parseDecision,
  resolveIncident,
} from "../supervision/supervision-service"
import { createRepairServiceForWorkspace } from "../../routes/repair"

export interface SupervisionToolOptions {
  db: Database.Database
  workspaceId: string
}

const text = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
})

export function createSupervisionTools(opts: SupervisionToolOptions) {
  const { db, workspaceId } = opts

  const loadIncident = (incidentId: string) => {
    const incident = getIncident({ db }, incidentId)
    if (!incident) return { error: `incident ${incidentId} not found` as const }
    if (incident.workspaceId !== workspaceId) {
      return { error: `incident ${incidentId} belongs to another workspace` as const }
    }
    return { incident }
  }

  return [
    tool(
      "list_incidents",
      "List runtime incidents for an execution (open and resolved). Use it to see what the supervisor already flagged before deciding.",
      { execution_id: z.string().min(1) },
      async ({ execution_id }) => {
        const incidents = listIncidents({ db }, execution_id).map((i) => ({
          id: i.id,
          nodeId: i.displayNodeId ?? i.nodeId,
          phase: i.phase,
          severity: i.severity,
          kind: i.kind,
          status: i.status,
          summary: i.summary,
          allowedActions: i.allowedActions,
          createdAt: i.createdAt,
        }))
        return text({ executionId: execution_id, incidents })
      },
    ),
    tool(
      "get_incident",
      "Read one runtime incident: evidence, allowed actions, lifecycle status and any decision already taken. Always call this before resolving — do not guess from the summary.",
      { incident_id: z.string().min(1) },
      async ({ incident_id }) => {
        const found = loadIncident(incident_id)
        if ("error" in found) return text({ error: found.error })
        return text({
          id: found.incident.id,
          executionId: found.incident.executionId,
          nodeId: found.incident.displayNodeId ?? found.incident.nodeId,
          phase: found.incident.phase,
          severity: found.incident.severity,
          kind: found.incident.kind,
          status: found.incident.status,
          summary: found.incident.summary,
          evidence: found.incident.evidence,
          contextRef: found.incident.contextRef,
          allowedActions: found.incident.allowedActions,
          decision: found.incident.decision,
          resolutionSource: found.incident.resolutionSource,
        })
      },
    ),
    tool(
      "resolve_incident",
      "Apply a decision to a runtime incident. Actions are whitelisted by the incident: proceed / inject / retry / pause / abort / block / reload / escalate. Prefer the smallest action (inject/retry) over abort. Idempotent — a second resolve is a no-op.",
      {
        incident_id: z.string().min(1),
        type: z.enum(["proceed", "inject", "retry", "pause", "abort", "block", "reload", "escalate"]),
        message: z.string().optional().describe("For inject: the instruction to give the node"),
        hint: z.string().optional().describe("For retry: guidance hint"),
        reason: z.string().optional().describe("For pause/abort/block/escalate: why"),
        var_pool_patches: z.record(z.string()).optional().describe("For retry: variables to patch before retrying"),
        model: z.string().optional().describe("For retry: model override"),
        continue_subsequent: z.boolean().optional().describe("For block: whether downstream nodes continue"),
        yaml: z.string().optional().describe("For reload: the replacement workflow YAML"),
        options: z.array(z.string()).optional().describe("For escalate: choices to show the human"),
      },
      async (args) => {
        const found = loadIncident(args.incident_id)
        if ("error" in found) return text({ error: found.error })
        const decision = parseDecision({
          type: args.type,
          message: args.message,
          reason: args.reason,
          hint: args.hint,
          varPoolPatches: args.var_pool_patches,
          model: args.model,
          continueSubsequent: args.continue_subsequent,
          yaml: args.yaml,
          options: args.options,
        })
        if (!decision) {
          return text({ error: `missing fields for decision type ${args.type}` })
        }
        const result = await resolveIncident({
          db,
          incidentId: args.incident_id,
          decision,
          source: "agent",
        })
        return text({ ...result, incidentId: args.incident_id, decision: decision.type })
      },
    ),
    tool(
      "escalate_incident",
      "Ask the human to decide. Lands a confirmation card in this chat with the given options; does NOT execute. Use when the fix is business-sensitive, irreversible, or you are not confident.",
      {
        incident_id: z.string().min(1),
        reason: z.string().min(1).describe("Why a human is needed — shown on the card"),
        options: z.array(z.string()).min(1).max(5).optional().describe("Choices to show (defaults to retry / abort / pause)"),
      },
      async ({ incident_id, reason, options }) => {
        const found = loadIncident(incident_id)
        if ("error" in found) return text({ error: found.error })
        const result = await escalateIncident({
          db,
          incidentId: incident_id,
          reason,
          options: options ?? ["继续重试", "中止执行", "先暂停，我来看看"],
        })
        return text({ ...result, incidentId: incident_id })
      },
    ),
    tool(
      "inject_node_instruction",
      "Re-run a node with an instruction (bottom half of `inject`). This is `retryFrom(node, {intervention})` — a fresh attempt with guidance, NOT real-time mid-stream steering. Use when you know the root cause and just need to tell the node what to change.",
      {
        execution_id: z.string().min(1),
        node_id: z.string().min(1),
        message: z.string().min(1).describe("Instruction for the next attempt"),
      },
      async ({ execution_id, node_id, message }) => {
        const service = createRepairServiceForWorkspace(workspaceId)
        if (!service) return text({ error: "repair service unavailable for this workspace" })
        try {
          const result = await service.intervene(execution_id, node_id, message)
          return text({ executionId: execution_id, nodeId: node_id, ...result })
        } catch (err: unknown) {
          return text({ error: err instanceof Error ? err.message : String(err) })
        }
      },
    ),
  ]
}
