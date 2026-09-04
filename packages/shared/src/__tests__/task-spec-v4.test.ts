import { describe, it, expect, expectTypeOf } from "vitest"
import {
  taskSpecSchema,
  taskPhaseSchema,
  type TaskSpec,
  type TaskPhase,
} from "../types/scheduler-job"

// ── task-phase-redesign ticket 01 — task_spec v4 schema ─────────────────
// Spec §Implementation Decisions (shared): taskSpecSchema gains
// `format?: "v4"` / `phases?: TaskPhase[]` / `autoAdvance?: boolean`;
// goal/ac (and the confirmed pair) become optional so v4 payloads without
// them parse while v3/generic payloads are byte-for-byte unchanged (K13).
// TaskPhase = { index, name, slug, specPath, workflowRef, inputValues }
// (Zod single source; web derives its type — see task-phase-contract.test.ts).

/** A minimal valid v4 phase (1-based index — ticket 07: i<n → next=i+1,
 *  i=n → archiving, so phase 1 is the first). */
function phase(overrides: Record<string, unknown> = {}) {
  return {
    index: 1,
    name: "地基与数据层",
    slug: "01-foundation",
    specPath: ".scratch/20260903/01-foundation/spec.md",
    workflowRef: "built-in/task-dev",
    inputValues: { goal: "${phase.slug}" },
    ...overrides,
  }
}

// ── AC1: v4 payload parses; v3 behavior unchanged ────────────────────────
describe("AC1 — v4 payload (no goal/ac, phases≥1) parses; v3 regression", () => {
  it("parses a v4 payload WITHOUT goal/ac, preserving format/phases/autoAdvance", () => {
    const parsed = taskSpecSchema.parse({
      format: "v4",
      autoAdvance: true,
      phases: [phase(), phase({ index: 2, name: "执行引擎", slug: "02-engine" })],
    })
    expect(parsed.format).toBe("v4")
    expect(parsed.autoAdvance).toBe(true)
    expect(parsed.phases).toHaveLength(2)
    expect(parsed.phases?.[1].slug).toBe("02-engine")
    expect(parsed.goal).toBeUndefined()
    expect(parsed.ac).toBeUndefined()
  })

  it("v4 payload with goal/ac still present parses (v3 fields optional, not banned)", () => {
    const parsed = taskSpecSchema.parse({
      format: "v4",
      goal: "g",
      ac: ["a"],
      phases: [phase()],
    })
    expect(parsed.goal).toBe("g")
    expect(parsed.ac).toEqual(["a"])
  })

  it("autoAdvance defaults to undefined (default-on is the server gate's derivation, not a schema default)", () => {
    const parsed = taskSpecSchema.parse({ format: "v4", phases: [phase()] })
    expect(parsed.autoAdvance).toBeUndefined()
  })

  it("autoAdvance accepts false", () => {
    expect(
      taskSpecSchema.safeParse({ format: "v4", autoAdvance: false, phases: [phase()] }).success,
    ).toBe(true)
  })

  it("rejects a non-boolean autoAdvance", () => {
    expect(
      taskSpecSchema.safeParse({ format: "v4", autoAdvance: "yes", phases: [phase()] }).success,
    ).toBe(false)
  })

  it("rejects an unknown format value (only the v4 flag exists)", () => {
    expect(taskSpecSchema.safeParse({ format: "v5", phases: [phase()] }).success).toBe(false)
  })

  it("v3 regression: goal/ac payload without format parses exactly as before", () => {
    const parsed = taskSpecSchema.parse({ goal: "g", ac: ["a"], task_type: "coding" })
    expect(parsed.goal).toBe("g")
    expect(parsed.ac).toEqual(["a"])
    expect(parsed.format).toBeUndefined()
    expect(parsed.phases).toBeUndefined()
  })

  it("v3 regression: present-but-invalid goal/ac are still rejected (min constraints kept)", () => {
    expect(taskSpecSchema.safeParse({ goal: "", ac: ["a"] }).success).toBe(false)
    expect(taskSpecSchema.safeParse({ goal: "g", ac: [] }).success).toBe(false)
    expect(taskSpecSchema.safeParse({ goal: "g", ac: [""] }).success).toBe(false)
  })

  it("v3 regression: empty goal inside a v4 payload is still rejected when present", () => {
    expect(taskSpecSchema.safeParse({ format: "v4", goal: "", phases: [phase()] }).success).toBe(
      false,
    )
  })
})

// ── AC1 (negative): TaskPhase field validation ───────────────────────────
describe("TaskPhase schema — positive/negative field cases", () => {
  it("parses a valid phase; inputValues defaults to {} when omitted", () => {
    const { inputValues: _omit, ...rest } = phase()
    const parsed = taskPhaseSchema.parse(rest)
    expect(parsed.index).toBe(1)
    expect(parsed.inputValues).toEqual({})
  })

  it("inputValues preserves placeholder strings (${phase.slug} etc.)", () => {
    const parsed = taskPhaseSchema.parse(
      phase({ inputValues: { spec_dir: "${phase.spec_dir}", home: "${task.home}" } }),
    )
    expect(parsed.inputValues.spec_dir).toBe("${phase.spec_dir}")
    expect(parsed.inputValues.home).toBe("${task.home}")
  })

  it("phases: [] fails — ≥1 phase required whenever the key is present (omission = not-yet-authored draft)", () => {
    expect(taskSpecSchema.safeParse({ format: "v4", phases: [] }).success).toBe(false)
  })

  it("phase missing specPath fails", () => {
    const { specPath: _omit, ...rest } = phase()
    expect(taskPhaseSchema.safeParse(rest).success).toBe(false)
  })

  it("phase missing each other required field fails (index/name/slug/workflowRef)", () => {
    for (const key of ["index", "name", "slug", "workflowRef"] as const) {
      const payload = phase()
      delete (payload as Record<string, unknown>)[key]
      expect(taskPhaseSchema.safeParse(payload).success, `missing ${key}`).toBe(false)
    }
  })

  it("index must be a 1-based integer", () => {
    expect(taskPhaseSchema.safeParse(phase({ index: 0 })).success).toBe(false)
    expect(taskPhaseSchema.safeParse(phase({ index: -1 })).success).toBe(false)
    expect(taskPhaseSchema.safeParse(phase({ index: 1.5 })).success).toBe(false)
  })

  it("name must be a non-empty string", () => {
    expect(taskPhaseSchema.safeParse(phase({ name: "" })).success).toBe(false)
  })

  it("slug must be path-safe (no '/' / '..' / leading dash)", () => {
    expect(taskPhaseSchema.safeParse(phase({ slug: "a/b" })).success).toBe(false)
    expect(taskPhaseSchema.safeParse(phase({ slug: "../escape" })).success).toBe(false)
    expect(taskPhaseSchema.safeParse(phase({ slug: "" })).success).toBe(false)
  })

  it("workflowRef reuses the WorkflowRef grammar ('built-in/x' ok, 'bad//ref' rejected)", () => {
    expect(taskPhaseSchema.safeParse(phase({ workflowRef: "task-dev" })).success).toBe(true)
    expect(taskPhaseSchema.safeParse(phase({ workflowRef: "built-in/task-dev.yaml" })).success).toBe(
      true,
    )
    expect(taskPhaseSchema.safeParse(phase({ workflowRef: "bad//ref" })).success).toBe(false)
    expect(taskPhaseSchema.safeParse(phase({ workflowRef: "" })).success).toBe(false)
  })
})

// ── AC1 (round-trip): DB TEXT serialization keeps the v4 fields ─────────
describe("PUT round-trip — v4 fields survive JSON serialization", () => {
  it("parse(serialize(parse(v4))) preserves format/phases/autoAdvance", () => {
    const once = taskSpecSchema.parse({ format: "v4", autoAdvance: false, phases: [phase()] })
    const twice = taskSpecSchema.parse(JSON.parse(JSON.stringify(once)))
    expect(twice.format).toBe("v4")
    expect(twice.autoAdvance).toBe(false)
    expect(twice.phases?.[0].specPath).toBe(phase().specPath)
  })
})

// ── AC2 (type level): derived TS types carry the spec shape ─────────────
describe("AC2 — TaskPhase / TaskSpec derived types (type-level)", () => {
  it("TaskPhase type matches the spec shape exactly", () => {
    expectTypeOf<TaskPhase>().toEqualTypeOf<{
      index: number
      name: string
      slug: string
      specPath: string
      workflowRef: string
      inputValues: Record<string, string>
    }>()
  })

  it("TaskSpec carries the optional v4 fields", () => {
    expectTypeOf<TaskSpec["format"]>().toEqualTypeOf<"v4" | undefined>()
    expectTypeOf<TaskSpec["phases"]>().toEqualTypeOf<TaskPhase[] | undefined>()
    expectTypeOf<TaskSpec["autoAdvance"]>().toEqualTypeOf<boolean | undefined>()
    expectTypeOf<TaskSpec["goal"]>().toEqualTypeOf<string | undefined>()
    expectTypeOf<TaskSpec["ac"]>().toEqualTypeOf<string[] | undefined>()
  })
})
