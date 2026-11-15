// packages/server/src/services/cabin/cabin-repos.ts
//
// Cabin repo helpers shared by CabinInitService (gate 3/4) and CabinService
// (repos endpoint / wake). The org registry contract is the existing one:
// ~/.octopus/orgs/<org>/repos/manifest.json + projects/<group>/<name> clones.
// config.json.repos[] stays the single cabin-side repo contract (decision #3).
//
// 2026-11-15 · 舱籍第三轮口径（design 21 §1.6 / plan 22 §2）：
//   · 项目 = 关联；ORG 主仓只读，只能 fetch + ff-only pull；
//   · 改动一律发生在 worktree；舱内/舱外仓库同语义；
//   · worktree 目录 projects/<name>（主）+ projects/<instance>/<name>（并行实例）。

import fs from "fs"
import path from "path"
import os from "os"
import { spawnSync } from "child_process"
import {
  parseManifest, parseManifestJson, findLocalRepo, cloneProject,
  type ManifestEntry,
} from "@octopus/shared"

export function getOctopusHome(): string {
  return process.env.OCTOPUS_HOME ?? path.join(os.homedir(), ".octopus")
}

export function getCloneBase(org: string): string {
  return path.join(getOctopusHome(), "orgs", org, "repos", "projects")
}

export function readOrgManifest(org: string): Record<string, ManifestEntry[]> {
  const reposDir = path.join(getOctopusHome(), "orgs", org, "repos")
  const jsonPath = path.join(reposDir, "manifest.json")
  const mdPath = path.join(reposDir, "manifest.md")
  if (fs.existsSync(jsonPath)) return parseManifestJson(fs.readFileSync(jsonPath, "utf-8"))
  if (fs.existsSync(mdPath)) return parseManifest(fs.readFileSync(mdPath, "utf-8"))
  return {}
}

export function findOrgEntry(
  groups: Record<string, ManifestEntry[]>, name: string,
): { entry: ManifestEntry; group: string } | null {
  for (const [group, entries] of Object.entries(groups)) {
    const found = entries.find((e) => e.name === name)
    if (found) return { entry: found, group }
  }
  return null
}

// ── 类型契约 ────────────────────────────────────────────────────────

/** org = ORG manifest 注册仓库；local = 目录里的仓库（舱内映射或舱外显式登记）。 */
export type CabinRepoSource = "org" | "local"

/** 并行 worktree 实例登记（同一项目多条分支并行时）。 */
export interface CabinWorktreeEntry {
  path: string
  branch: string
  /** 实例键：作业 id / 显式动作短码。 */
  instance: string
  created_at?: string
}

/** config.json.repos[] entry — pre-clone placeholders carry only name/group;
 *  post-init entries carry the project registration (source / main_path /
 *  mainline_branch) that resolveRepoDir / resolveWorktree read.
 *
 *  关键不变量：`branch` 永远只表示 **worktree 分支**；主线写 `mainline_branch`。
 *  `ensureWorktreesForReuse` 以 `branch + worktree_path` 作为「该重建」开关，
 *  把主线塞进 `branch` 会让新舱一唤醒就被自愈建出工作树。 */
export interface CabinRepoEntry {
  name: string
  /** 缺省 = "org"（兼容本轮之前写下的 config）。 */
  source?: CabinRepoSource
  // ORG 专用
  group?: string
  repoName?: string
  /** 归属 org（跨 org 关联时记录；老数据 group 就是 org）。 */
  org?: string
  // 路径
  /** 共享克隆 / 本地仓库绝对路径。 */
  main_path?: string
  /** 舱内本地项目的相对路径（如 apps/console）；舱外为空。 */
  local_path?: string
  /** 舱目录之外的来源（显式配置登记）。 */
  external?: boolean
  // 主线（只读展示；不参与 self-heal）
  mainline_branch?: string
  // worktree（只有真的开了才有；self-heal 以这两个字段为开关）
  worktree_path?: string
  branch?: string
  /** 并行实例（主 worktree 之外的）。 */
  worktrees?: CabinWorktreeEntry[]
}

/** 建舱/绑定时的项目输入（wire 形态）。 */
export interface CabinProjectInput {
  source?: CabinRepoSource
  /** ORG 项目所属 org。 */
  org?: string
  /** 项目名 / 本地目录名。 */
  repo?: string
  name?: string
  /** 舱内相对路径（source=local）。 */
  localPath?: string
  /** 舱外绝对路径（显式登记，需 external=true）。 */
  absolutePath?: string
  external?: boolean
}

/** 本地扫描候选（建舱初始化 / 绑定面板用）。 */
export interface LocalProjectCandidate {
  name: string
  /** 相对扫描根的路径（根自身 = "."）。 */
  local_path: string
  branch: string | null
  dirty: boolean
  remote: string | null
}

// ── 路径 ────────────────────────────────────────────────────────────

function realpathOr(p: string): string {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return path.resolve(p)
  }
}

/** target 是否在 root 内（含 root 自身）。realpath 比较，符号链接按真实位置算。 */
export function isPathInside(root: string, target: string): boolean {
  const r = realpathOr(root)
  const t = realpathOr(target)
  return t === r || t.startsWith(r + path.sep)
}

/** 舱内项目才写 local_path；舱外一律 external。 */
export function isExternalPath(cabinPath: string, absPath: string): boolean {
  return !isPathInside(cabinPath, absPath)
}

// ── key / 归一化 ────────────────────────────────────────────────────

/** 稳定项目键：ORG = `org:<org>/<name>`；本地 = `local:<local_path|name>`。 */
export function projectKey(entry: CabinRepoEntry): string {
  if ((entry.source ?? "org") === "org") {
    return `org:${entry.group || entry.org || ""}/${entry.name}`
  }
  return `local:${entry.local_path || entry.name}`
}

export function repoSource(entry: CabinRepoEntry): CabinRepoSource {
  return entry.source === "local" ? "local" : "org"
}

/** 老数据补齐：缺 source → org；org 条目 group 就是 org。 */
export function normalizeCabinRepoEntry(entry: CabinRepoEntry): CabinRepoEntry {
  const source = repoSource(entry)
  if (source === "org") {
    return { ...entry, source: "org", org: entry.org || entry.group }
  }
  return { ...entry, source: "local", external: entry.external === true }
}

// ── git 探测 ────────────────────────────────────────────────────────

function gitOut(dir: string, args: string[], timeout = 3_000): string | null {
  const r = spawnSync("git", ["-C", dir, ...args], { timeout, encoding: "utf-8" })
  if (r.status !== 0) return null
  return (r.stdout ?? "").trim()
}

export interface LocalRepoInfo {
  branch: string | null
  dirty: boolean
  remote: string | null
}

/** 只读探测：分支 / 是否有未提交改动 / origin。失败一律 null，不猜。 */
export function readLocalRepoInfo(repoPath: string): LocalRepoInfo {
  const branch = gitOut(repoPath, ["symbolic-ref", "--short", "-q", "HEAD"]) ?? null
  const status = gitOut(repoPath, ["status", "--porcelain"])
  const remote = gitOut(repoPath, ["remote", "get-url", "origin"]) ?? null
  return { branch, dirty: status !== null && status !== "", remote }
}

export function defaultMainlineBranch(repoPath: string): string | null {
  return gitOut(repoPath, ["symbolic-ref", "--short", "-q", "HEAD"])
}

export function isGitRepo(dir: string): boolean {
  if (!fs.existsSync(dir)) return false
  const dotGit = path.join(dir, ".git")
  return fs.existsSync(dotGit)
}

// ── 本地项目扫描 ────────────────────────────────────────────────────

const SCAN_IGNORED = new Set([
  ".git", ".cabin", "projects", "node_modules", "dist", "build",
  "target", "vendor", ".next", ".worktrees",
])
const SCAN_MAX_CANDIDATES = 50
const SCAN_MAX_DEPTH = 2

function visibleDir(name: string): boolean {
  return !name.startsWith(".") && !SCAN_IGNORED.has(name)
}

function safeRealDir(full: string): boolean {
  try {
    const st = fs.lstatSync(full)
    // 符号链接一律跳过：防环、防越界（扫描是只读的，但可见性也要收口）。
    return st.isDirectory() && !st.isSymbolicLink()
  } catch {
    return false
  }
}

function pushCandidate(out: LocalProjectCandidate[], root: string, absDir: string, rel: string): void {
  if (out.length >= SCAN_MAX_CANDIDATES) return
  const info = readLocalRepoInfo(absDir)
  out.push({
    name: path.basename(absDir) || path.basename(root),
    local_path: rel,
    branch: info.branch,
    dirty: info.dirty,
    remote: info.remote,
  })
}

/**
 * 扫舱目录下的 git 仓库（默认深度 1；根自身是 repo 时整个舱目录记一个项目）。
 *
 * 规则见 plan 22 §2.3：
 *   · 忽略 .git/.cabin/projects/node_modules/dist/build/... 与隐藏目录；
 *   · 父目录本身是 repo 时不再往下扫（防 monorepo 重复计数）；
 *   · 符号链接跳过；候选上限 50；纯读，失败返回空数组不抛。
 */
export function scanLocalProjects(root: string): LocalProjectCandidate[] {
  const out: LocalProjectCandidate[] = []
  let base: string
  try {
    base = fs.realpathSync.native(root)
  } catch {
    return out
  }
  if (!fs.existsSync(base)) return out

  // 根自身就是仓库 → 一个项目，不再往下扫。
  if (isGitRepo(base)) {
    pushCandidate(out, base, base, ".")
    return out
  }

  let level1: fs.Dirent[] = []
  try {
    level1 = fs.readdirSync(base, { withFileTypes: true })
  } catch {
    return out
  }

  for (const cur of level1) {
    if (out.length >= SCAN_MAX_CANDIDATES) break
    if (!cur.isDirectory() || !visibleDir(cur.name)) continue
    const abs1 = path.join(base, cur.name)
    if (!safeRealDir(abs1)) continue
    if (isGitRepo(abs1)) {
      pushCandidate(out, base, abs1, cur.name)
      continue
    }
    if (SCAN_MAX_DEPTH < 2) continue
    let level2: fs.Dirent[] = []
    try {
      level2 = fs.readdirSync(abs1, { withFileTypes: true })
    } catch {
      continue
    }
    for (const sub of level2) {
      if (out.length >= SCAN_MAX_CANDIDATES) break
      if (!sub.isDirectory() || !visibleDir(sub.name)) continue
      const abs2 = path.join(abs1, sub.name)
      if (!safeRealDir(abs2)) continue
      if (isGitRepo(abs2)) pushCandidate(out, base, abs2, path.join(cur.name, sub.name))
    }
  }

  // 同名目录（apps/console vs tools/console）→ 用父目录加前缀消歧。
  const seen = new Map<string, number>()
  for (const c of out) seen.set(c.name, (seen.get(c.name) ?? 0) + 1)
  return out.map((c) => {
    if ((seen.get(c.name) ?? 0) <= 1) return c
    const parent = path.dirname(c.local_path)
    if (!parent || parent === ".") return c
    return { ...c, name: `${path.basename(parent)}-${c.name}` }
  })
}

// ── config.json ─────────────────────────────────────────────────────

export function readCabinConfig(cabinPath: string): { name: string; repos: CabinRepoEntry[] } {
  const configPath = path.join(cabinPath, "config.json")
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as { name?: string; repos?: unknown }
    return {
      name: typeof raw.name === "string" ? raw.name : path.basename(cabinPath),
      repos: Array.isArray(raw.repos) ? (raw.repos as CabinRepoEntry[]) : [],
    }
  } catch {
    return { name: path.basename(cabinPath), repos: [] }
  }
}

/** Merge repo entries into config.json (preserves other keys). Atomic write. */
export function writeCabinConfigRepos(cabinPath: string, repos: CabinRepoEntry[]): void {
  const configPath = path.join(cabinPath, "config.json")
  let config: Record<string, unknown> = {}
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>
  } catch {
    config = { name: path.basename(cabinPath), created: new Date().toISOString() }
  }
  config.repos = repos
  const tmp = `${configPath}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), "utf-8")
  fs.renameSync(tmp, configPath)
}

function stripUndefined<T extends object>(value: T): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    if (v !== undefined) out[k] = v
  }
  return out as T
}

/**
 * 按 name 合并一条项目登记，**保留未知字段**。
 *
 * 这是 Cabin 侧唯一允许的 config.repos 写口：`writeSpecWorktreeMeta` 会整表
 * 重写成 5 个字段，把 source / local_path / mainline_branch 抹掉。
 */
export function mergeCabinRepoEntry(cabinPath: string, entry: CabinRepoEntry): CabinRepoEntry {
  const config = readCabinConfig(cabinPath)
  const next = stripUndefined(entry)
  const index = config.repos.findIndex((r) => r.name === entry.name)
  if (index >= 0) {
    config.repos[index] = stripUndefined({ ...config.repos[index], ...next })
  } else {
    config.repos.push(next)
  }
  writeCabinConfigRepos(cabinPath, config.repos)
  return config.repos.find((r) => r.name === entry.name) as CabinRepoEntry
}

export function removeCabinRepoEntry(cabinPath: string, name: string): boolean {
  const config = readCabinConfig(cabinPath)
  const next = config.repos.filter((r) => r.name !== name)
  if (next.length === config.repos.length) return false
  writeCabinConfigRepos(cabinPath, next)
  return true
}

/** 项目登记 → 绝对主仓路径。舱外/local 条目直接用 main_path。 */
export function resolveCabinRepo(
  cabinPath: string,
  entry: CabinRepoEntry,
): { mainPath: string | null; external: boolean } {
  if (entry.main_path) {
    return { mainPath: entry.main_path, external: entry.external === true || isExternalPath(cabinPath, entry.main_path) }
  }
  if (entry.local_path) {
    const abs = path.resolve(cabinPath, entry.local_path)
    return { mainPath: abs, external: false }
  }
  return { mainPath: null, external: false }
}

// ── worktree 目录 ───────────────────────────────────────────────────

/**
 * worktree 目录：
 *   · 主实例 = `<cabin>/projects/<name>`（向后兼容老舱）；
 *   · 并行实例 = `<cabin>/projects/<instance>/<name>`（子目录隔离，避免同名互删）。
 */
function safeSegment(raw: string, fallback: string): string {
  // 目录段只留 [A-Za-z0-9._-]：instance / name 来自 query/body，不能穿越出舱目录。
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.\-]+/, "")
  return cleaned === "" ? fallback : cleaned
}

export function worktreeDirFor(cabinPath: string, name: string, instance?: string): string {
  const safeName = safeSegment(name, "repo")
  if (instance && instance.trim() !== "") {
    return path.join(cabinPath, "projects", safeSegment(instance, "wt"), safeName)
  }
  return path.join(cabinPath, "projects", safeName)
}

// ── 克隆 ────────────────────────────────────────────────────────────

/** Idempotent: already-cloned repos return their local path; otherwise clone
 *  from the org manifest. Never throws — failures come back as {error}. */
export function ensureRepoCloned(org: string, name: string): { localPath: string } | { error: string } {
  const groups = readOrgManifest(org)
  const found = findOrgEntry(groups, name)
  if (!found) return { error: `repo '${name}' not found in org '${org}' manifest` }
  const cloneBase = getCloneBase(org)
  const existing = findLocalRepo(found.group, name, cloneBase)
  if (existing) return { localPath: existing }
  if (!found.entry.git_url) return { error: `repo '${name}' has no git_url` }
  const result = cloneProject(found.entry.git_url, found.group, name, found.entry.branch, cloneBase)
  if (!result.success) return { error: result.message }
  const localPath = findLocalRepo(found.group, name, cloneBase)
  if (!localPath) return { error: `clone reported success but local path missing for '${name}'` }
  return { localPath }
}

/** 舱内/舱外本地项目的登记条目（不 clone）。 */
export function localRepoEntry(
  cabinPath: string,
  input: { name: string; absPath: string },
): CabinRepoEntry {
  const abs = realpathOr(input.absPath)
  const external = isExternalPath(cabinPath, abs)
  const info = readLocalRepoInfo(abs)
  return stripUndefined({
    name: input.name,
    source: "local",
    main_path: abs,
    local_path: external ? undefined : path.relative(realpathOr(cabinPath), abs) || ".",
    external: external || undefined,
    mainline_branch: info.branch ?? undefined,
  })
}

/** ORG 项目登记条目（clone 由 ensureRepoCloned 负责）。 */
export function orgRepoEntry(
  input: { name: string; org?: string; group?: string; mainPath?: string; mainline?: string | null },
): CabinRepoEntry {
  return stripUndefined({
    name: input.name,
    source: "org",
    org: input.org,
    group: input.group || input.org,
    repoName: input.name,
    main_path: input.mainPath,
    mainline_branch: input.mainline ?? undefined,
  })
}