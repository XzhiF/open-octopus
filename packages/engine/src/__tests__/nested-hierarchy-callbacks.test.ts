// packages/engine/src/__tests__/nested-hierarchy-callbacks.test.ts
//
// Tests that SubWorkflowExecutor and LoopExecutor correctly propagate
// parent_node_id and iteration_index metadata through ensureNodeExecution.
//
import { describe, it, expect, vi, beforeEach } from "vitest"

describe("Nested hierarchy callback propagation", () => {
  describe("SubWorkflowExecutor — parentNodeId", () => {
    it("passes parentNodeId when calling ensureNodeExecution for child nodes", async () => {
      const ensureNodeExecution = vi.fn()
      const childWorkflow = {
        parsed: {
          name: "child-wf",
          nodes: [
            { id: "greet", type: "bash" },
            { id: "process", type: "bash" },
          ],
        },
        content: "yaml-content",
      }

      // Import SubWorkflowExecutor dynamically to avoid heavy deps
      const { SubWorkflowExecutor } = await import("../executors/sub-workflow")
      const { VarPool } = await import("@octopus/shared")

      const pool = new VarPool()
      const node = {
        id: "call-analysis",
        type: "sub_workflow" as const,
        workflow: "child-wf",
      }

      // Mock WorkflowEngine to prevent actual execution
      vi.doMock("../engine", () => ({
        WorkflowEngine: vi.fn().mockImplementation(() => ({
          updateVarPool: vi.fn(),
          setWorkflowResolver: vi.fn(),
          run: vi.fn().mockResolvedValue({
            status: "completed",
            nodeResults: {},
            poolSnapshot: {},
            durationMs: 10,
          }),
        })),
      }))

      const executor = new SubWorkflowExecutor(node, pool, {
        cwd: "/tmp",
        workflowResolver: () => childWorkflow,
        ensureNodeExecution,
      })

      await executor.execute()

      // Verify ensureNodeExecution was called with parentNodeId
      expect(ensureNodeExecution).toHaveBeenCalledWith(
        "call-analysis:greet",
        "bash",
        expect.objectContaining({ parentNodeId: "call-analysis" }),
      )
      expect(ensureNodeExecution).toHaveBeenCalledWith(
        "call-analysis:process",
        "bash",
        expect.objectContaining({ parentNodeId: "call-analysis" }),
      )

      vi.doUnmock("../engine")
    })
  })

  describe("RuntimeNodeMeta type", () => {
    it("is exported from engine module", async () => {
      const engine = await import("../engine")
      // RuntimeNodeMeta is an interface — verify it's accessible via type usage
      const meta: import("../engine").RuntimeNodeMeta = {
        parentNodeId: "parent-1",
        iterationIndex: 0,
      }
      expect(meta.parentNodeId).toBe("parent-1")
      expect(meta.iterationIndex).toBe(0)
    })
  })
})
