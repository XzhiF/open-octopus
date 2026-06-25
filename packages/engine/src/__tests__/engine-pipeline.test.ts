import { describe, it, expect, vi, beforeEach } from "vitest"
import { WorkflowEngine } from "../engine"
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

function makeWorkflow(nodes: any[]): WorkflowDef {
  return {
    apiVersion: "octopus/v1",
    kind: "Workflow",
    name: "test-pipeline",
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

describe("Engine + Pipeline Retry", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("retries failed bash node and succeeds on second attempt", async () => {
    const workflow = makeWorkflow([{ id: "flaky", type: "bash", bash: "exit 1" }])
    let callCount = 0
    vi.mocked(BashExecutor).mockImplementation(function(this: any) {
      this.execute = async () => {
        callCount++
        if (callCount < 2) return { outputs: {}, status: "failed" as const, durationMs: 50, logLines: ["exit 1"], exitCode: 1 }
        return { outputs: {}, status: "completed" as const, durationMs: 50, logLines: ["ok"], exitCode: 0 }
      }
    } as any)
    const retryEvents: Array<{ attempt: number }> = []
    const engine = new WorkflowEngine(workflow, {}, "/tmp", undefined, {
      onNodeRetry: (_: string, attempt: number) => retryEvents.push({ attempt }),
    })
    engine.setPipelineConfig(makePipelineConfig())
    const result = await engine.run()
    expect(result.status).toBe("completed")
    expect(callCount).toBe(2)
    expect(retryEvents).toHaveLength(1)
  })

  it("fails after max_attempts exhausted", async () => {
    const workflow = makeWorkflow([{ id: "always-fail", type: "bash", bash: "exit 1" }])
    vi.mocked(BashExecutor).mockImplementation(function(this: any) {
      this.execute = async () => ({ outputs: {}, status: "failed" as const, durationMs: 50, logLines: ["fail"], exitCode: 1 })
    } as any)
    const engine = new WorkflowEngine(workflow, {}, "/tmp")
    engine.setPipelineConfig(makePipelineConfig({
      retry: {
        default: { max_attempts: 2, backoff: { type: "fixed", initial_delay: 0, multiplier: 1, increment: 0, max_delay: 0 }, max_total_duration: 0, retry_on: ["exit_code_nonzero"], never_retry_on: ["user_cancelled"] },
        overrides: {},
      },
    }))
    const result = await engine.run()
    expect(result.status).toBe("failed")
  })

  it("does not retry when max_attempts is 1", async () => {
    const workflow = makeWorkflow([{ id: "no-retry", type: "bash", bash: "exit 1" }])
    let callCount = 0
    vi.mocked(BashExecutor).mockImplementation(function(this: any) {
      this.execute = async () => {
        callCount++
        return { outputs: {}, status: "failed" as const, durationMs: 50, logLines: ["fail"], exitCode: 1 }
      }
    } as any)
    const engine = new WorkflowEngine(workflow, {}, "/tmp")
    // No pipeline config set → no retry
    const result = await engine.run()
    expect(result.status).toBe("failed")
    expect(callCount).toBe(1)
  })
})

describe("Engine + Pipeline Failure Strategy", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("continue: failed node → downstream skipped → completed_with_failures", async () => {
    const workflow: WorkflowDef = {
      apiVersion: "octopus/v1", kind: "Workflow", name: "test-continue",
      execution_mode: "serial",
      nodes: [
        { id: "step-a", type: "bash", bash: "exit 1" },
        { id: "step-b", type: "bash", bash: "echo ok" },
        { id: "step-c", type: "bash", bash: "echo ok", depends_on: ["step-a"] },
      ],
    }
    let callCount = 0
    vi.mocked(BashExecutor).mockImplementation(function(this: any) {
      this.execute = async () => {
        callCount++
        // First 3 calls fail (step-a retries), subsequent calls succeed (step-b)
        if (callCount <= 3) return { outputs: {}, status: "failed" as const, durationMs: 50, logLines: ["fail"], exitCode: 1 }
        return { outputs: {}, status: "completed" as const, durationMs: 50, logLines: ["ok"], exitCode: 0 }
      }
    } as any)
    const engine = new WorkflowEngine(workflow, {}, "/tmp")
    engine.setPipelineConfig(makePipelineConfig({ execution: { failure_strategy: "continue", timeout: 86400, max_concurrent: 0, resume_on_interrupt: "manual", auto_resume_max_attempts: 3, auto_resume_delay: 10, pending_resume_timeout: 600 } }))
    const result = await engine.run()
    expect(result.status).toBe("completed_with_failures")
    expect(result.nodeResults["step-a"].status).toBe("failed")
    expect(result.nodeResults["step-b"].status).toBe("completed")
    expect(result.nodeResults["step-c"].status).toBe("skipped")
  })

  it("skip: failed node → downstream skipped_failed → completed_with_failures", async () => {
    const workflow: WorkflowDef = {
      apiVersion: "octopus/v1", kind: "Workflow", name: "test-skip",
      execution_mode: "serial",
      nodes: [
        { id: "step-a", type: "bash", bash: "exit 1" },
        { id: "step-b", type: "bash", bash: "echo ok", depends_on: ["step-a"] },
        { id: "step-c", type: "bash", bash: "echo ok" },
      ],
    }
    let callCount = 0
    vi.mocked(BashExecutor).mockImplementation(function(this: any) {
      this.execute = async () => {
        callCount++
        // First 3 calls fail (step-a retries), subsequent calls succeed (step-c)
        if (callCount <= 3) return { outputs: {}, status: "failed" as const, durationMs: 50, logLines: ["fail"], exitCode: 1 }
        return { outputs: {}, status: "completed" as const, durationMs: 50, logLines: ["ok"], exitCode: 0 }
      }
    } as any)
    const engine = new WorkflowEngine(workflow, {}, "/tmp")
    engine.setPipelineConfig(makePipelineConfig({ execution: { failure_strategy: "skip", timeout: 86400, max_concurrent: 0, resume_on_interrupt: "manual", auto_resume_max_attempts: 3, auto_resume_delay: 10, pending_resume_timeout: 600 } }))
    const result = await engine.run()
    expect(result.status).toBe("completed_with_failures")
    expect(result.nodeResults["step-a"].status).toBe("failed")
    expect(result.nodeResults["step-b"].status).toBe("skipped_failed")
    expect(result.nodeResults["step-c"].status).toBe("completed")
  })
})
