import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import {
  scanLocalProjects, isPathInside, worktreeDirFor, projectKey,
  mergeCabinRepoEntry, removeCabinRepoEntry, readCabinConfig,
  resolveCabinRepo, localRepoEntry, repoSource,
  localBranchExists, remoteBranchExists,
} from "../cabin-repos"

function git(cwd: string, args: string[]) {
  return spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd, encoding: "utf-8",
  })
}

function makeRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  expect(git(dir, ["init", "-b", "main"]).status).toBe(0)
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n")
  expect(git(dir, ["add", "."]).status).toBe(0)
  expect(git(dir, ["commit", "-m", "init"]).status).toBe(0)
}

describe("cabin-repos · 本地扫描与路径", () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cabin-repos-scan-"))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("扫深度 1 的仓库，忽略 node_modules / 隐藏目录", () => {
    makeRepo(path.join(root, "alpha"))
    makeRepo(path.join(root, "beta"))
    makeRepo(path.join(root, "node_modules", "dep"))
    makeRepo(path.join(root, ".hidden", "x"))

    const found = scanLocalProjects(root)
    expect(found.map((p) => p.local_path).sort()).toEqual(["alpha", "beta"])
    const alpha = found.find((p) => p.local_path === "alpha")!
    expect(alpha.branch).toBe("main")
    expect(alpha.dirty).toBe(false)
  })

  it("父目录是 repo 时不再往下扫（防 monorepo 重复计数）", () => {
    makeRepo(path.join(root, "mono"))
    fs.mkdirSync(path.join(root, "mono", "packages", "web"), { recursive: true })
    expect(git(path.join(root, "mono", "packages", "web"), ["init", "-b", "main"]).status).toBe(0)

    const found = scanLocalProjects(root)
    expect(found).toHaveLength(1)
    expect(found[0].local_path).toBe("mono")
  })

  it("深度 2：apps/console 与 tools/scripts 都能发现", () => {
    makeRepo(path.join(root, "apps", "console"))
    makeRepo(path.join(root, "tools", "scripts"))
    const found = scanLocalProjects(root)
    expect(found.map((p) => p.local_path).sort()).toEqual(["apps/console", "tools/scripts"])
  })

  it("同名项目用父目录前缀消歧", () => {
    makeRepo(path.join(root, "apps", "console"))
    makeRepo(path.join(root, "tools", "console"))
    const names = scanLocalProjects(root).map((p) => p.name).sort()
    expect(names).toEqual(["apps-console", "tools-console"])
  })

  it("根自身是 repo → 整个舱目录记一个项目（local_path = '.'）", () => {
    makeRepo(root)
    makeRepo(path.join(root, "nested"))
    const found = scanLocalProjects(root)
    expect(found).toHaveLength(1)
    expect(found[0].local_path).toBe(".")
  })

  it("不存在的根 → 空数组，不抛", () => {
    expect(scanLocalProjects(path.join(root, "nope"))).toEqual([])
  })

  it("isPathInside：包含自身 / 子路径 / 兄弟目录不误判", () => {
    const inside = path.join(root, "a", "b")
    fs.mkdirSync(inside, { recursive: true })
    expect(isPathInside(root, inside)).toBe(true)
    expect(isPathInside(root, root)).toBe(true)
    expect(isPathInside(path.join(root, "a"), path.join(root, "ab"))).toBe(false)
  })

  it("worktreeDirFor：主实例 projects/<name>，并行实例 projects/<instance>/<name>", () => {
    expect(worktreeDirFor("/c", "ledger")).toBe(path.join("/c", "projects", "ledger"))
    expect(worktreeDirFor("/c", "ledger", "job-9")).toBe(
      path.join("/c", "projects", "job-9", "ledger"),
    )
    expect(worktreeDirFor("/c", "ledger", "  ")).toBe(path.join("/c", "projects", "ledger"))
    // 路径穿越：instance / name 里的分隔符与 .. 一律清洗掉。
    expect(worktreeDirFor("/c", "ledger", "../../etc")).toBe(
      path.join("/c", "projects", "etc", "ledger"),
    )
    expect(worktreeDirFor("/c", "../evil")).toBe(path.join("/c", "projects", "evil"))
  })
})

describe("cabin-repos · config 合并", () => {
  let cabin: string

  beforeEach(() => {
    cabin = fs.mkdtempSync(path.join(os.tmpdir(), "cabin-repos-cfg-"))
    fs.writeFileSync(path.join(cabin, "config.json"), JSON.stringify({
      name: "舱", created: "2026-01-01", repos: [],
    }))
  })

  afterEach(() => {
    fs.rmSync(cabin, { recursive: true, force: true })
  })

  it("mergeCabinRepoEntry 按 name 合并，保留未触碰的字段（source/local_path/mainline_branch）", () => {
    mergeCabinRepoEntry(cabin, {
      name: "console", source: "local", main_path: "/w/console",
      local_path: "apps/console", mainline_branch: "feat/x", custom: "keep-me",
    } as never)
    const merged = mergeCabinRepoEntry(cabin, {
      name: "console", worktree_path: "/w/projects/console", branch: "cabin-1",
    })
    expect(merged.source).toBe("local")
    expect(merged.local_path).toBe("apps/console")
    expect(merged.mainline_branch).toBe("feat/x")
    expect((merged as unknown as { custom: string }).custom).toBe("keep-me")
    expect(merged.worktree_path).toBe("/w/projects/console")
    expect(merged.branch).toBe("cabin-1")
    // 其他顶层字段不能被抹掉。
    const raw = JSON.parse(fs.readFileSync(path.join(cabin, "config.json"), "utf-8"))
    expect(raw.name).toBe("舱")
    expect(raw.created).toBe("2026-01-01")
  })

  it("mergeCabinRepoEntry：mainline_branch = null 显式清除，其余字段不动", () => {
    mergeCabinRepoEntry(cabin, {
      name: "console", source: "local", local_path: "apps/console", mainline_branch: "feat/x",
    })
    const cleared = mergeCabinRepoEntry(cabin, { name: "console", mainline_branch: null })
    expect(cleared.mainline_branch).toBeUndefined()
    expect(cleared.source).toBe("local")
    expect(cleared.local_path).toBe("apps/console")
    // 落盘里不留 null。
    const raw = JSON.parse(fs.readFileSync(path.join(cabin, "config.json"), "utf-8"))
    expect(raw.repos[0]).not.toHaveProperty("mainline_branch")
  })

  it("removeCabinRepoEntry 只删目标条目", () => {
    mergeCabinRepoEntry(cabin, { name: "a", source: "org" })
    mergeCabinRepoEntry(cabin, { name: "b", source: "local" })
    expect(removeCabinRepoEntry(cabin, "a")).toBe(true)
    expect(readCabinConfig(cabin).repos.map((r) => r.name)).toEqual(["b"])
    expect(removeCabinRepoEntry(cabin, "missing")).toBe(false)
  })

  it("projectKey：ORG 用 org/name，本地用 local_path", () => {
    expect(projectKey({ name: "ledger", source: "org", org: "XzhiF" })).toBe("org:XzhiF/ledger")
    expect(projectKey({ name: "console", source: "local", local_path: "apps/console" }))
      .toBe("local:apps/console")
  })

  it("老数据无 source → 按 org 处理；repoSource 归一化", () => {
    mergeCabinRepoEntry(cabin, { name: "legacy", group: "XzhiF" })
    const entry = readCabinConfig(cabin).repos[0]
    expect(repoSource(entry)).toBe("org")
    expect(projectKey(entry)).toBe("org:XzhiF/legacy")
  })

  it("localRepoEntry：舱内写 local_path，舱外标 external", () => {
    const inside = path.join(cabin, "apps", "console")
    makeRepo(inside)
    const entry = localRepoEntry(cabin, { name: "console", absPath: inside })
    expect(entry.source).toBe("local")
    expect(entry.external).toBeUndefined()
    expect(entry.local_path).toBe(path.join("apps", "console"))

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cabin-repos-out-"))
    try {
      makeRepo(path.join(outside, "ext"))
      const ext = localRepoEntry(cabin, { name: "ext", absPath: path.join(outside, "ext") })
      expect(ext.external).toBe(true)
      expect(ext.local_path).toBeUndefined()
      expect(ext.main_path).toBe(fs.realpathSync(path.join(outside, "ext")))
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it("resolveCabinRepo：main_path 优先；local_path 相对舱目录解析", () => {
    const a = resolveCabinRepo(cabin, { name: "a", main_path: "/x/a" })
    expect(a.mainPath).toBe("/x/a")
    const b = resolveCabinRepo(cabin, { name: "b", source: "local", local_path: "apps/b" })
    expect(b.mainPath).toBe(path.join(cabin, "apps", "b"))
    expect(b.external).toBe(false)
  })
})

describe("cabin-repos · 分支探测", () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cabin-repos-br-"))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("localBranchExists：本地分支命中，缺失返回 false", () => {
    const repo = path.join(root, "repo")
    makeRepo(repo)
    expect(git(repo, ["branch", "feat/landing"]).status).toBe(0)
    expect(localBranchExists(repo, "main")).toBe(true)
    expect(localBranchExists(repo, "feat/landing")).toBe(true)
    expect(localBranchExists(repo, "feat/missing")).toBe(false)
  })

  it("remoteBranchExists：无 origin = false（本地是唯一真相）", () => {
    const repo = path.join(root, "repo")
    makeRepo(repo)
    expect(remoteBranchExists(repo, "main")).toBe(false)
  })
})