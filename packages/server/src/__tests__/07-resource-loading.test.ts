// packages/server/src/__tests__/07-resource-loading.test.ts
//
// Ticket 07 — SG6 (authoring_resources prompt-inject) + SG7 (resources →
// config.requires → workflow.requires UNION) + SG11 (TaskAuthorSessionAugmenter
// resurrects dead `enhancePromptWithSkills`).
//
// Peer-audit correction: task-author uses `getProvider('claude')` (Claude SDK),
// NOT Pi. `assembleContext()` is already fresh per turn (clone-runtime.ts:278);
// the `systemPrompt.append` seam (clone-runtime.ts:346-348) is where
// authoring_resources SKILL.md content is injected — the same seam 05's
// specUpdateNotice uses. No fresh-session / pi-adapter / DB-history-prepend.
//
// Scope:
//   AC1 (SG7): materializeTaskSpecToConfig propagates tasks.resources[] +
//              subunit.resources[] → config.requires (UNION, deduped)
//   AC2 (SG7): EngineInitPhase UNION-merges configRequires → workflow.requires
//              for provisioning (no override, no duplicates)
//   AC3 (SG11): TaskAuthorSessionAugmenter resolves authoring_resources[] →
//               SKILL.md content via ResourceManager + enhancePromptWithSkills
//   AC4 (SG6): CloneRuntime.chat appends authoringResourcesContent to
//              systemPrompt.append (alongside specUpdateNotice)
//
// Anti-fake-run: real better-sqlite3 + applySchema where DB is touched (R1/R3),
// real ResourceManager with temp basePath (R5), assert on spy call args (R4).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "fs"
import path from "path"
import os from "os"
import { materializeTaskSpecToConfig } from "../services/scheduler/scheduler-service"
import { ResourceManager } from "@octopus/shared"
import type { TaskSpec, ResourceRef, WorkflowDef } from "@octopus/shared"
import { TaskAuthorSessionAugmenter } from "../services/tasks/task-author-session-augmenter"
import { CloneRuntime } from "../services/agent/clone-runtime"
import type { CloneDef } from "@octopus/shared"
import { enhancePromptWithSkills } from "@octopus/providers"

const ORG = "e2e-td-07"

// ── AC1: SG7 materialize resources → config.requires ────────────────

describe("07 SG7: materializeTaskSpecToConfig propagates resources → config.requires", () => {
  it("propagates task-level resources[] → config.requires (all 4 types)", () => {
    const taskSpec: TaskSpec = {
      goal: "g",
      ac: ["a"],
      resources: [
        { type: "skill", name: "octo-backend" },
        { type: "agent", name: "code-reviewer" },
        { type: "command", name: "ship" },
        { type: "rule", name: "coding-style" },
      ],
    }
    const config = materializeTaskSpecToConfig(
      taskSpec,
      ["proj"],
      ORG,
      "wf",
      [],
      taskSpec.resources,
    )
    expect(config.requires?.skills).toContain("octo-backend")
    expect(config.requires?.agent_files).toContain("code-reviewer")
    expect(config.requires?.commands).toContain("ship")
    expect(config.requires?.rules).toContain("coding-style")
  })

  it("propagates subunit.resources[] → config.requires (flattened + deduped)", () => {
    const taskSpec: TaskSpec = {
      goal: "g",
      ac: ["a"],
      subunits: [
        {
          name: "sub-a",
          workspace_spec: { org: ORG, branch_prefix: "e2e-td-07-a", projects: [{ name: "p", source_path: "", group: "" }] },
          workflow_ref: "wf-a",
          input_values: {},
          skills: [],
          resources: [{ type: "skill", name: "shared-skill" }],
        },
        {
          name: "sub-b",
          workspace_spec: { org: ORG, branch_prefix: "e2e-td-07-b", projects: [{ name: "p", source_path: "", group: "" }] },
          workflow_ref: "wf-b",
          input_values: {},
          skills: [],
          resources: [
            { type: "skill", name: "shared-skill" }, // dupe
            { type: "command", name: "ship-cmd" },
          ],
        },
      ],
    }
    const config = materializeTaskSpecToConfig(taskSpec, ["proj"], ORG, undefined, [])
    // 'shared-skill' appears once (deduped)
    expect(config.requires?.skills).toEqual(["shared-skill"])
    expect(config.requires?.commands).toEqual(["ship-cmd"])
  })

  it("UNION-merges task-level + subunit-level resources (deduped)", () => {
    const taskSpec: TaskSpec = {
      goal: "g",
      ac: ["a"],
      resources: [{ type: "skill", name: "task-skill" }],
      subunits: [
        {
          name: "sub-a",
          workspace_spec: { org: ORG, branch_prefix: "e2e-td-07-c", projects: [{ name: "p", source_path: "", group: "" }] },
          workflow_ref: "wf-a",
          input_values: {},
          skills: [],
          resources: [
            { type: "skill", name: "task-skill" }, // dupe with task-level
            { type: "skill", name: "sub-skill" },
          ],
        },
      ],
    }
    const config = materializeTaskSpecToConfig(
      taskSpec,
      ["proj"],
      ORG,
      undefined,
      [],
      taskSpec.resources, // task-level resources
    )
    expect(config.requires?.skills).toEqual(expect.arrayContaining(["task-skill", "sub-skill"]))
    expect(config.requires?.skills).toHaveLength(2)
  })

  it("omits requires when no resources (backward compat with 06's AC4)", () => {
    const taskSpec: TaskSpec = { goal: "g", ac: ["a"] }
    const config = materializeTaskSpecToConfig(taskSpec, ["proj"], ORG, "wf", [])
    expect(config.requires).toBeUndefined()
  })
})

// ── AC3: SG11 TaskAuthorSessionAugmenter ────────────────────────────

describe("07 SG11: TaskAuthorSessionAugmenter resolves authoring_resources → SKILL.md content", () => {
  let tmpBase: string

  beforeEach(() => {
    tmpBase = path.join(os.tmpdir(), `octopus-res-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  })
  afterEach(() => {
    try { fs.rmSync(tmpBase, { recursive: true, force: true }) } catch { /* non-fatal */ }
  })

  /** Install a skill into a temp ResourceManager registry + filesystem. */
  function installSkill(rm: ResourceManager, name: string, group: string, content: string): void {
    // getInstallPath: basePath/installed/skills/{group}/{name}/SKILL.md
    const skillDir = path.join(tmpBase, "installed", "skills", group, name)
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), content, "utf-8")
    rm.registerInstalled({ name, type: "skill", group })
  }

  it("resolves a single skill authoring_resource → content string via enhancePromptWithSkills", () => {
    const rm = new ResourceManager({ basePath: tmpBase })
    installSkill(rm, "octo-fake", "test", "# Fake Skill\n\nDoes fake backend things.")

    const augmenter = new TaskAuthorSessionAugmenter(rm)
    const content = augmenter.resolveAuthoringResourcesContent([
      { type: "skill", name: "octo-fake" },
    ])
    // enhancePromptWithSkills format: "## Available Skills\n### <name>\n<content>"
    expect(content).toContain("## Available Skills")
    expect(content).toContain("octo-fake")
    expect(content).toContain("Does fake backend things.")
  })

  it("resolves multiple skills (each section labeled with skill name)", () => {
    const rm = new ResourceManager({ basePath: tmpBase })
    installSkill(rm, "skill-a", "g", "Content A body.")
    installSkill(rm, "skill-b", "g", "Content B body.")

    const augmenter = new TaskAuthorSessionAugmenter(rm)
    const content = augmenter.resolveAuthoringResourcesContent([
      { type: "skill", name: "skill-a" },
      { type: "skill", name: "skill-b" },
    ])
    expect(content).toContain("### skill-a")
    expect(content).toContain("Content A body.")
    expect(content).toContain("### skill-b")
    expect(content).toContain("Content B body.")
    // Order preserved (skill-a before skill-b)
    expect(content.indexOf("skill-a")).toBeLessThan(content.indexOf("skill-b"))
  })

  it("returns empty string when authoring_resources is empty", () => {
    const rm = new ResourceManager({ basePath: tmpBase })
    const augmenter = new TaskAuthorSessionAugmenter(rm)
    expect(augmenter.resolveAuthoringResourcesContent([])).toBe("")
  })

  it("skips non-skill resources (only skills are prompt-injected, v2-D8)", () => {
    const rm = new ResourceManager({ basePath: tmpBase })
    const augmenter = new TaskAuthorSessionAugmenter(rm)
    // commands/agents/rules are NOT prompt-injected (they're workspace-scope →
    // workflow.requires, not draft-scope prompt content). Only skills inject.
    const content = augmenter.resolveAuthoringResourcesContent([
      { type: "command", name: "ship" },
      { type: "agent", name: "code-reviewer" },
      { type: "rule", name: "coding-style" },
    ])
    expect(content).toBe("")
  })

  it("skips uninstalled skills gracefully (non-fatal)", () => {
    const rm = new ResourceManager({ basePath: tmpBase })
    const augmenter = new TaskAuthorSessionAugmenter(rm)
    // 'not-installed' was never registered — ResourceManager.readFile throws
    // RESOURCE_NOT_FOUND. The augmenter swallows it and returns "" (no skill
    // content to inject). The chat reply is unaffected.
    const content = augmenter.resolveAuthoringResourcesContent([
      { type: "skill", name: "not-installed" },
    ])
    expect(content).toBe("")
  })

  it("augmentPrompt composes base prompt + SKILL.md content (full systemPrompt builder)", () => {
    const rm = new ResourceManager({ basePath: tmpBase })
    installSkill(rm, "octo-backend", "g", "# Backend\nBuild the backend service.")

    const augmenter = new TaskAuthorSessionAugmenter(rm)
    const basePrompt = "You are the task-author clone."
    const augmented = augmenter.augmentPrompt(basePrompt, [
      { type: "skill", name: "octo-backend" },
    ])
    // Base prompt preserved at the front
    expect(augmented.startsWith(basePrompt)).toBe(true)
    // SKILL.md content appended via enhancePromptWithSkills
    expect(augmented).toContain("## Available Skills")
    expect(augmented).toContain("Build the backend service.")
  })
})
