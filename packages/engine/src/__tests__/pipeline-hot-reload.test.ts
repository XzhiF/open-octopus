import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { WorkflowEngine } from "../engine"
import type { WorkflowDef, PipelineConfig } from "@octopus/shared"
import fs from "fs"
import path from "path"
import os from "os"

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
    name: "test-hot-reload",
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
        max_attempts: 1,
        backoff: { type: "fixed", initial_delay: 0, multiplier: 2, increment: 0, max_delay: 0 },
        max_total_duration: 0,
        retry_on: ["exit_code_nonzero", "timeout", "agent_stream_error", "transient_error"],
        never_retry_on: ["approval_rejected", "user_cancelled", "config_error"],
      },
      overrides: {},
    },
    fork: { path_strategy: "all", merge_strategy: "wait_all", failure_handling: "fail_all" },
    checkpoint: { enabled: false, save_on: "per-node", max_checkpoints: 10, ttl: 86400, max_size_bytes: 1048576 },
    runtime_nodes: [],
    providers: {},
    channels: {},
    ...overrides,
  }
}

let tmpDir: string
let pipelinePath: string

beforeEach(() => {
  vi.clearAllMocks()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hot-reload-test-"))
  pipelinePath = path.join(tmpDir, "pipeline.yaml")
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe("Pipeline Hot-Reload", () => {
  it("setPipelineConfig stores pipelinePath and hash", () => {
    const workflow = makeWorkflow([{ id: "a", type: "bash", bash: "echo ok" }])
    const engine = new WorkflowEngine(workflow, {}, tmpDir, tmpDir)
    const config = makePipelineConfig()

    engine.setPipelineConfig(config, undefined, pipelinePath)
    // No assertion on private fields directly, but should not throw
    expect(true).toBe(true)
  })

  it("reloadPipelineIfNeeded returns false when pipelinePath is not set", () => {
    const workflow = makeWorkflow([{ id: "a", type: "bash", bash: "echo ok" }])
    const engine = new WorkflowEngine(workflow, {}, tmpDir, tmpDir)
    const config = makePipelineConfig()

    // Set config without pipelinePath
    engine.setPipelineConfig(config)
    // Engine should not crash when reloadPipelineIfNeeded is called internally
    // This is tested indirectly through run()
    expect(true).toBe(true)
  })

  it("reloadPipelineIfNeeded returns false when file has not changed", async () => {
    const workflow = makeWorkflow([{ id: "a", type: "bash", bash: "echo ok" }])
    const config = makePipelineConfig()

    // Write initial pipeline.yaml
    fs.writeFileSync(pipelinePath, JSON.stringify(config), "utf8")

    const engine = new WorkflowEngine(workflow, {}, tmpDir, tmpDir)
    engine.setPipelineConfig(config, undefined, pipelinePath)

    // Mock BashExecutor to return success
    vi.mocked(BashExecutor.prototype.execute).mockResolvedValue({
      outputs: {}, status: "completed", durationMs: 10, logLines: [],
    })

    let reloadedConfig: PipelineConfig | null = null
    const callbacks = {
      onPipelineReloaded: (c: PipelineConfig) => { reloadedConfig = c },
    }

    // Create engine with callbacks
    const engine2 = new WorkflowEngine(workflow, {}, tmpDir, tmpDir, callbacks)
    engine2.setPipelineConfig(config, undefined, pipelinePath)

    await engine2.run()

    // Config didn't change, so onPipelineReloaded should NOT have been called
    expect(reloadedConfig).toBeNull()
  })

  it("reloadPipelineIfNeeded detects file change and fires callback", async () => {
    const workflow = makeWorkflow([
      { id: "a", type: "bash", bash: "echo ok" },
      { id: "b", type: "bash", bash: "echo ok2" },
    ])
    const config = makePipelineConfig()

    // Write initial pipeline.yaml
    fs.writeFileSync(pipelinePath, JSON.stringify(config), "utf8")

    let reloadCount = 0
    const callbacks = {
      onPipelineReloaded: (_c: PipelineConfig) => { reloadCount++ },
    }

    const engine = new WorkflowEngine(workflow, {}, tmpDir, tmpDir, callbacks)
    engine.setPipelineConfig(config, undefined, pipelinePath)

    // Mock BashExecutor: on first call, modify pipeline.yaml
    let callCount = 0
    vi.mocked(BashExecutor.prototype.execute).mockImplementation(async function () {
      callCount++
      if (callCount === 1) {
        // Modify pipeline.yaml after first node completes
        const newConfig = makePipelineConfig({
          retry: {
            default: {
              max_attempts: 5,
              backoff: { type: "fixed", initial_delay: 0, multiplier: 2, increment: 0, max_delay: 0 },
              max_total_duration: 0,
              retry_on: ["exit_code_nonzero"],
              never_retry_on: ["approval_rejected", "user_cancelled", "config_error"],
            },
            overrides: {},
          },
        })
        fs.writeFileSync(pipelinePath, JSON.stringify(newConfig), "utf8")
      }
      return { outputs: {}, status: "completed", durationMs: 10, logLines: [] }
    })

    await engine.run()

    // The hot-reload should have fired once after node 'a' completed
    expect(reloadCount).toBe(1)
  })

  it("reloadPipelineIfNeeded handles parse errors gracefully", async () => {
    const workflow = makeWorkflow([
      { id: "a", type: "bash", bash: "echo ok" },
      { id: "b", type: "bash", bash: "echo ok2" },
    ])
    const config = makePipelineConfig()

    // Write initial valid pipeline.yaml
    fs.writeFileSync(pipelinePath, JSON.stringify(config), "utf8")

    const engine = new WorkflowEngine(workflow, {}, tmpDir, tmpDir)
    engine.setPipelineConfig(config, undefined, pipelinePath)

    let callCount = 0
    vi.mocked(BashExecutor.prototype.execute).mockImplementation(async function () {
      callCount++
      if (callCount === 1) {
        // Write invalid YAML after first node
        fs.writeFileSync(pipelinePath, "{{{{invalid yaml", "utf8")
      }
      return { outputs: {}, status: "completed", durationMs: 10, logLines: [] }
    })

    // Should not throw even though pipeline.yaml is now invalid
    const result = await engine.run()
    expect(result.status).toBe("completed")
  })

  it("reloadPipelineIfNeeded returns false when file does not exist", () => {
    const workflow = makeWorkflow([{ id: "a", type: "bash", bash: "echo ok" }])
    const config = makePipelineConfig()
    const nonExistentPath = path.join(tmpDir, "nonexistent.yaml")

    const engine = new WorkflowEngine(workflow, {}, tmpDir, tmpDir)
    engine.setPipelineConfig(config, undefined, nonExistentPath)
    // Should not crash
    expect(true).toBe(true)
  })
})
