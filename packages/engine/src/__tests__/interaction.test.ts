import { describe, it, expect } from "vitest"
import { InteractionExecutor } from "../executors/interaction"
import { VarPool } from "@octopus/shared"
import type { NodeDef } from "@octopus/shared"

describe("InteractionExecutor", () => {
  it("returns pending_interaction on first call without completion data", async () => {
    const node: NodeDef = {
      id: "int1",
      type: "interaction",
      interaction_display: "modal",
      interaction_max_rounds: 10,
      interaction_agent: {
        prompt: "You are a clarification assistant.",
        skills: ["octo-xzf-clarify"],
      },
    }
    const pool = new VarPool()
    const executor = new InteractionExecutor(node, pool)
    const result = await executor.execute()

    expect(result.status).toBe("pending_interaction")
    expect(result.interactionMetadata).toBeDefined()
    expect(result.interactionMetadata?.display).toBe("modal")
    expect(result.interactionMetadata?.nodeId).toBe("int1")
    expect(result.interactionMetadata?.maxRounds).toBe(10)
  })

  it("uses default display mode (modal) when not specified", async () => {
    const node: NodeDef = {
      id: "int2",
      type: "interaction",
    }
    const pool = new VarPool()
    const executor = new InteractionExecutor(node, pool)
    const result = await executor.execute()

    expect(result.status).toBe("pending_interaction")
    expect(result.interactionMetadata?.display).toBe("modal")
    expect(result.interactionMetadata?.maxRounds).toBe(20) // default
  })

  it("returns completed when completion data is provided", async () => {
    const node: NodeDef = {
      id: "int3",
      type: "interaction",
    }
    const pool = new VarPool()
    const executor = new InteractionExecutor(node, pool, {
      completionData: {
        summary: "Requirements clarified: need dark mode support",
        vars_update: { clarify_status: "COMPLETE", feature_name: "dark-mode" },
      },
    })
    const result = await executor.execute()

    expect(result.status).toBe("completed")
    expect(result.lastOutput).toBe("Requirements clarified: need dark mode support")
    expect(result.outputs.summary).toBe("Requirements clarified: need dark mode support")
    expect(result.outputs.vars_update).toEqual({ clarify_status: "COMPLETE", feature_name: "dark-mode" })
  })

  it("applies vars_update to VarPool", async () => {
    const node: NodeDef = {
      id: "int4",
      type: "interaction",
    }
    const pool = new VarPool()
    const executor = new InteractionExecutor(node, pool, {
      completionData: {
        summary: "Done",
        vars_update: { my_var: "my_value", count: 42 },
      },
    })
    await executor.execute()

    expect(pool.get("my_var")).toBe("my_value")
    expect(pool.get("count")).toBe(42)
  })

  it("applies outputs mapping", async () => {
    const node: NodeDef = {
      id: "int5",
      type: "interaction",
      outputs: {
        "$vars.result_summary": "$last_output",
      },
    }
    const pool = new VarPool()
    const executor = new InteractionExecutor(node, pool, {
      completionData: {
        summary: "The answer is 42",
      },
    })
    await executor.execute()

    expect(pool.get("result_summary")).toBe("The answer is 42")
  })

  it("completes immediately when interaction_exit_when evaluates to true", async () => {
    const node: NodeDef = {
      id: "int6",
      type: "interaction",
      interaction_exit_when: "$vars.status == 'DONE'",
    }
    const pool = new VarPool({ status: "DONE" })
    const executor = new InteractionExecutor(node, pool)
    const result = await executor.execute()

    expect(result.status).toBe("completed")
  })

  it("continues to pending_interaction when interaction_exit_when evaluates to false", async () => {
    const node: NodeDef = {
      id: "int7",
      type: "interaction",
      interaction_exit_when: "$vars.status == 'DONE'",
    }
    const pool = new VarPool({ status: "PENDING" })
    const executor = new InteractionExecutor(node, pool)
    const result = await executor.execute()

    expect(result.status).toBe("pending_interaction")
  })

  it("auto-completes when max_rounds is reached", async () => {
    const node: NodeDef = {
      id: "int8",
      type: "interaction",
      interaction_max_rounds: 5,
    }
    const pool = new VarPool()
    const executor = new InteractionExecutor(node, pool, {
      currentRound: 5,
    })
    const result = await executor.execute()

    expect(result.status).toBe("completed")
    expect(result.logLines.some(l => l.includes("max_rounds"))).toBe(true)
  })

  it("returns cancelled when signal is aborted", async () => {
    const node: NodeDef = {
      id: "int9",
      type: "interaction",
    }
    const pool = new VarPool()
    const ac = new AbortController()
    ac.abort()
    const executor = new InteractionExecutor(node, pool, { signal: ac.signal })
    const result = await executor.execute()

    expect(result.status).toBe("cancelled")
  })

  it("resolves $vars in interaction_agent prompt", async () => {
    const node: NodeDef = {
      id: "int10",
      type: "interaction",
      interaction_agent: {
        prompt: "Feature: $vars.feature_name",
      },
    }
    const pool = new VarPool({ feature_name: "dark-mode" })
    const executor = new InteractionExecutor(node, pool)
    const result = await executor.execute()

    expect(result.status).toBe("pending_interaction")
    expect(result.logLines.some(l => l.includes("Feature: dark-mode"))).toBe(true)
  })

  it("includes timeout info in log lines", async () => {
    const node: NodeDef = {
      id: "int11",
      type: "interaction",
      interaction_timeout: 3600,
    }
    const pool = new VarPool()
    const executor = new InteractionExecutor(node, pool)
    const result = await executor.execute()

    expect(result.status).toBe("pending_interaction")
    expect(result.logLines).toContain("Interaction timeout: 3600s")
    expect(result.timeout).toBe(3600)
  })
})
