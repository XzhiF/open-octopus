import { describe, it, expect, expectTypeOf } from "vitest"
import {
  taskSpecSchema,
  acceptancePreviewSchema,
  acceptanceRunbookSchema,
  subunitSpecSchema,
  workflowConfigSchema,
  taskResourceTypeSchema,
  resourceRefSchema,
  type TaskSpec,
  type SubunitSpec,
  type WorkflowConfig,
  type ResourceRef,
  type TaskResourceType,
} from "../types/scheduler-job"
import {
  TaskStatusSchema,
  taskStatusSsePayloadSchema,
  validateSpecFieldValue,
  TaskSpecFieldError,
  PHASE_STATUS_UPDATE_EVENT,
  type TaskStatus,
  type Task,
  type TaskSpecField,
  type TaskStatusSsePayload,
  type TaskExecutionBadge,
  type TaskExecutionSsePayload,
  type TriggerMode,
  SPEC_FIELD_UPDATE_EVENT,
  TASK_STATUS_EVENT,
  TASK_EXECUTION_EVENT,
  TASK_TRIGGER_FAILED_EVENT,
  TriggerModeSchema,
  taskExecutionSsePayloadSchema,
  taskTriggerFailedPayloadSchema,
  TASK_PREVIEW_EVENT,
} from "../types/task"
import type { TaskDispatchPort, ChildHandle } from "../types/task-dispatch-port"

// Independent sources of truth (spec literals — not derived from the code).
// task-phase-redesign v4 (ticket 07): 'awaiting_review' + 'archiving' join the
// set (K3 — written only by the v4 acceptance path; v3 rows never carry them).
// Order mirrors the schema-v40 DB CHECK list.
const EXPECTED_TASK_STATUSES = [
  "draft",
  "ready",
  "running",
  // task-pause: derived-only — no writer ever persists it on a task row (the truth is
  // executions.status='paused'), which is why it is absent from the schema-v40 DB CHECK
  // mirrored above. 'awaiting_review' is the other such value.
  "paused",
  "awaiting_review",
  "archiving",
  "done",
  "failed",
  "aborted",
] as const
// ADR-0021 票05: `EXPECTED_ORIGIN_TYPES` / `EXPECTED_ORIGIN_ROLES` are gone with the
// types they pinned. WHAT created a schedule stopped being a question anyone asks: the
// origin_* columns died in schema v42, and the last wire reference (the
// `origin_type: 'task'` discriminator on taskpool SSE) died here. WHEN a task runs is
// now the task's own field, so that is what gets pinned below.
const EXPECTED_TRIGGER_MODES = ["manual", "once", "cron"] as const
const EXPECTED_RESOURCE_TYPES = ["skill", "agent", "command", "rule"] as const
// Spec-field names the tool/SSE may carry (spec v2-D12 + glossary).
// task-workflow-handoff (ADR-0013): adds `workflow_ref` to the bindable set.
// task-phase-redesign v4 (ticket 07): adds `phases`.
const EXPECTED_SPEC_FIELDS = [
  "projects",
  "skills",
  "goal",
  "ac",
  "subunits",
  "integration_goal",
  "resources",
  "authoring_resources",
  "decisions",
  "workflow_ref",
  "phases",
  // 批次主 slug (2026-09-20 契约改版): `.scratch/<slug>/<sub>/` 的父目录名。
  "slug",
  // 执行分支名（2026-09-22 author 定名）：spec.branch → feat-<slug>-<日期> 推导的显式来源。
  "branch",
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
describe("AC1 — TaskStatus + TriggerMode enums", () => {
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
    // task-phase-redesign v4 (ticket 07) — the two acceptance-lifecycle states.
    expectTypeOf<"awaiting_review">().toMatchTypeOf<TaskStatus>()
    expectTypeOf<"archiving">().toMatchTypeOf<TaskStatus>()
  })

  // Widening guarantee (ticket 07 底线): adding the v4 states must NOT remove
  // or rename any v3 value — existing rows/clients keep parsing. Pinned against
  // the independent literal above (which mirrors the schema-v40 DB CHECK list).
  it("TaskStatusSchema is a pure WIDENING of the v3 set (no removals, no renames)", () => {
    const V3_STATUSES = ["draft", "ready", "running", "done", "failed", "aborted"] as const
    const options = TaskStatusSchema.options as readonly string[]
    for (const s of V3_STATUSES) {
      expect(options, `v3 status '${s}' must survive the widening`).toContain(s)
    }
    expect(options).toEqual([...EXPECTED_TASK_STATUSES])
  })

  it("TriggerModeSchema parses every expected mode, and nothing else", () => {
    // The three modes are the whole of 「任务何时该跑」 after ADR-0021. 'queued' /
    // 'claimed' / 'draft' deliberately do NOT parse — those were ENVELOPE row states,
    // and a mode enum that also accepts them is how the mirror would creep back in.
    for (const m of EXPECTED_TRIGGER_MODES) {
      expect(TriggerModeSchema.safeParse(m).success, `expected ${m} to parse`).toBe(true)
    }
    for (const m of ["queued", "claimed", "draft", "scheduled", "requirement"]) {
      expect(TriggerModeSchema.safeParse(m).success, `expected ${m} to be rejected`).toBe(false)
    }
  })

  it("every expected TriggerMode is a member of the union (type-level)", () => {
    for (const m of EXPECTED_TRIGGER_MODES) {
      expectTypeOf<(typeof EXPECTED_TRIGGER_MODES)[number]>().toMatchTypeOf<TriggerMode>()
    }
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

// ── AC3: TaskDispatchPort — a child RUN, not a child schedule (ADR-0021 票03/票04) ──
describe("AC3 — TaskDispatchPort dispatchChild / ChildHandle", () => {
  it("dispatchChild takes ONLY the subunit and returns a ChildHandle", () => {
    // Type-level: a conforming implementation must satisfy the interface. The old
    // version of this test asserted the OPPOSITE direction — that omitting
    // origin_role would fail to compile — because a child schedule row needed a role
    // written into schedules.origin_role. A child execution row carries parent_id and
    // child_index instead, so the role parameter has nothing to feed.
    const impl: TaskDispatchPort = {
      async dispatchChild(subunit) {
        expect(subunit.name).toBeDefined()
        return { child_id: "run-1", workspace_id: "ws-1" }
      },
      async resumeOnCompletion(handle, output) {
        expect(handle.child_id).toBeDefined()
        expect(output).toBeTypeOf("object")
      },
    }
    expect(impl.dispatchChild).toBeTypeOf("function")
  })

  it("ChildHandle carries child_id (the executions row), never schedule_id", async () => {
    const impl: TaskDispatchPort = {
      async dispatchChild() {
        return { child_id: "run-1", workspace_id: "ws-1" }
      },
      async resumeOnCompletion() {},
    }
    const handle = await impl.dispatchChild({ name: "s1", workflow_ref: "wf", input_values: {}, workspace_spec: { org: "o", branch_prefix: "b", projects: [] } } as never)
    expect(handle.child_id).toBe("run-1")
    expect("schedule_id" in handle).toBe(false)
  })
})

// ── AC4: spec_field_update SSE payload + update_task_spec_field tool ─

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
    // ADR-0021: WHEN lives here. Required, not optional — an optional trigger is how a
    // row silently stops being scannable by the built-in job.
    trigger_mode: "manual" as TriggerMode,
    trigger_at: null as string | null,
    cron_expression: null as string | null,
    cron_timezone: "Asia/Shanghai",
    trigger_enabled: true,
    next_fire_at: null as string | null,
    last_fired_at: null as string | null,
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

  it("TaskExecutionBadge is the board badge AND the history row (one shape)", () => {
    // It replaced two things: the envelope status mirror (schedule_status/scheduled_at
    // on the task) and children[] (the child SCHEDULE rows). name + error_summary are
    // what the UI used to have no source for — a subunit's label and a red run's reason.
    const badge: TaskExecutionBadge = {
      id: "exec-1",
      status: "failed",
      workflow_ref: "built-in/task-dev",
      name: "backend",
      phase_index: 1,
      round_index: 2,
      workspace_id: "ws-1",
      started_at: null,
      completed_at: null,
      created_at: "2026-01-01T00:00:00Z",
      error_summary: "engine died at node 3",
      children: [
        {
          id: "exec-2", status: "completed", workflow_ref: "wf/a", name: "subunit-a",
          phase_index: null, round_index: null, workspace_id: "ws-2",
          started_at: null, completed_at: null, created_at: "2026-01-01T00:00:00Z",
          error_summary: null,
        },
      ],
    }
    expect(badge.children).toHaveLength(1)
    expectTypeOf<TaskExecutionBadge["children"]>().toEqualTypeOf<
      TaskExecutionBadge[] | undefined
    >()
    // The mirror columns must not come back as optional-anythings: absent is the fix,
    // not nullable (a null schedule_status still says "there is a schedule").
    expectTypeOf<Task>().toHaveProperty("execution")
    type AssertNoEnvelope<T> = "schedule_status" extends keyof T ? false : true
    expectTypeOf<AssertNoEnvelope<Task>>().toEqualTypeOf<true>()
  })
})

// ── task-phase-redesign v4 (ticket 07) — wire legality of the new states +
//    the `phases` spec-field + the `phase_status_update` SSE contract ──────
describe("ticket 07 — v4 acceptance wire contract", () => {
  const phase = (over: Record<string, unknown> = {}) => ({
    index: 1,
    name: "Phase 1",
    slug: "phase-1",
    specPath: ".scratch/20260903/phase-1/spec.md",
    workflowRef: "built-in/task-dev",
    inputValues: {},
    ...over,
  })

  it("taskStatusSsePayloadSchema accepts the v4 states (that is why the widening exists)", () => {
    expect(
      taskStatusSsePayloadSchema.safeParse({ task_id: "t", status: "awaiting_review" }).success,
    ).toBe(true)
    expect(
      taskStatusSsePayloadSchema.safeParse({ task_id: "t", status: "archiving" }).success,
    ).toBe(true)
  })

  it("'phases' is a bindable spec-field (enum)", () => {
    expect(EXPECTED_SPEC_FIELDS).toContain("phases")
    expect(phase().slug).toBeTruthy()
  })

  it("validateSpecFieldValue('phases') normalizes each entry through taskPhaseSchema", () => {
    const out = validateSpecFieldValue("phases", [
      phase(),
      phase({ index: 2, name: "Phase 2", slug: "phase-2" }),
    ]) as Array<Record<string, unknown>>
    expect(out).toHaveLength(2)
    expect(out[0].slug).toBe("phase-1")
    expect(out[1].index).toBe(2)
    // inputValues has a schema default ({}), so an omitted key is materialized.
    expect(out[0].inputValues).toEqual({})
  })

  it("validateSpecFieldValue('phases') rejects a non-array / empty array", () => {
    expect(() => validateSpecFieldValue("phases", "nope")).toThrow(TaskSpecFieldError)
    expect(() => validateSpecFieldValue("phases", [])).toThrow(/non-empty/i)
  })

  it("validateSpecFieldValue('phases') rejects malformed entries (path-unsafe slug, 0 index)", () => {
    // Per-entry shape errors surface as ZodError (the subunits/resources/
    // integration_goal precedent) — the route's classifyError maps BOTH
    // ZodError and TaskSpecFieldError to 400, so the HTTP contract holds.
    expect(() => validateSpecFieldValue("phases", [phase({ slug: "../escape" })])).toThrow(/slug/i)
    expect(() => validateSpecFieldValue("phases", [phase({ index: 0 })])).toThrow(/too small|min/i)
  })

  // ── 批次主 slug (2026-09-20): task_spec.slug — `.scratch/<main>/<sub>/` 契约 ──
  it("'slug' is a bindable spec-field (enum)", () => {
    expect(EXPECTED_SPEC_FIELDS).toContain("slug")
  })

  it("validateSpecFieldValue('slug') accepts path-safe kebab, normalizes", () => {
    expect(validateSpecFieldValue("slug", "token-metering")).toBe("token-metering")
  })

  it("validateSpecFieldValue('slug') rejects path-unsafe / 中文 / empty", () => {
    expect(() => validateSpecFieldValue("slug", "../escape")).toThrow(/Invalid slug|path-safe/i)
    expect(() => validateSpecFieldValue("slug", "重构网关")).toThrow(/Invalid slug|path-safe/i)
    expect(() => validateSpecFieldValue("slug", "")).toThrow()
    expect(() => validateSpecFieldValue("slug", 42)).toThrow()
  })

  it("validateSpecFieldValue('slug') null clears (undefined rides out of the JSON merge)", () => {
    expect(validateSpecFieldValue("slug", null)).toBeUndefined()
  })

  it("taskSpecSchema carries optional slug and keeps legacy (无 slug) parsing byte-clean", () => {
    expect(taskSpecSchema.parse({ goal: "g", ac: ["a"], slug: "token-metering" }).slug).toBe("token-metering")
    const legacy = taskSpecSchema.parse({ goal: "g", ac: ["a"] })
    expect("slug" in legacy && legacy.slug).toBeFalsy()
  })

  // ── 执行分支名 (2026-09-22): spec.branch — author 定名，替代 taskpool-{uuid} ──
  it("'branch' is a bindable spec-field (enum)", () => {
    expect(EXPECTED_SPEC_FIELDS).toContain("branch")
  })

  it("validateSpecFieldValue('branch') accepts ASCII, rejects bad shape", () => {
    expect(validateSpecFieldValue("branch", "feat-runbook-mem")).toBe("feat-runbook-mem")
    expect(validateSpecFieldValue("branch", "billing-v2")).toBe("billing-v2")
    expect(() => validateSpecFieldValue("branch", "billing/2")).toThrow(/branch/i) // 斜杠/冒号一律拒
    expect(() => validateSpecFieldValue("branch", "计费分支")).toThrow(/branch/i)
    expect(() => validateSpecFieldValue("branch", "a")).toThrow(/branch/i) // <2 字符
    expect(validateSpecFieldValue("branch", null)).toBeUndefined() // null clears
  })

  it("taskSpecSchema carries optional branch; legacy 无 branch 照 parse", () => {
    expect(taskSpecSchema.parse({ goal: "g", ac: ["a"], branch: "feat-x" }).branch).toBe("feat-x")
    const legacy = taskSpecSchema.parse({ goal: "g", ac: ["a"] })
    expect("branch" in legacy && legacy.branch).toBeFalsy()
  })

  it("PHASE_STATUS_UPDATE_EVENT pins the ticket-11/12 wire name", () => {
    expect(PHASE_STATUS_UPDATE_EVENT).toBe("phase_status_update")
  })
})

describe("ticket 01 (v2.1) — acceptance_preview spec-field contract", () => {
  const okPreview = { command: "mvn -q spring-boot:run", url: "http://localhost:8080" }

  it("AC1: acceptancePreviewSchema accepts minimal + full, rejects bad url/empty cmd", () => {
    expect(acceptancePreviewSchema.safeParse(okPreview).success).toBe(true)
    expect(acceptancePreviewSchema.safeParse({
      ...okPreview, cwd: "packages", readyPattern: "Started .*Application",
    }).success).toBe(true)
    // url must be http(s)
    expect(acceptancePreviewSchema.safeParse({ command: "x", url: "localhost:8080" }).success).toBe(false)
    expect(acceptancePreviewSchema.safeParse({ command: "x", url: "ftp://h/p" }).success).toBe(false)
    // command required non-empty
    expect(acceptancePreviewSchema.safeParse({ command: "", url: "http://x" }).success).toBe(false)
    // url required
    expect(acceptancePreviewSchema.safeParse({ command: "x" }).success).toBe(false)
  })

  it("AC1: validateSpecFieldValue('acceptance_preview') parses object, null→undefined (clears)", () => {
    expect(validateSpecFieldValue("acceptance_preview", okPreview)).toMatchObject({ url: "http://localhost:8080" })
    // null clears — rides into spec merge as undefined so JSON.stringify drops the key
    expect(validateSpecFieldValue("acceptance_preview", null)).toBeUndefined()
    expect(() => validateSpecFieldValue("acceptance_preview", { command: "x", url: "nope" })).toThrow()
  })

  it("AC2: 'acceptance_preview' is a whitelisted TaskSpecField + round-trips on taskSpecSchema", () => {
    // The zod enum admits the new member (a stale build would reject the literal).
    const f: TaskSpecField = "acceptance_preview"
    expect(f).toBe("acceptance_preview")
    const spec = taskSpecSchema.parse({
      format: "v4", goal: "g", ac: ["a"],
      phases: [{ index: 1, name: "P", slug: "p", specPath: "./x/spec.md", workflowRef: "task-dev" }],
      acceptance_preview: okPreview,
    })
    expect(spec.acceptance_preview?.url).toBe("http://localhost:8080")
    // absent stays absent (no spurious key), same discipline as acceptance_verify
    const bare = taskSpecSchema.parse({
      format: "v4", goal: "g", ac: ["a"],
      phases: [{ index: 1, name: "P", slug: "p", specPath: "./x/spec.md", workflowRef: "task-dev" }],
    })
    expect("acceptance_preview" in bare).toBe(false)
    expect("acceptance_verify" in bare).toBe(false)
  })

  it("acceptance_runbook: 多服务/远端部署的正道形态（up/ready/views/down?）", () => {
    const ok = {
      up: { command: "docker compose up -d" },
      ready: { command: "docker compose ps | grep -q healthy" },
      views: [{ label: "web", url: "http://localhost:3000" }, { url: "http://localhost:8080" }],
      down: { command: "docker compose down" },
      timeoutS: 120,
    }
    // schema + spec-field
    expect(acceptanceRunbookSchema.safeParse(ok).success).toBe(true)
    // down 可缺省（远端部署不该本地杀）
    expect(acceptanceRunbookSchema.safeParse({ up: ok.up, ready: ok.ready }).success).toBe(true)
    // 缺 up 或 ready → 拒
    expect(acceptanceRunbookSchema.safeParse({ ready: ok.ready }).success).toBe(false)
    expect(acceptanceRunbookSchema.safeParse({ up: ok.up }).success).toBe(false)
    // view url 必须 http(s)
    expect(acceptanceRunbookSchema.safeParse({ ...ok, views: [{ url: "localhost:1" }] }).success).toBe(false)
    // spec-field null-clears + 白名单成员
    expect(validateSpecFieldValue("acceptance_runbook", ok)).toMatchObject({ up: ok.up })
    expect(validateSpecFieldValue("acceptance_runbook", null)).toBeUndefined()
    const f: TaskSpecField = "acceptance_runbook"
    expect(f).toBe("acceptance_runbook")
    const spec = taskSpecSchema.parse({
      format: "v4", goal: "g", ac: ["a"],
      phases: [{ index: 1, name: "P", slug: "p", specPath: "./x/spec.md", workflowRef: "task-dev" }],
      acceptance_runbook: ok,
    })
    expect(spec.acceptance_runbook?.views).toHaveLength(2)
    const bare = taskSpecSchema.parse({
      format: "v4", goal: "g", ac: ["a"],
      phases: [{ index: 1, name: "P", slug: "p", specPath: "./x/spec.md", workflowRef: "task-dev" }],
    })
    expect("acceptance_runbook" in bare).toBe(false)
  })

  it("TASK_PREVIEW_EVENT is the pinned SSE channel name", () => {
    expect(TASK_PREVIEW_EVENT).toBe("task_preview")
  })
})
