import { describe, it, expect, expectTypeOf } from "vitest"
import {
  workflowConfigSchema,
  projectSpecSchema,
  taskSpecSchema,
  type WorkflowConfig,
  type ScheduleStatus,
} from "../types/scheduler-job"

// Independent source of truth for the new terminal statuses (spec G2).
const EXPECTED_TERMINAL_STATUSES = ["failed", "aborted"] as const

const baseWorkspaceSpec = {
  org: "xzf",
  branch_prefix: "feat",
  projects: [{ name: "proj-a", source_path: "", group: "" }],
}

// ── AC2: ScheduleStatus includes terminal failed/aborted ────────────
describe("ScheduleStatus includes terminal failed/aborted (G2)", () => {
  it("'failed' is a valid ScheduleStatus (type-level)", () => {
    expectTypeOf<ScheduleStatus>().toMatchTypeOf<"failed">()
    const s: ScheduleStatus = "failed"
    expect(s).toBe("failed")
  })

  it("'aborted' is a valid ScheduleStatus (type-level)", () => {
    expectTypeOf<ScheduleStatus>().toMatchTypeOf<"aborted">()
    const s: ScheduleStatus = "aborted"
    expect(s).toBe("aborted")
  })

  it("every expected terminal status is a member of the ScheduleStatus union", () => {
    // Fixture is the independent source of truth; if a status is removed from
    // the ScheduleStatus type, the typed assignment below fails tsc.
    const all: ScheduleStatus[] = [
      "draft",
      "queued",
      "claimed",
      "running",
      "done",
      "failed",
      "aborted",
    ]
    for (const t of EXPECTED_TERMINAL_STATUSES) {
      expect(all).toContain(t)
    }
  })
})

// ── TaskSpec schema ─────────────────────────────────────────────────
describe("taskSpecSchema", () => {
  it("parses a simple task spec (goal + ac only)", () => {
    const result = taskSpecSchema.safeParse({ goal: "do thing", ac: ["done"] })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.goal).toBe("do thing")
    }
  })

  // task-phase-redesign ticket 01 (K13): goal/ac became OPTIONAL at the schema
  // level so v4 payloads (phases-only) parse. v3 enforcement is NOT lost — it
  // moved to the format-branched ready gate (server, ticket 04: missing goal/ac
  // still blocks a non-v4 spec). The min(1) constraint still applies when the
  // key is present.
  it("accepts task spec missing goal (v4 relaxation — schema level only)", () => {
    const result = taskSpecSchema.safeParse({ ac: ["done"] })
    expect(result.success).toBe(true)
  })

  it("rejects task spec with empty ac", () => {
    const result = taskSpecSchema.safeParse({ goal: "g", ac: [] })
    expect(result.success).toBe(false)
  })
})

// ── AC1 + AC5: workflowConfigSchema v3.0 + v2.0 compat ──────────────
describe("workflowConfigSchema v3.0 + task_spec (AC1, AC5)", () => {
  it("parses a v3.0 config WITH task_spec (AC1)", () => {
    const result = workflowConfigSchema.safeParse({
      schema_version: "3.0",
      type: "workflow",
      workspace_spec: baseWorkspaceSpec,
      workflow_chain: [{ workflow_ref: "flows/compose.yaml", input_values: {} }],
      max_retain: 5,
      task_spec: {
        goal: "Build feature X",
        ac: ["AC1: implement it", "AC2: integration passes"],
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.schema_version).toBe("3.0")
      expect(result.data.task_spec?.goal).toBe("Build feature X")
    }
  })

  it("parses a v2.0 config WITHOUT task_spec — backward compat (AC5)", () => {
    const result = workflowConfigSchema.safeParse({
      schema_version: "2.0",
      type: "workflow",
      workspace_spec: baseWorkspaceSpec,
      workflow_chain: [{ workflow_ref: "flows/simple.yaml", input_values: {} }],
      max_retain: 10,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.schema_version).toBe("2.0")
      expect(result.data.task_spec).toBeUndefined()
    }
  })

  it("WorkflowConfig type allows schema_version '2.0' and '3.0' (type-level)", () => {
    const v2: WorkflowConfig = {
      schema_version: "2.0",
      type: "workflow",
      workspace_spec: { org: "o", branch_prefix: "b", projects: [] },
      workflow_chain: [],
      max_retain: 1,
    }
    const v3: WorkflowConfig = {
      schema_version: "3.0",
      type: "workflow",
      workspace_spec: { org: "o", branch_prefix: "b", projects: [] },
      workflow_chain: [],
      max_retain: 1,
      task_spec: { goal: "g", ac: ["a"], resources: [], authoring_resources: [], skill_groups: [], decisions: [], ac_confirmed: [] },
    }
    expect(v2.schema_version).toBe("2.0")
    expect(v3.schema_version).toBe("3.0")
  })
})

// ── projectSpecSchema: group retained ────────────────────────────────
describe("projectSpecSchema group retained (G8)", () => {
  it("accepts a project with group", () => {
    const result = projectSpecSchema.safeParse({
      name: "proj-a",
      source_path: "",
      group: "backend",
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.group).toBe("backend")
    }
  })

  it("defaults group to empty string", () => {
    const result = projectSpecSchema.safeParse({ name: "proj-a", source_path: "" })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.group).toBe("")
    }
  })
})
