// packages/server/src/services/agent/__tests__/workflow-presets-seed.test.ts
//
// task-workflow-presets (review fix 2026-08-27): the 🔴 gap was that the
// default catalog never reached the task-author clone dir. The seed constant
// (written by CloneInitService on first init) is the single source — this test
// guards that the seeded content is PARSEABLE + consumable by the read-side
// (WorkflowPresetsService), so a fresh install's GET /api/workflow-presets is
// never permanently empty.

import { describe, it, expect } from "vitest"
import yaml from "js-yaml"
import { workflowPresetsCatalogSchema } from "@octopus/shared"
import {
  DEFAULT_WORKFLOW_PRESETS_YAML,
  PREV_DEFAULT_WORKFLOW_PRESETS_YAMLS,
  PRESETS_VERSION,
  hashPresetsContent,
} from "../workflow-presets-seed"

describe("DEFAULT_WORKFLOW_PRESETS_YAML (seed catalog)", () => {
  it("parses into a valid preset catalog with the general fallback", () => {
    const parsed = workflowPresetsCatalogSchema.parse(yaml.load(DEFAULT_WORKFLOW_PRESETS_YAML))
    expect(parsed.presets.length).toBeGreaterThanOrEqual(1)
    const general = parsed.presets.find((p) => p.skills_group.length === 0)
    expect(general).toBeDefined()
    expect(general!.workflow.length).toBeGreaterThan(0)
  })

  it("only uses ${goal}/${ac} placeholders (any placeholder must be resolvable)", () => {
    const parsed = workflowPresetsCatalogSchema.parse(yaml.load(DEFAULT_WORKFLOW_PRESETS_YAML))
    const allowed = /^\$\{(goal|ac)\}$/
    for (const preset of parsed.presets) {
      expect(preset.name.length).toBeGreaterThan(0)
      expect(preset.workflow.length).toBeGreaterThan(0)
      for (const value of Object.values(preset.inputs)) {
        // Every placeholder in a seeded value must be a resolvable one — a
        // typo here would surface as an unresolvable input at ready time.
        const placeholders = value.match(/\$\{(\w+)\}/g) ?? []
        for (const ph of placeholders) {
          expect(allowed.test(ph), `${preset.name}: bad placeholder ${ph}`).toBe(true)
        }
      }
    }
  })
})

// ── goal-task-dev (ticket 05): general-dev 换绑 task-dev + 版本迁移常量 ────

describe("preset seed versioning (goal-task-dev 05)", () => {
  it("general-dev binds built-in/task-dev with goal/ac skeleton (AC1)", () => {
    const parsed = workflowPresetsCatalogSchema.parse(yaml.load(DEFAULT_WORKFLOW_PRESETS_YAML))
    const general = parsed.presets.find((p) => p.name === "general-dev")
    expect(general).toBeDefined()
    expect(general!.workflow).toBe("built-in/task-dev")
    expect(general!.inputs).toEqual({ goal: "${goal}", ac: "${ac}" })
    // max_turns deliberately NOT in the skeleton — it rides the YAML default (200)

    // xzf / superpowers entries unchanged
    const xzf = parsed.presets.find((p) => p.name === "xzf-dev")
    expect(xzf!.workflow).toBe("built-in/xzf-dev")
    expect(xzf!.inputs).toEqual({ idea: "${goal}" })
    const sp = parsed.presets.find((p) => p.name === "superpowers-task-dev")
    expect(sp!.workflow).toBe("built-in/superpowers-task-dev")
    expect(sp!.inputs).toEqual({ goal: "${goal}", ac: "${ac}" })
  })

  it("new default carries a `# version: N` header matching PRESETS_VERSION", () => {
    const firstLine = DEFAULT_WORKFLOW_PRESETS_YAML.split("\n")[0]
    expect(firstLine).toBe(`# version: ${PRESETS_VERSION}`)
    expect(PRESETS_VERSION).toBe(2)
  })

  it("PREV defaults are the pre-migration literals (general-dev=matt-dev-pipeline)", () => {
    for (const prev of PREV_DEFAULT_WORKFLOW_PRESETS_YAMLS) {
      const parsed = workflowPresetsCatalogSchema.parse(yaml.load(prev))
      expect(parsed.presets.length).toBeGreaterThanOrEqual(1)
      const general = parsed.presets.find((p) => p.name === "general-dev")
      expect(general!.workflow).toBe("built-in/matt-dev-pipeline")
      // no version header on any prev default
      expect(prev.startsWith("# version:")).toBe(false)
    }
  })

  it("hashPresetsContent: normalizes version header + trailing whitespace, distinguishes real edits", () => {
    const newH = hashPresetsContent(DEFAULT_WORKFLOW_PRESETS_YAML)
    const prevH = hashPresetsContent(PREV_DEFAULT_WORKFLOW_PRESETS_YAMLS[PREV_DEFAULT_WORKFLOW_PRESETS_YAMLS.length - 1])
    // historical baselines are mutually distinct (each must be recognized)
    expect(new Set(PREV_DEFAULT_WORKFLOW_PRESETS_YAMLS.map(hashPresetsContent)).size)
      .toBe(PREV_DEFAULT_WORKFLOW_PRESETS_YAMLS.length)
    expect(newH).not.toBe(prevH)

    // header line + trailing whitespace do not change the identity hash
    expect(hashPresetsContent(DEFAULT_WORKFLOW_PRESETS_YAML + "\n\n")).toBe(newH)
    expect(hashPresetsContent(DEFAULT_WORKFLOW_PRESETS_YAML.replace(`# version: ${PRESETS_VERSION}\n`, ""))).toBe(newH)
    expect(hashPresetsContent(PREV_DEFAULT_WORKFLOW_PRESETS_YAMLS[PREV_DEFAULT_WORKFLOW_PRESETS_YAMLS.length - 1] + "\n")).toBe(prevH)

    // a genuine content edit changes it
    expect(hashPresetsContent(DEFAULT_WORKFLOW_PRESETS_YAML + "# tweaked\n")).not.toBe(newH)
  })
})