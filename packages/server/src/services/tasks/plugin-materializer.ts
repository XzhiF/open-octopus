// packages/server/src/services/tasks/plugin-materializer.ts
//
// PluginMaterializer — per-task plugin directory materialization (ADR-0010).
//
// Each task has a home dir `~/.octopus/tasks/{id}/` with a `skills/` subdirectory
// (created by TaskHomeService.createHome). This service turns the task's selected
// Skill groups into links inside that `skills/` dir so the Claude Agent SDK
// discovers them as a third plugin directory (CloneRuntime.getPlugins appends
// `taskHomePath` when the task-author session has a home — see clone-runtime.ts).
//
// Link strategy (AC2):
//   - Windows: junction via `fs.symlinkSync(target, path, "junction")` — no
//     administrator rights needed (unlike a true symlink). Node's lstat reports
//     junctions as symbolic links, so TaskHomeService.reapHome correctly
//     unlinks them as links rather than following into the target (SW-BP14).
//   - POSIX: directory symlink via `fs.symlinkSync(target, path, "dir")`.
//   - Failure → copy the directory recursively as a degraded fallback
//     (`fs.cpSync(target, linkPath, { recursive: true })`). The skill is still
//     discoverable; only staleness on re-install is the trade-off.
//
// "default" group (AC3, D17): an empty marker — selecting it means "use only the
// built-in spec-field flow + shared skills (already exposed via plugin #1,
// `~/.octopus/agent`). Materializing it would cause the SDK to re-discover the
// same skills, so we skip it entirely (no outcomes emitted).
//
// Idempotency (AC4): if an entry already exists at `{home}/skills/{name}`:
//   - a symlink/junction → skip (the link is already there; re-linking would
//     unlink+recreate with no benefit and a small race window).
//   - a real directory/file → skip and do NOT replace (the agent may have
//     hand-written a skill there; trashing user content is unacceptable).
//
// Non-fatal: a skill whose installPath is missing from disk, or which fails
// both link and copy, is recorded as `method: "fail"` and the run continues —
// the task-author session can still proceed with the other skills.

import fs from "fs"
import path from "path"
import type { ResourceManager } from "@octopus/shared"

/** The built-in "default" group — an empty marker, not materialized (D17). */
export const DEFAULT_SKILL_GROUP = "default"

const SKILLS_DIR = "skills"

export type MaterializeMethod = "link" | "copy" | "skip" | "fail"

export interface MaterializeOutcome {
  group: string
  skill: string
  method: MaterializeMethod
  reason?: string
}

export interface MaterializeResult {
  outcomes: MaterializeOutcome[]
}

export class PluginMaterializer {
  private readonly rm: ResourceManager

  constructor(rm: ResourceManager) {
    this.rm = rm
  }

  /**
   * Materialize the given Skill groups into `{home}/skills/` as links (or
   * copies on fallback). Idempotent. The `skills/` dir is created on demand.
   * Returns one outcome per installed skill encountered (default group emits
   * none).
   */
  materializeGroups(home: string, groups: string[]): MaterializeResult {
    const skillsDir = path.join(home, SKILLS_DIR)
    fs.mkdirSync(skillsDir, { recursive: true })

    const installed = this.rm.list({ type: "skill", installed: true }).resources
    const outcomes: MaterializeOutcome[] = []

    for (const group of groups) {
      // AC3 / D17: "default" is an empty marker — skip entirely. Shared skills
      // are already exposed via plugin #1 (~/.octopus/agent); re-materializing
      // would cause SDK duplicate discovery.
      if (group === DEFAULT_SKILL_GROUP) continue

      const groupSkills = installed.filter((e) => e.group === group)
      for (const entry of groupSkills) {
        const linkPath = path.join(skillsDir, entry.name)
        outcomes.push(this.linkOrCopy(entry.installPath, linkPath, group, entry.name))
      }
    }

    return { outcomes }
  }

  /**
   * Create a link at `linkPath` pointing to `target`, or fall back to a copy.
   * - Existing symlink/junction → skip (idempotent).
   * - Existing real dir/file → skip (don't trash user content).
   * - Missing target → fail (skill was unregistered from under us).
   * - symlink throw → copy fallback.
   * - copy throw → fail (non-fatal, run continues).
   */
  private linkOrCopy(
    target: string,
    linkPath: string,
    group: string,
    skill: string,
  ): MaterializeOutcome {
    // lstat (not stat/existsSync) so a symlink is detected even if its target
    // is missing — existsSync follows the link and would return false for a
    // dangling link, causing us to try symlinkSync which then fails EEXIST.
    let existing: fs.Stats | null = null
    try {
      existing = fs.lstatSync(linkPath)
    } catch {
      existing = null
    }
    if (existing) {
      const reason = existing.isSymbolicLink()
        ? "link already exists"
        : "non-link entry already exists"
      return { group, skill, method: "skip", reason }
    }

    // Target missing on disk — skill was unregistered from under us. Don't
    // try to link (would create a dangling link) or copy (would fail).
    if (!fs.existsSync(target)) {
      return { group, skill, method: "fail", reason: `installPath missing: ${target}` }
    }

    // AC2: platform-appropriate link. Junction on Windows (no admin), dir
    // symlink on POSIX. Both report isSymbolicLink() on lstat.
    try {
      this.createLink(target, linkPath)
      return { group, skill, method: "link" }
    } catch (linkErr) {
      const linkMsg = linkErr instanceof Error ? linkErr.message : String(linkErr)
      // Fallback: copy the directory recursively. The skill is still
      // discoverable; staleness on re-install is the accepted trade-off.
      try {
        fs.cpSync(target, linkPath, { recursive: true })
        return { group, skill, method: "copy", reason: `link failed: ${linkMsg}` }
      } catch (copyErr) {
        const copyMsg = copyErr instanceof Error ? copyErr.message : String(copyErr)
        // eslint-disable-next-line no-console
        console.warn(
          `[plugin-materializer] both link and copy failed for ${skill} (group=${group}): link=${linkMsg}; copy=${copyMsg}`,
        )
        return {
          group,
          skill,
          method: "fail",
          reason: `link failed: ${linkMsg}; copy failed: ${copyMsg}`,
        }
      }
    }
  }

  /** Create a platform-appropriate link: junction on Windows (no admin rights),
   *  directory symlink on POSIX. Both are reported as symbolic links by lstat,
   *  so TaskHomeService.reapHome unlinks them as links (SW-BP14). */
  private createLink(target: string, linkPath: string): void {
    if (process.platform === "win32") {
      // "junction" type skips the privilege check for directory links.
      fs.symlinkSync(target, linkPath, "junction")
    } else {
      fs.symlinkSync(target, linkPath, "dir")
    }
  }
}
