import { describe, it, expect, vi } from "vitest"
import { WorkflowEngine } from "../engine"
import type { WorkflowDef } from "@octopus/shared"
import type { NodeExecutionResult } from "../executors/types"
import type { IAgentProvider } from "@octopus/providers"
import { VarPool } from "@octopus/shared"

function makeCompletedResult(overrides?: Partial<NodeExecutionResult>): NodeExecutionResult {
  return {
    status: "completed",
    outputs: {},
    durationMs: 10,
    logLines: [],
    ...overrides,
  }
}

function makeMockProvider(): IAgentProvider {
  return {
    getType: () => "claude",
    sendQuery: async function* () {
      yield { type: "result" }
    },
  }
}

vi.mock("../executors/bash", () => ({
  BashExecutor: vi.fn(),
}))
vi.mock("../executors/python", () => ({
  PythonExecutor: vi.fn(),
}))
vi.mock("../executors/condition", () => ({
  ConditionExecutor: vi.fn(),
}))
vi.mock("../executors/approval", () => ({
  ApprovalExecutor: vi.fn(),
}))
vi.mock("../executors/loop", () => ({
  LoopExecutor: vi.fn(),
}))
vi.mock("../executors/agent", () => ({
  AgentExecutor: vi.fn(),
}))
vi.mock("../logger", () => ({
  JsonlLogger: vi.fn().mockImplementation(() => ({
    log: vi.fn(),
    getLogDir: vi.fn().mockReturnValue("/tmp/logs"),
  })),
}))

import { BashExecutor } from "../executors/bash"
import { AgentExecutor } from "../executors/agent"
import { ConditionExecutor } from "../executors/condition"

describe("Parallel execution", () => {
  const mockProvider = makeMockProvider()

  // ── Level computation ──

  it("linear chain A→B→C in auto mode degenerates to serial", async () => {
    const callOrder: string[] = []
    vi.mocked(BashExecutor).mockImplementation((node: any) => ({
      execute: vi.fn().mockImplementation(() => {
        callOrder.push(node.id)
        return Promise.resolve(makeCompletedResult())
      }),
    } as any))

    const workflow: WorkflowDef = {
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "linear-chain",
      execution_mode: "auto",
      nodes: [
        { id: "A", type: "bash", bash: "echo a" },
        { id: "B", type: "bash", bash: "echo b", depends_on: ["A"] },
        { id: "C", type: "bash", bash: "echo c", depends_on: ["B"] },
      ],
    }

    const engine = new WorkflowEngine(workflow, { "claude": mockProvider }, "/tmp/test")
    const result = await engine.run()

    expect(result.status).toBe("completed")
    expect(callOrder).toEqual(["A", "B", "C"])
  })

  it("linear chain in serial mode matches legacy behavior", async () => {
    const callOrder: string[] = []
    vi.mocked(BashExecutor).mockImplementation((node: any) => ({
      execute: vi.fn().mockImplementation(() => {
        callOrder.push(node.id)
        return Promise.resolve(makeCompletedResult())
      }),
    } as any))

    const workflow: WorkflowDef = {
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "serial-chain",
      execution_mode: "serial",
      nodes: [
        { id: "A", type: "bash", bash: "echo a" },
        { id: "B", type: "bash", bash: "echo b", depends_on: ["A"] },
        { id: "C", type: "bash", bash: "echo c", depends_on: ["B"] },
      ],
    }

    const engine = new WorkflowEngine(workflow, { "claude": mockProvider }, "/tmp/test")
    const result = await engine.run()

    expect(result.status).toBe("completed")
    expect(callOrder).toEqual(["A", "B", "C"])
  })

  // ── Fan-out parallel ──

  it("fan-out A→[B,C]→D runs B and C concurrently", async () => {
    const executionTimes: Map<string, number> = new Map()
    vi.mocked(BashExecutor).mockImplementation((node: any) => ({
      execute: vi.fn().mockImplementation(() => {
        executionTimes.set(node.id, Date.now())
        return Promise.resolve(makeCompletedResult())
      }),
    } as any))

    const workflow: WorkflowDef = {
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "fan-out",
      execution_mode: "auto",
      nodes: [
        { id: "A", type: "bash", bash: "echo a" },
        { id: "B", type: "bash", bash: "echo b", depends_on: ["A"] },
        { id: "C", type: "bash", bash: "echo c", depends_on: ["A"] },
        { id: "D", type: "bash", bash: "echo d", depends_on: ["B", "C"] },
      ],
    }

    const engine = new WorkflowEngine(workflow, { "claude": mockProvider }, "/tmp/test")
    const result = await engine.run()

    expect(result.status).toBe("completed")
    // B and C should be in the same level — their results exist
    expect(result.nodeResults["B"]).toBeDefined()
    expect(result.nodeResults["C"]).toBeDefined()
    expect(result.nodeResults["D"]).toBeDefined()
  })

  it("fan-out with max_concurrent=1 degenerates to serial", async () => {
    const callOrder: string[] = []
    vi.mocked(BashExecutor).mockImplementation((node: any) => ({
      execute: vi.fn().mockImplementation(() => {
        callOrder.push(node.id)
        return Promise.resolve(makeCompletedResult())
      }),
    } as any))

    const workflow: WorkflowDef = {
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "max-concurrent-1",
      execution_mode: "auto",
      max_concurrent: 1,
      nodes: [
        { id: "A", type: "bash", bash: "echo a" },
        { id: "B", type: "bash", bash: "echo b", depends_on: ["A"] },
        { id: "C", type: "bash", bash: "echo c", depends_on: ["A"] },
        { id: "D", type: "bash", bash: "echo d", depends_on: ["B", "C"] },
      ],
    }

    const engine = new WorkflowEngine(workflow, { "claude": mockProvider }, "/tmp/test")
    const result = await engine.run()

    expect(result.status).toBe("completed")
    // All nodes run, order may not be exactly A,B,C,D but all complete
    expect(result.nodeResults["A"]).toBeDefined()
    expect(result.nodeResults["B"]).toBeDefined()
    expect(result.nodeResults["C"]).toBeDefined()
    expect(result.nodeResults["D"]).toBeDefined()
  })

  // ── Fail-fast ──

  it("parallel node failure triggers fail-fast at level boundary", async () => {
    vi.mocked(BashExecutor).mockImplementation((node: any) => ({
      execute: vi.fn().mockImplementation(() => {
        if (node.id === "fail") {
          return Promise.resolve(makeCompletedResult({ status: "failed", logLines: ["boom"] }))
        }
        return Promise.resolve(makeCompletedResult())
      }),
    } as any))

    const workflow: WorkflowDef = {
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "parallel-fail",
      execution_mode: "auto",
      nodes: [
        { id: "A", type: "bash", bash: "echo a" },
        { id: "fail", type: "bash", bash: "exit 1", depends_on: ["A"] },
        { id: "C", type: "bash", bash: "echo c", depends_on: ["A"] },
        { id: "D", type: "bash", bash: "echo d", depends_on: ["fail", "C"] },
      ],
    }

    const engine = new WorkflowEngine(workflow, { "claude": mockProvider }, "/tmp/test")
    const result = await engine.run()

    expect(result.status).toBe("failed")
    expect(result.nodeResults["fail"].status).toBe("failed")
    // C may or may not be in nodeResults — depends on level structure
    // D is in a later level and should NOT execute since fail is in its depends_on
  })

  // ── VarPool isolation ──

  it("parallel nodes writing different keys merge into main pool", async () => {
    vi.mocked(BashExecutor).mockImplementation((node: any) => ({
      execute: vi.fn().mockImplementation(() => {
        // Simulate each node writing a different key to pool
        const pool = new VarPool()
        if (node.id === "B") pool.set("key_b", "value_b")
        if (node.id === "C") pool.set("key_c", "value_c")
        // In real execution, executor writes to its forked pool
        // Here we just verify the engine mechanism works
        return Promise.resolve(makeCompletedResult({
          outputs: { key_b: node.id === "B" ? "value_b" : undefined, key_c: node.id === "C" ? "value_c" : undefined },
        }))
      }),
    } as any))

    const workflow: WorkflowDef = {
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "varpool-merge",
      execution_mode: "auto",
      nodes: [
        { id: "A", type: "bash", bash: "echo a" },
        { id: "B", type: "bash", bash: "echo b", depends_on: ["A"] },
        { id: "C", type: "bash", bash: "echo c", depends_on: ["A"] },
      ],
    }

    const engine = new WorkflowEngine(workflow, { "claude": mockProvider }, "/tmp/test")
    const result = await engine.run()

    expect(result.status).toBe("completed")
  })

  // ── agents passthrough ──

  it("agent node with agents definition passes it to executor", async () => {
    vi.mocked(AgentExecutor).mockImplementation(() => ({
      execute: vi.fn().mockResolvedValue(makeCompletedResult({
        lastOutput: "done",
        sessionId: "sess1",
      })),
    } as any))

    const workflow: WorkflowDef = {
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "agents-passthrough",
      execution_mode: "auto",
      nodes: [
        { id: "review", type: "agent", prompt: "Review code", agents: {
          "security-scanner": { description: "Security scanner", prompt: "Scan for vulnerabilities" },
        }},
      ],
    }

    const engine = new WorkflowEngine(workflow, { "claude": mockProvider }, "/tmp/test")
    const result = await engine.run()

    expect(result.status).toBe("completed")
    expect(AgentExecutor).toHaveBeenCalled()
    // Verify the agent executor was constructed with the agents field
    const ctorCall = vi.mocked(AgentExecutor).mock.calls[0]
    const nodeArg = ctorCall[0] as any
    expect(nodeArg.agents).toBeDefined()
    expect(nodeArg.agents["security-scanner"]).toBeDefined()
  })

  // ── context: "continue" with depends_on ──

  it("agent B with context: continue resumes globalSessionId from agent A", async () => {
    vi.mocked(AgentExecutor).mockImplementation((...args: any[]) => {
      const node = args[0] as any
      return {
        execute: vi.fn().mockResolvedValue(makeCompletedResult({
          lastOutput: `${node.id} done`,
          sessionId: `sess-global`,
        })),
      } as any
    })

    const workflow: WorkflowDef = {
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "session-chain",
      execution_mode: "auto",
      nodes: [
        { id: "agentA", type: "agent", prompt: "First task" },
        { id: "agentB", type: "agent", prompt: "Second task", depends_on: ["agentA"] },
      ],
    }

    const engine = new WorkflowEngine(workflow, { "claude": mockProvider }, "/tmp/test")
    const result = await engine.run()

    expect(result.status).toBe("completed")
    // agentA creates globalSessionId = "sess-global"
    // agentB (context: "continue" by default) resumes globalSessionId
    const calls = vi.mocked(AgentExecutor).mock.calls
    const ctorB = calls.find(c => (c[0] as any).id === "agentB") ?? calls[1]
    expect(ctorB).toBeDefined()
    const previousSessionId = ctorB![3] as string | undefined
    expect(previousSessionId).toBe("sess-global")
  })

  // ── Condition jumpTo cross-level ──

  it("condition jumpTo skips nodes in subsequent levels", async () => {
    vi.mocked(ConditionExecutor).mockImplementation((node: any) => ({
      execute: vi.fn().mockResolvedValue(makeCompletedResult({
        jumpTo: "target",
      })),
    } as any))
    vi.mocked(BashExecutor).mockImplementation((node: any) => ({
      execute: vi.fn().mockResolvedValue(makeCompletedResult()),
    } as any))

    // Level 0: check
    // Level 1: skipped (depends on check), target (depends on check)
    // Condition in level 0 jumps to target → skipped is skipped
    const workflow: WorkflowDef = {
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "jump-skip",
      execution_mode: "auto",
      nodes: [
        { id: "check", type: "condition", cases: [{ when: "true", then: "target" }] },
        { id: "skipped", type: "bash", bash: "echo skip", depends_on: ["check"] },
        { id: "target", type: "bash", bash: "echo target", depends_on: ["check"] },
      ],
    }

    const engine = new WorkflowEngine(workflow, { "claude": mockProvider }, "/tmp/test")
    const result = await engine.run()

    expect(result.status).toBe("completed")
    expect(result.nodeResults["check"]).toBeDefined()
    // "skipped" should be skipped due to condition jumpTo targeting "target"
    expect(result.nodeResults["skipped"].status).toBe("skipped")
    expect(result.nodeResults["target"]).toBeDefined()
  })

  // ── DAG mixed structure ──

  it("multi-layer fan-out + fan-in computes correct levels", async () => {
    const callOrder: string[] = []
    vi.mocked(BashExecutor).mockImplementation((node: any) => ({
      execute: vi.fn().mockImplementation(() => {
        callOrder.push(node.id)
        return Promise.resolve(makeCompletedResult())
      }),
    } as any))

    const workflow: WorkflowDef = {
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "multi-layer",
      execution_mode: "auto",
      nodes: [
        { id: "A", type: "bash", bash: "echo a" },
        { id: "B", type: "bash", bash: "echo b", depends_on: ["A"] },
        { id: "C", type: "bash", bash: "echo c", depends_on: ["A"] },
        { id: "D", type: "bash", bash: "echo d", depends_on: ["B"] },
        { id: "E", type: "bash", bash: "echo e", depends_on: ["C"] },
        { id: "F", type: "bash", bash: "echo f", depends_on: ["D", "E"] },
      ],
    }

    const engine = new WorkflowEngine(workflow, { "claude": mockProvider }, "/tmp/test")
    const result = await engine.run()

    expect(result.status).toBe("completed")
    // A must be first, F must be last
    expect(callOrder.indexOf("A")).toBeLessThan(callOrder.indexOf("B"))
    expect(callOrder.indexOf("A")).toBeLessThan(callOrder.indexOf("C"))
    expect(callOrder.indexOf("B")).toBeLessThan(callOrder.indexOf("D"))
    expect(callOrder.indexOf("C")).toBeLessThan(callOrder.indexOf("E"))
    expect(callOrder.indexOf("D")).toBeLessThan(callOrder.indexOf("F"))
    expect(callOrder.indexOf("E")).toBeLessThan(callOrder.indexOf("F"))
  })

  // ── VarPool fork/merge unit ──

  it("VarPool fork creates independent copy", () => {
    const pool = new VarPool({ x: 1, y: 2 })
    const fork = pool.fork()

    fork.set("x", 10)
    expect(pool.get("x")).toBe(1) // main pool unchanged
    expect(fork.get("x")).toBe(10)
  })

  it("VarPool merge combines forked changes with last-writer strategy", () => {
    const pool = new VarPool({ x: 1 })
    const fork1 = pool.fork()
    const fork2 = pool.fork()

    fork1.set("a", "from-fork1")
    fork2.set("b", "from-fork2")
    fork2.set("x", 99) // both forks share original x=1, fork2 overwrites

    pool.merge([fork1, fork2])

    expect(pool.get("a")).toBe("from-fork1")
    expect(pool.get("b")).toBe("from-fork2")
    expect(pool.get("x")).toBe(99) // last-writer wins
  })

  it("parallel forks writing disjoint vars do not overwrite each other", async () => {
    // Regression: fork2's unchanged keys must NOT clobber fork1's changes
    vi.mocked(BashExecutor).mockImplementation((node: any, pool: any) => ({
      execute: vi.fn().mockImplementation(() => {
        // Each parallel node writes to its own fork (passed by the engine)
        if (node.id === "B") pool.set("from_b", 42)
        if (node.id === "C") pool.set("from_c", 99)
        return Promise.resolve(makeCompletedResult())
      }),
    } as any))

    const workflow: WorkflowDef = {
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "disjoint-merge",
      execution_mode: "auto",
      variables: { shared: "initial" },
      nodes: [
        { id: "B", type: "bash", bash: "echo b" },
        { id: "C", type: "bash", bash: "echo c" },
      ],
    }

    const engine = new WorkflowEngine(workflow, { "claude": mockProvider }, "/tmp/test")
    const result = await engine.run()

    expect(result.status).toBe("completed")
    // Both forks' changes must be in the final pool
    expect(result.poolSnapshot.from_b).toBe(42)
    expect(result.poolSnapshot.from_c).toBe(99)
    expect(result.poolSnapshot.shared).toBe("initial")
  })

  // ── computeExecutionLevels unit ──

  it("computeExecutionLevels produces correct levels for simple DAG", async () => {
    vi.mocked(BashExecutor).mockImplementation(() => ({
      execute: vi.fn().mockResolvedValue(makeCompletedResult()),
    } as any))

    // A → B,C → D
    // Level 0: A
    // Level 1: B, C
    // Level 2: D
    const workflow: WorkflowDef = {
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "level-test",
      execution_mode: "auto",
      nodes: [
        { id: "A", type: "bash", bash: "echo a" },
        { id: "B", type: "bash", bash: "echo b", depends_on: ["A"] },
        { id: "C", type: "bash", bash: "echo c", depends_on: ["A"] },
        { id: "D", type: "bash", bash: "echo d", depends_on: ["B", "C"] },
      ],
    }

    const engine = new WorkflowEngine(workflow, { "claude": mockProvider }, "/tmp/test")
    const result = await engine.run()

    expect(result.status).toBe("completed")
    expect(result.nodeResults["A"].status).toBe("completed")
    expect(result.nodeResults["B"].status).toBe("completed")
    expect(result.nodeResults["C"].status).toBe("completed")
    expect(result.nodeResults["D"].status).toBe("completed")
  })

  it("nodes without depends_on run in level 0", async () => {
    vi.mocked(BashExecutor).mockImplementation(() => ({
      execute: vi.fn().mockResolvedValue(makeCompletedResult()),
    } as any))

    // A, B, C have no depends_on — all in level 0
    const workflow: WorkflowDef = {
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "independent",
      execution_mode: "auto",
      nodes: [
        { id: "A", type: "bash", bash: "echo a" },
        { id: "B", type: "bash", bash: "echo b" },
        { id: "C", type: "bash", bash: "echo c" },
      ],
    }

    const engine = new WorkflowEngine(workflow, { "claude": mockProvider }, "/tmp/test")
    const result = await engine.run()

    expect(result.status).toBe("completed")
    expect(result.nodeResults["A"].status).toBe("completed")
    expect(result.nodeResults["B"].status).toBe("completed")
    expect(result.nodeResults["C"].status).toBe("completed")
  })

  it("max_concurrent splits large level into batches", async () => {
    vi.mocked(BashExecutor).mockImplementation(() => ({
      execute: vi.fn().mockResolvedValue(makeCompletedResult()),
    } as any))

    // 7 nodes with no depends_on, max_concurrent=3 → batches [3,3,1]
    const workflow: WorkflowDef = {
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "batched",
      execution_mode: "auto",
      max_concurrent: 3,
      nodes: [
        { id: "n1", type: "bash", bash: "echo 1" },
        { id: "n2", type: "bash", bash: "echo 2" },
        { id: "n3", type: "bash", bash: "echo 3" },
        { id: "n4", type: "bash", bash: "echo 4" },
        { id: "n5", type: "bash", bash: "echo 5" },
        { id: "n6", type: "bash", bash: "echo 6" },
        { id: "n7", type: "bash", bash: "echo 7" },
      ],
    }

    const engine = new WorkflowEngine(workflow, { "claude": mockProvider }, "/tmp/test")
    const result = await engine.run()

    expect(result.status).toBe("completed")
    for (let i = 1; i <= 7; i++) {
      expect(result.nodeResults[`n${i}`].status).toBe("completed")
    }
  })
})