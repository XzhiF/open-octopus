// packages/server/src/services/tasks/task-author-session-augmenter.ts
//
// 07 — SG11 TaskAuthorSessionAugmenter.
//
// Resurrects the dead `enhancePromptWithSkills` (packages/providers/src/pi/
// prompt-enhancer.ts) by wiring it into the task-author draft-scope resource
// loading path (v2-D8/D13). The augmenter resolves `tasks.authoring_resources[]`
// (draft-scope, set by the agent via the `update_task_spec_field` tool
// field='authoring_resources' — 03 built that endpoint) to installed skill
// SKILL.md content via the global ResourceManager, formats it via
// `enhancePromptWithSkills`, and returns the content string for the clone chat
// route to inject into the task-author session's `systemPrompt.append`
// (clone-runtime.ts:346-348 — the same seam 05's specUpdateNotice uses).
//
// Scope (v2-D8/D13): ONLY `skill`-type authoring_resources are prompt-injected.
// agent/command/rule resources are workspace-scope (→ workflow.requires at
// dispatch, SG7) and are NOT injected into the draft prompt.
//
// Draft scope ≠ workspace scope:
//   - authoring_resources[] (draft) → THIS augmenter → task-author systemPrompt
//   - resources[] (workspace)     → materialize → config.requires → workflow.requires
//
// Non-fatal: an uninstalled/unreadable skill is skipped (the chat reply is
// unaffected — the agent simply doesn't see that skill's content this turn).
// The agent can still install resources via the resource CLI and re-set
// authoring_resources to retry on the next turn.

import type { ResourceManager, ResourceRef } from "@octopus/shared"
import { enhancePromptWithSkills } from "@octopus/providers"

const SKILL_FILE = "SKILL.md"

export class TaskAuthorSessionAugmenter {
  private resourceManager: ResourceManager

  constructor(resourceManager: ResourceManager) {
    this.resourceManager = resourceManager
  }

  /**
   * Resolve authoring_resources[] (draft-scope) → a formatted SKILL.md
   * content string suitable for appending to the task-author session's
   * systemPrompt. Returns "" when no skill content is available (no skills,
   * only non-skill refs, or all skills uninstalled).
   *
   * The output format is produced by `enhancePromptWithSkills`
   * ("## Available Skills\n### <name>\n<content>..."). The clone chat route
   * appends this string to the systemPrompt base via CloneRuntime.chat's
   * `authoringResourcesContent` param → sendWithProvider's `append` concat
   * (clone-runtime.ts:346-348, alongside specUpdateNotice).
   */
  resolveAuthoringResourcesContent(authoringResources: ResourceRef[]): string {
    const skills: string[] = []
    const skillContents: Record<string, string> = {}

    for (const ref of authoringResources) {
      // v2-D8/D13: only skills are prompt-injected. agent/command/rule are
      // workspace-scope (→ workflow.requires via SG7 materialize), not draft-scope.
      if (ref.type !== "skill") continue
      try {
        // ResourceManager.readFile does path-traversal-safe reading from the
        // resource's installPath (resource-manager.ts:633). Throws
        // RESOURCE_NOT_FOUND when the skill isn't installed — caught below.
        const content = this.resourceManager.readFile("skill", ref.name, SKILL_FILE)
        if (content) {
          skills.push(ref.name)
          skillContents[ref.name] = content
        }
      } catch {
        // Uninstalled / unreadable skill — skip (non-fatal). The agent can
        // install the resource and re-set authoring_resources next turn.
      }
    }

    // enhancePromptWithSkills returns the prompt unchanged when skills is empty.
    // We pass an empty base ("") so the output is just the skill sections (the
    // route composes it with the real cloneContext base separately).
    return enhancePromptWithSkills("", { skills, skillContents })
  }

  /**
   * Compose a base system prompt with authoring_resources[] SKILL.md content.
   * Convenience wrapper: base + resolveAuthoringResourcesContent() via
   * enhancePromptWithSkills. Used when the caller wants the augmenter to do
   * both the base + skills composition in one call.
   */
  augmentPrompt(basePrompt: string, authoringResources: ResourceRef[]): string {
    const content = this.resolveAuthoringResourcesContent(authoringResources)
    if (!content) return basePrompt
    return `${basePrompt}\n\n${content}`
  }
}
