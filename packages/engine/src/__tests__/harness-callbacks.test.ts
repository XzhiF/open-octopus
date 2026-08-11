import { describe, it, expect, vi, beforeEach } from "vitest"
import { WorkflowEngine, type EngineCallbacks } from "../engine"
import type { WorkflowDef, PipelineConfig } from "@octopus/shared"

vi.mock("../executors/bash")
vi.mock("../executors/python")
vi.mock("../executors/condition")
vi.mock("../executors/approval")
vi.mock("../executors/loop")
vi.mock("../executors/agent")
vi.mock("../executors/agent-runner")
vi.mock("../logger")

import { BashExecutor } from "../executors/bash"
import { AgentExecutor } from "../executors/agent"

function makeWorkflow(nodes: any[]): WorkflowDef {
  return {
    apiVersion: "octopus/v1",
    kind: "Workflow",
    name: "test-harness-callbacks",
    execution_mode: "serial",
    nodes,
  }
}

function makePipelineConfig(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    apiVersion: "octopus/v1",
    kind: "Pipeline",
    execution: {
      failure_strategy: "fail_fast",
      timeout: 86400,
      max_concurrent: 0,
      resume_on_interrupt: "manual",
      auto_resume_max_attempts: 3,
      auto_resume_delay: 10,
      pending_resume_timeout: 600,
    },
    retry: {
      default: {
        max_attempts: 3,
        backoff: { type: "fixed", initial_delay: 0, multiplier: 2, increment: 0, max_delay: 0 },
        max_total_duration: 0,
        retry_on: ["exit_code_nonzero", "timeout", "agent_stream_error", "transient_error"],
        never_retry_on: ["approval_rejected", "user_cancelled", "config_error"],
      },
      overrides: {},
    },
    fork: { path_strategy: "all", merge_strategy: "wait_all", failure_handling: "fail_all" },
    checkpoint: { enabled: false, save_on: "per-node", max_checkpoints: 10, ttl: 86400, max_size_bytes: 1048576 },
    ...overrides,
  }
}

/** Pipeline config with max_attempts: 1 so failures propagate immediately to executeNodesSequential. */
function makeNoRetryPipelineConfig(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return makePipelineConfig({
    retry: {
      default: {
        max_attempts: 1,
        backoff: { type: "fixed", initial_delay: 0, multiplier: 1, increment: 0, max_delay: 0 },
        max_total_duration: 0,
        retry_on: [],
        never_retry_on: [],
      },
      overrides: {},
    },
    ...overrides,
  })
}

describe("Harness Callbacks — onBeforeNode", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("skip: node is skipped when onBeforeNode returns 'skip'", async () => {
    const workflow = makeWorkflow([
      { id: "node-a", type: "bash", bash: "echo hello" },
    ])
    const executeMock = vi.fn().mockResolvedValue({ outputs: {}, status: "completed" as const, durationMs: 10, logLines: ["ok"] })
    vi.mocked(BashExecutor).mockImplementation(function (this: any) {
      this.execute = executeMock
    } as any)

    const onBeforeNode = vi.fn().mockResolvedValue({ action: "skip" })
    const onNodeEnd = vi.fn()
    const callbacks: EngineCallbacks = { onBeforeNode, onNodeEnd }

    const engine = new WorkflowEngine(workflow, {}, "/tmp", undefined, callbacks)
    const result = await engine.run()

    // execute() should never have been called (constructor is called by createExecutor, but not execute)
    expect(executeMock).not.toHaveBeenCalled()
    // onBeforeNode was called with correct args
    expect(onBeforeNode).toHaveBeenCalledWith("node-a", "bash", expect.objectContaining({ id: "node-a" }))
    // onNodeEnd should be called with "skipped"
    expect(onNodeEnd).toHaveBeenCalledWith("node-a", "skipped", 0, expect.anything(), "bash")
    // Overall workflow completes successfully (skipped is not a failure)
    expect(result.status).toBe("completed")
    // Node result should show skipped
    expect(result.nodeResults["node-a"].status).toBe("skipped")
  })

  it("override: returns overrideResult when onBeforeNode returns 'override'", async () => {
    const workflow = makeWorkflow([
      { id: "node-a", type: "bash", bash: "echo hello" },
    ])
    const executeMock = vi.fn().mockResolvedValue({ outputs: {}, status: "completed" as const, durationMs: 10, logLines: ["ok"] })
    vi.mocked(BashExecutor).mockImplementation(function (this: any) {
      this.execute = executeMock
    } as any)

    const overrideResult = {
      outputs: { result: "overridden" },
      status: "completed" as const,
      durationMs: 0,
      logLines: ["Override by harness"],
    }
    const onBeforeNode = vi.fn().mockResolvedValue({ action: "override", overrideResult })
    const callbacks: EngineCallbacks = { onBeforeNode }

    const engine = new WorkflowEngine(workflow, {}, "/tmp", undefined, callbacks)
    const result = await engine.run()

    expect(executeMock).not.toHaveBeenCalled()
    expect(result.nodeResults["node-a"].outputs).toEqual({ result: "overridden" })
    expect(result.status).toBe("completed")
  })

  it("proceed: node executes normally when onBeforeNode returns 'proceed'", async () => {
    const workflow = makeWorkflow([
      { id: "node-a", type: "bash", bash: "echo hello" },
    ])
    vi.mocked(BashExecutor).mockImplementation(function (this: any) {
      this.execute = async () => ({ outputs: { out: "real" }, status: "completed" as const, durationMs: 10, logLines: ["ok"] })
    } as any)

    const onBeforeNode = vi.fn().mockResolvedValue({ action: "proceed" })
    const callbacks: EngineCallbacks = { onBeforeNode }

    const engine = new WorkflowEngine(workflow, {}, "/tmp", undefined, callbacks)
    const result = await engine.run()

    expect(result.nodeResults["node-a"].outputs).toEqual({ out: "real" })
  })
})

describe("Harness Callbacks — onBeforeRetry", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("harnessHint: injects hint into VarPool when onBeforeRetry returns harnessHint", async () => {
    const workflow = makeWorkflow([
      { id: "flaky", type: "bash", bash: "exit 1" },
    ])
    let callCount = 0
    vi.mocked(BashExecutor).mockImplementation(function (this: any) {
      this.execute = async () => {
        callCount++
        if (callCount < 3) return { outputs: {}, status: "failed" as const, durationMs: 50, logLines: ["exit 1"], exitCode: 1 }
        return { outputs: {}, status: "completed" as const, durationMs: 50, logLines: ["ok"], exitCode: 0 }
      }
    } as any)

    const onBeforeRetry = vi.fn().mockResolvedValue({ action: "retry", harnessHint: "Try installing deps first" })
    const callbacks: EngineCallbacks = { onBeforeRetry }

    const engine = new WorkflowEngine(workflow, {}, "/tmp", undefined, callbacks)
    engine.setPipelineConfig(makePipelineConfig())
    const result = await engine.run()

    expect(result.status).toBe("completed")
    expect(onBeforeRetry).toHaveBeenCalled()
    // VarPool should have harness_hint set
    expect(result.poolSnapshot["harness_hint"]).toBe("Try installing deps first")
  })

  it("modelOverride: changes node.model for agent nodes", async () => {
    const workflow = makeWorkflow([
      { id: "agent-node", type: "agent", prompt: "do something", model: "original-model" },
    ])
    let callCount = 0
    vi.mocked(AgentExecutor).mockImplementation(function (this: any) {
      this.execute = async () => {
        callCount++
        if (callCount < 2) return { outputs: {}, status: "failed" as const, durationMs: 50, logLines: ["400 error: vision not supported"] }
        return { outputs: { text: "done" }, status: "completed" as const, durationMs: 50, logLines: ["ok"] }
      }
    } as any)

    let capturedNode: any = null
    const onBeforeRetry = vi.fn().mockResolvedValue({ action: "retry", modelOverride: "vision-model" })
    const onBeforeNode = vi.fn().mockImplementation(async (_nodeId: string, _nodeType: string, nodeConfig: any) => {
      capturedNode = nodeConfig
      return { action: "proceed" }
    })
    const callbacks: EngineCallbacks = { onBeforeRetry, onBeforeNode }

    // Provide a mock provider so ExecutorFactory doesn't throw for agent nodes
    const mockProvider = { query: vi.fn(), supportsTools: true } as any
    const engine = new WorkflowEngine(workflow, { claude: mockProvider }, "/tmp", undefined, callbacks)
    engine.setPipelineConfig(makePipelineConfig())
    const result = await engine.run()

    expect(result.status).toBe("completed")
    expect(onBeforeRetry).toHaveBeenCalledWith("agent-node", 1, expect.anything(), expect.anything())
    // After modelOverride, the node.model should be changed for the next retry
    // The onBeforeNode callback on the retry call should see the updated model
    expect(capturedNode.model).toBe("vision-model")
  })

  it("skip: returns skipped result when onBeforeRetry returns 'skip'", async () => {
    const workflow = makeWorkflow([
      { id: "flaky", type: "bash", bash: "exit 1" },
    ])
    vi.mocked(BashExecutor).mockImplementation(function (this: any) {
      this.execute = async () => ({ outputs: {}, status: "failed" as const, durationMs: 50, logLines: ["exit 1"], exitCode: 1 })
    } as any)

    const onBeforeRetry = vi.fn().mockResolvedValue({ action: "skip" })
    const callbacks: EngineCallbacks = { onBeforeRetry }

    const engine = new WorkflowEngine(workflow, {}, "/tmp", undefined, callbacks)
    engine.setPipelineConfig(makePipelineConfig())
    const result = await engine.run()

    expect(result.nodeResults["flaky"].status).toBe("skipped")
    // Only 1 attempt (first fail + callback says skip, no retry)
    expect(onBeforeRetry).toHaveBeenCalledTimes(1)
  })

  it("abort: aborts and returns failed when onBeforeRetry returns 'abort'", async () => {
    const workflow = makeWorkflow([
      { id: "flaky", type: "bash", bash: "exit 1" },
    ])
    vi.mocked(BashExecutor).mockImplementation(function (this: any) {
      this.execute = async () => ({ outputs: {}, status: "failed" as const, durationMs: 50, logLines: ["exit 1"], exitCode: 1 })
    } as any)

    const onBeforeRetry = vi.fn().mockResolvedValue({ action: "abort" })
    const callbacks: EngineCallbacks = { onBeforeRetry }

    const engine = new WorkflowEngine(workflow, {}, "/tmp", undefined, callbacks)
    engine.setPipelineConfig(makePipelineConfig())
    const result = await engine.run()

    expect(result.nodeResults["flaky"].status).toBe("failed")
    expect(result.status).toBe("failed")
  })

  it("override: returns overrideResult when onBeforeRetry returns 'override'", async () => {
    const workflow = makeWorkflow([
      { id: "flaky", type: "bash", bash: "exit 1" },
    ])
    vi.mocked(BashExecutor).mockImplementation(function (this: any) {
      this.execute = async () => ({ outputs: {}, status: "failed" as const, durationMs: 50, logLines: ["exit 1"], exitCode: 1 })
    } as any)

    const overrideResult = {
      outputs: { fixed: true },
      status: "completed" as const,
      durationMs: 0,
      logLines: ["Fixed by harness"],
    }
    const onBeforeRetry = vi.fn().mockResolvedValue({ action: "override", overrideResult })
    const callbacks: EngineCallbacks = { onBeforeRetry }

    const engine = new WorkflowEngine(workflow, {}, "/tmp", undefined, callbacks)
    engine.setPipelineConfig(makePipelineConfig())
    const result = await engine.run()

    expect(result.status).toBe("completed")
    expect(result.nodeResults["flaky"].outputs).toEqual({ fixed: true })
  })

  it("varPoolPatches: applies patches to VarPool when onBeforeRetry returns varPoolPatches", async () => {
    const workflow = makeWorkflow([
      { id: "flaky", type: "bash", bash: "exit 1" },
    ])
    let callCount = 0
    vi.mocked(BashExecutor).mockImplementation(function (this: any) {
      this.execute = async () => {
        callCount++
        if (callCount < 3) return { outputs: {}, status: "failed" as const, durationMs: 50, logLines: ["exit 1"], exitCode: 1 }
        return { outputs: {}, status: "completed" as const, durationMs: 50, logLines: ["ok"], exitCode: 0 }
      }
    } as any)

    const onBeforeRetry = vi.fn().mockResolvedValue({
      action: "retry",
      varPoolPatches: { PRE_INSTALL: "apt-get install -y jq", FIX_FLAG: "--verbose" },
    })
    const callbacks: EngineCallbacks = { onBeforeRetry }

    const engine = new WorkflowEngine(workflow, {}, "/tmp", undefined, callbacks)
    engine.setPipelineConfig(makePipelineConfig())
    const result = await engine.run()

    expect(result.status).toBe("completed")
    expect(onBeforeRetry).toHaveBeenCalled()
    // VarPool should have the patched variables
    expect(result.poolSnapshot["PRE_INSTALL"]).toBe("apt-get install -y jq")
    expect(result.poolSnapshot["FIX_FLAG"]).toBe("--verbose")
  })
})

describe("Harness Callbacks — onFailureDecision", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("continue: marks partial failure and continues execution", async () => {
    const workflow = makeWorkflow([
      { id: "step-a", type: "bash", bash: "exit 1" },
      { id: "step-b", type: "bash", bash: "echo ok" },
    ])

    let callCount = 0
    vi.mocked(BashExecutor).mockImplementation(function (this: any) {
      this.execute = async () => {
        callCount++
        if (callCount === 1) return { outputs: {}, status: "failed" as const, durationMs: 50, logLines: ["fail"], exitCode: 1 }
        return { outputs: {}, status: "completed" as const, durationMs: 50, logLines: ["ok"] }
      }
    } as any)

    const onFailureDecision = vi.fn().mockResolvedValue({ action: "continue" })
    const callbacks: EngineCallbacks = { onFailureDecision }

    const engine = new WorkflowEngine(workflow, {}, "/tmp", undefined, callbacks)
    // Use no-retry config so failure propagates immediately to executeNodesSequential
    engine.setPipelineConfig(makeNoRetryPipelineConfig({
      execution: {
        failure_strategy: "fail_fast",
        timeout: 86400,
        max_concurrent: 0,
        resume_on_interrupt: "manual",
        auto_resume_max_attempts: 3,
        auto_resume_delay: 10,
        pending_resume_timeout: 600,
      },
    }))
    const result = await engine.run()

    expect(onFailureDecision).toHaveBeenCalledWith("step-a", expect.any(String), "fail_fast")
    expect(result.nodeResults["step-a"].status).toBe("failed")
    expect(result.nodeResults["step-b"].status).toBe("completed")
    expect(result.status).toBe("completed_with_failures")
  })

  it("delegate: pauses engine and returns paused status", async () => {
    const workflow = makeWorkflow([
      { id: "step-a", type: "bash", bash: "exit 1" },
      { id: "step-b", type: "bash", bash: "echo ok" },
    ])
    vi.mocked(BashExecutor).mockImplementation(function (this: any) {
      this.execute = async () => ({ outputs: {}, status: "failed" as const, durationMs: 50, logLines: ["fail"], exitCode: 1 })
    } as any)

    const onFailureDecision = vi.fn().mockResolvedValue({ action: "delegate" })
    const callbacks: EngineCallbacks = { onFailureDecision }

    const engine = new WorkflowEngine(workflow, {}, "/tmp", undefined, callbacks)
    // Use no-retry config so failure propagates immediately to executeNodesSequential
    engine.setPipelineConfig(makeNoRetryPipelineConfig({
      execution: {
        failure_strategy: "fail_fast",
        timeout: 86400,
        max_concurrent: 0,
        resume_on_interrupt: "manual",
        auto_resume_max_attempts: 3,
        auto_resume_delay: 10,
        pending_resume_timeout: 600,
      },
    }))
    const result = await engine.run()

    expect(onFailureDecision).toHaveBeenCalledWith("step-a", expect.any(String), "fail_fast")
    expect(result.status).toBe("paused")
    // step-b should not have been executed
    expect(result.nodeResults["step-b"]).toBeUndefined()
  })

  it("override: replaces failed result with overrideResult when onFailureDecision returns 'override'", async () => {
    const workflow = makeWorkflow([
      { id: "step-a", type: "bash", bash: "exit 1" },
      { id: "step-b", type: "bash", bash: "echo ok" },
    ])

    let callCount = 0
    vi.mocked(BashExecutor).mockImplementation(function (this: any) {
      this.execute = async () => {
        callCount++
        if (callCount === 1) return { outputs: {}, status: "failed" as const, durationMs: 50, logLines: ["fail"], exitCode: 1 }
        return { outputs: {}, status: "completed" as const, durationMs: 50, logLines: ["ok"] }
      }
    } as any)

    const overrideResult = {
      status: "completed",
      outputs: { report: "generated by harness agent" },
      exitCode: 0,
    }
    const onFailureDecision = vi.fn().mockResolvedValue({ action: "override", overrideResult })
    const callbacks: EngineCallbacks = { onFailureDecision }

    const engine = new WorkflowEngine(workflow, {}, "/tmp", undefined, callbacks)
    engine.setPipelineConfig(makeNoRetryPipelineConfig({
      execution: {
        failure_strategy: "fail_fast",
        timeout: 86400,
        max_concurrent: 0,
        resume_on_interrupt: "manual",
        auto_resume_max_attempts: 3,
        auto_resume_delay: 10,
        pending_resume_timeout: 600,
      },
    }))
    const result = await engine.run()

    expect(onFailureDecision).toHaveBeenCalledWith("step-a", expect.any(String), "fail_fast")
    // step-a should be marked as completed with override outputs
    expect(result.nodeResults["step-a"].status).toBe("completed")
    expect(result.nodeResults["step-a"].outputs).toEqual({ report: "generated by harness agent" })
    // step-b should execute normally after override
    expect(result.nodeResults["step-b"].status).toBe("completed")
    // Overall execution should complete successfully
    expect(result.status).toBe("completed")
  })
})

describe("Harness Callbacks — backward compatibility", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("engine runs normally when no harness callbacks are provided", async () => {
    const workflow = makeWorkflow([
      { id: "node-a", type: "bash", bash: "echo hello" },
      { id: "node-b", type: "bash", bash: "echo world", depends_on: ["node-a"] },
    ])
    vi.mocked(BashExecutor).mockImplementation(function (this: any) {
      this.execute = async () => ({ outputs: {}, status: "completed" as const, durationMs: 10, logLines: ["ok"] })
    } as any)

    // No harness callbacks at all — just existing callbacks
    const onNodeStart = vi.fn()
    const callbacks: EngineCallbacks = { onNodeStart }

    const engine = new WorkflowEngine(workflow, {}, "/tmp", undefined, callbacks)
    const result = await engine.run()

    expect(result.status).toBe("completed")
    expect(onNodeStart).toHaveBeenCalledTimes(2)
    expect(result.nodeResults["node-a"].status).toBe("completed")
    expect(result.nodeResults["node-b"].status).toBe("completed")
  })

  it("engine runs normally with no callbacks at all", async () => {
    const workflow = makeWorkflow([
      { id: "node-a", type: "bash", bash: "echo hello" },
    ])
    vi.mocked(BashExecutor).mockImplementation(function (this: any) {
      this.execute = async () => ({ outputs: {}, status: "completed" as const, durationMs: 10, logLines: ["ok"] })
    } as any)

    const engine = new WorkflowEngine(workflow, {}, "/tmp")
    const result = await engine.run()

    expect(result.status).toBe("completed")
    expect(result.nodeResults["node-a"].status).toBe("completed")
  })

  it("retry works normally when onBeforeRetry is not provided", async () => {
    const workflow = makeWorkflow([
      { id: "flaky", type: "bash", bash: "exit 1" },
    ])
    let callCount = 0
    vi.mocked(BashExecutor).mockImplementation(function (this: any) {
      this.execute = async () => {
        callCount++
        if (callCount < 2) return { outputs: {}, status: "failed" as const, durationMs: 50, logLines: ["exit 1"], exitCode: 1 }
        return { outputs: {}, status: "completed" as const, durationMs: 50, logLines: ["ok"], exitCode: 0 }
      }
    } as any)

    const engine = new WorkflowEngine(workflow, {}, "/tmp")
    engine.setPipelineConfig(makePipelineConfig())
    const result = await engine.run()

    expect(result.status).toBe("completed")
    expect(callCount).toBe(2)
  })
})
