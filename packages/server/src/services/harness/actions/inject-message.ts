// packages/server/src/services/harness/actions/inject-message.ts
//
// inject_message action — calls RepairService.intervene() to inject a message
// into a running agent session. Used primarily for the "stupid retry" scenario
// where the agent needs corrective guidance before its next attempt.

import type { ActionHandler } from "../action-types"

export const injectMessageHandler: ActionHandler = async (ctx) => {
  const { report, strategyAction, repairService } = ctx
  const message = strategyAction.message

  if (!message) {
    return {
      success: false,
      action: "inject_message",
      message: "inject_message action requires a 'message' field in the strategy config",
    }
  }

  if (!repairService) {
    return {
      success: false,
      action: "inject_message",
      message: "RepairService is not available — cannot inject message",
    }
  }

  try {
    const response = await repairService.intervene(
      report.executionId,
      report.nodeId,
      message,
    )

    return {
      success: true,
      action: "inject_message",
      message: response.injected
        ? `Injected message into node ${report.nodeId}`
        : `Message recorded but engine not live for node ${report.nodeId}`,
      details: { injected: response.injected },
    }
  } catch (err) {
    return {
      success: false,
      action: "inject_message",
      message: `Failed to inject message: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
