import { describe, it, expect, vi } from "vitest"
import { LoopExecutor } from "../executors/loop"
import { VarPool } from "@octopus/shared"
import type { NodeDef } from "@octopus/shared"
import type { ICheckpointStore } from "../pipeline/checkpoint-types"
import os from "os"

describe("LoopExecutor", () => {
  it("iterates for max_iterations when while is always true", async () => {
    const node: NodeDef = {
      id: "loop1",
      type: "loop",
      max_iterations: 5,
      while: "true",
      nodes: [
        { id: "inc", type: "bash", bash: "echo hello" },
      ],
    }
    const pool = new VarPool({ counter: 0 })

    const executor = new LoopExecutor(node, pool, {}, os.tmpdir())
    const result = await executor.execute()

    expect(result.status).toBe("completed")
    expect(result.iterations).toBe(5)
    expect(result.logLines).toContain("Loop hit max_iterations limit: 5")
  })

  it("skips loop when while condition is false initially", async () => {
    const node: NodeDef = {
      id: "loop1b",
      type: "loop",
      max_iterations: 10,
      while: "false",
      nodes: [
        { id: "inc", type: "bash", bash: "echo never" },
      ],
    }
    const pool = new VarPool()

    const executor = new LoopExecutor(node, pool, {}, os.tmpdir())
    const result = await executor.execute()

    expect(result.status).toBe("completed")
    expect(result.iterations).toBe(0)
  })

  it("breaks when break_when is true", async () => {
    const node: NodeDef = {
      id: "loop2",
      type: "loop",
      max_iterations: 100,
      while: "true",
      nodes: [
        { id: "check", type: "bash", bash: "echo found", break_when: "$vars.found == true" },
      ],
    }
    const pool = new VarPool({ found: true })

    const executor = new LoopExecutor(node, pool, {}, os.tmpdir())
    const result = await executor.execute()

    expect(result.iterations).toBeLessThanOrEqual(1)
  })

  it("continues when continue_when is true", async () => {
    const node: NodeDef = {
      id: "loop3",
      type: "loop",
      max_iterations: 5,
      while: "true",
      nodes: [
        { id: "skip_check", type: "bash", bash: "echo skip", continue_when: "true" },
        { id: "do_work", type: "bash", bash: "echo work" },
      ],
    }
    const pool = new VarPool()

    const executor = new LoopExecutor(node, pool, {}, os.tmpdir())
    const result = await executor.execute()

    expect(result.status).toBe("completed")
  })

  it("respects max_iterations", async () => {
    const node: NodeDef = {
      id: "loop4",
      type: "loop",
      max_iterations: 3,
      while: "true",
      nodes: [
        { id: "step", type: "bash", bash: "echo step" },
      ],
    }
    const pool = new VarPool()

    const executor = new LoopExecutor(node, pool, {}, os.tmpdir())
    const result = await executor.execute()

    expect(result.iterations).toBe(3)
    expect(result.logLines).toContain("Loop hit max_iterations limit: 3")
  })

  it("condition jumpTo 'break' exits the loop", async () => {
    const node: NodeDef = {
      id: "loop5",
      type: "loop",
      max_iterations: 10,
      while: "true",
      nodes: [
        { id: "work", type: "bash", bash: "echo work" },
        {
          id: "check",
          type: "condition",
          depends_on: ["work"],
          cases: [
            { when: "$vars.done == true", then: "break" },
            { when: "default", then: "work" },
          ],
        },
      ],
    }
    const pool = new VarPool({ done: true })

    const executor = new LoopExecutor(node, pool, {}, os.tmpdir())
    const result = await executor.execute()

    expect(result.status).toBe("completed")
    expect(result.iterations).toBe(1)
  })

  it("condition jumpTo backward target triggers next iteration", async () => {
    // Regression test: condition jumpTo pointing to an earlier inner node
    // should NOT exit the loop — it should end the current iteration and
    // let the outer while loop re-enter for the next iteration.
    const node: NodeDef = {
      id: "loop6",
      type: "loop",
      max_iterations: 10,
      while: "$vars.count < 3",
      nodes: [
        {
          id: "work",
          type: "bash",
          bash: 'next=$(( $vars.count + 1 )); echo "{\\"vars_update\\":{\\"count\\":$next}}"',
        },
        {
          id: "check",
          type: "condition",
          depends_on: ["work"],
          cases: [
            { when: "$vars.count >= 3", then: "break" },
            { when: "default", then: "work" }, // backward jump → next iteration
          ],
        },
      ],
    }
    const pool = new VarPool({ count: 0 })
    const executor = new LoopExecutor(node, pool, {}, os.tmpdir())
    const result = await executor.execute()

    expect(result.status).toBe("completed")
    // Iteration 1: work→count=1, check→jumpTo "work" (backward→next iter)
    // Iteration 2: work→count=2, check→jumpTo "work" (backward→next iter)
    // Iteration 3: work→count=3, check→jumpTo "break"→exits
    expect(result.iterations).toBe(3)
    expect(pool.get("count")).toBe(3)
  })

  it("condition jumpTo forward target skips intermediate nodes", async () => {
    const node: NodeDef = {
      id: "loop7",
      type: "loop",
      max_iterations: 1,
      while: "true",
      nodes: [
        { id: "first", type: "bash", bash: "echo first" },
        { id: "middle", type: "bash", bash: "echo middle" },
        { id: "last", type: "bash", bash: "echo last" },
        {
          id: "decide",
          type: "condition",
          cases: [
            { when: "true", then: "last" }, // forward jump over "middle"
          ],
        },
        // Note: "decide" is placed BEFORE "middle" in node order to test forward skip
      ],
    }
    // Reorder: decide should come after first, jump to last, skipping middle
    node.nodes = [
      { id: "first", type: "bash", bash: "echo first" },
      {
        id: "decide",
        type: "condition",
        cases: [
          { when: "true", then: "last" },
        ],
      },
      { id: "middle", type: "bash", bash: "echo middle" },
      { id: "last", type: "bash", bash: "echo last" },
    ]

    const pool = new VarPool()
    const executor = new LoopExecutor(node, pool, {}, os.tmpdir())
    const result = await executor.execute()

    expect(result.status).toBe("completed")
    // first, decide, last should run; middle should be skipped
    expect(result.logLines).toContain("first")
    expect(result.logLines).not.toContain("middle")
    expect(result.logLines).toContain("last")
  })

  it("creates a SwarmExecutor for swarm nodes inside a loop", async () => {
    const node: NodeDef = {
      id: "loop_with_swarm",
      type: "loop",
      max_iterations: 1,
      while: "true",
      nodes: [
        {
          id: "swarm1",
          type: "swarm",
          mode: "review",
          experts: [
            { role: "reviewer", prompt: "review code", model: "haiku" },
          ],
        },
      ],
    }
    const pool = new VarPool()

    // Swarm node inside loop creates SwarmExecutor.
    // With no providers it fails for a different reason, proving the guard is gone.
    const executor = new LoopExecutor(
      node, pool, {}, os.tmpdir(),
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined,
      undefined, undefined, undefined, undefined,
    )

    let caughtError: unknown
    try {
      await executor.execute()
    } catch (err) {
      caughtError = err
    }

    if (caughtError instanceof Error) {
      expect(caughtError.message).not.toContain("swarm 节点不支持嵌套在 loop 内部")
    }
  })

  it("accepts checkpointStore, executionId, hookExecutor, and agentResolver params", async () => {
    const node: NodeDef = {
      id: "loop_params",
      type: "loop",
      max_iterations: 1,
      while: "false",
      nodes: [],
    }
    const pool = new VarPool()

    const mockCheckpointStore: ICheckpointStore = { save: vi.fn(), load: vi.fn(), cleanExpired: vi.fn() }
    const mockHookExecutor = vi.fn<(event: string, context: Record<string, unknown>) => Promise<void>>()
    const mockAgentResolver = vi.fn<(topic: string, maxExperts: number) => Promise<Array<{ role: string; agent_file: string; description: string }>>>()

    // Should not throw when constructing with new params
    const executor = new LoopExecutor(
      node, pool, {}, os.tmpdir(),
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined,
      mockCheckpointStore,
      "exec-test-123",
      mockHookExecutor,
      mockAgentResolver,
    )

    const result = await executor.execute()
    expect(result.status).toBe("completed")
    expect(result.iterations).toBe(0)
  })
})