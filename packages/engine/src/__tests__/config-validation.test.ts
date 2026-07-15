import { describe, it, expect } from "vitest"
import { AgentExecutor } from "../executors/agent"
import { SwarmExecutor } from "../executors/swarm"
import { LoopExecutor } from "../executors/loop"
import { BashExecutor } from "../executors/bash"
import { ApprovalExecutor } from "../executors/approval"
import { PythonExecutor } from "../executors/python"
import { VarPool } from "@octopus/shared"
import type { NodeDef } from "@octopus/shared"

const node: NodeDef = { id: "test", type: "bash", bash: "echo hi" }
const pool = new VarPool()

describe("Config validation — AgentConfig", () => {
  it("accepts minimal valid AgentConfig", () => {
    const mockRunner = { run: async () => ({}) } as any
    const executor = new AgentExecutor(node, pool, { runner: mockRunner })
    expect(executor).toBeDefined()
  })

  it("AgentConfig with all optional fields", () => {
    const mockRunner = { run: async () => ({}) } as any
    const executor = new AgentExecutor(node, pool, {
      runner: mockRunner,
      signal: undefined,
      engineContext: undefined,
      loopContext: { iteration: 1 },
      providerKey: "claude",
      workflowName: "test",
      modelAliasConfig: undefined,
    })
    expect(executor).toBeDefined()
  })
})

describe("Config validation — SwarmConfig", () => {
  it("accepts minimal valid SwarmConfig", () => {
    const executor = new SwarmExecutor(node, pool, { providers: {}, cwd: "/tmp" })
    expect(executor).toBeDefined()
  })

  it("SwarmConfig accepts all optional fields", () => {
    const executor = new SwarmExecutor(node, pool, {
      providers: { claude: {} as any },
      cwd: "/tmp",
      callbacks: undefined,
      logger: undefined,
      checkpointStore: undefined,
      executionId: "test-exec",
      modelAliasConfig: undefined,
      workflowEngine: "claude",
      agentResolver: undefined,
      engineHookFn: undefined,
    })
    expect(executor).toBeDefined()
  })
})

describe("Config validation — LoopConfig", () => {
  it("accepts minimal LoopConfig", () => {
    const executor = new LoopExecutor(node, pool, { providers: {}, cwd: "/tmp" })
    expect(executor).toBeDefined()
  })

  it("accepts LoopConfig with ResumeConfig", () => {
    const executor = new LoopExecutor(node, pool, { providers: {}, cwd: "/tmp" }, {
      resumeIteration: 3,
      resumeFromNodeId: "guess",
      innerNodeOverrides: new Map(),
    })
    expect(executor).toBeDefined()
  })
})

describe("Config validation — Leaf executors", () => {
  it("BashExecutor accepts empty config", () => {
    const executor = new BashExecutor(node, pool)
    expect(executor).toBeDefined()
  })

  it("BashExecutor accepts config with options", () => {
    const executor = new BashExecutor(node, pool, { signal: undefined, cwd: "/tmp" })
    expect(executor).toBeDefined()
  })

  it("ApprovalExecutor accepts empty config", () => {
    const executor = new ApprovalExecutor(node, pool)
    expect(executor).toBeDefined()
  })

  it("ApprovalExecutor accepts config with userChoice", () => {
    const executor = new ApprovalExecutor(node, pool, { userChoice: "approve" })
    expect(executor).toBeDefined()
  })

  it("PythonExecutor accepts empty config", () => {
    const pyNode: NodeDef = { id: "test", type: "python", python: "print('hi')" }
    const executor = new PythonExecutor(pyNode, pool)
    expect(executor).toBeDefined()
  })
})
