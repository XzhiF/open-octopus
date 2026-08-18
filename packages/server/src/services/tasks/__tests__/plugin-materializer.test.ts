// packages/server/src/services/tasks/__tests__/plugin-materializer.test.ts
//
// Ticket 03 — PluginMaterializer unit tests (ADR-0010, D17, SW-BP14).
//
// Seam under test: PluginMaterializer.materializeGroups(home, groups) — the
// public method that turns selected Skill groups into per-task plugin links.
// We observe behavior through the filesystem (readdir / readFileSync / lstat)
// and the returned outcome array. No DB, no real ~/.octopus.
//
// Test infrastructure mirrors 07-resource-loading.test.ts: a temp ResourceManager
// basePath + `rm.registerInstalled({ name, type: "skill", group })` + writing
// SKILL.md at `basePath/installed/skills/{group}/{name}/SKILL.md`.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "fs"
import path from "path"
import os from "os"
import { ResourceManager } from "@octopus/shared"
import { PluginMaterializer, DEFAULT_SKILL_GROUP } from "../plugin-materializer"

// ── Test helpers ───────────────────────────────────────────────────

function createTempBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "plugin-mat-"))
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

/** Install a skill into a temp ResourceManager registry + filesystem.
 *  Mirrors 07-resource-loading.test.ts: installSkill(rm, name, group, content). */
function installSkill(
  rm: ResourceManager,
  basePath: string,
  name: string,
  group: string,
  content: string,
): void {
  // getInstallPath: basePath/installed/skills/{group}/{name}/
  const skillDir = path.join(basePath, "installed", "skills", group, name)
  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), content, "utf-8")
  rm.registerInstalled({ name, type: "skill", group })
}

/** Create a fresh task home (just the dir; materializer creates skills/ on demand). */
function createTaskHome(base: string, id: string): string {
  const home = path.join(base, "tasks", id)
  fs.mkdirSync(home, { recursive: true })
  return home
}

describe("PluginMaterializer", () => {
  let rmBase: string
  let homeBase: string
  let rm: ResourceManager
  let materializer: PluginMaterializer
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    rmBase = createTempBase()
    homeBase = createTempBase()
    rm = new ResourceManager({ basePath: rmBase })
    materializer = new PluginMaterializer(rm)
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
    vi.restoreAllMocks()
    cleanupDir(rmBase)
    cleanupDir(homeBase)
  })

  // ── AC1: materializeGroups links each skill in each group ─────────

  describe("AC1 — materializeGroups links each skill in each group", () => {
    it("creates a link per skill and SKILL.md is readable through the link", () => {
      installSkill(rm, rmBase, "octo-foo", "g1", "# Foo\n\nFoo skill body.")
      installSkill(rm, rmBase, "octo-bar", "g1", "# Bar\n\nBar skill body.")
      const home = createTaskHome(homeBase, "t-1")

      const result = materializer.materializeGroups(home, ["g1"])

      expect(result.outcomes).toHaveLength(2)
      // Each skill name appears in the outcomes
      const skillNames = result.outcomes.map((o) => o.skill).sort()
      expect(skillNames).toEqual(["octo-bar", "octo-foo"])
      // All outcomes are "link" method
      expect(result.outcomes.every((o) => o.method === "link")).toBe(true)
      // The links exist at {home}/skills/{name}/ and SKILL.md is readable through them
      for (const name of ["octo-foo", "octo-bar"]) {
        const linkPath = path.join(home, "skills", name)
        expect(fs.existsSync(linkPath)).toBe(true)
        const skillMd = path.join(linkPath, "SKILL.md")
        expect(fs.existsSync(skillMd)).toBe(true)
        const content = fs.readFileSync(skillMd, "utf-8")
        expect(content).toContain(name === "octo-foo" ? "Foo skill body" : "Bar skill body")
      }
    })

    it("materializes multiple groups in one call (union of skills)", () => {
      installSkill(rm, rmBase, "s-a", "g1", "# A\n\nA body.")
      installSkill(rm, rmBase, "s-b", "g2", "# B\n\nB body.")
      const home = createTaskHome(homeBase, "t-multi")

      const result = materializer.materializeGroups(home, ["g1", "g2"])

      expect(result.outcomes).toHaveLength(2)
      const skills = result.outcomes.map((o) => o.skill).sort()
      expect(skills).toEqual(["s-a", "s-b"])
      // Both readable
      expect(fs.readFileSync(path.join(home, "skills", "s-a", "SKILL.md"), "utf-8")).toContain("A body.")
      expect(fs.readFileSync(path.join(home, "skills", "s-b", "SKILL.md"), "utf-8")).toContain("B body.")
    })

    it("creates skills/ dir on demand when home has no skeleton yet", () => {
      installSkill(rm, rmBase, "solo", "g1", "# Solo\n\nSolo body.")
      // Home dir exists but no skills/ subdir
      const home = path.join(homeBase, "tasks", "t-bare")
      fs.mkdirSync(home, { recursive: true })
      expect(fs.existsSync(path.join(home, "skills"))).toBe(false)

      materializer.materializeGroups(home, ["g1"])

      expect(fs.existsSync(path.join(home, "skills", "solo"))).toBe(true)
    })

    it("group with no installed skills → no outcomes, no error", () => {
      const home = createTaskHome(homeBase, "t-empty-group")
      const result = materializer.materializeGroups(home, ["g-empty"])
      expect(result.outcomes).toEqual([])
      // skills/ dir still created (idempotent scaffold)
      expect(fs.existsSync(path.join(home, "skills"))).toBe(true)
    })

    it("empty groups array → no outcomes, no error, skills/ still created", () => {
      const home = createTaskHome(homeBase, "t-empty-groups")
      const result = materializer.materializeGroups(home, [])
      expect(result.outcomes).toEqual([])
      expect(fs.existsSync(path.join(home, "skills"))).toBe(true)
    })

    it("skill registered but installPath missing on disk → fail outcome, non-fatal", () => {
      installSkill(rm, rmBase, "ghost", "g1", "# Ghost\n\nGhost body.")
      const home = createTaskHome(homeBase, "t-ghost")
      // Wipe the install dir AFTER registering — registry still lists it
      fs.rmSync(path.join(rmBase, "installed", "skills", "g1", "ghost"), {
        recursive: true,
        force: true,
      })

      const result = materializer.materializeGroups(home, ["g1"])

      expect(result.outcomes).toHaveLength(1)
      expect(result.outcomes[0]!.method).toBe("fail")
      expect(result.outcomes[0]!.skill).toBe("ghost")
      // No link created
      expect(fs.existsSync(path.join(home, "skills", "ghost"))).toBe(false)
    })
  })

  // ── AC2: link type + copy fallback ────────────────────────────────

  describe("AC2 — link is a symlink/junction per lstat; copy fallback", () => {
    it("the created link is reported as a symlink by lstat (junction on win, symlink on posix)", () => {
      installSkill(rm, rmBase, "lstat-skill", "g1", "# L\n\nL body.")
      const home = createTaskHome(homeBase, "t-lstat")

      materializer.materializeGroups(home, ["g1"])

      const linkPath = path.join(home, "skills", "lstat-skill")
      const lst = fs.lstatSync(linkPath)
      // Both Windows junctions and POSIX symlinks report isSymbolicLink() === true
      expect(lst.isSymbolicLink()).toBe(true)
    })

    it("falls back to copy when symlink creation throws (method=copy, content readable)", () => {
      installSkill(rm, rmBase, "copy-skill", "g1", "# Copy\n\nCopy body.")
      const home = createTaskHome(homeBase, "t-copy")

      // Force fs.symlinkSync to throw — simulates a locked-down temp dir or
      // a platform where symlink needs privileges the test runner lacks.
      const spy = vi
        .spyOn(fs, "symlinkSync")
        .mockImplementation(() => {
          throw new Error("synthetic symlink permission denied")
        })

      const result = materializer.materializeGroups(home, ["g1"])

      spy.mockRestore()

      expect(result.outcomes).toHaveLength(1)
      expect(result.outcomes[0]!.method).toBe("copy")
      // The link path is now a REAL directory (copy), not a symlink
      const linkPath = path.join(home, "skills", "copy-skill")
      expect(fs.lstatSync(linkPath).isDirectory()).toBe(true)
      expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(false)
      // Content is readable through the copy
      const content = fs.readFileSync(path.join(linkPath, "SKILL.md"), "utf-8")
      expect(content).toContain("Copy body.")
    })
  })

  // ── AC3: "default" group is an empty marker — skip materialization ─

  describe("AC3 — default group is an empty marker (D17, not materialized)", () => {
    it('group === "default" → no outcomes, no link created', () => {
      // Even if a skill is registered under group "default", the materializer
      // must skip it — D17: default is an empty marker, shared skills are
      // already exposed via plugin #1 (~/.octopus/agent), re-materializing
      // would cause the SDK to discover duplicates.
      installSkill(rm, rmBase, "dont-mat", "default", "# D\n\nD body.")
      const home = createTaskHome(homeBase, "t-default")

      const result = materializer.materializeGroups(home, ["default"])

      expect(result.outcomes).toEqual([])
      expect(fs.existsSync(path.join(home, "skills", "dont-mat"))).toBe(false)
    })

    it("DEFAULT_SKILL_GROUP constant equals 'default'", () => {
      expect(DEFAULT_SKILL_GROUP).toBe("default")
    })

    it("mixed default + real group → only real group contributes", () => {
      installSkill(rm, rmBase, "dont-mat", "default", "# D\n\nD body.")
      installSkill(rm, rmBase, "real-skill", "g1", "# R\n\nR body.")
      const home = createTaskHome(homeBase, "t-mixed")

      const result = materializer.materializeGroups(home, ["default", "g1"])

      expect(result.outcomes).toHaveLength(1)
      expect(result.outcomes[0]!.skill).toBe("real-skill")
      expect(fs.existsSync(path.join(home, "skills", "dont-mat"))).toBe(false)
      expect(fs.existsSync(path.join(home, "skills", "real-skill"))).toBe(true)
    })
  })

  // ── AC4: idempotent re-materialization ───────────────────────────

  describe("AC4 — idempotent (re-materialize does not error)", () => {
    it("calling twice with same args — second call does not throw, links still readable", () => {
      installSkill(rm, rmBase, "idem", "g1", "# I\n\nI body.")
      const home = createTaskHome(homeBase, "t-idem")

      const r1 = materializer.materializeGroups(home, ["g1"])
      expect(() => materializer.materializeGroups(home, ["g1"])).not.toThrow()

      // First call linked
      expect(r1.outcomes.every((o) => o.method === "link")).toBe(true)
      // Link still readable after second call
      const content = fs.readFileSync(path.join(home, "skills", "idem", "SKILL.md"), "utf-8")
      expect(content).toContain("I body.")
    })

    it("re-materialize an existing link → skip outcome (idempotent, no replace-thrash)", () => {
      installSkill(rm, rmBase, "idem2", "g1", "# I2\n\nI2 body.")
      const home = createTaskHome(homeBase, "t-idem2")

      materializer.materializeGroups(home, ["g1"])
      const r2 = materializer.materializeGroups(home, ["g1"])

      // Second call: the link already exists → skip (no error, no replace)
      expect(r2.outcomes).toHaveLength(1)
      expect(r2.outcomes[0]!.method).toBe("skip")
      // Content still readable
      expect(fs.readFileSync(path.join(home, "skills", "idem2", "SKILL.md"), "utf-8")).toContain("I2 body.")
    })

    it("existing real directory at link path → skip (don't trash user content)", () => {
      // If something already exists at {home}/skills/{name} and it's NOT a
      // link (a real dir — maybe the agent wrote a hand-rolled skill there),
      // the materializer must NOT delete or replace it.
      installSkill(rm, rmBase, "usermade", "g1", "# U\n\nU body.")
      const home = createTaskHome(homeBase, "t-realdir")
      const realDir = path.join(home, "skills", "usermade")
      fs.mkdirSync(realDir, { recursive: true })
      fs.writeFileSync(path.join(realDir, "SKILL.md"), "# Hand-made\n\nUser wrote this.", "utf-8")

      const result = materializer.materializeGroups(home, ["g1"])

      expect(result.outcomes).toHaveLength(1)
      expect(result.outcomes[0]!.method).toBe("skip")
      // The user's hand-made content is preserved (NOT replaced by the registry link)
      const content = fs.readFileSync(path.join(realDir, "SKILL.md"), "utf-8")
      expect(content).toContain("Hand-made")
      expect(content).not.toContain("U body.")
    })
  })
})
