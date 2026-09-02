// packages/server/src/services/tasks/__tests__/task-home-service.test.ts
//
// Ticket 02 — TaskHomeService unit tests (ADR-0011, SW-BP12/BP14).
//
// Seam under test: TaskHomeService public methods. We observe behavior through the
// filesystem (readdir / readFileSync) + a console.warn spy. No DB, no real ~/.octopus.
// Tests inject a temp baseDir so the global home is never touched.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "fs"
import path from "path"
import os from "os"
import type { ArtifactIndexEntry } from "@octopus/shared"
import { TaskHomeService } from "../task-home-service"

function createTempBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "task-home-"))
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

describe("TaskHomeService", () => {
  let base: string
  let svc: TaskHomeService
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    base = createTempBase()
    svc = new TaskHomeService(base)
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
    cleanupDir(base)
  })

  // ── ticket 09 (task-phase-redesign, AC3): per-project probe in context.md ──
  describe("ticket 09 AC3 — context.md project paths + convention probe", () => {
    it("probes the matt conventions per resolved project and marks present/missing", () => {
      const id = "t-probe-1"
      // Fake project A: only CONTEXT-MAP.md + docs/adr/ exist.
      const projA = path.join(base, "projA")
      fs.mkdirSync(path.join(projA, "docs", "adr"), { recursive: true })
      fs.writeFileSync(path.join(projA, "CONTEXT-MAP.md"), "# map\n")
      // Fake project B: all four conventions present.
      const projB = path.join(base, "projB")
      fs.mkdirSync(path.join(projB, "docs", "adr"), { recursive: true })
      fs.mkdirSync(path.join(projB, ".scratch"), { recursive: true })
      fs.writeFileSync(path.join(projB, "CONTEXT-MAP.md"), "# map\n")
      fs.writeFileSync(path.join(projB, "CONTEXT.md"), "# ctx\n")
      fs.writeFileSync(path.join(projB, ".scratch", "index.md"), "# idx\n")

      svc.createHome(id, {
        org: "xzf",
        projects: [
          { name: "projA", path: projA },
          { name: "projB", path: projB },
        ],
      })
      const ctx = fs.readFileSync(path.join(svc.homePath(id), "context.md"), "utf-8")

      // AC3: each selected project gets a path line…
      expect(ctx).toContain(`- project: projA  →  ${projA}`)
      expect(ctx).toContain(`- project: projB  →  ${projB}`)
      // …plus probe RESULT lines (✓ present / — missing) for the four conventions.
      const projABlock = ctx.slice(ctx.indexOf("project: projA"), ctx.indexOf("project: projB"))
      expect(projABlock).toContain("CONTEXT-MAP.md ✓")
      expect(projABlock).toContain("CONTEXT.md —")
      expect(projABlock).toContain("docs/adr/ ✓")
      expect(projABlock).toContain(".scratch/index.md —")
      const projBBlock = ctx.slice(ctx.indexOf("project: projB"))
      for (const c of ["CONTEXT-MAP.md ✓", "CONTEXT.md ✓", "docs/adr/ ✓", ".scratch/index.md ✓"]) {
        expect(projBBlock).toContain(c)
      }
      // Guidance for the agent (US2): what to read, and the degradation rule.
      expect(ctx).toContain("领域")
      expect(ctx).toContain("无领域文档 project")
      expect(ctx).toContain("降级")
    })

    it("marks a fully convention-less project as degraded and unresolved projects stay un-probed", () => {
      const id = "t-probe-2"
      const emptyProj = path.join(base, "empty-proj")
      fs.mkdirSync(emptyProj, { recursive: true })

      svc.createHome(id, {
        projects: [
          { name: "empty-proj", path: emptyProj },
          { name: "no-path-proj" },
        ],
      })
      const ctx = fs.readFileSync(path.join(svc.homePath(id), "context.md"), "utf-8")

      expect(ctx).toContain("无领域文档 project")
      // Unresolved project keeps the existing placeholder and no probe noise.
      expect(ctx).toContain("no-path-proj  (路径未解析)")
    })

    it("writeContextFile refresh re-probes current disk state", () => {
      const id = "t-probe-3"
      const proj = path.join(base, "proj")
      fs.mkdirSync(proj, { recursive: true })
      svc.createHome(id)
      svc.writeContextFile(id, "o", [{ name: "proj", path: proj }])
      let ctx = fs.readFileSync(path.join(svc.homePath(id), "context.md"), "utf-8")
      // All four missing → degrade annotation (not per-file marks).
      expect(ctx).toContain("惯例文件全部缺失")

      fs.writeFileSync(path.join(proj, "CONTEXT-MAP.md"), "# later\n")
      svc.writeContextFile(id, "o", [{ name: "proj", path: proj }])
      ctx = fs.readFileSync(path.join(svc.homePath(id), "context.md"), "utf-8")
      // Re-probe flips to per-file marks once a convention exists.
      expect(ctx).toContain("CONTEXT-MAP.md ✓")
      expect(ctx).not.toContain("惯例文件全部缺失")
    })
  })

  // ── AC1: homePath pure derivation + createHome skeleton ────────────
  describe("AC1 — homePath + createHome", () => {
    it("homePath is a pure derivation with no FS side effect", () => {
      const id = "abc-123"
      const expected = path.join(base, "tasks", id)
      expect(svc.homePath(id)).toBe(expected)
      // No directory should have been created.
      expect(fs.existsSync(expected)).toBe(false)
    })

    it("createHome builds the skills/ + artifacts/ + workflows/ + .claude/rules/ skeleton + context.md", () => {
      const id = "t-1"
      const home = svc.createHome(id)
      expect(home).toBe(svc.homePath(id))
      expect(fs.existsSync(path.join(home, "skills"))).toBe(true)
      expect(fs.existsSync(path.join(home, "artifacts"))).toBe(true)
      expect(fs.existsSync(path.join(home, "workflows"))).toBe(true)
      expect(fs.existsSync(path.join(home, ".claude", "rules"))).toBe(true)
      expect(fs.existsSync(path.join(home, ".claude", "rules", "task-context.md"))).toBe(true)
      expect(fs.existsSync(path.join(home, "context.md"))).toBe(true)
      const entries = fs.readdirSync(home).sort()
      expect(entries).toEqual([".claude", "artifacts", "context.md", "skills", "spec.json", "workflows"])
    })

    it("createHome writes task-context.md with path constraints only", () => {
      const id = "t-1b"
      svc.createHome(id)
      const ruleContent = fs.readFileSync(
        path.join(svc.homePath(id), ".claude", "rules", "task-context.md"),
        "utf-8",
      )
      expect(ruleContent).toContain("工作目录")
      expect(ruleContent).toContain("产物目录")
      expect(ruleContent).toContain("强制")
      expect(ruleContent).toContain("alwaysApply: true")
      // Rules file references context.md for dynamic state
      expect(ruleContent).toContain("context.md")
      // Rules file has NO project/org state inline — that belongs to context.md
      expect(ruleContent).not.toContain("项目已锁定")
      expect(ruleContent).not.toContain("repos/index.md")
    })

    it("createHome writes context.md with org/projects/skillGroups", () => {
      const id = "t-1c"
      svc.createHome(id, { org: "xzf", projects: [{ name: "open-octopus", path: "/home/user/octopus" }], skillGroups: ["superpowers-zh"] })
      const ctx = fs.readFileSync(path.join(svc.homePath(id), "context.md"), "utf-8")
      expect(ctx).toContain("org: xzf")
      expect(ctx).toContain("project: open-octopus")
      expect(ctx).toContain("/home/user/octopus")
      expect(ctx).toContain("locked skill groups: superpowers-zh")
      expect(ctx).toContain("cwd:")
    })

    // ── task-workflow-handoff (ADR-0013): workflows/ dir + readWorkflowFile ──

    it("workflowsDir is a pure path derivation", () => {
      const id = "t-wf"
      const expected = path.join(base, "tasks", id, "workflows")
      expect(svc.workflowsDir(id)).toBe(expected)
    })

    it("readWorkflowFile returns null for missing home / missing file", () => {
      const id = "t-wf-miss"
      // No home created → directory missing → null
      expect(svc.readWorkflowFile(id, "missing.yaml")).toBeNull()
      // Home created but file missing → null
      svc.createHome(id)
      expect(svc.readWorkflowFile(id, "missing.yaml")).toBeNull()
    })

    it("readWorkflowFile rejects path-escape attempts (ref must be bare filename)", () => {
      const id = "t-wf-escape"
      svc.createHome(id)
      // Write a real file, then try to read via escape path
      fs.writeFileSync(path.join(svc.workflowsDir(id), "secret.yaml"), "content", "utf-8")
      expect(svc.readWorkflowFile(id, "../secret.yaml")).toBeNull()
      expect(svc.readWorkflowFile(id, "sub/secret.yaml")).toBeNull()
      expect(svc.readWorkflowFile(id, "..\\secret.yaml")).toBeNull()
      expect(svc.readWorkflowFile(id, "secret.yaml\0.txt")).toBeNull()
    })

    it("readWorkflowFile returns content on hit", () => {
      const id = "t-wf-hit"
      svc.createHome(id)
      const yaml = "workflow:\n  name: my-flow\n"
      fs.writeFileSync(path.join(svc.workflowsDir(id), "my-flow.yaml"), yaml, "utf-8")
      expect(svc.readWorkflowFile(id, "my-flow.yaml")).toBe(yaml)
    })

    it("listWorkflowFiles lists YAML filenames, ignores non-YAML", () => {
      const id = "t-wf-list"
      svc.createHome(id)
      fs.writeFileSync(path.join(svc.workflowsDir(id), "a.yaml"), "x", "utf-8")
      fs.writeFileSync(path.join(svc.workflowsDir(id), "b.yml"), "x", "utf-8")
      fs.writeFileSync(path.join(svc.workflowsDir(id), "readme.md"), "x", "utf-8")
      fs.mkdirSync(path.join(svc.workflowsDir(id), "subdir"), { recursive: true })
      const files = svc.listWorkflowFiles(id)
      expect(files.sort()).toEqual(["a.yaml", "b.yml"])
    })

    it("listWorkflowFiles returns [] when home/workflows missing", () => {
      expect(svc.listWorkflowFiles("no-such-id")).toEqual([])
    })

    it("writeContextFile refreshes dynamic state without touching rules", () => {
      const id = "t-1d"
      svc.createHome(id, { org: "old-org" })
      const ruleBefore = fs.readFileSync(path.join(svc.homePath(id), ".claude", "rules", "task-context.md"), "utf-8")

      // Simulate project change
      svc.writeContextFile(id, "old-org", [{ name: "new-project", path: "/path/to/new-project" }], ["group-a"])
      const ctx = fs.readFileSync(path.join(svc.homePath(id), "context.md"), "utf-8")
      expect(ctx).toContain("project: new-project")
      expect(ctx).toContain("/path/to/new-project")
      expect(ctx).toContain("locked skill groups: group-a")

      // Rules file untouched (static)
      const ruleAfter = fs.readFileSync(path.join(svc.homePath(id), ".claude", "rules", "task-context.md"), "utf-8")
      expect(ruleAfter).toBe(ruleBefore)
    })

    // ── 06: spec.json — structured goal/ac snapshot the task-author agent reads ──

    it("createHome writes a baseline spec.json; writeSpecFile refreshes it with real data", () => {
      const id = "t-spec"
      svc.createHome(id)
      const p = path.join(svc.homePath(id), "spec.json")
      expect(fs.existsSync(p)).toBe(true)

      const first = JSON.parse(fs.readFileSync(p, "utf-8")) as {
        task_id: string
        version: number
        updated_at: string
        spec: Record<string, unknown>
      }
      expect(first.task_id).toBe(id)
      expect(first.version).toBe(1)
      expect(first.spec).toEqual({})

      // A spec-field save refreshes the snapshot with the current task_spec.
      svc.writeSpecFile(id, {
        version: 7,
        spec: { goal: "g", ac: ["a1", "a2"], goal_confirmed: true, ac_confirmed: ["a1", "a2"] },
        updated_at: "2026-08-21T00:00:00Z",
      })
      const second = JSON.parse(fs.readFileSync(p, "utf-8")) as {
        task_id: string
        version: number
        updated_at: string
        spec: { goal: string; ac: string[]; goal_confirmed: boolean }
      }
      expect(second.version).toBe(7)
      expect(second.spec.goal).toBe("g")
      expect(second.spec.ac).toEqual(["a1", "a2"])
      expect(second.spec.goal_confirmed).toBe(true)
      expect(second.updated_at).toBe("2026-08-21T00:00:00Z")
    })

    it("writeSpecFile is a silent no-op when the home doesn't exist (legacy/v2 task)", () => {
      const warnBefore = warnSpy.mock.calls.length
      svc.writeSpecFile("t-ghost", { version: 1, spec: {}, updated_at: "x" })
      expect(fs.existsSync(svc.homePath("t-ghost"))).toBe(false)
      // No warning either — a missing home is an expected case, not an error.
      expect(warnSpy.mock.calls.length).toBe(warnBefore)
    })

    it("rules file (task-context.md) points the agent to spec.json", () => {
      const id = "t-rules"
      svc.createHome(id)
      const content = fs.readFileSync(
        path.join(svc.homePath(id), ".claude", "rules", "task-context.md"),
        "utf-8",
      )
      // The rules file is SDK-loaded (alwaysApply) — this is the deterministic
      // way the agent learns about spec.json on its first turn.
      expect(content).toContain("spec.json")
    })

    it("context.md points to spec.json", () => {
      const id = "t-ctx"
      svc.createHome(id)
      const ctx = fs.readFileSync(path.join(svc.homePath(id), "context.md"), "utf-8")
      expect(ctx).toContain("spec.json")
    })

    it("createHome is idempotent (calling twice leaves one home)", () => {
      const id = "t-2"
      svc.createHome(id)
      svc.createHome(id)
      const home = svc.homePath(id)
      const entries = fs.readdirSync(home).sort()
      expect(entries).toEqual([".claude", "artifacts", "context.md", "skills", "spec.json", "workflows"])
    })

    it("ensureRulesFile backfills rules for existing homes without .claude/", () => {
      const id = "t-3"
      // Simulate an old task home (no .claude/ dir)
      const home = svc.homePath(id)
      fs.mkdirSync(path.join(home, "skills"), { recursive: true })
      fs.mkdirSync(path.join(home, "artifacts"), { recursive: true })
      expect(fs.existsSync(path.join(home, ".claude"))).toBe(false)

      svc.ensureRulesFile(id)

      expect(fs.existsSync(path.join(home, ".claude", "rules", "task-context.md"))).toBe(true)
      const content = fs.readFileSync(path.join(home, ".claude", "rules", "task-context.md"), "utf-8")
      expect(content).toContain("alwaysApply: true")
    })

    it("ensureRulesFile is no-op when rules file already exists", () => {
      const id = "t-4"
      svc.createHome(id) // writes rules file
      const rulePath = path.join(svc.homePath(id), ".claude", "rules", "task-context.md")
      const before = fs.readFileSync(rulePath, "utf-8")

      svc.ensureRulesFile(id) // should not overwrite

      const after = fs.readFileSync(rulePath, "utf-8")
      expect(after).toBe(before)
    })

    it("ensureRulesFile is no-op when home doesn't exist", () => {
      // Should not throw, should not create anything
      svc.ensureRulesFile("t-nonexistent")
      expect(fs.existsSync(svc.homePath("t-nonexistent"))).toBe(false)
    })
  })

  // ── AC2/AC3: readArtifacts + writeArtifactEntry ───────────────────
  describe("AC2/AC3 — readArtifacts + writeArtifactEntry", () => {
    function entry(overrides: Partial<ArtifactIndexEntry> = {}): ArtifactIndexEntry {
      return {
        path: "spec.md",
        by: "open-spec",
        title: "Spec",
        external: false,
        updated_at: "2026-08-18T00:00:00.000Z",
        ...overrides,
      }
    }

    it("readArtifacts returns [] when no index file exists", () => {
      svc.createHome("t-10")
      expect(svc.readArtifacts("t-10")).toEqual([])
    })

    it("writeArtifactEntry round-trips 3 distinct entries", () => {
      svc.createHome("t-11")
      // scan-first: the FILES must exist on disk (filesystem is the truth).
      const dir = path.join(base, "tasks", "t-11", "artifacts")
      fs.writeFileSync(path.join(dir, "spec.md"), "# spec", "utf-8")
      fs.writeFileSync(path.join(dir, "proposal.md"), "# proposal", "utf-8")
      fs.writeFileSync(path.join(dir, "stories.md"), "# stories", "utf-8")
      svc.writeArtifactEntry("t-11", entry({ path: "spec.md" }))
      svc.writeArtifactEntry("t-11", entry({ path: "proposal.md", title: "Proposal" }))
      svc.writeArtifactEntry("t-11", entry({ path: "stories.md", title: "Stories" }))
      const read = svc.readArtifacts("t-11")
      expect(read.map((e) => e.path).sort()).toEqual([
        "proposal.md",
        "spec.md",
        "stories.md",
      ])
      const spec = read.find((e) => e.path === "spec.md")!
      expect(spec.by).toBe("open-spec")
      expect(spec.external).toBe(false)
    })

    it("writeArtifactEntry upserts by path (dedupe, latest wins)", () => {
      svc.createHome("t-12")
      const dir = path.join(base, "tasks", "t-12", "artifacts")
      fs.writeFileSync(path.join(dir, "spec.md"), "# spec", "utf-8")
      svc.writeArtifactEntry("t-12", entry({ path: "spec.md", title: "Old" }))
      svc.writeArtifactEntry("t-12", entry({ path: "spec.md", title: "New" }))
      const read = svc.readArtifacts("t-12")
      expect(read).toHaveLength(1)
      expect(read[0].title).toBe("New")
    })

    it("writeArtifactEntry rejects an entry missing a required field", () => {
      svc.createHome("t-13")
      // by is missing → schema rejects
      const bad = { path: "x.md", title: "X", external: false, updated_at: "2026-08-18" } as unknown as ArtifactIndexEntry
      expect(() => svc.writeArtifactEntry("t-13", bad)).toThrow()
      // Nothing should have been written.
      expect(svc.readArtifacts("t-13")).toEqual([])
    })

    it("writeArtifactEntry works even if home was not pre-created (defensive mkdir)", () => {
      // No createHome call — writeArtifactEntry must still persist.
      svc.writeArtifactEntry("t-14", entry({ path: "spec.md" }))
      // scan-first: drop a real file so the entry survives the listing.
      fs.writeFileSync(
        path.join(base, "tasks", "t-14", "artifacts", "spec.md"),
        "# spec",
        "utf-8",
      )
      expect(svc.readArtifacts("t-14")).toHaveLength(1)
    })

    it("readArtifacts on corrupted JSON returns [] and warns (SW-BP12)", () => {
      svc.createHome("t-15")
      const file = path.join(svc.artifactsDir("t-15"), "artifacts.json")
      fs.writeFileSync(file, "{invalid", "utf-8")
      expect(svc.readArtifacts("t-15")).toEqual([])
      expect(warnSpy).toHaveBeenCalled()
      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join("\n")
      expect(warned.toLowerCase()).toContain("corrupt")
    })

    it("readArtifacts on non-array JSON returns [] and warns", () => {
      svc.createHome("t-16")
      const file = path.join(base, "tasks", "t-16", "artifacts", "artifacts.json")
      fs.writeFileSync(file, '{"oops":true}', "utf-8")
      expect(svc.readArtifacts("t-16")).toEqual([])
      expect(warnSpy).toHaveBeenCalled()
    })

    it("readArtifacts flattens a grouped-object index written by an LLM session (bugfix 2026-08-26)", () => {
      svc.createHome("t-17")
      const dir = path.join(base, "tasks", "t-17", "artifacts")
      fs.writeFileSync(path.join(dir, "glossary.md"), "# g", "utf-8")
      fs.writeFileSync(path.join(dir, "spec-details.md"), "# s", "utf-8")
      fs.writeFileSync(path.join(dir, "artifacts.json"), JSON.stringify({
        task_id: "t-17",
        "grill-aftermath": [
          { path: "glossary.md", kind: "glossary", desc: "词条" },
          { path: "spec-details.md", kind: "spec", desc: "细节" },
        ],
        external: [{ path: path.join(base, "external", "proposal.md"), by: "agent" }],
      }), "utf-8")

      const read = svc.readArtifacts("t-17")
      expect(read).toHaveLength(3)

      const glossary = read.find((e) => e.path === "glossary.md")!
      expect(glossary.title).toBe("词条") // desc → title fallback
      expect(glossary.by).toBe("task-author") // missing by → default
      expect(glossary.external).toBe(false) // relative artifact
      expect(glossary.updated_at.length).toBeGreaterThan(0) // mtime fallback

      const ext = read.find((e) => e.external)!
      expect(ext.path).toBe(path.join(base, "external", "proposal.md"))
      expect(ext.by).toBe("agent") // explicit by preserved
      expect(warnSpy).not.toHaveBeenCalled()
    })

    it("readArtifacts drops a loose entry with no path from a grouped index", () => {
      svc.createHome("t-18")
      const dir = path.join(base, "tasks", "t-18", "artifacts")
      fs.writeFileSync(path.join(dir, "artifacts.json"), JSON.stringify({
        "grill-aftermath": [{ desc: "no path here" }],
      }), "utf-8")
      expect(svc.readArtifacts("t-18")).toEqual([])
      expect(warnSpy).toHaveBeenCalled()
    })

    it("scan-first: an unregistered file still appears (filesystem is the truth)", () => {
      svc.createHome("t-19")
      const dir = path.join(base, "tasks", "t-19", "artifacts")
      fs.writeFileSync(path.join(dir, "agent-notes.md"), "# notes", "utf-8")
      fs.mkdirSync(path.join(dir, "adr"), { recursive: true })
      fs.writeFileSync(path.join(dir, "adr", "0001-x.md"), "# adr", "utf-8")
      // No artifacts.json at all — the listing is purely the filesystem.
      const read = svc.readArtifacts("t-19")
      expect(read).toHaveLength(2)
      const notes = read.find((e) => e.path === "agent-notes.md")!
      expect(notes.by).toBe("filesystem")
      expect(notes.title).toBe("agent-notes.md")
      expect(notes.external).toBe(false)
      expect(notes.updated_at.length).toBeGreaterThan(0)
      const adr = read.find((e) => e.path === "adr/0001-x.md")!
      expect(adr).toBeDefined()
    })

    it("scan-first: an internal index entry whose file is gone is dropped", () => {
      svc.createHome("t-19b")
      const dir = path.join(base, "tasks", "t-19b", "artifacts")
      fs.writeFileSync(path.join(dir, "artifacts.json"), JSON.stringify([
        { path: "ghost.md", by: "agent", title: "Ghost", external: false, updated_at: "2026-08-18T00:00:00.000Z" },
      ]), "utf-8")
      // The file was deleted → the entry no longer lists (filesystem is truth).
      expect(svc.readArtifacts("t-19b")).toEqual([])
    })
  })

  // ── AC5: external ↔ path consistency ──────────────────────────────
  describe("AC5 — external/path consistency", () => {
    function absPath(): string {
      // A real absolute path (resolved lazily — `base` is set in beforeEach).
      return path.join(base, "external", "proposal.md")
    }
    function base_entry(): ArtifactIndexEntry {
      return {
        path: "spec.md",
        by: "open-spec",
        title: "Spec",
        external: false,
        updated_at: "2026-08-18T00:00:00.000Z",
      }
    }

    it("external=true requires an absolute path", () => {
      svc.createHome("t-20")
      expect(() =>
        svc.writeArtifactEntry("t-20", { ...base_entry(), external: true, path: "relative.md" }),
      ).toThrow(/absolute/i)
    })

    it("external=false rejects an absolute path", () => {
      svc.createHome("t-21")
      expect(() =>
        svc.writeArtifactEntry("t-21", { ...base_entry(), external: false, path: absPath() }),
      ).toThrow(/relative/i)
    })

    it("external=true + absolute path is accepted", () => {
      svc.createHome("t-22")
      svc.writeArtifactEntry("t-22", {
        ...base_entry(),
        external: true,
        path: absPath(),
        title: "Proposal",
      })
      const read = svc.readArtifacts("t-22")
      expect(read).toHaveLength(1)
      expect(read[0].external).toBe(true)
      expect(read[0].path).toBe(absPath())
    })

    it("external=false + relative path is accepted", () => {
      svc.createHome("t-23")
      // scan-first: the file must exist for the entry to survive the listing.
      fs.writeFileSync(
        path.join(svc.artifactsDir("t-23"), "spec.md"),
        "# spec",
        "utf-8",
      )
      svc.writeArtifactEntry("t-23", base_entry())
      const read = svc.readArtifacts("t-23")
      expect(read).toHaveLength(1)
      expect(read[0].external).toBe(false)
      expect(read[0].path).toBe("spec.md")
    })
  })

  // ── AC4: reapHome — whole-tree delete WITHOUT following links ──────
  describe("AC4 — reapHome", () => {
    it("removes the whole home directory tree (real files only)", () => {
      const id = "t-30"
      svc.createHome(id)
      // Drop a real file inside artifacts/ so the tree is non-empty.
      fs.writeFileSync(
        path.join(svc.artifactsDir(id), "spec.md"),
        "# real spec",
        "utf-8",
      )
      const home = svc.homePath(id)
      expect(fs.existsSync(home)).toBe(true)
      svc.reapHome(id)
      expect(fs.existsSync(home)).toBe(false)
    })

    it("is idempotent on a missing home (no throw)", () => {
      expect(() => svc.reapHome("never-existed")).not.toThrow()
    })

    it("does NOT follow a junction/symlink into the target (SW-BP14)", () => {
      const id = "t-31"
      svc.createHome(id)

      // A target directory OUTSIDE the task home, with a real file in it.
      const targetDir = path.join(base, "external-skill-source")
      const targetFile = path.join(targetDir, "SKILL.md")
      fs.mkdirSync(targetDir, { recursive: true })
      fs.writeFileSync(targetFile, "# real skill", "utf-8")

      // Link the target into the home's skills/ dir. Use a junction on
      // Windows (no admin needed) and a dir symlink elsewhere — the same
      // two shapes the plugin-materializer will produce.
      const linkPath = path.join(svc.homePath(id), "skills", "linked-skill")
      const linkType = process.platform === "win32" ? "junction" : "dir"
      fs.symlinkSync(targetDir, linkPath, linkType as fs.symlink.Type)
      // Sanity: the link resolves to the target.
      expect(fs.realpathSync(linkPath)).toBe(fs.realpathSync(targetDir))
      // And the linked file is visible through the link.
      expect(fs.readFileSync(path.join(linkPath, "SKILL.md"), "utf-8")).toBe("# real skill")

      // Reap the whole home.
      svc.reapHome(id)

      // The link inside the home is gone (home removed entirely)...
      expect(fs.existsSync(svc.homePath(id))).toBe(false)
      // ...and crucially the target survived — reap did NOT follow the link.
      expect(fs.existsSync(targetDir)).toBe(true)
      expect(fs.existsSync(targetFile)).toBe(true)
      expect(fs.readFileSync(targetFile, "utf-8")).toBe("# real skill")
    })

    it("reaps a home whose skills/ contains a mix of links and real dirs", () => {
      const id = "t-32"
      svc.createHome(id)
      const home = svc.homePath(id)

      // Real sub-skill dir with a file.
      const realSkill = path.join(home, "skills", "real-skill")
      fs.mkdirSync(realSkill, { recursive: true })
      fs.writeFileSync(path.join(realSkill, "SKILL.md"), "real", "utf-8")

      // Linked skill pointing outside.
      const targetDir = path.join(base, "external-mixed")
      fs.mkdirSync(targetDir, { recursive: true })
      fs.writeFileSync(path.join(targetDir, "SKILL.md"), "linked", "utf-8")
      const linkPath = path.join(home, "skills", "linked-skill")
      const linkType = process.platform === "win32" ? "junction" : "dir"
      fs.symlinkSync(targetDir, linkPath, linkType as fs.symlink.Type)

      svc.reapHome(id)
      expect(fs.existsSync(home)).toBe(false)
      expect(fs.existsSync(targetDir)).toBe(true)
    })

    it("detaches a top-level junction/symlink child of the home (sharpest SW-BP14 edge)", () => {
      // skills/ itself is a link to an external dir (not a real dir with
      // links inside). A naive recursive rm that follows links would delete
      // the target's contents. This is the case the pre-pass must cover.
      const id = "t-33"
      const home = svc.homePath(id)
      fs.mkdirSync(home, { recursive: true })
      fs.mkdirSync(path.join(home, "artifacts"), { recursive: true })
      fs.writeFileSync(path.join(home, "artifacts", "spec.md"), "x", "utf-8")

      const targetDir = path.join(base, "external-toplevel-skill")
      const targetFile = path.join(targetDir, "SKILL.md")
      fs.mkdirSync(targetDir, { recursive: true })
      fs.writeFileSync(targetFile, "# real skill", "utf-8")

      // skills/ IS the junction (not a container of one).
      const linkType = process.platform === "win32" ? "junction" : "dir"
      fs.symlinkSync(targetDir, path.join(home, "skills"), linkType as fs.symlink.Type)

      svc.reapHome(id)
      expect(fs.existsSync(home)).toBe(false)
      expect(fs.existsSync(targetDir)).toBe(true)
      expect(fs.existsSync(targetFile)).toBe(true)
      expect(fs.readFileSync(targetFile, "utf-8")).toBe("# real skill")
    })
  })
})
