import { describe, it, expect, expectTypeOf } from "vitest"
import {
  taskSpecSchema,
  subunitSpecSchema,
  workflowConfigSchema,
  OriginTypeSchema,
  taskResourceTypeSchema,
  resourceRefSchema,
  type TaskSpec,
  type SubunitSpec,
  type WorkflowConfig,
  type OriginType,
  type ResourceRef,
  type TaskResourceType,
} from "../types/scheduler-job"
import {
  TaskStatusSchema,
  taskStatusSsePayloadSchema,
  specFieldUpdatePayloadSchema,
  updateTaskSpecFieldToolSchema,
  type TaskStatus,
  type Task,
  type TaskSpecField,
  type SpecFieldUpdatePayload,
  type TaskStatusSsePayload,
  type UpdateTaskSpecFieldTool,
  type ScheduleStatusListener,
  SPEC_FIELD_UPDATE_EVENT,
  TASK_STATUS_EVENT,
  UPDATE_TASK_SPEC_FIELD_TOOL_NAME,
} from "../types/task"
import type { TaskDispatchPort, ScheduleHandle, OriginRole } from "../types/task-dispatch-port"

// Independent sources of truth (spec literals — not derived from the code).
const EXPECTED_TASK_STATUSES = ["draft", "ready", "running", "done", "failed", "aborted"] as const
const EXPECTED_ORIGIN_TYPES = ["cron", "task", "agent", "manual", "api"] as const
const EXPECTED_RESOURCE_TYPES = ["skill", "agent", "command", "rule"] as const
const EXPECTED_ORIGIN_ROLES = ["primary", "coordinator", "subunit"] as const
// Spec-field names the tool/SSE may carry (spec v2-D12 + glossary).
const EXPECTED_SPEC_FIELDS = [
  "projects",
  "skills",
  "goal",
  "ac",
  "subunits",
  "integration_goal",
  "resources",
  "authoring_resources",
] as const

const baseWorkspaceSpec = {
  org: "xzf",
  branch_prefix: "feat",
  projects: [{ name: "proj-a", source_path: "", group: "" }],
}

// S2 absence assertion: compiles cleanly whether or not the field exists.
// resolves to `true` only when Task does NOT carry the key.
type AssertAbsent<T, K extends string | number | symbol> = T extends { [P in K]: unknown } ? false : true

// ── AC1: TaskStatus + OriginType enums ───────────────────────────────
describe("AC1 — TaskStatus + OriginType enums", () => {
  it("TaskStatusSchema parses every expected status", () => {
    for (const s of EXPECTED_TASK_STATUSES) {
      expect(TaskStatusSchema.safeParse(s).success, `expected ${s} to parse`).toBe(true)
    }
  })

  it("TaskStatusSchema rejects non-task statuses (queued/claimed are schedule, not task)", () => {
    expect(TaskStatusSchema.safeParse("queued").success).toBe(false)
    expect(TaskStatusSchema.safeParse("claimed").success).toBe(false)
    expect(TaskStatusSchema.safeParse("pending").success).toBe(false)
    expect(TaskStatusSchema.safeParse("triggered").success).toBe(false)
  })

  it("every expected TaskStatus is a member of the union (type-level)", () => {
    expectTypeOf<"draft">().toMatchTypeOf<TaskStatus>()
    expectTypeOf<"ready">().toMatchTypeOf<TaskStatus>()
    expectTypeOf<"running">().toMatchTypeOf<TaskStatus>()
    expectTypeOf<"done">().toMatchTypeOf<TaskStatus>()
    expectTypeOf<"failed">().toMatchTypeOf<TaskStatus>()
    expectTypeOf<"aborted">().toMatchTypeOf<TaskStatus>()
  })

  it("OriginTypeSchema parses every expected origin", () => {
    for (const t of EXPECTED_ORIGIN_TYPES) {
      expect(OriginTypeSchema.safeParse(t).success, `expected ${t} to parse`).toBe(true)
    }
  })

  it("OriginTypeSchema rejects the v1 'requirement' value and unknown origins", () => {
    expect(OriginTypeSchema.safeParse("requirement").success).toBe(false)
    expect(OriginTypeSchema.safeParse("webhook").success).toBe(false)
  })

  it("every expected OriginType is a member of the union (type-level)", () => {
    expectTypeOf<"cron">().toMatchTypeOf<OriginType>()
    expectTypeOf<"task">().toMatchTypeOf<OriginType>()
    expectTypeOf<"agent">().toMatchTypeOf<OriginType>()
    expectTypeOf<"manual">().toMatchTypeOf<OriginType>()
    expectTypeOf<"api">().toMatchTypeOf<OriginType>()
  })
})

// ── AC2: resourceRefSchema + TaskSpec/SubunitSpec/WorkflowConfig extensions ─
describe("AC2 — resource refs + spec/config extensions", () => {
  it("TaskResourceType parses the 4 provisionable types, rejects clone/workflow", () => {
    for (const t of EXPECTED_RESOURCE_TYPES) {
      expect(taskResourceTypeSchema.safeParse(t).success).toBe(true)
    }
    // clone (manual-install) + workflow (referenced via workflow_ref) are NOT task resource types
    expect(taskResourceTypeSchema.safeParse("clone").success).toBe(false)
    expect(taskResourceTypeSchema.safeParse("workflow").success).toBe(false)
  })

  it("resourceRefSchema requires {type, name}", () => {
    expect(resourceRefSchema.safeParse({ type: "skill", name: "octo-backend" }).success).toBe(true)
    expect(resourceRefSchema.safeParse({ type: "clone", name: "x" }).success).toBe(false)
    expect(resourceRefSchema.safeParse({ type: "skill" }).success).toBe(false)
    expect(resourceRefSchema.safeParse({ name: "x" }).success).toBe(false)
  })

  it("SubunitSpec parses with resources[] and defaults to [] when omitted", () => {
    const withRes = subunitSpecSchema.safeParse({
      name: "backend",
      workspace_spec: baseWorkspaceSpec,
      workflow_ref: "flows/b.yaml",
      resources: [{ type: "skill", name: "octo-backend" }],
    })
    expect(withRes.success).toBe(true)
    if (withRes.success) {
      expect(withRes.data.resources).toEqual([{ type: "skill", name: "octo-backend" }])
    }

    const without = subunitSpecSchema.safeParse({
      name: "solo",
      workspace_spec: baseWorkspaceSpec,
      workflow_ref: "x.yaml",
    })
    expect(without.success).toBe(true)
    if (without.success) {
      expect(without.data.resources).toEqual([])
    }
  })

  it("TaskSpec parses with resources[] + authoring_resources[] and defaults both to []", () => {
    const withRes = taskSpecSchema.safeParse({
      goal: "g",
      ac: ["a"],
      resources: [{ type: "command", name: "ship" }],
      authoring_resources: [{ type: "skill", name: "octo-research" }],
    })
    expect(withRes.success).toBe(true)
    if (withRes.success) {
      expect(withRes.data.resources).toEqual([{ type: "command", name: "ship" }])
      expect(withRes.data.authoring_resources).toEqual([{ type: "skill", name: "octo-research" }])
    }

    // v1 data without the new fields still parses (no migration).
    const legacy = taskSpecSchema.safeParse({ goal: "g", ac: ["a"] })
    expect(legacy.success).toBe(true)
    if (legacy.success) {
      expect(legacy.data.resources).toEqual([])
      expect(legacy.data.authoring_resources).toEqual([])
    }
  })

  it("WorkflowConfig parses with requires mirroring WorkflowDef.requires (4 keys)", () => {
    const r = workflowConfigSchema.safeParse({
      schema_version: "3.0",
      type: "workflow",
      workspace_spec: baseWorkspaceSpec,
      workflow_chain: [{ workflow_ref: "flows/c.yaml", input_values: {} }],
      requires: {
        skills: ["octo-backend"],
        agent_files: ["reviewer"],
        commands: ["ship"],
        rules: ["no-secrets"],
      },
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.requires?.skills).toEqual(["octo-backend"])
      expect(r.data.requires?.agent_files).toEqual(["reviewer"])
      expect(r.data.requires?.commands).toEqual(["ship"])
      expect(r.data.requires?.rules).toEqual(["no-secrets"])
    }
  })

  it("WorkflowConfig.requires is optional and each key is optional", () => {
    const r = workflowConfigSchema.safeParse({
      schema_version: "2.0",
      type: "workflow",
      workspace_spec: baseWorkspaceSpec,
      workflow_chain: [{ workflow_ref: "x.yaml", input_values: {} }],
      requires: { skills: ["octo-backend"] },
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.requires?.skills).toEqual(["octo-backend"])
      expect(r.data.requires?.agent_files).toBeUndefined()
    }

    const noRequires = workflowConfigSchema.safeParse({
      schema_version: "2.0",
      type: "workflow",
      workspace_spec: baseWorkspaceSpec,
      workflow_chain: [{ workflow_ref: "x.yaml", input_values: {} }],
    })
    expect(noRequires.success).toBe(true)
    if (noRequires.success) {
      expect(noRequires.data.requires).toBeUndefined()
    }
  })

  it("types are assignable at the type level", () => {
    const ref: ResourceRef = { type: "skill", name: "x" }
    const rt: TaskResourceType = "agent"
    const cfg: WorkflowConfig = {
      schema_version: "3.0",
      type: "workflow",
      workspace_spec: { org: "o", branch_prefix: "b", projects: [] },
      workflow_chain: [],
      max_retain: 10,
      requires: { skills: ["octo-backend"] },
    }
    const spec: TaskSpec = { goal: "g", ac: ["a"], resources: [ref], authoring_resources: [ref], skill_groups: [], decisions: [], ac_confirmed: [] }
    const sub: SubunitSpec = {
      name: "n",
      workspace_spec: { org: "o", branch_prefix: "b", projects: [] },
      workflow_ref: "x",
      input_values: {},
      skills: [],
      resources: [ref],
    }
    expect(ref.type).toBe("skill")
    expect(rt).toBe("agent")
    expect(cfg.requires?.skills).toEqual(["octo-backend"])
    expect(spec.resources).toHaveLength(1)
    expect(sub.resources).toHaveLength(1)
  })
})

// ── AC3: TaskDispatchPort +origin_role param ────────────────────────
describe("AC3 — TaskDispatchPort origin_role param", () => {
  it("OriginRole is primary | coordinator | subunit (type-level)", () => {
    const roles: OriginRole[] = [...EXPECTED_ORIGIN_ROLES]
    for (const r of EXPECTED_ORIGIN_ROLES) {
      expect(roles).toContain(r)
    }
  })

  it("dispatchChildSchedule accepts origin_role as a required param (type-level)", () => {
    // Conforming impl MUST accept origin_role. If origin_role is removed from
    // the interface, this assignment fails tsc.
    const impl: TaskDispatchPort = {
      async dispatchChildSchedule(subunit, origin_role) {
        expect(subunit.name).toBeDefined()
        expect(origin_role).toBeDefined()
        return { schedule_id: "sch-1", workspace_id: "ws-1" }
      },
      async resumeOnCompletion(handle, output) {
        expect(handle.schedule_id).toBeDefined()
        expect(output).toBeTypeOf("object")
      },
    }
    expect(impl.dispatchChildSchedule).toBeTypeOf("function")
  })

  it("dispatchChildSchedule can be invoked with origin_role", async () => {
    const impl: TaskDispatchPort = {
      async dispatchChildSchedule(_subunit, origin_role) {
        return { schedule_id: `sch-${origin_role}`, workspace_id: "ws-1" }
      },
      async resumeOnCompletion() {},
    }
    const handle = await impl.dispatchChildSchedule(
      {
        name: "be",
        workspace_spec: { org: "o", branch_prefix: "b", projects: [] },
        workflow_ref: "x",
        input_values: {},
        skills: [],
        resources: [],
      },
      "subunit",
    )
    expect(handle.schedule_id).toBe("sch-subunit")
  })

  it("v1-style impl (ignoring origin_role) still satisfies the interface (backward-compat)", () => {
    // TS permits impls that accept fewer params than the interface declares.
    const v1Impl: TaskDispatchPort = {
      async dispatchChildSchedule(subunit) {
        return { schedule_id: "sch-legacy", workspace_id: "ws-1" }
      },
      async resumeOnCompletion(handle) {
        expect(handle.schedule_id).toBeDefined()
      },
    }
    expect(v1Impl.dispatchChildSchedule).toBeTypeOf("function")
  })

  it("ScheduleHandle still carries schedule_id", () => {
    const handle: ScheduleHandle = { schedule_id: "sch-1" }
    expect(handle.schedule_id).toBe("sch-1")
  })
})

// ── AC4: spec_field_update SSE payload + update_task_spec_field tool ─
describe("AC4 — spec_field_update SSE + update_task_spec_field tool", () => {
  it("exports the event/tool name constants", () => {
    expect(SPEC_FIELD_UPDATE_EVENT).toBe("spec_field_update")
    expect(TASK_STATUS_EVENT).toBe("task_status")
    expect(UPDATE_TASK_SPEC_FIELD_TOOL_NAME).toBe("update_task_spec_field")
  })

  it("TaskSpecField covers the 8 spec fields (type-level)", () => {
    for (const f of EXPECTED_SPEC_FIELDS) {
      expectTypeOf<typeof f>().toMatchTypeOf<TaskSpecField>()
    }
  })

  it("specFieldUpdatePayloadSchema parses {task_id, field, value, version}", () => {
    const r = specFieldUpdatePayloadSchema.safeParse({
      task_id: "task-1",
      field: "goal",
      value: "ship the feature",
      version: 3,
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.task_id).toBe("task-1")
      expect(r.data.field).toBe("goal")
      expect(r.data.value).toBe("ship the feature")
      expect(r.data.version).toBe(3)
    }
  })

  it("specFieldUpdatePayloadSchema rejects unknown field", () => {
    expect(
      specFieldUpdatePayloadSchema.safeParse({ task_id: "t", field: "nope", value: "x", version: 1 }).success,
    ).toBe(false)
  })

  it("specFieldUpdatePayloadSchema rejects missing version", () => {
    expect(
      specFieldUpdatePayloadSchema.safeParse({ task_id: "t", field: "goal", value: "x" }).success,
    ).toBe(false)
  })

  it("specFieldUpdatePayloadSchema accepts value as unknown (any spec-field value shape)", () => {
    // value is a string for goal/ac, an array for skills/projects/subunits,
    // an object for integration_goal — schema must not over-constrain.
    expect(
      specFieldUpdatePayloadSchema.safeParse({ task_id: "t", field: "skills", value: ["a", "b"], version: 2 }).success,
    ).toBe(true)
    expect(
      specFieldUpdatePayloadSchema.safeParse({
        task_id: "t",
        field: "integration_goal",
        value: { strategy: "synthesis" },
        version: 2,
      }).success,
    ).toBe(true)
  })

  it("taskStatusSsePayloadSchema parses {task_id, status, origin_type?, schedule_id?}", () => {
    const r = taskStatusSsePayloadSchema.safeParse({ task_id: "task-1", status: "running" })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.status).toBe("running")
    }
  })

  it("taskStatusSsePayloadSchema accepts optional schedule_id + origin_type for traceability", () => {
    const r = taskStatusSsePayloadSchema.safeParse({
      task_id: "task-1",
      status: "done",
      schedule_id: "sch-9",
      origin_type: "task",
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.schedule_id).toBe("sch-9")
      expect(r.data.origin_type).toBe("task")
    }
  })

  it("taskStatusSsePayloadSchema rejects invalid status", () => {
    expect(taskStatusSsePayloadSchema.safeParse({ task_id: "t", status: "queued" }).success).toBe(false)
  })

  it("updateTaskSpecFieldToolSchema parses {task_id, field, value}", () => {
    const r = updateTaskSpecFieldToolSchema.safeParse({ task_id: "task-1", field: "goal", value: "ship it" })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.task_id).toBe("task-1")
      expect(r.data.field).toBe("goal")
      expect(r.data.value).toBe("ship it")
    }
  })

  it("updateTaskSpecFieldToolSchema rejects missing task_id", () => {
    expect(updateTaskSpecFieldToolSchema.safeParse({ field: "goal", value: "x" }).success).toBe(false)
  })

  it("tool/payload types are assignable (type-level)", () => {
    const tool: UpdateTaskSpecFieldTool = { task_id: "t", field: "skills", value: ["octo-backend"] }
    const sse: SpecFieldUpdatePayload = { task_id: "t", field: "goal", value: "x", version: 1 }
    const status: TaskStatusSsePayload = { task_id: "t", status: "done" }
    expect(tool.field).toBe("skills")
    expect(sse.version).toBe(1)
    expect(status.status).toBe("done")
  })
})

// ── AC5: Task row type (no schedule_id/execution_id per S2) ──────────
describe("AC5 — Task row type (S2 polymorphic-origin, no schedule pointers)", () => {
  const baseRow = {
    id: "task-1",
    org: "xzf",
    name: "Build feature X",
    task_spec: { goal: "g", ac: ["a"], resources: [], authoring_resources: [], skill_groups: [], decisions: [], ac_confirmed: [] },
    authoring_resources: [] as ResourceRef[],
    resources: [] as ResourceRef[],
    skills: [] as string[],
    project_ids: [] as string[],
    version: 1,
    deleted_at: null as string | null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  }

  it("Task is assignable with the full row shape", () => {
    const t: Task = { ...baseRow, status: "draft" }
    expect(t.id).toBe("task-1")
    expect(t.status).toBe("draft")
  })

  it("Task allows every TaskStatus (type-level)", () => {
    const draft: Task = { ...baseRow, status: "draft" }
    const ready: Task = { ...baseRow, status: "ready" }
    const running: Task = { ...baseRow, status: "running" }
    const done: Task = { ...baseRow, status: "done" }
    const failed: Task = { ...baseRow, status: "failed" }
    const aborted: Task = { ...baseRow, status: "aborted" }
    expect([draft, ready, running, done, failed, aborted]).toHaveLength(6)
  })

  it("Task has NO schedule_id / execution_id / claimed_at fields (S2 — type-level)", () => {
    // Conditional-type absence check: compiles cleanly whether or not the field
    // exists, and asserts to `true` only when the field is ABSENT.
    expectTypeOf<AssertAbsent<Task, "schedule_id">>().toEqualTypeOf<true>()
    expectTypeOf<AssertAbsent<Task, "execution_id">>().toEqualTypeOf<true>()
    expectTypeOf<AssertAbsent<Task, "claimed_at">>().toEqualTypeOf<true>()
  })

  it("Task has source_chat_session_id + completed_at optional fields", () => {
    const t: Task = { ...baseRow, status: "done", source_chat_session_id: "sess-1", completed_at: "2026-01-02T00:00:00Z" }
    expect(t.source_chat_session_id).toBe("sess-1")
    expect(t.completed_at).toBe("2026-01-02T00:00:00Z")
  })

  it("ScheduleStatusListener interface is implementable", () => {
    const listener: ScheduleStatusListener = {
      onScheduleTransition(args) {
        expect(args.schedule_id).toBeDefined()
        expect(args.origin_type).toBeDefined()
        expect(args.origin_id).toBeDefined()
        expect(args.status).toBeDefined()
      },
    }
    expect(listener.onScheduleTransition).toBeTypeOf("function")
  })
})
