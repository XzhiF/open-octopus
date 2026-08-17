import { describe, it, expect, expectTypeOf } from "vitest"
import {
  workflowConfigSchema,
  projectSpecSchema,
  subunitSpecSchema,
  taskSpecSchema,
  integrationGoalSchema,
  type WorkflowConfig,
  type ScheduleStatus,
  type TaskSpec,
  type SubunitSpec,
  type IntegrationGoal,
} from "../types/scheduler-job"
import { NodeSchema, WorkflowSchema, type NodeDef } from "../types/workflow"
import type { TaskDispatchPort, ScheduleHandle } from "../types/task-dispatch-port"

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

// ── SubunitSpec schema ──────────────────────────────────────────────
describe("subunitSpecSchema", () => {
  it("parses a valid subunit with all fields", () => {
    const result = subunitSpecSchema.safeParse({
      name: "backend",
      workspace_spec: baseWorkspaceSpec,
      workflow_ref: "flows/backend.yaml",
      input_values: { goal: "ship it" },
      skills: ["octo-backend"],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.name).toBe("backend")
      expect(result.data.skills).toEqual(["octo-backend"])
      expect(result.data.input_values.goal).toBe("ship it")
    }
  })

  it("defaults skills to [] and input_values to {}", () => {
    const result = subunitSpecSchema.safeParse({
      name: "fe",
      workspace_spec: baseWorkspaceSpec,
      workflow_ref: "flows/fe.yaml",
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.skills).toEqual([])
      expect(result.data.input_values).toEqual({})
    }
  })

  it("rejects subunit missing name", () => {
    const result = subunitSpecSchema.safeParse({
      workspace_spec: baseWorkspaceSpec,
      workflow_ref: "x.yaml",
    })
    expect(result.success).toBe(false)
  })

  it("rejects subunit missing workspace_spec", () => {
    const result = subunitSpecSchema.safeParse({
      name: "solo",
      workflow_ref: "x.yaml",
    })
    expect(result.success).toBe(false)
  })
})

// ── TaskSpec schema ─────────────────────────────────────────────────
describe("taskSpecSchema", () => {
  it("parses a composite task spec with subunits + integration_goal", () => {
    const result = taskSpecSchema.safeParse({
      goal: "Build composite feature",
      ac: ["subunits complete", "integration green"],
      subunits: [
        {
          name: "backend",
          workspace_spec: baseWorkspaceSpec,
          workflow_ref: "flows/backend.yaml",
          input_values: {},
          skills: ["octo-backend"],
        },
      ],
      integration_goal: { strategy: "synthesis" },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.goal).toBe("Build composite feature")
      expect(result.data.ac).toHaveLength(2)
      expect(result.data.subunits?.[0].name).toBe("backend")
      expect(result.data.integration_goal?.strategy).toBe("synthesis")
    }
  })

  it("parses a simple task spec (goal + ac only)", () => {
    const result = taskSpecSchema.safeParse({ goal: "do thing", ac: ["done"] })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.subunits).toBeUndefined()
      expect(result.data.integration_goal).toBeUndefined()
    }
  })

  it("rejects task spec missing goal", () => {
    const result = taskSpecSchema.safeParse({ ac: ["done"] })
    expect(result.success).toBe(false)
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
        ac: ["AC1: subunit A done", "AC2: integration passes"],
        subunits: [
          {
            name: "backend",
            workspace_spec: baseWorkspaceSpec,
            workflow_ref: "flows/backend.yaml",
            input_values: {},
            skills: ["octo-backend"],
          },
        ],
        integration_goal: { strategy: "synthesis" },
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.schema_version).toBe("3.0")
      expect(result.data.task_spec?.goal).toBe("Build feature X")
      expect(result.data.task_spec?.subunits?.[0].name).toBe("backend")
      expect(result.data.task_spec?.integration_goal?.strategy).toBe("synthesis")
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
      task_spec: { goal: "g", ac: ["a"], resources: [], authoring_resources: [] },
    }
    expect(v2.schema_version).toBe("2.0")
    expect(v3.schema_version).toBe("3.0")
  })
})

// ── AC3: task_dispatch node type ─────────────────────────────────────
describe("task_dispatch node type (AC3)", () => {
  it("'task_dispatch' is a member of the NodeDef.type union (type-level)", () => {
    expectTypeOf<"task_dispatch">().toMatchTypeOf<NodeDef["type"]>()
    const node: NodeDef = { id: "dispatch-1", type: "task_dispatch" }
    expect(node.type).toBe("task_dispatch")
  })

  it("NodeSchema parses a task_dispatch node with subunit ref + mappings + await", () => {
    const result = NodeSchema.safeParse({
      id: "dispatch-1",
      type: "task_dispatch",
      workflow_ref: "flows/backend.yaml",
      await: true,
      input_mapping: { goal: "$vars.goal" },
      output_mapping: { result: "$last_output" },
      // subunit is a string reference resolved by the executor from the
      // composition loop iteration / task_spec.subunits.
      subunit: "$iteration.subunit",
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.type).toBe("task_dispatch")
      expect(result.data.await).toBe(true)
      expect(result.data.workflow_ref).toBe("flows/backend.yaml")
      expect(result.data.subunit).toBe("$iteration.subunit")
      expect(result.data.output_mapping?.result).toBe("$last_output")
    }
  })

  it("NodeSchema parses a minimal task_dispatch node (await defaults to undefined)", () => {
    const result = NodeSchema.safeParse({
      id: "dispatch-2",
      type: "task_dispatch",
      subunit: "$iteration.subunit",
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.await).toBeUndefined()
    }
  })

  it("rejects an inline object subunit (subunit is a string reference)", () => {
    const result = NodeSchema.safeParse({
      id: "dispatch-3",
      type: "task_dispatch",
      subunit: { name: "inline-not-allowed" },
    })
    expect(result.success).toBe(false)
  })

  it("WorkflowSchema validates a workflow containing a task_dispatch node", () => {
    const result = WorkflowSchema.safeParse({
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "composition",
      nodes: [
        { id: "dispatch-1", type: "task_dispatch", subunit: "$iteration.subunit", await: true },
      ],
    })
    expect(result.success).toBe(true)
  })
})

// ── AC4: TaskDispatchPort interface ──────────────────────────────────
describe("TaskDispatchPort interface (AC4, G1)", () => {
  it("ScheduleHandle carries schedule_id", () => {
    const handle: ScheduleHandle = { schedule_id: "sch-1" }
    expect(handle.schedule_id).toBe("sch-1")
  })

  it("accepts a conforming implementation at the type level", () => {
    const impl: TaskDispatchPort = {
      async dispatchChildSchedule(subunit) {
        expect(subunit.name).toBeDefined()
        return { schedule_id: "sch-1", workspace_id: "ws-1" }
      },
      async resumeOnCompletion(handle, output) {
        expect(handle.schedule_id).toBeDefined()
        expect(output).toBeTypeOf("object")
      },
    }
    expect(impl.dispatchChildSchedule).toBeTypeOf("function")
    expect(impl.resumeOnCompletion).toBeTypeOf("function")
  })
})

// ── integrationGoalSchema ────────────────────────────────────────────
describe("integrationGoalSchema", () => {
  it("defaults strategy to 'synthesis' when omitted", () => {
    const result = integrationGoalSchema.safeParse({ prompt: "merge outputs" })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.strategy).toBe("synthesis")
    }
  })

  it("accepts strategy 'merge'", () => {
    const result = integrationGoalSchema.safeParse({ strategy: "merge" })
    expect(result.success).toBe(true)
  })

  it("rejects unknown strategy", () => {
    const result = integrationGoalSchema.safeParse({ strategy: "magic" })
    expect(result.success).toBe(false)
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
