// HumanSupervisor — the escalation channel.
//
// Escalation is not a separate approval system: it lands a confirmation card in
// the same chat. The human clicks an option; the card POSTs resolve with
// resolution_source = 'user'. `requestDecision` returns null immediately for the
// same reason ChatSupervisor does: no engine hook may block on a human.

import type { Decision, Incident, Supervisor } from "@octopus/shared"
import type { ActivitySeverity } from "../activity/activity-bus"
import type { OwnerTarget } from "./owner-resolver"
import { getChatEventBridge } from "../activity/chat-event-bridge"

const activitySeverity = (severity: Incident["severity"]): ActivitySeverity =>
  severity === "warning" ? "warn" : severity

export class HumanSupervisor implements Supervisor {
  readonly id: string
  readonly kind = "human" as const

  constructor(private target: OwnerTarget | null) {
    this.id = target ? `human:${target.sessionId}` : "human:unassigned"
  }

  async notify(incident: Incident, _opts?: { wake?: boolean }): Promise<void> {
    if (!this.target) return
    getChatEventBridge().requestIncidentEscalation({
      sessionId: this.target.sessionId,
      workspaceId: incident.workspaceId || this.target.workspaceId || null,
      executionId: incident.executionId,
      incidentId: incident.id,
      nodeId: incident.displayNodeId ?? incident.nodeId,
      kind: incident.kind,
      severity: activitySeverity(incident.severity),
      summary: incident.summary,
      options: (incident.evidence.find((e) => Array.isArray(e.options))?.options as string[]) ?? [
        "继续重试",
        "中止执行",
        "先暂停，我来看看",
      ],
    })
  }

  async requestDecision(_incident: Incident, _opts: { timeoutMs: number }): Promise<Decision | null> {
    return null
  }
}
