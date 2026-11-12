import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { spawnSync } from "child_process"
import { applySchema } from "../../../db/schema"
import { CabinDAO } from "../../../db/dao/cabin-dao"
import { SSEService } from "../../sse"
import { CabinInitService } from "../cabin-init-service"
import { writeManifestJson } from "@octopus/shared"
import type { CabinRow } from "../../../db/types"

const now = () => new Date().toISOString()

function makeRow(over: Partial<CabinRow> & { id: string; path: string }): CabinRow {
  const ts = now()
  return {
    name: "测试舱", workspace_id: null, main_session_id: "sess-1",
    requirements: "# 需求\n\n做一个结算平台", status: "initializing",
    mainline_strategy: "clean-main", org: null, init_state: null, cockpit_prefs: null,
    focused_job_id: null, version: 1,
    created_at: ts, updated_at: ts, last_active_at: ts, archived_at: null,
    ...over,
  }
}

describe("CabinInitService", () => {
  let db: Database.Database
  let dao: CabinDAO
  let sse: SSEService
  let tmpDir: string
  let turnRunner: ReturnType<typeof vi.fn>
  let svc: CabinInitService

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    dao = new CabinDAO(db)
    sse = new SSEService()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cabin-init-test-"))
    turnRunner = vi.fn(async () => {})
    svc = new CabinInitService({ cabin: dao, sse, runOrchestratorTurn: turnRunner })
  })

  afterEach(() => {
    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function seed(over: Partial<CabinRow> = {}): CabinRow {
    const row = makeRow({ id: "cabin-1", path: tmpDir, ...over })
    dao.insert(row)
    return row
  }

  it("runs all 7 gates to active (no repos) and persists disk truth", async () => {
    seed()
    const events: string[] = []
    sse.subscribe("cabin:cabin-1", (e) => events.push(e.event))

    await svc.runGate("cabin-1")

    expect(dao.findById("cabin-1")!.status).toBe("active")
    const state = JSON.parse(fs.readFileSync(path.join(tmpDir, ".cabin", "init-state.json"), "utf-8"))
    expect(state.items).toHaveLength(7)
    expect(state.items.every((i: { state: string }) => i.state === "done")).toBe(true)
    const manifest = JSON.parse(fs.readFileSync(path.join(tmpDir, ".cabin", "manifest.json"), "utf-8"))
    expect(manifest.id).toBe("cabin-1")
    expect(manifest.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(fs.readFileSync(path.join(tmpDir, ".cabin", "requirements.md"), "utf-8")).toContain("结算平台")
    expect(dao.listIterations("cabin-1").map((i) => i.code)).toEqual(["M1"])
    expect(turnRunner).toHaveBeenCalledTimes(1)
    expect(events).toContain("cabin_init_progress")
    expect(events).toContain("cabin_status")
    // DB cold-load mirror tracks disk
    expect(JSON.parse(dao.findById("cabin-1")!.init_state!).items).toHaveLength(7)
  })

  it("gate failure keeps initializing; retry skips done items and resumes", async () => {
    seed()
    turnRunner.mockRejectedValueOnce(new Error("model unavailable"))

    await svc.runGate("cabin-1")
    const row = dao.findById("cabin-1")!
    expect(row.status).toBe("initializing")
    const state = svc.loadState(row)
    const failed = state.items.find((i) => i.key === "first-iteration")!
    expect(failed.state).toBe("failed")
    expect(failed.error).toContain("model unavailable")
    expect(failed.fix_hint).toBeTruthy()
    expect(state.items.filter((i) => i.state === "done")).toHaveLength(6)

    // Done items must NOT re-run: delete a done gate's artifact, retry, and
    // verify it stays deleted (requirements gate skipped).
    fs.rmSync(path.join(tmpDir, ".cabin", "requirements.md"))
    await svc.runGate("cabin-1")
    expect(dao.findById("cabin-1")!.status).toBe("active")
    expect(fs.existsSync(path.join(tmpDir, ".cabin", "requirements.md"))).toBe(false)
    expect(turnRunner).toHaveBeenCalledTimes(2)
  })

  it("loadState merges an older snapshot against the full gate definition", () => {
    const row = seed()
    fs.mkdirSync(path.join(tmpDir, ".cabin"), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, ".cabin", "init-state.json"), JSON.stringify({
      items: [{ key: "dir", label: "目录可写", state: "done" }],
    }))
    const state = svc.loadState(row)
    expect(state.items).toHaveLength(7)
    expect(state.items[0].state).toBe("done")
    expect(state.items[1].state).toBe("pending")
  })

  it("concurrent runGate calls are no-ops", async () => {
    seed()
    let release!: () => void
    turnRunner.mockImplementationOnce(() => new Promise<void>((res) => { release = res }))
    const first = svc.runGate("cabin-1")
    await vi.waitFor(() => expect(turnRunner).toHaveBeenCalledTimes(1))
    const second = svc.runGate("cabin-1")
    release()
    await Promise.all([first, second])
    expect(turnRunner).toHaveBeenCalledTimes(1)
    expect(dao.findById("cabin-1")!.status).toBe("active")
  })

  it("rejects a cabin that is not initializing", async () => {
    seed({ status: "active" })
    await expect(svc.runGate("cabin-1")).rejects.toThrow(/not initializing/)
  })

  it("clone gate fails loudly when repos are requested without an org", async () => {
    seed()
    fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify({
      name: "test", repos: [{ name: "demo" }],
    }))
    await svc.runGate("cabin-1")
    expect(dao.findById("cabin-1")!.status).toBe("initializing")
    const failed = svc.loadState(dao.findById("cabin-1")!).items.find((i) => i.key === "clone")!
    expect(failed.state).toBe("failed")
    expect(failed.error).toContain("org")
  })

  it("clones from the org registry and cuts spec-shaped worktrees (config.json.repos[] contract)", async () => {
    // Real local git repo as the clone source; OCTOPUS_HOME points at a fixture.
    const octopusHome = fs.mkdtempSync(path.join(os.tmpdir(), "cabin-init-home-"))
    const prevHome = process.env.OCTOPUS_HOME
    process.env.OCTOPUS_HOME = octopusHome
    try {
      const sourceRepo = path.join(octopusHome, "source-demo")
      fs.mkdirSync(sourceRepo, { recursive: true })
      const git = (args: string[], cwd: string) =>
        spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf-8" })
      expect(git(["init", "-b", "main"], sourceRepo).status).toBe(0)
      fs.writeFileSync(path.join(sourceRepo, "a.txt"), "hello")
      expect(git(["add", "."], sourceRepo).status).toBe(0)
      expect(git(["commit", "-m", "init"], sourceRepo).status).toBe(0)

      const reposDir = path.join(octopusHome, "orgs", "test-org", "repos")
      fs.mkdirSync(reposDir, { recursive: true })
      fs.writeFileSync(path.join(reposDir, "manifest.json"), writeManifestJson({
        g: [{ name: "demo", git_url: sourceRepo, branch: "main", manual_tags: [], group: "g" }],
      }))

      seed({ org: "test-org" })
      fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify({
        name: "test", repos: [{ name: "demo" }],
      }))

      await svc.runGate("cabin-1")
      expect(dao.findById("cabin-1")!.status).toBe("active")

      // config.json.repos[] upgraded to the full spec shape resolveWorktree reads.
      const config = JSON.parse(fs.readFileSync(path.join(tmpDir, "config.json"), "utf-8"))
      expect(config.repos).toHaveLength(1)
      const entry = config.repos[0]
      expect(entry.name).toBe("demo")
      expect(entry.main_path).toBeTruthy()
      expect(entry.branch).toBe("cabin-cabin-1")
      expect(fs.existsSync(entry.worktree_path)).toBe(true)
      expect(fs.existsSync(path.join(entry.worktree_path, "a.txt"))).toBe(true)
      // The clone's origin points at the local fixture repo, so mainline sync
      // legitimately succeeds; the worktree lands on the cabin branch.
      const mainline = svc.loadState(dao.findById("cabin-1")!).items.find((i) => i.key === "mainline")!
      expect(mainline.state).toBe("done")
      expect(mainline.sub).toContain("worktree 就绪")
    } finally {
      if (prevHome === undefined) delete process.env.OCTOPUS_HOME
      else process.env.OCTOPUS_HOME = prevHome
      fs.rmSync(octopusHome, { recursive: true, force: true })
    }
  })
})