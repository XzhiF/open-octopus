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
  type TaskSpecField,
  type ArtifactIndexEntry,
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

// ── AC3: ArtifactIndexEntry type ─────────────────────────────────────
// ── 分支计划（2026-11-24）：base_branch / target_branch / branch_plan ──
describe("分支计划 — taskSpecSchema + validateSpecFieldValue", () => {
  it("taskSpecSchema 接受 feat/xxx 形态的 base/target 与 per-repo branch_plan", () => {
    const parsed = taskSpecSchema.parse({
      base_branch: "feat/long-lived",
      target_branch: "feat/long-lived",
      branch_plan: { console: { base: "feat/console", target: "release-1.2" } },
    })
    expect(parsed.base_branch).toBe("feat/long-lived")
    expect(parsed.target_branch).toBe("feat/long-lived")
    expect(parsed.branch_plan?.console).toEqual({ base: "feat/console", target: "release-1.2" })
  })

  it("taskSpecSchema 拒绝非法 ref（空格 / .. / 结尾 .lock / 开头 /）", () => {
    for (const bad of ["feat x", "feat..x", "feat/x.lock", "/feat", "feat/", "feat/@{x}"]) {
      expect(() => taskSpecSchema.parse({ base_branch: bad })).toThrow()
    }
  })

  it("spec-field 可写 base_branch/target_branch，null 清空", () => {
    expect(validateSpecFieldValue("base_branch", "feat/abc")).toBe("feat/abc")
    expect(validateSpecFieldValue("target_branch", "release/1.0")).toBe("release/1.0")
    expect(validateSpecFieldValue("base_branch", null)).toBeUndefined()
    expect(validateSpecFieldValue("target_branch", null)).toBeUndefined()
  })

  it("spec-field 拒绝非法分支名（TaskSpecFieldError）", () => {
    expect(() => validateSpecFieldValue("base_branch", "feat x")).toThrow(TaskSpecFieldError)
    expect(() => validateSpecFieldValue("target_branch", "a..b")).toThrow(TaskSpecFieldError)
    expect(() => validateSpecFieldValue("base_branch", "")).toThrow(TaskSpecFieldError)
  })

  it("spec-field 可写 branch_plan（多仓逐仓落点），null 清空、坏项 400", () => {
    expect(validateSpecFieldValue("branch_plan", {
      console: { base: "feat/console", target: "release/1.2" },
      ledger: { base: "feat/ledger" },
    })).toEqual({
      console: { base: "feat/console", target: "release/1.2" },
      ledger: { base: "feat/ledger" },
    })
    expect(validateSpecFieldValue("branch_plan", null)).toBeUndefined()
    expect(() => validateSpecFieldValue("branch_plan", [])).toThrow(TaskSpecFieldError)
    expect(() => validateSpecFieldValue("branch_plan", "console")).toThrow(TaskSpecFieldError)
    expect(() => validateSpecFieldValue("branch_plan", { console: { base: "feat x" } }))
      .toThrow(TaskSpecFieldError)
  })
})

describe("AC3 — ArtifactIndexEntry type", () => {  it("artifactIndexEntrySchema parses a valid internal entry", () => {
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

})
