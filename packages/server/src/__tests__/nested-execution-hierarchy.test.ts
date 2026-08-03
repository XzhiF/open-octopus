// packages/server/src/__tests__/nested-execution-hierarchy.test.ts
//
// Integration tests for parent_node_id and iteration_index columns in node_executions.
// Verifies that nested execution hierarchy metadata is correctly populated.
//
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../db/schema"
import { ExecutionDAO } from "../db/dao/execution-dao"

describe("Nested execution hierarchy — DB columns", () => {
  let db: Database.Database
  let dao: ExecutionDAO
  const execId = "test-exec-001"

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    dao = new ExecutionDAO(db)
    // Create workspace first (FK constraint)
    db.prepare(`
      INSERT INTO workspaces (id, name, org, path, created_at, updated_at)
      VALUES ('ws-1', 'Test Workspace', 'default', '/tmp/test', datetime('now'), datetime('now'))
    `).run()
    // Create parent execution
    dao.insertExecution({
      id: execId,
      workspace_id: "ws-1",
      org: "default",
      workflow_ref: "test-wf",
      workflow_name: "Test Workflow",
      status: "running",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
  })

  afterEach(() => {
    db.close()
  })

  describe("Schema: new columns exist", () => {
    it("has parent_node_id column on node_executions", () => {
      const cols = db.prepare("PRAGMA table_info(node_executions)").all() as { name: string }[]
      expect(cols.some(c => c.name === "parent_node_id")).toBe(true)
    })

    it("has iteration_index column on node_executions", () => {
      const cols = db.prepare("PRAGMA table_info(node_executions)").all() as { name: string }[]
      expect(cols.some(c => c.name === "iteration_index")).toBe(true)
    })
  })

  describe("insertNodeExecution: accepts new columns", () => {
    it("inserts with parent_node_id and iteration_index", () => {
      dao.insertNodeExecution({
        id: `${execId}-child1`,
        execution_id: execId,
        node_id: "call-wf:child1",
        node_type: "bash",
        status: "pending",
        parent_node_id: "call-wf",
        iteration_index: 0,
      })

      const row = dao.findNodeExecution(execId, "call-wf:child1")
      expect(row).not.toBeNull()
      expect(row!.parent_node_id).toBe("call-wf")
      expect(row!.iteration_index).toBe(0)
    })

    it("inserts with null parent_node_id and iteration_index (backward compat)", () => {
      dao.insertNodeExecution({
        id: `${execId}-step1`,
        execution_id: execId,
        node_id: "step1",
        node_type: "bash",
        status: "pending",
      })

      const row = dao.findNodeExecution(execId, "step1")
      expect(row).not.toBeNull()
      expect(row!.parent_node_id).toBeNull()
      expect(row!.iteration_index).toBeNull()
    })
  })

  describe("insertNodeExecutionOrIgnore: accepts new columns", () => {
    it("inserts with parent_node_id and iteration_index", () => {
      dao.insertNodeExecutionOrIgnore({
        id: `${execId}-scoped:child`,
        execution_id: execId,
        node_id: "scoped:child",
        node_type: "bash",
        status: "pending",
        parent_node_id: "scoped",
        iteration_index: 2,
      })

      const row = dao.findNodeExecution(execId, "scoped:child")
      expect(row).not.toBeNull()
      expect(row!.parent_node_id).toBe("scoped")
      expect(row!.iteration_index).toBe(2)
    })

    it("ignores duplicate inserts", () => {
      dao.insertNodeExecutionOrIgnore({
        id: `${execId}-dup`,
        execution_id: execId,
        node_id: "dup",
        node_type: "bash",
        status: "pending",
        parent_node_id: "parent1",
      })
      // Second insert should be ignored
      dao.insertNodeExecutionOrIgnore({
        id: `${execId}-dup`,
        execution_id: execId,
        node_id: "dup",
        node_type: "bash",
        status: "running",
        parent_node_id: "parent2",
      })

      const row = dao.findNodeExecution(execId, "dup")
      expect(row!.parent_node_id).toBe("parent1") // First insert wins
    })
  })

  describe("updateNodeExecution: allows new columns", () => {
    it("updates parent_node_id", () => {
      dao.insertNodeExecution({
        id: `${execId}-upd1`,
        execution_id: execId,
        node_id: "upd1",
        node_type: "bash",
        status: "pending",
      })

      dao.updateNodeExecution(`${execId}-upd1`, { parent_node_id: "new-parent" })

      const row = dao.findNodeExecution(execId, "upd1")
      expect(row!.parent_node_id).toBe("new-parent")
    })

    it("updates iteration_index", () => {
      dao.insertNodeExecution({
        id: `${execId}-upd2`,
        execution_id: execId,
        node_id: "upd2",
        node_type: "bash",
        status: "pending",
      })

      dao.updateNodeExecution(`${execId}-upd2`, { iteration_index: 3 })

      const row = dao.findNodeExecution(execId, "upd2")
      expect(row!.iteration_index).toBe(3)
    })
  })

  describe("Scenario: sub-workflow children have parent_node_id", () => {
    it("simulates sub-workflow with 3 child nodes", () => {
      // Pre-create parent node
      dao.insertNodeExecution({
        id: `${execId}-call-analysis`,
        execution_id: execId,
        node_id: "call-analysis",
        node_type: "sub_workflow",
        status: "running",
      })

      // Simulate onRuntimeNodeAdded for child nodes (with parent meta)
      const childNodes = [
        { id: "call-analysis:greet", type: "bash" },
        { id: "call-analysis:process", type: "agent" },
        { id: "call-analysis:summarize", type: "bash" },
      ]

      for (const child of childNodes) {
        dao.insertNodeExecutionOrIgnore({
          id: `${execId}-${child.id}`,
          execution_id: execId,
          node_id: child.id,
          node_type: child.type,
          status: "pending",
          parent_node_id: "call-analysis",
        })
      }

      // Verify all children have parent_node_id
      const allNodes = dao.findNodeExecutions(execId)
      const children = allNodes.filter(n => n.node_id.includes(":"))
      expect(children).toHaveLength(3)
      for (const child of children) {
        expect(child.parent_node_id).toBe("call-analysis")
        expect(child.iteration_index).toBeNull()
      }
    })
  })

  describe("Scenario: loop inner nodes have iteration_index", () => {
    it("simulates loop with 3 iterations", () => {
      // Pre-create loop node
      dao.insertNodeExecution({
        id: `${execId}-review-loop`,
        execution_id: execId,
        node_id: "review-loop",
        node_type: "loop",
        status: "running",
      })

      // Simulate 3 iterations of inner node "prep"
      for (let i = 0; i < 3; i++) {
        dao.insertNodeExecutionOrIgnore({
          id: `${execId}-prep-iter-${i}`,
          execution_id: execId,
          node_id: `prep-iter-${i}`,
          node_type: "bash",
          status: "completed",
          iteration_index: i,
        })
      }

      const allNodes = dao.findNodeExecutions(execId)
      const iterNodes = allNodes.filter(n => n.node_id.startsWith("prep-iter-"))
      expect(iterNodes).toHaveLength(3)
      expect(iterNodes.map(n => n.iteration_index)).toEqual([0, 1, 2])
    })
  })

  describe("Scenario: loop containing sub-workflow", () => {
    it("simulates loop with sub-workflow children having both parent_node_id and iteration_index", () => {
      // Pre-create loop and sub-workflow nodes
      dao.insertNodeExecution({
        id: `${execId}-review-loop`,
        execution_id: execId,
        node_id: "review-loop",
        node_type: "loop",
        status: "running",
      })
      dao.insertNodeExecution({
        id: `${execId}-call-analysis`,
        execution_id: execId,
        node_id: "call-analysis",
        node_type: "sub_workflow",
        status: "running",
      })

      // Simulate 2 iterations, each with a sub-workflow child
      for (let i = 0; i < 2; i++) {
        dao.insertNodeExecutionOrIgnore({
          id: `${execId}-call-analysis:process-iter-${i}`,
          execution_id: execId,
          node_id: `call-analysis:process-iter-${i}`,
          node_type: "bash",
          status: "completed",
          parent_node_id: "call-analysis",
          iteration_index: i,
        })
      }

      const allNodes = dao.findNodeExecutions(execId)
      const childNodes = allNodes.filter(n => n.node_id.includes(":"))
      expect(childNodes).toHaveLength(2)
      for (const child of childNodes) {
        expect(child.parent_node_id).toBe("call-analysis")
        expect(child.iteration_index).not.toBeNull()
      }
      expect(childNodes.map(n => n.iteration_index)).toEqual([0, 1])
    })
  })

  describe("Scenario: 3-layer sub-workflow nesting", () => {
    it("simulates A → B → C nesting with parent chain", () => {
      // Layer A: root node
      dao.insertNodeExecution({
        id: `${execId}-call-b`,
        execution_id: execId,
        node_id: "call-b",
        node_type: "sub_workflow",
        status: "running",
      })

      // Layer B: child of A
      dao.insertNodeExecutionOrIgnore({
        id: `${execId}-call-b:call-c`,
        execution_id: execId,
        node_id: "call-b:call-c",
        node_type: "sub_workflow",
        status: "running",
        parent_node_id: "call-b",
      })

      // Layer C: child of B
      dao.insertNodeExecutionOrIgnore({
        id: `${execId}-call-b:call-c:leaf`,
        execution_id: execId,
        node_id: "call-b:call-c:leaf",
        node_type: "bash",
        status: "completed",
        parent_node_id: "call-b:call-c",
      })

      // Verify parent chain
      const leafNode = dao.findNodeExecution(execId, "call-b:call-c:leaf")
      expect(leafNode!.parent_node_id).toBe("call-b:call-c")

      const middleNode = dao.findNodeExecution(execId, "call-b:call-c")
      expect(middleNode!.parent_node_id).toBe("call-b")

      const rootNode = dao.findNodeExecution(execId, "call-b")
      expect(rootNode!.parent_node_id).toBeNull() // root has no parent
    })
  })

  describe("Backward compatibility: existing queries handle nulls", () => {
    it("findNodeExecutions returns rows with null new columns", () => {
      dao.insertNodeExecution({
        id: `${execId}-old-node`,
        execution_id: execId,
        node_id: "old-node",
        node_type: "bash",
        status: "completed",
      })

      const rows = dao.findNodeExecutions(execId)
      expect(rows.length).toBeGreaterThanOrEqual(1)
      const oldNode = rows.find(r => r.node_id === "old-node")
      expect(oldNode).toBeDefined()
      expect(oldNode!.parent_node_id).toBeNull()
      expect(oldNode!.iteration_index).toBeNull()
    })
  })
})
