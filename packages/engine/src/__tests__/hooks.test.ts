import { describe, it, expect, vi, beforeEach } from "vitest"
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
      yield { type: "message_start", messageId: "msg1" }
      yield { type: "text_delta", content: "mock hook result", messageId: "msg1" }
      yield { type: "text_done", messageId: "msg1" }
      yield { type: "message_stop", messageId: "msg1" }
      yield { type: "result", content: "mock hook result", sessionId: "sess-hook" }
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

describe("WorkflowEngine hooks", () => {
  const mockProvider = makeMockProvider()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("executes on_node_failure bash hook when a node fails", async () => {
    const executeFn = vi.fn().mockResolvedValue(makeCompletedResult({ status: "failed", logLines: ["command failed"] }))
    vi.mocked(BashExecutor).mockImplementation((node: any) => ({
      execute: executeFn,
    } as any))

    const workflow: WorkflowDef = {
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "hook-fail-test",
      execution_mode: "serial",
      hooks: {
        on_node_failure: [
          { id: "notify-hook", type: "bash", bash: "echo 'node failed'" },
        ],
      },
      nodes: [
        { id: "step1", type: "bash", bash: "false" },
      ],
    }

    const engine = new WorkflowEngine(workflow, { "claude": mockProvider }, "/tmp/test")
    const result = await engine.run()

    expect(result.status).toBe("failed")
    // BashExecutor is called twice: once for step1, once for the hook
    expect(vi.mocked(BashExecutor)).toHaveBeenCalledTimes(2)
    // The hook should have been instantiated with the hook's node definition
    const hookCall = vi.mocked(BashExecutor).mock.calls[1]
    expect(hookCall[0].id).toBe("notify-hook")
    expect(hookCall[0].type).toBe("bash")
  })

  it("executes on_node_success bash hook when a node succeeds", async () => {
    const executeFn = vi.fn().mockResolvedValue(makeCompletedResult())
    vi.mocked(BashExecutor).mockImplementation(() => ({
      execute: executeFn,
    } as any))

    const workflow: WorkflowDef = {
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "hook-success-test",
      execution_mode: "serial",
      hooks: {
        on_node_success: [
          { id: "success-hook", type: "bash", bash: "echo 'node succeeded'" },
        ],
      },
      nodes: [
        { id: "step1", type: "bash", bash: "echo done" },
      ],
    }

    const engine = new WorkflowEngine(workflow, { "claude": mockProvider }, "/tmp/test")
    const result = await engine.run()

    expect(result.status).toBe("completed")
    // BashExecutor is called twice: once for step1, once for the hook
    expect(vi.mocked(BashExecutor)).toHaveBeenCalledTimes(2)
    const hookCall = vi.mocked(BashExecutor).mock.calls[1]
    expect(hookCall[0].id).toBe("success-hook")
  })

  it("respects nodes filter -- only triggers for matching node IDs", async () => {
    const executeFn = vi.fn().mockResolvedValue(makeCompletedResult())
    vi.mocked(BashExecutor).mockImplementation(() => ({
      execute: executeFn,
    } as any))

    const workflow: WorkflowDef = {
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "hook-filter-test",
      execution_mode: "serial",
      hooks: {
        on_node_success: [
          { id: "filtered-hook", type: "bash", bash: "echo filtered", nodes: ["step2"] },
        ],
      },
      nodes: [
        { id: "step1", type: "bash", bash: "echo first" },
        { id: "step2", type: "bash", bash: "echo second", depends_on: ["step1"] },
      ],
    }

    const engine = new WorkflowEngine(workflow, { "claude": mockProvider }, "/tmp/test")
    const result = await engine.run()

    expect(result.status).toBe("completed")
    // BashExecutor is called 3 times: step1, step2, and hook (only for step2)
    expect(vi.mocked(BashExecutor)).toHaveBeenCalledTimes(3)
    // First call: step1 (no hook triggered)
    expect(vi.mocked(BashExecutor).mock.calls[0][0].id).toBe("step1")
    // Second call: step2
    expect(vi.mocked(BashExecutor).mock.calls[1][0].id).toBe("step2")
    // Third call: the hook (triggered only for step2)
    expect(vi.mocked(BashExecutor).mock.calls[2][0].id).toBe("filtered-hook")
  })

  it("hook failure does not affect main workflow status", async () => {
    const executeFn = vi.fn()
      .mockResolvedValueOnce(makeCompletedResult()) // step1 succeeds
      .mockRejectedValueOnce(new Error("hook exploded")) // hook fails

    vi.mocked(BashExecutor).mockImplementation(() => ({
      execute: executeFn,
    } as any))

    const workflow: WorkflowDef = {
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "hook-error-test",
      execution_mode: "serial",
      hooks: {
        on_node_success: [
          { id: "bad-hook", type: "bash", bash: "exit 1" },
        ],
      },
      nodes: [
        { id: "step1", type: "bash", bash: "echo ok" },
      ],
    }

    const engine = new WorkflowEngine(workflow, { "claude": mockProvider }, "/tmp/test")
    const result = await engine.run()

    // Workflow should still complete successfully despite hook failure
    expect(result.status).toBe("completed")
  })

  it("does not execute hooks when workflow has no hooks defined", async () => {
    const executeFn = vi.fn().mockResolvedValue(makeCompletedResult())
    vi.mocked(BashExecutor).mockImplementation(() => ({
      execute: executeFn,
    } as any))

    const workflow: WorkflowDef = {
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "no-hooks-test",
      execution_mode: "serial",
      nodes: [
        { id: "step1", type: "bash", bash: "echo hello" },
      ],
    }

    const engine = new WorkflowEngine(workflow, { "claude": mockProvider }, "/tmp/test")
    const result = await engine.run()

    expect(result.status).toBe("completed")
    // BashExecutor is called only once for step1 (no hooks)
    expect(vi.mocked(BashExecutor)).toHaveBeenCalledTimes(1)
  })

  it("cleans up $hook.* variables after hook execution", async () => {
    let poolSnapshotAfterHook: Record<string, any> = {}

    const executeFn = vi.fn()
      .mockImplementationOnce(async function () {
        // step1 execution
        return makeCompletedResult()
      })
      .mockImplementationOnce(async function () {
        // hook execution - capture pool state during hook
        return makeCompletedResult()
      })

    vi.mocked(BashExecutor).mockImplementation(() => ({
      execute: executeFn,
    } as any))

    const workflow: WorkflowDef = {
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "hook-cleanup-test",
      execution_mode: "serial",
      hooks: {
        on_node_success: [
          { id: "cleanup-hook", type: "bash", bash: "echo $hook.event" },
        ],
      },
      nodes: [
        { id: "step1", type: "bash", bash: "echo done" },
      ],
    }

    const engine = new WorkflowEngine(workflow, { "claude": mockProvider }, "/tmp/test")
    const result = await engine.run()

    expect(result.status).toBe("completed")
    // After the workflow completes, $hook.* variables should be cleaned up
    const hookKeys = Object.keys(result.poolSnapshot).filter((k) => k.startsWith("hook."))
    expect(hookKeys).toHaveLength(0)
  })
})
