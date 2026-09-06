// packages/server/src/services/agent/__tests__/workflow-presets-seed.test.ts
//
// task-workflow-presets (review fix 2026-08-27): the default catalog must
// reach the task-author clone dir and be PARSEABLE + consumable by the
// read-side (WorkflowPresetsService), so a fresh install's
// GET /api/workflow-presets is never permanently empty.
//
// binding-catalog redesign (2026-09-06): v3 default = the v4 binding catalog
// (spec-dev → built-in/matt-spec-dev with the ${phase.batch_rel} skeleton);
// skills_group retired; historical literals are migration baselines only.

import { describe, it, expect } from "vitest"
import yaml from "js-yaml"
import { workflowPresetsCatalogSchema } from "@octopus/shared"
import {
  DEFAULT_WORKFLOW_PRESETS_YAML,
  PREV_DEFAULT_WORKFLOW_PRESETS_YAMLS,
  PREV_DEFAULT_V1A_WORKFLOW_PRESETS_YAML,
  PREV_DEFAULT_V1B_WORKFLOW_PRESETS_YAML,
  PREV_DEFAULT_V2_WORKFLOW_PRESETS_YAML,
  PRESETS_VERSION,
  hashPresetsContent,
} from "../workflow-presets-seed"

// v4 词表 + v3 遗留 goal/ac（骨架必须全部可解析，否则 ready 报 input）
const RESOLVABLE_PLACEHOLDER = /^\$\{(goal|ac|phase\.slug|phase\.spec_dir|phase\.batch_rel|task\.home|task_artifacts_dir)\}$/

describe("DEFAULT_WORKFLOW_PRESETS_YAML (binding catalog v3)", () => {
  it("parses and carries the v4 default: spec-dev → matt-spec-dev with batch_dir skeleton", () => {
    const parsed = workflowPresetsCatalogSchema.parse(yaml.load(DEFAULT_WORKFLOW_PRESETS_YAML))
    expect(parsed.presets.length).toBeGreaterThanOrEqual(1)
    const specDev = parsed.presets.find((p) => p.name === "spec-dev")
    expect(specDev).toBeDefined()
    expect(specDev!.workflow).toBe("built-in/matt-spec-dev")
    expect(specDev!.inputs).toEqual({ batch_dir: "${phase.batch_rel}" })
  })

  it("no retired-flow refs in the default catalog (v3 = v4 主打 only)", () => {
    for (const wf of ["built-in/task-dev", "built-in/matt-dev-pipeline", "built-in/xzf-dev", "built-in/superpowers-task-dev"]) {
      expect(DEFAULT_WORKFLOW_PRESETS_YAML, wf).not.toContain(wf)
    }
  })

  it("every placeholder in every skeleton is resolvable vocabulary", () => {
    const parsed = workflowPresetsCatalogSchema.parse(yaml.load(DEFAULT_WORKFLOW_PRESETS_YAML))
    for (const preset of parsed.presets) {
      expect(preset.name.length).toBeGreaterThan(0)
      expect(preset.workflow.length).toBeGreaterThan(0)
      for (const value of Object.values(preset.inputs)) {
        const placeholders = value.match(/\$\{[\w.]+\}/g) ?? []
        for (const ph of placeholders) {
          expect(RESOLVABLE_PLACEHOLDER.test(ph), `${preset.name}: bad placeholder ${ph}`).toBe(true)
        }
      }
    }
  })

  it("管理键不在骨架里（server 派发注入，手填即双源）", () => {
    const parsed = workflowPresetsCatalogSchema.parse(yaml.load(DEFAULT_WORKFLOW_PRESETS_YAML))
    for (const preset of parsed.presets) {
      for (const key of Object.keys(preset.inputs)) {
        expect(["task_artifacts_dir", "prev_handoff_paths", "feedback", "feedback_path", "phase_spec_dir"].includes(key), key).toBe(false)
      }
    }
  })

  it("carries a `# version: N` header matching PRESETS_VERSION (v3)", () => {
    const firstLine = DEFAULT_WORKFLOW_PRESETS_YAML.split("\n")[0]
    expect(firstLine).toBe(`# version: ${PRESETS_VERSION}`)
    expect(PRESETS_VERSION).toBe(3)
  })
})

describe("PREV migration baselines", () => {
  it("PREV list contains every historical default, mutually distinct, all parseable", () => {
    expect(PREV_DEFAULT_WORKFLOW_PRESETS_YAMLS).toEqual([
      PREV_DEFAULT_V1A_WORKFLOW_PRESETS_YAML,
      PREV_DEFAULT_V1B_WORKFLOW_PRESETS_YAML,
      PREV_DEFAULT_V2_WORKFLOW_PRESETS_YAML,
    ])
    expect(new Set(PREV_DEFAULT_WORKFLOW_PRESETS_YAMLS.map(hashPresetsContent)).size)
      .toBe(PREV_DEFAULT_WORKFLOW_PRESETS_YAMLS.length)
    for (const prev of PREV_DEFAULT_WORKFLOW_PRESETS_YAMLS) {
      const parsed = workflowPresetsCatalogSchema.parse(yaml.load(prev))
      expect(parsed.presets.length).toBeGreaterThanOrEqual(1)
    }
  })

  it("v1a/v1b bind general-dev → matt-dev-pipeline (pre-goal-task-dev)", () => {
    for (const prev of [PREV_DEFAULT_V1A_WORKFLOW_PRESETS_YAML, PREV_DEFAULT_V1B_WORKFLOW_PRESETS_YAML]) {
      const parsed = workflowPresetsCatalogSchema.parse(yaml.load(prev))
      const general = parsed.presets.find((p) => p.name === "general-dev")
      expect(general!.workflow).toBe("built-in/matt-dev-pipeline")
      // no version header on the pre-v2 literals
      expect(prev.startsWith("# version:")).toBe(false)
    }
  })

  it("v2 binds general-dev → task-dev and carries the `# version: 2` header", () => {
    expect(PREV_DEFAULT_V2_WORKFLOW_PRESETS_YAML.startsWith("# version: 2\n")).toBe(true)
    const parsed = workflowPresetsCatalogSchema.parse(yaml.load(PREV_DEFAULT_V2_WORKFLOW_PRESETS_YAML))
    const general = parsed.presets.find((p) => p.name === "general-dev")
    expect(general!.workflow).toBe("built-in/task-dev")
    // retired skills_group keys are stripped by the new schema, parse still succeeds
    expect("skills_group" in parsed.presets[0]).toBe(false)
  })

  it("hashPresetsContent: normalizes version header + trailing whitespace, distinguishes real edits", () => {
    const newH = hashPresetsContent(DEFAULT_WORKFLOW_PRESETS_YAML)
    const prevH = hashPresetsContent(PREV_DEFAULT_V2_WORKFLOW_PRESETS_YAML)
    expect(newH).not.toBe(prevH)

    // header line + trailing whitespace do not change the identity hash
    expect(hashPresetsContent(DEFAULT_WORKFLOW_PRESETS_YAML + "\n\n")).toBe(newH)
    expect(hashPresetsContent(DEFAULT_WORKFLOW_PRESETS_YAML.replace(`# version: ${PRESETS_VERSION}\n`, ""))).toBe(newH)
    expect(hashPresetsContent(PREV_DEFAULT_V2_WORKFLOW_PRESETS_YAML + "\n")).toBe(prevH)

    // a genuine content edit changes it
    expect(hashPresetsContent(DEFAULT_WORKFLOW_PRESETS_YAML + "# tweaked\n")).not.toBe(newH)
  })
})
