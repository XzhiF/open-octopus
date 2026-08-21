import { describe, it, expect, expectTypeOf } from "vitest"
import {
  taskSpecSchema,
  type TaskSpec,
} from "../types/scheduler-job"
import {
  TaskSpecFieldSchema,
  validateSpecFieldValue,
  TaskSpecFieldError,
  artifactIndexEntrySchema,
  assistWorkflowRunSchema,
  type TaskSpecField,
  type ArtifactIndexEntry,
  type AssistWorkflowRun,
} from "../types/task"

// ── AC1: taskSpecSchema gains task_type / skill_groups / decisions /
//        goal_confirmed / ac_confirmed (ticket 01) ──────────────────────
describe("AC1 — taskSpecSchema v3 new fields", () => {
  it("round-trips task_type / skill_groups / decisions / goal_confirmed / ac_confirmed", () => {
    const parsed = taskSpecSchema.parse({
      goal: "g",
      ac: ["a"],
      task_type: "coding",
      skill_groups: ["open-spec"],
      decisions: ["x"],
      goal_confirmed: true,
      ac_confirmed: ["a"],
    })
    expect(parsed.task_type).toBe("coding")
    expect(parsed.skill_groups).toEqual(["open-spec"])
    expect(parsed.decisions).toEqual(["x"])
    expect(parsed.goal_confirmed).toBe(true)
    expect(parsed.ac_confirmed).toEqual(["a"])
  })

  it("defaults skill_groups / decisions / ac_confirmed to [] when omitted; task_type/goal_confirmed undefined", () => {
    const parsed = taskSpecSchema.parse({ goal: "g", ac: ["a"] })
    expect(parsed.skill_groups).toEqual([])
    expect(parsed.decisions).toEqual([])
    expect(parsed.ac_confirmed).toEqual([])
    expect(parsed.task_type).toBeUndefined()
    expect(parsed.goal_confirmed).toBeUndefined()
  })

  it("accepts task_type 'generic' too", () => {
    expect(taskSpecSchema.safeParse({ goal: "g", ac: ["a"], task_type: "generic" }).success).toBe(true)
  })

  it("rejects an unknown task_type value", () => {
    expect(
      taskSpecSchema.safeParse({ goal: "g", ac: ["a"], task_type: "nope" }).success,
    ).toBe(false)
  })

  // AC4: existing goal/ac min(1) constraints not broken
  it("still rejects empty goal (AC4)", () => {
    expect(taskSpecSchema.safeParse({ goal: "", ac: ["a"] }).success).toBe(false)
  })
  it("still rejects empty ac array (AC4)", () => {
    expect(taskSpecSchema.safeParse({ goal: "g", ac: [] }).success).toBe(false)
  })
  it("still rejects an empty-string ac element (AC4)", () => {
    expect(taskSpecSchema.safeParse({ goal: "g", ac: [""] }).success).toBe(false)
  })

  // SW-BP2: PUT round-trip must not drop the new fields
  it("PUT round-trip: parse(serialize(parsed)) preserves the three passed new fields", () => {
    const original = {
      goal: "g",
      ac: ["a"],
      task_type: "coding" as const,
      skill_groups: ["open-spec"],
      decisions: ["x"],
    }
    const once = taskSpecSchema.parse(original)
    // Simulate DB TEXT round-trip: JSON.stringify then parse again through schema
    const twice = taskSpecSchema.parse(JSON.parse(JSON.stringify(once)))
    expect(twice.task_type).toBe("coding")
    expect(twice.skill_groups).toEqual(["open-spec"])
    expect(twice.decisions).toEqual(["x"])
  })

  it("TaskSpec type carries the new fields (type-level)", () => {
    expectTypeOf<TaskSpec["task_type"]>().toEqualTypeOf<"coding" | "generic" | undefined>()
    expectTypeOf<TaskSpec["skill_groups"]>().toEqualTypeOf<string[]>()
    expectTypeOf<TaskSpec["decisions"]>().toEqualTypeOf<string[]>()
    expectTypeOf<TaskSpec["goal_confirmed"]>().toEqualTypeOf<boolean | undefined>()
    expectTypeOf<TaskSpec["ac_confirmed"]>().toEqualTypeOf<string[]>()
  })
})

// ── AC2: TaskSpecFieldSchema + validateSpecFieldValue decisions branch ─
describe("AC2 — TaskSpecFieldSchema + validateSpecFieldValue decisions branch", () => {
  it("TaskSpecFieldSchema parses 'decisions'", () => {
    expect(TaskSpecFieldSchema.safeParse("decisions").success).toBe(true)
  })

  it("'decisions' is a member of the TaskSpecField union (type-level)", () => {
    expectTypeOf<"decisions">().toMatchTypeOf<TaskSpecField>()
  })

  it("validateSpecFieldValue accepts a decisions string[] and returns it", () => {
    expect(() => validateSpecFieldValue("decisions", ["a"])).not.toThrow()
    expect(validateSpecFieldValue("decisions", ["a", "b"])).toEqual(["a", "b"])
  })

  it("validateSpecFieldValue rejects non-array decisions (throws TaskSpecFieldError)", () => {
    expect(() => validateSpecFieldValue("decisions", "not-array")).toThrow(TaskSpecFieldError)
    expect(() => validateSpecFieldValue("decisions", [1, 2])).toThrow(TaskSpecFieldError)
  })

  it("validateSpecFieldValue rejects an array with non-string elements for decisions", () => {
    expect(() => validateSpecFieldValue("decisions", ["ok", 3])).toThrow(TaskSpecFieldError)
  })

  it("validateSpecFieldValue throws on an unknown field (defensive default)", () => {
    expect(() =>
      validateSpecFieldValue("unknown" as TaskSpecField, ["a"]),
    ).toThrow(TaskSpecFieldError)
  })

  // Existing fields still validate (analog port — not regressed)
  it("validateSpecFieldValue still validates 'goal' (non-empty string)", () => {
    expect(() => validateSpecFieldValue("goal", "")).toThrow(TaskSpecFieldError)
    expect(validateSpecFieldValue("goal", "ship it")).toBe("ship it")
  })
})

// ── AC3: ArtifactIndexEntry + AssistWorkflowRun types ─────────────────
describe("AC3 — ArtifactIndexEntry + AssistWorkflowRun types", () => {
  it("artifactIndexEntrySchema parses a valid internal entry", () => {
    const r = artifactIndexEntrySchema.safeParse({
      path: "spec.md",
      by: "open-spec",
      title: "Spec",
      external: false,
      updated_at: "2026-08-18T00:00:00.000Z",
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.path).toBe("spec.md")
      expect(r.data.external).toBe(false)
    }
  })

  it("artifactIndexEntrySchema parses an external entry with an absolute path", () => {
    const r = artifactIndexEntrySchema.safeParse({
      path: "/abs/path/to/proposal.md",
      by: "third-party-skill",
      title: "Proposal",
      external: true,
      updated_at: "2026-08-18T00:00:00.000Z",
    })
    expect(r.success).toBe(true)
  })

  it("artifactIndexEntrySchema rejects an entry missing a required field", () => {
    expect(
      artifactIndexEntrySchema.safeParse({ path: "x.md", by: "x", external: false }).success,
    ).toBe(false)
  })

  it("ArtifactIndexEntry type carries the spec shape (type-level)", () => {
    expectTypeOf<ArtifactIndexEntry["path"]>().toEqualTypeOf<string>()
    expectTypeOf<ArtifactIndexEntry["by"]>().toEqualTypeOf<string>()
    expectTypeOf<ArtifactIndexEntry["title"]>().toEqualTypeOf<string>()
    expectTypeOf<ArtifactIndexEntry["external"]>().toEqualTypeOf<boolean>()
    expectTypeOf<ArtifactIndexEntry["updated_at"]>().toEqualTypeOf<string>()
  })

  it("assistWorkflowRunSchema parses a run without optional output fields", () => {
    const r = assistWorkflowRunSchema.safeParse({
      run_id: "r1",
      execution_id: "e1",
      workspace_id: "w1",
      template: "moa-requirements-review",
      status: "running",
      logs: [{ t: "2026-08-18T00:00:00.000Z", icon: "▶", text: "started" }],
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.run_id).toBe("r1")
      expect(r.data.output).toBeUndefined()
      expect(r.data.output_raw).toBeUndefined()
      expect(r.data.output_parse_error).toBeUndefined()
    }
  })

  it("assistWorkflowRunSchema parses a completed run with structured output", () => {
    const r = assistWorkflowRunSchema.safeParse({
      run_id: "r2",
      execution_id: "e2",
      workspace_id: "w2",
      template: "spec-review-swarm",
      status: "success",
      logs: [{ t: "2026-08-18T00:00:00.000Z", icon: "✓", text: "done" }],
      output: { ac_candidates: ["ac1"], suggestions: ["s1"], risks: ["r1"] },
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.output?.ac_candidates).toEqual(["ac1"])
    }
  })

  it("AssistWorkflowRun type carries the spec shape (type-level)", () => {
    expectTypeOf<AssistWorkflowRun["run_id"]>().toEqualTypeOf<string>()
    expectTypeOf<AssistWorkflowRun["execution_id"]>().toEqualTypeOf<string>()
    expectTypeOf<AssistWorkflowRun["workspace_id"]>().toEqualTypeOf<string>()
    expectTypeOf<AssistWorkflowRun["template"]>().toEqualTypeOf<string>()
    expectTypeOf<AssistWorkflowRun["status"]>().toEqualTypeOf<string>()
    expectTypeOf<AssistWorkflowRun["logs"]>().toEqualTypeOf<
      { t: string; icon: string; text: string }[]
    >()
    expectTypeOf<AssistWorkflowRun["output_parse_error"]>().toEqualTypeOf<boolean | undefined>()
  })
})
