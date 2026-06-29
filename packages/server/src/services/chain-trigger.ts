import type { ExecutionDAO } from "../../db/dao/execution-dao"
import type { ChainDef, ChainItem } from "@octopus/shared"
import { evaluateExpression } from "@octopus/shared"

export class ChainTrigger {
  constructor(
    private executionDAO: ExecutionDAO,
    private createExecution: (workspaceId: string, input: {
      workflow_ref: string
      parent_id?: string
      input_values?: Record<string, unknown>
      triggered_by?: string
    }) => Promise<string>,
  ) {}

  async evaluateAndTrigger(
    workflowDef: { chain?: ChainDef },
    executionId: string,
    status: string,
    poolSnapshot: Record<string, unknown>,
    workspaceId: string,
  ): Promise<void> {
    if (!workflowDef.chain) return

    const chain = status === "completed" || status === "completed_with_failures"
      ? workflowDef.chain.on_success
      : workflowDef.chain.on_failure

    if (!chain || chain.length === 0) return

    const exec = this.executionDAO.findById(executionId)
    if (!exec) return

    const chainDepth = this.calculateChainDepth(executionId)
    if (chainDepth > 5) {
      console.error(`[ChainTrigger] Chain depth exceeds limit (5) for execution ${executionId}`)
      return
    }

    for (const item of chain) {
      try {
        if (item.condition) {
          const conditionResult = evaluateExpression(item.condition, poolSnapshot)
          if (!conditionResult) continue
        }

        const inputValues = this.resolveInputMapping(item.input_mapping, poolSnapshot)

        await this.createExecution(workspaceId, {
          workflow_ref: item.workflow,
          parent_id: executionId,
          input_values: inputValues,
          triggered_by: "chain",
        })

        console.log(`[ChainTrigger] Triggered ${item.workflow} from ${executionId}`)
      } catch (err) {
        console.error(`[ChainTrigger] Failed to trigger ${item.workflow}:`, err)
      }
    }
  }

  private calculateChainDepth(executionId: string): number {
    let depth = 0
    let currentId = executionId

    while (depth < 10) {
      const exec = this.executionDAO.findById(currentId)
      if (!exec || !exec.parent_id || exec.parent_id === "0") break
      currentId = exec.parent_id
      depth++
    }

    return depth
  }

  private resolveInputMapping(
    mapping: Record<string, string> | undefined,
    pool: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!mapping) return {}

    const result: Record<string, unknown> = {}
    for (const [key, expr] of Object.entries(mapping)) {
      try {
        result[key] = evaluateExpression(expr, pool)
      } catch {
        console.warn(`[ChainTrigger] Failed to resolve ${expr}, using empty string`)
        result[key] = ""
      }
    }

    return result
  }
}
