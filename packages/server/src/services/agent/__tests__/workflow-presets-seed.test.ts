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
import { DEFAULT_WORKFLOW_PRESETS_YAML } from "../workflow-presets-seed"

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