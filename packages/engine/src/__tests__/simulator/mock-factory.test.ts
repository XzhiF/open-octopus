import { describe, it, expect } from "vitest"
import { VarPool } from "@octopus/shared"
import type { NodeDef } from "@octopus/shared"
import { SimulatorExecutorFactory } from "../../simulator/mock-factory"
import { MockAgentExecutor } from "../../simulator/mock-executors"
import { ConditionExecutor } from "../../executors/condition"

function makeNode(id: string, type: string): NodeDef {
  return { id, type: type as any }
}

describe("SimulatorExecutorFactory", () => {
  it("returns MockAgentExecutor for agent nodes", () => {
    const pool = new VarPool()
    const factory = new SimulatorExecutorFactory(
      { "agent-1": { output: "hello" } },
      pool,
      {},
    )
    const executor = factory.createExecutor(makeNode("agent-1", "agent"))
    expect(executor).toBeInstanceOf(MockAgentExecutor)
  })

  it("returns ConditionExecutor for condition nodes (real)", () => {
    const pool = new VarPool()
    const factory = new SimulatorExecutorFactory({}, pool, {})
    const node: NodeDef = {
      id: "cond-1",
      type: "condition",
      cases: [{ when: "default", then: "next" }],
    }
    const executor = factory.createExecutor(node)
    expect(executor).toBeInstanceOf(ConditionExecutor)
  })

  it("throws in strict mode when mock is missing", () => {
    const pool = new VarPool()
    const factory = new SimulatorExecutorFactory({}, pool, {}, { strict: true })
    expect(() => factory.createExecutor(makeNode("agent-1", "agent"))).toThrow("Strict mode")
  })

  it("auto-passes in non-strict mode when mock is missing", async () => {
    const pool = new VarPool()
    const factory = new SimulatorExecutorFactory({}, pool, {}, { strict: false })
    const executor = factory.createExecutor(makeNode("agent-1", "agent"))
    const result = await executor.execute()
    expect(result.status).toBe("completed")
    expect(result.logLines[0]).toContain("auto-passed")
  })

  it("throws for real_execution on non-bash/python nodes", () => {
    const pool = new VarPool()
    const factory = new SimulatorExecutorFactory(
      { "agent-1": {} },
      pool,
      {},
      { realExecution: ["agent-1"] },
    )
    expect(() => factory.createExecutor(makeNode("agent-1", "agent"))).toThrow(
      "Only bash/python",
    )
  })

  it("returns MockAgentExecutor for swarm nodes", () => {
    const pool = new VarPool()
    const factory = new SimulatorExecutorFactory(
      { "swarm-1": { output: "consensus" } },
      pool,
      {},
    )
    const executor = factory.createExecutor(makeNode("swarm-1", "swarm"))
    // Swarm uses MockSwarmExecutor, not MockAgentExecutor
    expect(executor.constructor.name).toBe("MockSwarmExecutor")
  })

  it("returns MockBashExecutor for bash nodes", () => {
    const pool = new VarPool()
    const factory = new SimulatorExecutorFactory(
      { "bash-1": { output: "result" } },
      pool,
      {},
    )
    const executor = factory.createExecutor(makeNode("bash-1", "bash"))
    expect(executor.constructor.name).toBe("MockBashExecutor")
  })

  it("returns MockApprovalExecutor for approval nodes", () => {
    const pool = new VarPool()
    const factory = new SimulatorExecutorFactory(
      { "approval-1": { choice: "approve" } },
      pool,
      {},
    )
    const executor = factory.createExecutor(makeNode("approval-1", "approval"))
    expect(executor.constructor.name).toBe("MockApprovalExecutor")
  })
})
