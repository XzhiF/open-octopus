// ChatSupervisor — adapts an execution's chat owner to the Supervisor contract.
//
// notify() appends a deterministic incident card to the transcript and wakes
// the agent with the incident protocol. It deliberately does NOT wait: the
// engine's hooks are awaited, and a chat turn takes seconds to minutes.

import type { Decision, Incident, Supervisor } from "@octopus/shared"
import type { ActivitySeverity } from "../activity/activity-bus"
import type { OwnerTarget } from "./owner-resolver"
import { getChatEventBridge } from "../activity/chat-event-bridge"

const activitySeverity = (severity: Incident["severity"]): ActivitySeverity =>
  severity === "warning" ? "warn" : severity

export class ChatSupervisor implements Supervisor {
  readonly id: string
  readonly kind = "chat" as const

  constructor(private target: OwnerTarget) {
    this.id = `chat:${target.sessionId}`
  }

  async notify(incident: Incident, opts?: { wake?: boolean }): Promise<void> {
    if (opts?.wake === false) {
      // Info-level signal: deterministic card only, zero LLM.
      getChatEventBridge().requestIncidentCard({
        sessionId: this.target.sessionId,
        workspaceId: incident.workspaceId || this.target.workspaceId || null,
        executionId: incident.executionId,
        incidentId: incident.id,
        nodeId: incident.displayNodeId ?? incident.nodeId,
        kind: incident.kind,
        severity: activitySeverity(incident.severity),
        summary: incident.summary,
        status: "dispatched",
        allowedActions: incident.allowedActions,
      })
      return
    }
    await getChatEventBridge().notifyIncident({
      sessionId: this.target.sessionId,
      org: this.target.org,
      workspaceId: incident.workspaceId || this.target.workspaceId || null,
      executionId: incident.executionId,
      incidentId: incident.id,
      nodeId: incident.displayNodeId ?? incident.nodeId,
      kind: incident.kind,
      severity: activitySeverity(incident.severity),
      summary: incident.summary,
      status: "dispatched",
      allowedActions: incident.allowedActions,
    })
  }

  /** Chat is asynchronous by design — the engine must never await a turn. */
  async requestDecision(_incident: Incident, _opts: { timeoutMs: number }): Promise<Decision | null> {
    return null
  }
}
