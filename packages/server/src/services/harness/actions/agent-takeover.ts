// packages/server/src/services/harness/actions/agent-takeover.ts
//
// agent_takeover action — creates a harness agent session that executes
// the node logic directly. This is a STUB implementation; ticket 09 will
// flesh out the full agent delegation logic.

import type { ActionHandler } from "../action-types"

export const agentTakeoverHandler: ActionHandler = async (ctx) => {
  const { report } = ctx

  // Stub: ticket 09 will implement the full agent delegation flow.
  // For now, acknowledge the action and return success so the harness
  // can proceed without crashing.
  return {
    success: true,
    action: "agent_takeover",
    message: `stub: agent takeover for node ${report.nodeId} — ticket 09 will implement`,
    details: {
      nodeId: report.nodeId,
      nodeType: report.nodeType,
      executionId: report.executionId,
      stub: true,
    },
  }
}
