// packages/server/src/__tests__/tasks-v3-ready-inputs.test.ts
//
// task-workflow-presets (T5): ready-gate required inputs validation.
//
// Verifies:
//   AC1: simple v3 task with workflow requiring "idea" input, no input_values
//        → 409 missing includes "input:idea"
//   AC2: simple v3 task with input_values containing ${goal} → resolves → passes
//   AC3: simple v3 task with literal input_values → passes
//   AC4: composite task (subunits >= 2) → skips input check
//   AC5: workflow with no required inputs → no input:<name> in missing

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import Database from "better-sqlite3"
import { Hono } from "hono"
import { applySchema } from "../db/schema"
import { AgentSessionDAO } from "../db/dao"
import { SSEService } from "../services/sse"
import { TasksService } from "../services/tasks/tasks-service"
import { createTasksRoutes } from "../routes/tasks"
import path from "path"
import os from "os"
import fs from "fs"
import { TaskHomeService } from "../services/tasks/task-home-service"

const ORG = "e2e-td-t5"

// A workflow YAML with required + optional inputs for testing
const WORKFLOW_WITH_REQUIRED_INPUTS = `
apiVersion: octopus/v1
kind: Workflow
name: test-flow
inputs:
  idea:
    description: "The idea"
    required: true
  feature:
    description: "Optional feature"
    required: false
    default: ""
`

const WORKFLOW_NO_REQUIRED_INPUTS = `
apiVersion: octopus/v1
kind: Workflow
name: no-required-flow
inputs:
  feature:
    description: "Optional"
    required: false
    default: ""
`

function newDb(): Database.Database {
  const db = new Database(":memory:")
  applySchema(db)
  return db
}

function insertTask(
  db: Database.Database,
  overrides: Partial<{
    id: string
    name: string
    status: string
    task_spec: Record<string, unknown>
    version: number
    workflow_ref: string | null
  }> = {},
) {
  const id = overrides.id ?? `e2e-td-t5-${Math.random().toString(36).slice(2, 8)}`
  const now = new Date().toISOString()
  const spec = overrides.task_spec ?? {
    goal: "E2E_TD goal",
    ac: ["E2E_TD ac1"],
    task_type: "coding",
    goal_confirmed: true,
    ac_confirmed: ["E2E_TD ac1"],
    skill_groups: [],
    decisions: [],
    resources: [],
    authoring_resources: [],
  }
  db.prepare(`
    INSERT INTO tasks (id, org, name, status, source_chat_session_id, task_spec,
      authoring_resources, resources, skills, project_ids, workflow_ref, version,
      deleted_at, created_at, updated_at, completed_at)
    VALUES (?, ?, ?, ?, NULL, ?, '[]', '[]', '[]', '[]', ?, ?, NULL, ?, ?, NULL)
  `).run(
    id,
    ORG,
    overrides.name ?? "E2E_TD task",
    overrides.status ?? "draft",
    JSON.stringify(spec),
    overrides.workflow_ref ?? null,
    overrides.version ?? 1,
    now,
    now,
  )
  return id
}

describe("T5: ready-gate required inputs validation (integration)", () => {
  let db: Database.Database
  let app: Hono
  let tmpDir: string

  beforeAll(() => {
    db = newDb()
    const sse = new SSEService()

    // Create a temp dir for task homes
    tmpDir = path.join(os.tmpdir(), `test-t5-${Date.now()}`)
    fs.mkdirSync(tmpDir, { recursive: true })

    // Stub BuiltInWorkflowService: returns workflow content with required inputs
    // for refs containing "required-flow", and no-required content for "no-required"
    const stubBuiltIn = {
      get(ref: string) {
        if (ref.includes("required-flow")) {
          return { ref, content: WORKFLOW_WITH_REQUIRED_INPUTS }
        }
        if (ref.includes("no-required")) {
          return { ref, content: WORKFLOW_NO_REQUIRED_INPUTS }
        }
        return null
      },
    } as any

    const taskHome = new TaskHomeService(tmpDir)
    const service = new TasksService(
      db, sse, new AgentSessionDAO(db), taskHome, undefined, stubBuiltIn,
    )
    app = new Hono()
    app.route("/api/tasks", createTasksRoutes(service, sse))
  })

  afterAll(() => {
    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("AC1: missing required input → 409 with input:idea in missing", async () => {
    const id = insertTask(db, {
      name: "E2E_TD_missing_input",
      task_spec: {
        goal: "Build something",
        ac: ["works"],
        task_type: "coding",
        goal_confirmed: true,
        ac_confirmed: ["works"],
        skill_groups: [],
        decisions: [],
        resources: [],
        authoring_resources: [],
        // No input_values
      },
      workflow_ref: "built-in/required-flow",
    })

    const res = await app.request(`/api/tasks/${id}/ready`, { method: "POST" })
    expect(res.status).toBe(409)
    const body = await res.json() as { error: string; missing: string[] }
    expect(body.missing).toContain("input:idea")
  })

  it("AC1b: UNKNOWN placeholder ${nope} in input_values → 409 with input:idea (NEVER 500)", async () => {
    // Review fix 2026-08-27: a stray/unknown placeholder must surface as a
    // missing item in the gate (like any other missing input), not a raw throw
    // that 500s the ready request.
    const id = insertTask(db, {
      name: "E2E_TD_unknown_placeholder",
      task_spec: {
        goal: "Build something",
        ac: ["works"],
        task_type: "coding",
        goal_confirmed: true,
        ac_confirmed: ["works"],
        skill_groups: [],
        decisions: [],
        resources: [],
        authoring_resources: [],
        input_values: { idea: "${nope}" },
      },
      workflow_ref: "built-in/required-flow",
    })

    const res = await app.request(`/api/tasks/${id}/ready`, { method: "POST" })
    expect(res.status).toBe(409)
    const body = await res.json() as { error: string; missing: string[] }
    // The unresolved ${nope} key surfaces as a missing input (deduped against the
    // required-empty check), never a 500.
    expect(body.missing).toContain("input:idea")
  })

  it("AC2: ${goal} in input_values resolves → passes input check", async () => {
    const id = insertTask(db, {
      name: "E2E_TD_goal_resolved",
      task_spec: {
        goal: "Build a widget",
        ac: ["works"],
        task_type: "coding",
        goal_confirmed: true,
        ac_confirmed: ["works"],
        skill_groups: [],
        decisions: [],
        resources: [],
        authoring_resources: [],
        input_values: { idea: "${goal}" },
      },
      workflow_ref: "built-in/required-flow",
    })

    const res = await app.request(`/api/tasks/${id}/ready`, { method: "POST" })
    // Should not have input:idea in missing (may still have other issues, but not this)
    if (res.status === 409) {
      const body = await res.json() as { missing: string[] }
      expect(body.missing).not.toContain("input:idea")
    } else {
      expect(res.status).toBe(200)
    }
  })

  it("AC3: literal input_values → passes input check", async () => {
    const id = insertTask(db, {
      name: "E2E_TD_literal",
      task_spec: {
        goal: "Build something",
        ac: ["works"],
        task_type: "coding",
        goal_confirmed: true,
        ac_confirmed: ["works"],
        skill_groups: [],
        decisions: [],
        resources: [],
        authoring_resources: [],
        input_values: { idea: "my literal idea" },
      },
      workflow_ref: "built-in/required-flow",
    })

    const res = await app.request(`/api/tasks/${id}/ready`, { method: "POST" })
    if (res.status === 409) {
      const body = await res.json() as { missing: string[] }
      expect(body.missing).not.toContain("input:idea")
    } else {
      expect(res.status).toBe(200)
    }
  })

  it("AC4: composite task skips input check", async () => {
    const id = insertTask(db, {
      name: "E2E_TD_composite",
      task_spec: {
        goal: "Big task",
        ac: ["works"],
        task_type: "coding",
        goal_confirmed: true,
        ac_confirmed: ["works"],
        skill_groups: [],
        decisions: [],
        resources: [],
        authoring_resources: [],
        // No input_values — would fail for simple task
        subunits: [
          {
            name: "sub1",
            workspace_spec: { org: ORG, branch_prefix: "test", projects: [{ name: "p", source_path: "", group: "" }] },
            workflow_ref: "flow1",
            input_values: {},
            skills: [],
            resources: [],
          },
          {
            name: "sub2",
            workspace_spec: { org: ORG, branch_prefix: "test", projects: [{ name: "p", source_path: "", group: "" }] },
            workflow_ref: "flow2",
            input_values: {},
            skills: [],
            resources: [],
          },
        ],
      },
      // No workflow_ref needed for composite (uses composition-task)
    })

    const res = await app.request(`/api/tasks/${id}/ready`, { method: "POST" })
    // Composite tasks don't check input:<name> — they skip the check entirely
    if (res.status === 409) {
      const body = await res.json() as { missing: string[] }
      expect(body.missing.some(m => m.startsWith("input:"))).toBe(false)
    }
  })

  it("AC5: workflow with no required inputs → no input: missing", async () => {
    const id = insertTask(db, {
      name: "E2E_TD_no_required",
      task_spec: {
        goal: "Simple task",
        ac: ["works"],
        task_type: "coding",
        goal_confirmed: true,
        ac_confirmed: ["works"],
        skill_groups: [],
        decisions: [],
        resources: [],
        authoring_resources: [],
        // No input_values
      },
      workflow_ref: "built-in/no-required",
    })

    const res = await app.request(`/api/tasks/${id}/ready`, { method: "POST" })
    if (res.status === 409) {
      const body = await res.json() as { missing: string[] }
      expect(body.missing.some(m => m.startsWith("input:"))).toBe(false)
    } else {
      expect(res.status).toBe(200)
    }
  })
})
