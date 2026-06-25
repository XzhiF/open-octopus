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
    name: "test-runtime-nodes",
    execution_mode: "serial",
    nodes,
  }
}

function makePipelineConfig(runtimeNodes: any[] = []): PipelineConfig {
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
    retry: { default: { max_attempts: 1, backoff: { type: "fixed", initial_delay: 1, multiplier: 1, increment: 0, max_delay: 10 }, max_total_duration: 0, retry_on: [], never_retry_on: [] }, overrides: {} },
    fork: { path_strategy: "all", merge_strategy: "wait_all", failure_handling: "fail_all" },
    checkpoint: { enabled: false, save_on: "per-node", max_checkpoints: 10, ttl: 86400, max_size_bytes: 1048576 },
    runtime_nodes: runtimeNodes,
  }
}

describe("Runtime Node Detection and Insertion", () => {
  let onRuntimeNodeAdded: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    onRuntimeNodeAdded = vi.fn()
    const mockBash = BashExecutor as unknown as ReturnType<typeof vi.fn>
    mockBash.mockImplementation(() => ({
      execute: vi.fn().mockResolvedValue({
        outputs: {},
        status: "completed",
        durationMs: 10,
        logLines: [],
      }),
    }))
  })

  it("detects new runtime nodes after a node completes", async () => {
    const workflow = makeWorkflow([
      { id: "build", type: "bash", bash: "echo build" },
      { id: "test", type: "bash", bash: "echo test" },
    ])
    const callbacks = { onRuntimeNodeAdded }
    const engine = new WorkflowEngine(
      workflow, {}, "/tmp", undefined, callbacks, undefined, "exec-test",
    )
    engine.setPipelineConfig(makePipelineConfig([
      { id: "cleanup", type: "bash", bash: "echo cleanup", depends_on: ["test"] },
    ]))

    await engine.run()

    expect(onRuntimeNodeAdded).toHaveBeenCalledWith("cleanup", "bash")
  })

  it("skips runtime nodes that already have results (re-detection)", async () => {
    // After a runtime node is detected and inserted, it should not be re-detected
    // on subsequent node boundaries (tracked via runtimeNodeIds set)
    const workflow = makeWorkflow([
      { id: "build", type: "bash", bash: "echo build" },
      { id: "test", type: "bash", bash: "echo test" },
      { id: "deploy", type: "bash", bash: "echo deploy" },
    ])
    const callbacks = { onRuntimeNodeAdded }
    const engine = new WorkflowEngine(
      workflow, {}, "/tmp", undefined, callbacks, undefined, "exec-test",
    )
    // cleanup depends on build — will be detected after build completes
    engine.setPipelineConfig(makePipelineConfig([
      { id: "cleanup", type: "bash", bash: "echo cleanup", depends_on: ["build"] },
    ]))

    await engine.run()

    // cleanup should be added exactly once (not re-added after test or deploy)
    expect(onRuntimeNodeAdded).toHaveBeenCalledTimes(1)
    expect(onRuntimeNodeAdded).toHaveBeenCalledWith("cleanup", "bash")
  })

  it("skips runtime nodes with invalid depends_on references", async () => {
    const workflow = makeWorkflow([
      { id: "build", type: "bash", bash: "echo build" },
    ])
    const callbacks = { onRuntimeNodeAdded }
    const engine = new WorkflowEngine(
      workflow, {}, "/tmp", undefined, callbacks, undefined, "exec-test",
    )
    engine.setPipelineConfig(makePipelineConfig([
      { id: "deploy", type: "bash", bash: "echo deploy", depends_on: ["nonexistent"] },
    ]))

    await engine.run()

    // deploy has invalid depends_on → should not be added
    expect(onRuntimeNodeAdded).not.toHaveBeenCalled()
  })

  it("does not re-insert already registered runtime nodes", async () => {
    const workflow = makeWorkflow([
      { id: "build", type: "bash", bash: "echo build" },
      { id: "test", type: "bash", bash: "echo test" },
      { id: "deploy", type: "bash", bash: "echo deploy" },
    ])
    const callbacks = { onRuntimeNodeAdded }
    const engine = new WorkflowEngine(
      workflow, {}, "/tmp", undefined, callbacks, undefined, "exec-test",
    )
    engine.setPipelineConfig(makePipelineConfig([
      { id: "notify", type: "bash", bash: "echo notify", depends_on: ["build"] },
    ]))

    await engine.run()

    // notify should be added exactly once
    expect(onRuntimeNodeAdded).toHaveBeenCalledTimes(1)
    expect(onRuntimeNodeAdded).toHaveBeenCalledWith("notify", "bash")
  })

  it("handles multiple runtime nodes", async () => {
    const workflow = makeWorkflow([
      { id: "build", type: "bash", bash: "echo build" },
    ])
    const callbacks = { onRuntimeNodeAdded }
    const engine = new WorkflowEngine(
      workflow, {}, "/tmp", undefined, callbacks, undefined, "exec-test",
    )
    engine.setPipelineConfig(makePipelineConfig([
      { id: "notify", type: "bash", bash: "echo notify", depends_on: ["build"] },
      { id: "cleanup", type: "bash", bash: "echo cleanup", depends_on: ["build"] },
    ]))

    await engine.run()

    expect(onRuntimeNodeAdded).toHaveBeenCalledTimes(2)
  })

  it("no runtime nodes in config means no callbacks", async () => {
    const workflow = makeWorkflow([
      { id: "build", type: "bash", bash: "echo build" },
    ])
    const callbacks = { onRuntimeNodeAdded }
    const engine = new WorkflowEngine(
      workflow, {}, "/tmp", undefined, callbacks, undefined, "exec-test",
    )
    engine.setPipelineConfig(makePipelineConfig([]))

    await engine.run()

    expect(onRuntimeNodeAdded).not.toHaveBeenCalled()
  })
})
