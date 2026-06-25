import { describe, it, expect } from "vitest"
import { ConditionExecutor } from "../executors/condition"
import { VarPool } from "@octopus/shared"
import type { NodeDef } from "@octopus/shared"

describe("ConditionExecutor", () => {
  it("matches a case with truthy condition", async () => {
    const node: NodeDef = {
      id: "cond1",
      type: "condition",
      cases: [
        { when: "$vars.status == 'ok'", then: "success-node" },
        { when: "$vars.status == 'fail'", then: "error-node" },
      ],
    }
    const pool = new VarPool({ status: "ok" })
    const executor = new ConditionExecutor(node, pool)
    const result = await executor.execute()

    expect(result.status).toBe("completed")
    expect(result.matchedCase).toBe(0)
    expect(result.jumpTo).toBe("success-node")
  })

  it("matches default case", async () => {
    const node: NodeDef = {
      id: "cond2",
      type: "condition",
      cases: [
        { when: "$vars.status == 'ok'", then: "success-node" },
        { when: "default", then: "fallback-node" },
      ],
    }
    const pool = new VarPool({ status: "unknown" })
    const executor = new ConditionExecutor(node, pool)
    const result = await executor.execute()

    expect(result.status).toBe("completed")
    expect(result.jumpTo).toBe("fallback-node")
  })

  it("returns failed when no case matches and no default", async () => {
    const node: NodeDef = {
      id: "cond3",
      type: "condition",
      cases: [
        { when: "$vars.x > 100", then: "high" },
        { when: "$vars.x < 10", then: "low" },
      ],
    }
    const pool = new VarPool({ x: 50 })
    const executor = new ConditionExecutor(node, pool)
    const result = await executor.execute()

    expect(result.status).toBe("failed")
  })

  it("matches second case", async () => {
    const node: NodeDef = {
      id: "cond4",
      type: "condition",
      cases: [
        { when: "$vars.mode == 'prod'", then: "deploy-prod" },
        { when: "$vars.mode == 'uat'", then: "deploy-uat" },
      ],
    }
    const pool = new VarPool({ mode: "uat" })
    const executor = new ConditionExecutor(node, pool)
    const result = await executor.execute()

    expect(result.matchedCase).toBe(1)
    expect(result.jumpTo).toBe("deploy-uat")
  })

  it("injects inputs into pool before evaluation", async () => {
    const node: NodeDef = {
      id: "cond5",
      type: "condition",
      inputs: { env: "staging", region: "us-west" },
      cases: [
        { when: "$inputs.env == 'staging'", then: "deploy-staging" },
      ],
    }
    const pool = new VarPool()
    const executor = new ConditionExecutor(node, pool)
    const result = await executor.execute()

    expect(result.status).toBe("completed")
    expect(result.jumpTo).toBe("deploy-staging")
  })
})