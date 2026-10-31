// packages/server/src/services/tasks/__tests__/archive-cleanup.test.ts
//
// 归档后构建产物清理（2026-10-31）—— 真 git + 临时仓库。
//
// 覆盖：
//   · 纯函数：git ignored 行解析 / 白名单分类 / 受保护路径
//   · sweepWorktree：删白名单产物；保留已跟踪文件、未跟踪非忽略文件；
//     其余 ignored 项进 leftovers（只计量不删）
//   · 安全校验：受保护路径 / 路径越界 / 内部含跟踪文件 一律拒删
//   · createArchiveCleaner：done 才允许；cleanup.json 落盘；cleanLeftovers 回写

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import Database from "better-sqlite3"
import { applySchema } from "../../../db/schema"
import { TaskHomeService } from "../task-home-service"
import { defaultRun } from "../archive-delta"
import {
  classifyIgnoredEntry,
  createArchiveCleaner,
  isProtectedRel,
  parseIgnoredEntries,
  sweepWorktree,
} from "../archive-cleanup-service"

const temps: string[] = []

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  temps.push(dir)
  return dir
}

function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" })
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(r.stderr ?? "").toString()}`)
  }
  return (r.stdout ?? "").toString()
}

function makeRepo(root: string, gitignore: string[]): string {
  fs.mkdirSync(root, { recursive: true })
  git(["init", "-b", "main"], root)
  git(["config", "user.email", "cleanup@test.local"], root)
  git(["config", "user.name", "Cleanup Test"], root)
  fs.writeFileSync(path.join(root, ".gitignore"), gitignore.join("\n") + "\n")
  fs.mkdirSync(path.join(root, "src"), { recursive: true })
  fs.writeFileSync(path.join(root, "src", "index.ts"), "export const x = 1\n")
  git(["add", "-A"], root)
  git(["commit", "-m", "seed"], root)
  return root
}

function writeFile(root: string, rel: string, content = "x"): void {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

beforeEach(() => {
  temps.length = 0
})

afterEach(() => {
  for (const dir of temps.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      /* Windows lock — temp dir, best effort */
    }
  }
})

// ── Pure functions ───────────────────────────────────────────────────

describe("parseIgnoredEntries", () => {
  it("keeps only !! rows, normalises dir marker and separators", () => {
    const raw = ["!! node_modules/", "?? scratch.txt", "!! .idea/", "!! certs\\a.pem", ""].join("\0")
    expect(parseIgnoredEntries(raw)).toEqual([
      { path: "node_modules", kind: "dir" },
      { path: ".idea", kind: "dir" },
      { path: "certs/a.pem", kind: "file" },
    ])
  })
})

describe("classifyIgnoredEntry", () => {
  it("build dirs / artifact extensions are candidates; everything else is a leftover", () => {
    expect(classifyIgnoredEntry({ path: "node_modules", kind: "dir" })).toBe("candidate")
    expect(classifyIgnoredEntry({ path: "packages/api/node_modules", kind: "dir" })).toBe("candidate")
    expect(classifyIgnoredEntry({ path: "target", kind: "dir" })).toBe("candidate")
    expect(classifyIgnoredEntry({ path: "cmake-build-debug", kind: "dir" })).toBe("candidate")
    expect(classifyIgnoredEntry({ path: "target/classes/A.class", kind: "file" })).toBe("candidate")
    expect(classifyIgnoredEntry({ path: "lib/x.jar", kind: "file" })).toBe("candidate")
    expect(classifyIgnoredEntry({ path: ".idea", kind: "dir" })).toBe("leftover")
    expect(classifyIgnoredEntry({ path: ".env", kind: "file" })).toBe("leftover")
    expect(classifyIgnoredEntry({ path: "scratch.txt", kind: "file" })).toBe("leftover")
  })
})

describe("isProtectedRel", () => {
  it("protects env files, keys and system dirs", () => {
    for (const rel of [
      ".env",
      "config/.env.local",
      "certs/server.pem",
      "keys/a.key",
      ".claude/settings.local.json",
      ".git/config",
      "nested/.octopus/x",
    ]) {
      expect(isProtectedRel(rel), rel).toBe(true)
    }
    expect(isProtectedRel("node_modules/x")).toBe(false)
    expect(isProtectedRel("dist")).toBe(false)
  })
})

// ── sweepWorktree ────────────────────────────────────────────────────

describe("sweepWorktree", () => {
  it("deletes whitelisted build artifacts, keeps tracked + untracked-non-ignored files, lists leftovers", async () => {
    const root = makeRepo(tmp("octo-cleanup-sweep-"), [
      "node_modules/",
      "dist/",
      "target/",
      ".idea/",
      "cache/",
      ".env",
    ])
    writeFile(root, "node_modules/pkg/index.js", "x".repeat(2048))
    writeFile(root, "dist/app.js", "y".repeat(1024))
    writeFile(root, "target/classes/A.class", "z".repeat(512))
    writeFile(root, ".idea/workspace.xml", "<x/>")
    writeFile(root, "cache/lib/data.bin", "c".repeat(128))
    writeFile(root, ".env", "SECRET=1")
    writeFile(root, "keep.txt", "untracked but not ignored")

    const result = await sweepWorktree("api", root, { run: defaultRun })

    expect(result.ok).toBe(true)
    expect(result.error).toBeUndefined()

    const removedPaths = result.removed.map((r) => r.path)
    expect(removedPaths).toEqual(expect.arrayContaining(["node_modules", "dist", "target"]))
    expect(result.removed_count).toBeGreaterThanOrEqual(3)
    expect(result.freed_bytes).toBeGreaterThanOrEqual(2048 + 1024 + 512)

    expect(fs.existsSync(path.join(root, "node_modules"))).toBe(false)
    expect(fs.existsSync(path.join(root, "dist"))).toBe(false)
    expect(fs.existsSync(path.join(root, "target"))).toBe(false)

    // Untracked but NOT ignored → never touched.
    expect(fs.existsSync(path.join(root, "keep.txt"))).toBe(true)
    // Ignored but not whitelisted → leftovers, still on disk.
    expect(fs.existsSync(path.join(root, ".idea", "workspace.xml"))).toBe(true)
    expect(fs.existsSync(path.join(root, "cache", "lib", "data.bin"))).toBe(true)
    expect(fs.existsSync(path.join(root, ".env"))).toBe(true)

    const leftoverPaths = result.leftovers.map((l) => l.path)
    expect(leftoverPaths).toEqual(expect.arrayContaining([".idea", "cache", ".env"]))
    expect(result.leftover_count).toBe(3)
    // Sizes are measured (bytes) for leftovers too.
    expect(result.leftovers.find((l) => l.path === "cache")?.bytes).toBe(128)
  }, 30_000)

  it("does not treat an ignored dir containing a tracked file as a deletable whole", async () => {
    const root = makeRepo(tmp("octo-cleanup-tracked-"), ["dist/"])
    writeFile(root, "dist/tracked.txt", "tracked payload")
    git(["add", "-f", "dist/tracked.txt"], root)
    git(["commit", "-m", "track dist"], root)
    writeFile(root, "dist/artifact.js", "built")

    const result = await sweepWorktree("api", root, { run: defaultRun })

    expect(result.ok).toBe(true)
    expect(result.removed.some((r) => r.path === "dist")).toBe(false)
    expect(fs.existsSync(path.join(root, "dist", "tracked.txt"))).toBe(true)
    // The ignored file inside is still on disk (classified as a leftover, not whitelisted).
    expect(fs.existsSync(path.join(root, "dist", "artifact.js"))).toBe(true)
  }, 30_000)
})

// ── createArchiveCleaner over DB ─────────────────────────────────────

function newDb(): Database.Database {
  const db = new Database(":memory:")
  applySchema(db)
  return db
}

interface Fixture {
  db: Database.Database
  homeBase: string
  home: string
  repo: string
  taskId: string
  project: string
}

function makeFixture(opts: { status?: string; gitignore?: string[] } = {}): Fixture {
  const db = newDb()
  const base = tmp("octo-cleanup-fx-")
  const homeBase = path.join(base, "home")
  const wsPath = path.join(base, "ws")
  const repo = makeRepo(path.join(wsPath, "projects", "api"), opts.gitignore ?? [
    "node_modules/",
    "dist/",
    ".idea/",
    ".env",
  ])
  const taskId = `t-cleanup-${Date.now()}`
  const home = path.join(homeBase, "tasks", taskId)
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(
    path.join(wsPath, "config.json"),
    JSON.stringify({
      name: `ws-${taskId}`,
      repo_group: "test",
      repos: [{ name: "api", worktree_path: repo, branch: "feat/x" }],
    }, null, 2),
  )
  const now = new Date().toISOString()
  db.prepare(
    "INSERT INTO workspaces (id, name, repo_group, path, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'scheduler', 'active', ?, ?)",
  ).run(`ws-${taskId}`, `task:${taskId}`, "test", wsPath, now, now)
  db.prepare(`
    INSERT INTO tasks (id, repo_group, name, status, task_spec, authoring_resources, resources, skills,
      project_ids, version, created_at, updated_at, completed_at, workspace_id)
    VALUES (?, 'test', 'cleanup fixture', ?, '{"format":"v4"}', '[]', '[]', '[]', '["api"]', 1, ?, ?, ?, ?)
  `).run(taskId, opts.status ?? "done", now, now, now, `ws-${taskId}`)
  return { db, homeBase, home, repo, taskId, project: "api" }
}

describe("createArchiveCleaner", () => {
  it("only runs for done tasks and persists cleanup.json", async () => {
    const fx = makeFixture({ status: "archiving" })
    const homeService = new TaskHomeService(fx.homeBase)
    const cleaner = createArchiveCleaner({ db: fx.db, taskHomeService: homeService, run: defaultRun })
    await expect(cleaner.cleanupTask(fx.taskId)).rejects.toThrow(/done tasks/)

    fx.db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(fx.taskId)
    writeFile(fx.repo, "node_modules/pkg/a.js", "n".repeat(4096))
    writeFile(fx.repo, "dist/out.js", "d".repeat(2048))
    writeFile(fx.repo, ".idea/workspace.xml", "<x/>")
    writeFile(fx.repo, ".env", "SECRET=1")

    const report = await cleaner.cleanupTask(fx.taskId)
    expect(report.status).toBe("done")
    expect(report.total_freed_bytes).toBeGreaterThanOrEqual(4096 + 2048)
    expect(report.projects).toHaveLength(1)
    expect(report.projects[0].removed.map((r) => r.path)).toEqual(
      expect.arrayContaining(["node_modules", "dist"]),
    )
    expect(report.projects[0].leftover_count).toBeGreaterThanOrEqual(2)

    const file = path.join(fx.home, "archive", "cleanup.json")
    expect(fs.existsSync(file)).toBe(true)
    const persisted = JSON.parse(fs.readFileSync(file, "utf-8"))
    expect(persisted.taskId).toBe(fx.taskId)
    expect(persisted.status).toBe("done")
    expect(cleaner.readReport(fx.taskId)?.status).toBe("done")
  }, 30_000)

  it("refuses to clean when the resolved dir is the configured main repo", async () => {
    const fx = makeFixture()
    const wsPath = path.dirname(path.dirname(fx.repo))
    fs.writeFileSync(
      path.join(wsPath, "config.json"),
      JSON.stringify({
        name: "ws",
        repos: [{ name: "api", main_path: fx.repo, worktree_path: fx.repo, branch: "feat/x" }],
      }, null, 2),
    )
    writeFile(fx.repo, "node_modules/pkg/a.js", "n".repeat(1024))

    const homeService = new TaskHomeService(fx.homeBase)
    const cleaner = createArchiveCleaner({ db: fx.db, taskHomeService: homeService, run: defaultRun })
    const report = await cleaner.cleanupTask(fx.taskId)

    expect(report.status).toBe("failed")
    expect(report.projects[0].error).toMatch(/主仓/)
    expect(fs.existsSync(path.join(fx.repo, "node_modules"))).toBe(true)
    await expect(
      cleaner.cleanLeftovers(fx.taskId, fx.project, [".idea"]),
    ).rejects.toThrow(/主仓/)
  }, 30_000)

  it("cleanLeftovers deletes a listed ignored path, refuses protected / escaping / tracked paths", async () => {
    const fx = makeFixture()
    const homeService = new TaskHomeService(fx.homeBase)
    const cleaner = createArchiveCleaner({ db: fx.db, taskHomeService: homeService, run: defaultRun })
    writeFile(fx.repo, ".idea/workspace.xml", "<x/>")
    writeFile(fx.repo, ".env", "SECRET=1")
    writeFile(fx.repo, "dist/tracked.txt", "tracked payload")
    git(["add", "-f", "dist/tracked.txt"], fx.repo)
    git(["commit", "-m", "track dist"], fx.repo)
    writeFile(fx.repo, "dist/artifact.js", "built")

    const initial = await cleaner.cleanupTask(fx.taskId)
    expect(initial.projects[0].leftovers.some((l) => l.path === ".idea")).toBe(true)

    const first = await cleaner.cleanLeftovers(fx.taskId, fx.project, [".idea"])
    expect(first.results[0]).toMatchObject({ path: ".idea", ok: true })
    expect(fs.existsSync(path.join(fx.repo, ".idea"))).toBe(false)

    const refused = await cleaner.cleanLeftovers(fx.taskId, fx.project, [
      ".env",
      "../outside",
      "dist",
    ])
    const byPath = new Map(refused.results.map((r) => [r.path, r]))
    expect(byPath.get(".env")?.ok).toBe(false)
    expect(byPath.get(".env")?.reason).toMatch(/受保护/)
    expect(byPath.get("../outside")?.ok).toBe(false)
    expect(byPath.get("../outside")?.reason).toMatch(/越界/)
    expect(byPath.get("dist")?.ok).toBe(false)
    expect(byPath.get("dist")?.reason).toMatch(/跟踪文件/)
    expect(fs.existsSync(path.join(fx.repo, ".env"))).toBe(true)
    expect(fs.existsSync(path.join(fx.repo, "dist", "tracked.txt"))).toBe(true)

    // The ignored file inside dist/ is fair game when named explicitly.
    const okFile = await cleaner.cleanLeftovers(fx.taskId, fx.project, ["dist/artifact.js"])
    expect(okFile.results[0]).toMatchObject({ path: "dist/artifact.js", ok: true })
    expect(fs.existsSync(path.join(fx.repo, "dist", "artifact.js"))).toBe(false)

    const persisted = cleaner.readReport(fx.taskId)
    expect(persisted?.total_freed_bytes).toBeGreaterThan(0)
  }, 30_000)
})
