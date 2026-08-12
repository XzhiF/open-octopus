// packages/server/src/services/harness/actions/modify-definition.ts
//
// modify_definition action — modifies the workflow YAML definition and
// triggers a reload via RepairService.reloadWorkflow().
// The strategy action must include a `content` field with the updated YAML.

import type { ActionHandler } from "../action-types"

export const modifyDefinitionHandler: ActionHandler = async (ctx) => {
  const { report, strategyAction, repairService } = ctx
  const content = strategyAction.content as string | undefined

  if (!content) {
    return {
      success: false,
      action: "modify_definition",
      message: "modify_definition action requires a 'content' field with the updated YAML",
    }
  }

  if (!repairService) {
    return {
      success: false,
      action: "modify_definition",
      message: "RepairService is not available — cannot reload workflow definition",
    }
  }

  try {
    const response = repairService.reloadWorkflow(report.executionId, content)

    return {
      success: true,
      action: "modify_definition",
      message: `Workflow definition reloaded with ${response.diff.length} changes`,
      details: {
        reloaded: response.reloaded,
        diff: response.diff,
        field: strategyAction.field,
        value: strategyAction.value,
      },
    }
  } catch (err) {
    return {
      success: false,
      action: "modify_definition",
      message: `Failed to reload definition: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
