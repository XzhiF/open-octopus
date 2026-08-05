// packages/server/src/services/harness/actions/agent-takeover.ts
//
// agent_takeover action — signals that a node needs to be taken over by
// an agent session. When used within a strategy that also has
// delegate_to_agent: true, the StrategyEngine will invoke the
// AgentDelegationService (Layer 3) to perform the actual takeover.

import type { ActionHandler } from "../action-types"

export const agentTakeoverHandler: ActionHandler = async (ctx) => {
  const { report } = ctx

  return {
    success: true,
    action: "agent_takeover",
    message: `Agent takeover requested for node ${report.nodeId} (${report.nodeType})`,
    delegate: true, // Signal that Layer 3 delegation should follow
    details: {
      nodeId: report.nodeId,
      nodeType: report.nodeType,
      executionId: report.executionId,
      detector: report.detector,
      severity: report.severity,
    },
  }
}
