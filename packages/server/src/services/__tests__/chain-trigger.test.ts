// packages/server/src/services/__tests__/chain-trigger.test.ts
// TC-035/036/037/038/039: Tests for ChainTrigger (evaluateAndTrigger)
import { describe, it, expect, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { ExecutionDAO } from "../../db/dao/execution-dao"
import { ChainTrigger } from "../chain-trigger"
import { evaluateExpression } from "@octopus/shared"
import { randomUUID } from "crypto"
import { readFileSync } from "fs"
import { resolve } from "path"

// Mock evaluateExpression from @octopus/shared.
// The real implementation expects a VarPool instance as the second argument,
// but ChainTrigger passes a plain Record<string, unknown> (poolSnapshot).
//
// ChainTrigger uses evaluateExpression in two contexts:
//   1. Condition evaluation: expects a truthy/falsy result
//   2. Input mapping resolution: expects the actual resolved value (or throw on missing)
//
// This mock returns the actual resolved value for $vars.xxx references
// and throws when the variable is missing from the pool, which triggers
// resolveInputMapping's catch block to fall back to "".
vi.mock("@octopus/shared", async () => {
  const actual = await vi.importActual<typeof import("@octopus/shared")>(
    "@octopus/shared",
  )
  return {
    ...actual,
    evaluateExpression: vi.fn(
      (expr: string, pool: Record<string, unknown>): unknown => {
        if (expr.trim() === "default") return true

        // For $vars.xxx references, return/throw based on pool contents
        const varsMatch = expr.match(/^\$vars\.([a-zA-Z0-9_]+)$/)
        if (varsMatch) {
          const key = varsMatch[1]
          if (!(key in pool)) {
            throw new Error(`Variable not found: ${key}`)
          }
          return pool[key]
        }

        // For other expressions, resolve $vars.xxx inline and evaluate
        let resolved = expr
        resolved = resolved.replace(
          /\$vars\.([a-zA-Z0-9_]+)/g,
          (_match: string, key: string) => {
            const val = pool[key]
            if (val === undefined || val === null) return "null"
            if (typeof val === "string") return JSON.stringify(val)
            return String(val)
          },
        )
        try {
          const fn = new Function(`return (${resolved})`)
          return Boolean(fn())
        } catch {
          return false
        }
      },
    ),
  }
})

const SCHEMA_SQL = readFileSync(resolve(__dirname, "../../db/schema.sql"), "utf-8")

function createTestDb(): Database.Database {
  const db = new Database(":memory:")
  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")
  db.exec(SCHEMA_SQL)
  return db
}

const WS_ID = "ws-chain-test"
const ORG = "test-org"

/** Seed a workspace row so execution FK references are satisfied. */
function seedWorkspace(db: Database.Database): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT OR IGNORE INTO workspaces
      (id, name, org, description, status, path, created_at, updated_at, source)
     VALUES (?, ?, ?, NULL, 'active', ?, ?, ?, 'user')`,
  ).run(WS_ID, "Chain Test Workspace", ORG, `/tmp/${WS_ID}`, now, now)
}

/** Seed an execution row with optional parent_id for chain depth tests. */
function seedExecution(
  db: Database.Database,
  opts: {
    id: string
    parent_id?: string
    status?: string
    child_index?: number
  },
): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO executions
      (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name,
       status, org, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    WS_ID,
    opts.parent_id ?? "0",
    opts.child_index ?? 0,
    "test-wf",
    "Test Workflow",
    opts.status ?? "completed",
    ORG,
    now,
    now,
  )
}

describe("ChainTrigger", () => {
  let db: Database.Database
  let executionDAO: ExecutionDAO
  let createExecution: ReturnType<typeof vi.fn>
  let chainTrigger: ChainTrigger

  beforeEach(() => {
    db = createTestDb()
    seedWorkspace(db)
    executionDAO = new ExecutionDAO(db)
    createExecution = vi.fn().mockResolvedValue(randomUUID())
    chainTrigger = new ChainTrigger(executionDAO, createExecution)
    // Clear mock history between tests (vi.mock is module-scoped)
    createExecution.mockClear()
    vi.mocked(evaluateExpression)?.mockClear?.()
  })

  // ── TC-035: on_success chain ────────────────────────────────────────

  describe("on_success chain", () => {
    it("TC-035: triggers on_success workflow when execution completes", async () => {
      const executionId = randomUUID()
      seedExecution(db, { id: executionId, status: "completed" })

      const workflowDef = {
        chain: {
          on_success: [{ workflow: "bug-fixer" }],
        },
      }

      await chainTrigger.evaluateAndTrigger(
        workflowDef,
        executionId,
        "completed",
        { confirmed: "true" },
        WS_ID,
      )

      expect(createExecution).toHaveBeenCalledTimes(1)
      expect(createExecution).toHaveBeenCalledWith(WS_ID, {
        workflow_ref: "bug-fixer",
        parent_id: executionId,
        input_values: {},
        triggered_by: "chain",
      })
    })

    it("does not trigger on_success when execution fails", async () => {
      const executionId = randomUUID()
      seedExecution(db, { id: executionId, status: "failed" })

      const workflowDef = {
        chain: {
          on_success: [{ workflow: "bug-fixer" }],
        },
      }

      await chainTrigger.evaluateAndTrigger(
        workflowDef,
        executionId,
        "failed",
        {},
        WS_ID,
      )

      expect(createExecution).not.toHaveBeenCalled()
    })
  })

  // ── TC-036: on_failure chain ────────────────────────────────────────

  describe("on_failure chain", () => {
    it("TC-036: triggers on_failure workflow when execution fails", async () => {
      const executionId = randomUUID()
      seedExecution(db, { id: executionId, status: "failed" })

      const workflowDef = {
        chain: {
          on_failure: [{ workflow: "error-notifier" }],
        },
      }

      await chainTrigger.evaluateAndTrigger(
        workflowDef,
        executionId,
        "failed",
        {},
        WS_ID,
      )

      expect(createExecution).toHaveBeenCalledTimes(1)
      expect(createExecution).toHaveBeenCalledWith(WS_ID, {
        workflow_ref: "error-notifier",
        parent_id: executionId,
        input_values: {},
        triggered_by: "chain",
      })
    })

    it("does not trigger on_failure when execution succeeds", async () => {
      const executionId = randomUUID()
      seedExecution(db, { id: executionId, status: "completed" })

      const workflowDef = {
        chain: {
          on_failure: [{ workflow: "error-notifier" }],
        },
      }

      await chainTrigger.evaluateAndTrigger(
        workflowDef,
        executionId,
        "completed",
        {},
        WS_ID,
      )

      expect(createExecution).not.toHaveBeenCalled()
    })
  })

  // ── TC-037: MAX_CHAIN_DEPTH ─────────────────────────────────────────

  describe("MAX_CHAIN_DEPTH", () => {
    it("TC-037: blocks chain triggering when depth exceeds limit of 5", async () => {
      // Build a chain: E0 (root, parent='0') → E1 → E2 → E3 → E4 → E5 → E6
      // calculateChainDepth(E6) walks up 6 levels, exceeding the limit of 5.
      // (Need 7 executions for depth 6, since depth counts parent hops, not nodes.)
      const ids: string[] = []
      for (let i = 0; i < 7; i++) {
        const id = randomUUID()
        seedExecution(db, {
          id,
          parent_id: i === 0 ? "0" : ids[i - 1],
          child_index: i,
        })
        ids.push(id)
      }

      const deepestId = ids[6]

      const workflowDef = {
        chain: {
          on_success: [{ workflow: "should-not-trigger" }],
        },
      }

      await chainTrigger.evaluateAndTrigger(
        workflowDef,
        deepestId,
        "completed",
        {},
        WS_ID,
      )

      // Depth 6 > 5, so createExecution must NOT be called
      expect(createExecution).not.toHaveBeenCalled()
    })

    it("allows chain triggering when depth is exactly at the limit", async () => {
      // E0 → E1 → E2 → E3 → E4 → E5: depth of E5 = 5, which is NOT > 5
      const ids: string[] = []
      for (let i = 0; i < 6; i++) {
        const id = randomUUID()
        seedExecution(db, {
          id,
          parent_id: i === 0 ? "0" : ids[i - 1],
          child_index: i,
        })
        ids.push(id)
      }

      const workflowDef = {
        chain: {
          on_success: [{ workflow: "next-step" }],
        },
      }

      await chainTrigger.evaluateAndTrigger(
        workflowDef,
        ids[5],
        "completed",
        {},
        WS_ID,
      )

      expect(createExecution).toHaveBeenCalledTimes(1)
      expect(createExecution).toHaveBeenCalledWith(WS_ID, {
        workflow_ref: "next-step",
        parent_id: ids[5],
        input_values: {},
        triggered_by: "chain",
      })
    })
  })

  // ── TC-038: resolveInputMapping with missing vars ───────────────────

  describe("resolveInputMapping", () => {
    it("TC-038: falls back to empty string when variable does not exist in pool", async () => {
      const executionId = randomUUID()
      seedExecution(db, { id: executionId })

      const workflowDef = {
        chain: {
          on_success: [
            {
              workflow: "downstream-wf",
              input_mapping: {
                data: "$vars.nonexistent",
              },
            },
          ],
        },
      }

      // Pool has 'existing' but NOT 'nonexistent'
      await chainTrigger.evaluateAndTrigger(
        workflowDef,
        executionId,
        "completed",
        { existing: "value" },
        WS_ID,
      )

      expect(createExecution).toHaveBeenCalledTimes(1)
      const callArgs = createExecution.mock.calls[0]
      expect(callArgs[0]).toBe(WS_ID)
      expect(callArgs[1].workflow_ref).toBe("downstream-wf")
      expect(callArgs[1].parent_id).toBe(executionId)
      // $vars.nonexistent is not in the pool → evaluateExpression returns undefined → fallback to ""
      expect(callArgs[1].input_values.data).toBe("")
    })

    it("resolves existing variables from the pool", async () => {
      const executionId = randomUUID()
      seedExecution(db, { id: executionId })

      const workflowDef = {
        chain: {
          on_success: [
            {
              workflow: "downstream-wf",
              input_mapping: {
                result: "$vars.build_status",
              },
            },
          ],
        },
      }

      await chainTrigger.evaluateAndTrigger(
        workflowDef,
        executionId,
        "completed",
        { build_status: "success" },
        WS_ID,
      )

      expect(createExecution).toHaveBeenCalledTimes(1)
      const callArgs = createExecution.mock.calls[0]
      // $vars.build_status resolves to the actual pool value
      expect(callArgs[1].input_values.result).toBe("success")
    })
  })

  // ── TC-039: Chain position / parent-child relationship ──────────────

  describe("chain parent-child relationships", () => {
    it("TC-039: records correct parent_execution_id in a multi-level chain A->B->C", async () => {
      // Create the chain: A (root) → B (child of A) → C (child of B)
      const idA = randomUUID()
      const idB = randomUUID()
      const idC = randomUUID()

      seedExecution(db, { id: idA, parent_id: "0" })
      seedExecution(db, { id: idB, parent_id: idA, child_index: 1 })
      seedExecution(db, { id: idC, parent_id: idB, child_index: 2 })

      // Verify parent_execution_id relationships in the executions table
      const execA = executionDAO.findById(idA)
      const execB = executionDAO.findById(idB)
      const execC = executionDAO.findById(idC)

      expect(execA!.parent_id).toBe("0")
      expect(execB!.parent_id).toBe(idA)
      expect(execC!.parent_id).toBe(idB)

      // Trigger from C (depth = 2, within limit)
      const newExecId = randomUUID()
      createExecution.mockResolvedValue(newExecId)

      const workflowDef = {
        chain: {
          on_success: [{ workflow: "step-d" }],
        },
      }

      await chainTrigger.evaluateAndTrigger(
        workflowDef,
        idC,
        "completed",
        {},
        WS_ID,
      )

      // createExecution should be called with parent_id = idC
      expect(createExecution).toHaveBeenCalledTimes(1)
      expect(createExecution).toHaveBeenCalledWith(WS_ID, {
        workflow_ref: "step-d",
        parent_id: idC,
        input_values: {},
        triggered_by: "chain",
      })
    })
  })

  // ── Edge cases ──────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("returns early when workflowDef has no chain property", async () => {
      const executionId = randomUUID()
      seedExecution(db, { id: executionId })

      await chainTrigger.evaluateAndTrigger(
        {},
        executionId,
        "completed",
        {},
        WS_ID,
      )

      expect(createExecution).not.toHaveBeenCalled()
    })

    it("returns early when execution is not found in the database", async () => {
      const nonExistentId = randomUUID()

      const workflowDef = {
        chain: {
          on_success: [{ workflow: "something" }],
        },
      }

      await chainTrigger.evaluateAndTrigger(
        workflowDef,
        nonExistentId,
        "completed",
        {},
        WS_ID,
      )

      expect(createExecution).not.toHaveBeenCalled()
    })

    it("triggers on_success for completed_with_failures status", async () => {
      const executionId = randomUUID()
      seedExecution(db, { id: executionId, status: "completed" })

      const workflowDef = {
        chain: {
          on_success: [{ workflow: "cleanup-wf" }],
        },
      }

      await chainTrigger.evaluateAndTrigger(
        workflowDef,
        executionId,
        "completed_with_failures",
        {},
        WS_ID,
      )

      expect(createExecution).toHaveBeenCalledTimes(1)
      expect(createExecution).toHaveBeenCalledWith(WS_ID, {
        workflow_ref: "cleanup-wf",
        parent_id: executionId,
        input_values: {},
        triggered_by: "chain",
      })
    })
  })
})
