import { VarPool, evaluateExpression, substituteVars } from "@octopus/shared"
import type { NodeDef } from "@octopus/shared"
import type { NodeExecutor, NodeExecutionResult } from "./types"

export class ConditionExecutor implements NodeExecutor {
  constructor(private node: NodeDef, private pool: VarPool) {}

  async execute(): Promise<NodeExecutionResult> {
    const start = Date.now()
    const cases = this.node.cases ?? []

    // 从 pool 获取全局 inputs（而不是 this.node.inputs）
    const inputs: Record<string, any> = {}
    const poolSnapshot = this.pool.snapshot()
    for (const [key, value] of Object.entries(poolSnapshot)) {
      inputs[key] = value
    }

    // 添加 node.inputs（如果有的话，作为局部变量）
    if (this.node.inputs) {
      for (const [key, expr] of Object.entries(this.node.inputs)) {
        inputs[key] = substituteVars(expr, this.pool)
      }
    }

    for (let i = 0; i < cases.length; i++) {
      const case_ = cases[i]

      // 跳过 default case（在后面专门处理）
      if (case_.when.trim() === "default") {
        continue
      }

      if (evaluateExpression(case_.when, this.pool, undefined, inputs)) {
        const durationMs = Date.now() - start
        return {
          outputs: { matched_case: i, then: case_.then },
          status: "completed",
          durationMs,
          logLines: [`Condition matched case ${i}: ${case_.when} → ${case_.then}`],
          matchedCase: i,
          jumpTo: case_.then,
        }
      }
    }

    // 处理 default case
    const defaultCase = cases.find((c) => c.when.trim() === "default")
    if (defaultCase) {
      const durationMs = Date.now() - start
      return {
        outputs: { matched_case: cases.indexOf(defaultCase), then: defaultCase.then },
        status: "completed",
        durationMs,
        logLines: [`Condition matched default → ${defaultCase.then}`],
        matchedCase: cases.indexOf(defaultCase),
        jumpTo: defaultCase.then,
      }
    }

    const durationMs = Date.now() - start
    return {
      outputs: {},
      status: "failed",
      durationMs,
      logLines: ["No condition case matched"],
    }
  }
}