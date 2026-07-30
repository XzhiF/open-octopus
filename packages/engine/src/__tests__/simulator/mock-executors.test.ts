import { describe, it, expect } from "vitest"
import { VarPool } from "@octopus/shared"
import type { NodeDef } from "@octopus/shared"
import {
  MockAgentExecutor,
  MockSwarmExecutor,
  MockBashExecutor,
  MockPythonExecutor,
  MockApprovalExecutor,
} from "../../simulator/mock-executors"

function makeNode(id: string, type: string): NodeDef {
  return { id, type: type as any }
}

describe("MockAgentExecutor", () => {
  it("returns basic output and outputs", async () => {
    const pool = new VarPool()
    const node = makeNode("agent-1", "agent")
    const executor = new MockAgentExecutor(node, pool, {
      output: "hi",
      outputs: { x: 1 },
    })
    const result = await executor.execute()

    expect(result.status).toBe("completed")
    expect(result.lastOutput).toBe("hi")
    expect(result.outputs.x).toBe(1)
    expect(result.outputs.output).toBe("hi")
  })

  it("writes update_vars to VarPool", async () => {
    const pool = new VarPool()
    const node = makeNode("agent-1", "agent")
    const executor = new MockAgentExecutor(node, pool, {
      update_vars: { score: 0.9 },
    })
    await executor.execute()

    expect(pool.get("score")).toBe(0.9)
  })

  it("returns failed status with error", async () => {
    const pool = new VarPool()
    const node = makeNode("agent-1", "agent")
    const executor = new MockAgentExecutor(node, pool, {
      status: "failed",
      error: "timeout",
    })
    const result = await executor.execute()

    expect(result.status).toBe("failed")
    expect(result.error).toBe("timeout")
  })

  it("substitutes variables in output", async () => {
    const pool = new VarPool({ name: "Alice" })
    const node = makeNode("agent-1", "agent")
    const executor = new MockAgentExecutor(node, pool, {
      output: "$vars.name said hi",
    })
    const result = await executor.execute()

    expect(result.lastOutput).toBe("Alice said hi")
  })

  it("returns completed with empty mock", async () => {
    const pool = new VarPool()
    const node = makeNode("agent-1", "agent")
    const executor = new MockAgentExecutor(node, pool, {})
    const result = await executor.execute()

    expect(result.status).toBe("completed")
    expect(result.lastOutput).toBeUndefined()
  })
})

describe("MockSwarmExecutor", () => {
  it("returns whole swarm output", async () => {
    const pool = new VarPool()
    const node = makeNode("swarm-1", "swarm")
    const executor = new MockSwarmExecutor(node, pool, {
      output: "consensus",
      outputs: { agreed: true },
    })
    const result = await executor.execute()

    expect(result.status).toBe("completed")
    expect(result.lastOutput).toBe("consensus")
    expect(result.outputs.agreed).toBe(true)
  })
})

describe("MockBashExecutor", () => {
  it("returns output with exit_code 0", async () => {
    const pool = new VarPool()
    const node = makeNode("bash-1", "bash")
    const executor = new MockBashExecutor(node, pool, {
      output: "result",
      exit_code: 0,
    })
    const result = await executor.execute()

    expect(result.status).toBe("completed")
    expect(result.lastOutput).toBe("result")
    expect(result.exitCode).toBe(0)
  })

  it("returns failed with exit_code 1", async () => {
    const pool = new VarPool()
    const node = makeNode("bash-1", "bash")
    const executor = new MockBashExecutor(node, pool, {
      status: "failed",
      exit_code: 1,
    })
    const result = await executor.execute()

    expect(result.status).toBe("failed")
    expect(result.exitCode).toBe(1)
  })
})

describe("MockPythonExecutor", () => {
  it("returns python output", async () => {
    const pool = new VarPool()
    const node = makeNode("py-1", "python")
    const executor = new MockPythonExecutor(node, pool, {
      output: "42",
    })
    const result = await executor.execute()

    expect(result.lastOutput).toBe("42")
    expect(result.status).toBe("completed")
  })
})

describe("MockApprovalExecutor", () => {
  it("completes with approve choice", async () => {
    const pool = new VarPool()
    const node = makeNode("approval-1", "approval")
    const executor = new MockApprovalExecutor(node, pool, {
      choice: "approve",
    })
    const result = await executor.execute()

    expect(result.status).toBe("completed")
    expect(result.outputs.choice).toBe("approve")
    expect(result.decision).toBe("approve")
  })

  it("rejects with reject choice", async () => {
    const pool = new VarPool()
    const node = makeNode("approval-1", "approval")
    const executor = new MockApprovalExecutor(node, pool, {
      choice: "reject",
    })
    const result = await executor.execute()

    expect(result.status).toBe("rejected")
  })

  it("includes comment", async () => {
    const pool = new VarPool()
    const node = makeNode("approval-1", "approval")
    const executor = new MockApprovalExecutor(node, pool, {
      choice: "approve",
      comment: "looks good",
    })
    const result = await executor.execute()

    expect(result.comment).toBe("looks good")
  })
})
