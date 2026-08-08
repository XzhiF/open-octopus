// packages/server/src/services/harness/actions/modify-varpool.ts
//
// modify_varpool action — calls RepairService.patchVarPool() to modify
// variable values in the running workflow's VarPool, then optionally
// triggers a retry of the affected node.

import type { ActionHandler } from "../action-types"

export const modifyVarpoolHandler: ActionHandler = async (ctx) => {
  const { report, strategyAction, repairService } = ctx
  const key = strategyAction.key as string | undefined
  const value = strategyAction.value

  if (!key || value === undefined) {
    return {
      success: false,
      action: "modify_varpool",
      message: "modify_varpool action requires 'key' and 'value' fields",
    }
  }

  if (!repairService) {
    return {
      success: false,
      action: "modify_varpool",
      message: "RepairService is not available — cannot modify VarPool",
    }
  }

  try {
    const response = repairService.patchVarPool(report.executionId, {
      [key]: value,
    })

    return {
      success: true,
      action: "modify_varpool",
      message: `Updated VarPool: ${key} = ${JSON.stringify(value)}`,
      details: {
        key,
        value,
        updated: response.updated,
      },
    }
  } catch (err) {
    return {
      success: false,
      action: "modify_varpool",
      message: `Failed to modify VarPool: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
