import { describe, it, expect, expectTypeOf } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  taskPhaseSchema,
  taskSpecSchema,
  type TaskPhase,
} from "../types/scheduler-job"

// ── task-phase-redesign ticket 01 — AC2 contract test ────────────────────
// The spec mandates: "TaskPhase = { index, name, slug, specPath, workflowRef,
// inputValues }（Zod 单源，前端类型派生——契约测试守）". This file is the
// guard: (1) a structural snapshot of the single Zod source, (2) a type-level
// diff against the spec-declared shape (a compile-time check — breaks the
// build if the schema drifts from the contract), (3) a source-level check that
// the web-app's task types are IMPORTED from @octopus/shared (no local mirror
// of TaskSpec/TaskPhase may appear there), which is what makes "前端类型派生"
// a real, enforceable property.

/** The contract literal from spec.md §Implementation Decisions (shared).
 *  Written independently of the schema (hand-typed, not z.infer) so the
 *  mutual-assignability check below is a genuine two-source diff. */
interface SpecTaskPhase {
  index: number
  name: string
  slug: string
  specPath: string
  workflowRef: string
  inputValues: Record<string, string>
}

describe("AC2 contract — TaskPhase Zod single source ↔ spec shape", () => {
  it("Zod shape keys snapshot exactly the 6 spec fields", () => {
    expect(Object.keys(taskPhaseSchema.shape).sort()).toEqual([
      "index",
      "inputValues",
      "name",
      "slug",
      "specPath",
      "workflowRef",
    ])
  })

  it("taskSpecSchema shape snapshot includes the v4 trio alongside v3 fields", () => {
    const keys = Object.keys(taskSpecSchema.shape)
    expect(keys).toContain("format")
    expect(keys).toContain("phases")
    expect(keys).toContain("autoAdvance")
    // v3 keys survive the v4 edit (K13: 停用不物理删)
    for (const legacy of [
      "goal",
      "ac",
      "task_type",
      "skill_groups",
      "decisions",
      "goal_confirmed",
      "ac_confirmed",
      "input_values",
      "subunits",
    ]) {
      expect(keys, `v3 key '${legacy}' must remain`).toContain(legacy)
    }
  })

  it("z.infer<TaskPhase> and the spec literal are mutually assignable (type-level diff)", () => {
    expectTypeOf<TaskPhase>().toEqualTypeOf<SpecTaskPhase>()
  })
})

describe("AC2 contract — web-app derives its task types from @octopus/shared", () => {
  // Resolved from this test file → ../../../web-app/lib/tasks-api.ts
  // (src/__tests__ → shared → packages → web-app).
  const WEB_TASKS_API = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../web-app/lib/tasks-api.ts",
  )

  it("web tasks-api.ts imports TaskSpec from @octopus/shared (single source, no local mirror)", () => {
    const src = readFileSync(WEB_TASKS_API, "utf-8")
    // The import block: `import type { ... TaskSpec ... } from "@octopus/shared"`
    expect(src).toMatch(
      /import\s+type\s*\{[^}]*\bTaskSpec\b[^}]*\}\s*from\s*"@octopus\/shared"/,
    )
    // A hand-mirrored `interface TaskSpec`/`type TaskPhase` here would break
    // the "前端类型派生" contract — forbid it.
    expect(src).not.toMatch(/\b(interface|type)\s+TaskSpec\b/)
    expect(src).not.toMatch(/\b(interface|type)\s+TaskPhase\b/)
  })
})
