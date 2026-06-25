import { describe, it, expect, beforeEach } from "vitest"
import { WorkflowEngine } from "../engine"
import type { WorkflowDef, NodeDef } from "@octopus/shared"
import { VarPool } from "@octopus/shared"

function createTestWorkflow(nodes: NodeDef[]): WorkflowDef {
  return {
    id: "test-wf",
    name: "Test Workflow",
    nodes,
    edges: nodes.length > 1
      ? [{ id: "e1", from: nodes[0].id, to: nodes[1].id }]
      : [],
  }
}

describe("WorkflowEngine pause/resume", () => {
  let engine: WorkflowEngine

  beforeEach(() => {
    engine = new WorkflowEngine(
      createTestWorkflow([{ id: "n1", type: "bash", script: "echo hi" }]),
      {},
      process.cwd()
    )
  })

  describe("pauseAtNode", () => {
    it("sets pausedAt to the specified node", () => {
      engine.pauseAtNode("n1")
      expect(engine.resumeFromPause()).toBe("n1")
    })

    it("resumeFromPause clears pausedAt", () => {
      engine.pauseAtNode("n1")
      engine.resumeFromPause()
      expect(engine.resumeFromPause()).toBeNull()
    })
  })

  describe("pending_approval vs paused separation", () => {
    it("pending_approval does not set pausedAt via setNodeResult", () => {
      const wf = createTestWorkflow([
        { id: "n1", type: "bash", script: "echo hi" },
        { id: "n2", type: "approval", options: [{ label: "OK", value: "ok" }] },
      ])
      const e = new WorkflowEngine(wf, {}, process.cwd())
      e.setNodeResult("n1", { status: "completed" as const } as any)
      e.setNodeResult("n2", { status: "pending_approval" as const } as any)
      expect(e.resumeFromPause()).toBeNull()
    })

    it("isPaused and isPendingApproval return correct values", () => {
      expect(engine.isPaused()).toBe(false)
      expect(engine.isPendingApproval()).toBe(false)
      engine.pauseAtNode("n1")
      expect(engine.isPaused()).toBe(true)
      expect(engine.isPendingApproval()).toBe(false)
    })
  })
})
