// packages/server/src/services/tasks/archive-cleanup-service.ts
//
// 归档后构建产物清理（2026-10-31）—「done 之后补一步」。
//
// 任务归档完成后，各 project 的 worktree 仍留在盘上；跑过 install/build 的仓
// 往往带着 node_modules / target / dist / classes / jar 之类可再生产物，单个任务
// 动辄几个 GB。本模块在 done 后做一次**确定性清扫**：
//
//   • 发现 = `git status --porcelain -z --ignored=traditional` 的 `!!` 行
//     （只列 git 忽略项；不递归 ignored 目录，快且不误伤源码）。
//   • 分类 = 构建产物白名单（多语言）→ 删除候选；其余 ignored 项 → leftovers，
//     只计量、只列清单，交给主 Chat 的 Agent 兜底（clean_archive_leftovers）。
//   • 删除前三重校验：git check-ignore 通过 / 内部无已跟踪文件 / 内部无未跟踪且
//     未忽略文件；受保护路径（.env、密钥、.claude、.git …）永不删。
//   • worktree 必须是 git 根（rev-parse --show-toplevel == 解析目录），绝不碰主仓。
//
// 报告落 `{task home}/archive/cleanup.json`（report.json 是归档快照，不改写），
// 归档台与 get_archive_state 只读它。

import fs from "fs"
import path from "path"
import type Database from "better-sqlite3"
import { defaultRun, resolveProjectDir, type CommandRunner } from "./archive-delta"
import type { TaskHomeService } from "./task-home-service"

// ── Types ────────────────────────────────────────────────────────────

export interface IgnoredEntry {
  /** Worktree-relative posix path (no trailing slash). */
  path: string
  kind: "dir" | "file"
}

export interface CleanupRemovedItem {
  path: string
  kind: "dir" | "file"
  bytes: number
}

export interface CleanupLeftoverItem {
  path: string
  kind: "dir" | "file"
  /** null = 计量超预算（目录过大，未走完）。 */
  bytes: number | null
}

export interface ProjectCleanupResult {
  project: string
  dir: string | null
  ok: boolean
  /** 本次实际删除的条目数（removed 数组只保留前 100 条明细）。 */
  removed_count: number
  removed: CleanupRemovedItem[]
  freed_bytes: number
  /** 安全校验不通过 → 未删（内部有跟踪文件 / 未跟踪且未忽略 / 受保护 …）。 */
  skipped: Array<{ path: string; reason: string }>
  /** 校验通过但删除本身失败（Windows 锁文件等）——可让 Agent 重试。 */
  failed: Array<{ path: string; message: string }>
  /** 其余被 git 忽略、但不在构建产物白名单里的条目（只列清单，不删）。 */
  leftovers: CleanupLeftoverItem[]
  /** leftovers 的真实总数（数组只保留前 100 条）。 */
  leftover_count: number
  error?: string
}

export interface ArchiveCleanupReport {
  taskId: string
  startedAt: string
  finishedAt: string | null
  status: "running" | "done" | "partial" | "failed"
  total_freed_bytes: number
  projects: ProjectCleanupResult[]
  error?: string
}

export interface CleanupLeftoversResult {
  path: string
  ok: boolean
  bytes?: number
  reason?: string
}

export interface ArchiveCleanupDeps {
  db: Database.Database
  taskHomeService: TaskHomeService
  /** Injectable command runner (production = spawnSync; tests = real git). */
  run?: CommandRunner
  now?: () => Date
}

export interface TaskArchiveCleaner {
  cleanupTask(taskId: string): Promise<ArchiveCleanupReport>
  cleanLeftovers(
    taskId: string,
    project: string,
    paths: string[],
  ): Promise<{ report: ArchiveCleanupReport; results: CleanupLeftoversResult[] }>
  readReport(taskId: string): ArchiveCleanupReport | null
}

// ── Whitelist ────────────────────────────────────────────────────────
//
// 泛名（build / bin / out / target / vendor）只在「git 已忽略」时才会成为候选；
// 被仓库跟踪的同名目录根本不会出现在 `!!` 列表里，所以不会误删源码目录。

const BUILD_ARTIFACT_DIRS = new Set([
  // JS / TS
  "node_modules", "bower_components", "jspm_packages", "dist", "build", "out",
  "coverage", ".next", ".nuxt", ".output", ".turbo", ".parcel-cache", ".vite",
  ".cache", ".angular", ".svelte-kit", "storybook-static",
  // JVM / Kotlin / Scala
  "target", ".gradle", ".bloop", ".metals",
  // Python
  "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".venv", "venv",
  // PHP / Ruby
  "vendor", ".bundle",
  // .NET / C / C++ / Go
  "bin", "obj",
  // Dart / Elixir / Haskell / Swift / Obj-C
  ".dart_tool", "_build", "deps", "dist-newstyle", ".stack-work", ".build", "DerivedData",
])

const BUILD_ARTIFACT_DIR_PREFIXES = ["cmake-build-"]

const BUILD_ARTIFACT_FILE_EXTS = new Set([
  ".class", ".jar", ".war", ".ear",
  ".pyc", ".pyo",
  ".o", ".so", ".dylib", ".dll", ".beam",
])

const PROTECTED_SEGMENTS = new Set([".git", ".claude", ".octopus"])
const PROTECTED_FILE_RE = /(^\.env(\..*)?$)|(\.(pem|key|p12|pfx|keystore)$)/i

const REMOVED_CAP = 100
const LEFTOVER_CAP = 100
const SKIPPED_CAP = 50
const CANDIDATE_MEASURE_CAP = 200_000
const LEFTOVER_MEASURE_CAP = 5_000

// ── Pure helpers ─────────────────────────────────────────────────────

/** Parse `git status --porcelain -z --ignored=traditional` and keep `!!` rows. */
export function parseIgnoredEntries(raw: string): IgnoredEntry[] {
  const out: IgnoredEntry[] = []
  for (const chunk of raw.split("\0")) {
    if (!chunk.startsWith("!! ")) continue
    const rawPath = chunk.slice(3)
    if (!rawPath) continue
    const isDir = rawPath.endsWith("/")
    const rel = (isDir ? rawPath.slice(0, -1) : rawPath).replace(/\\/g, "/")
    if (!rel) continue
    out.push({ path: rel, kind: isDir ? "dir" : "file" })
  }
  return out
}

/** candidate = 白名单构建产物（会尝试删除）；leftover = 其余 ignored 项（只列清单）。 */
export function classifyIgnoredEntry(entry: IgnoredEntry): "candidate" | "leftover" {
  const base = path.posix.basename(entry.path)
  if (entry.kind === "dir") {
    if (BUILD_ARTIFACT_DIRS.has(base)) return "candidate"
    if (BUILD_ARTIFACT_DIR_PREFIXES.some((p) => base.startsWith(p))) return "candidate"
    return "leftover"
  }
  const ext = path.posix.extname(base).toLowerCase()
  return BUILD_ARTIFACT_FILE_EXTS.has(ext) ? "candidate" : "leftover"
}

/** 受保护路径：即使被 git 忽略也绝不自动删（密钥 / 本地配置 / 系统目录）。 */
export function isProtectedRel(rel: string): boolean {
  const segs = rel.split("/").filter(Boolean)
  if (segs.length === 0) return true
  if (segs.some((s) => PROTECTED_SEGMENTS.has(s))) return true
  return PROTECTED_FILE_RE.test(segs[segs.length - 1])
}

/** Resolve a worktree-relative path; null = 空 / 绝对 / `..` / 逃出根。 */
function resolveInside(rootAbs: string, rel: string): string | null {
  if (!rel || rel.includes("\0")) return null
  if (
    path.isAbsolute(rel) ||
    /^[a-zA-Z]:[\\/]/.test(rel) ||
    rel.startsWith("/") ||
    rel.startsWith("\\")
  ) {
    return null
  }
  if (rel.split(/[\\/]/).some((seg) => seg === "..")) return null
  const abs = path.resolve(rootAbs, rel)
  const back = path.relative(rootAbs, abs)
  if (back === "" || back.startsWith("..") || path.isAbsolute(back)) return null
  return abs
}

function samePath(a: string, b: string): boolean {
  const ra = path.resolve(a)
  const rb = path.resolve(b)
  return process.platform === "win32"
    ? ra.toLowerCase() === rb.toLowerCase()
    : ra === rb
}

// ── Measurement / deletion ───────────────────────────────────────────

interface MeasureResult {
  bytes: number
  /** true = 走盘超过 entryCap，bytes 只是下界（报告里显示为 null）。 */
  truncated: boolean
}

/** Sum file sizes without following symlinks/junctions. */
export async function measureTree(abs: string, entryCap: number): Promise<MeasureResult> {
  let bytes = 0
  let entries = 0
  let truncated = false
  const walk = async (dir: string): Promise<void> => {
    if (truncated) return
    let ents: fs.Dirent[]
    try {
      ents = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of ents) {
      entries += 1
      if (entries > entryCap) {
        truncated = true
        return
      }
      const full = path.join(dir, ent.name)
      let st: fs.Stats
      try {
        st = await fs.promises.lstat(full)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) continue // junction/symlink: 链接本身不占产物体积，也不跟随
      if (st.isDirectory()) {
        await walk(full)
        if (truncated) return
      } else if (st.isFile()) {
        bytes += st.size
      }
    }
  }
  try {
    const st = await fs.promises.lstat(abs)
    if (st.isSymbolicLink()) return { bytes: 0, truncated: false }
    if (st.isFile()) return { bytes: st.size, truncated: false }
    if (st.isDirectory()) await walk(abs)
  } catch {
    /* already gone */
  }
  return { bytes, truncated }
}

/** 软链/junction 只拆链接本身；真实目录递归删除（Node 的 rm 不跟随链接）。 */
async function removePath(abs: string): Promise<void> {
  let st: fs.Stats
  try {
    st = await fs.promises.lstat(abs)
  } catch {
    return // raced away — idempotent success
  }
  if (st.isSymbolicLink()) {
    await fs.promises.unlink(abs)
    return
  }
  await fs.promises.rm(abs, {
    recursive: st.isDirectory(),
    force: true,
    maxRetries: 8,
    retryDelay: 150,
  })
}

// ── Safety verification ──────────────────────────────────────────────

type VerifyResult = { ok: true; abs: string } | { ok: false; reason: string }

function verifyIgnoredPath(
  rootAbs: string,
  rel: string,
  run: CommandRunner,
): VerifyResult {
  const abs = resolveInside(rootAbs, rel)
  if (!abs) return { ok: false, reason: "路径越界或非法（须为 worktree 相对路径）" }
  if (isProtectedRel(rel)) return { ok: false, reason: "受保护路径（密钥/本地配置）" }

  const ignored = run("git", ["check-ignore", "-q", "--", rel], rootAbs)
  if (ignored.code !== 0) {
    // check-ignore（不带 --no-index）对「内部有已跟踪文件」的目录返回非零 ——
    // 这正是我们要的保守语义；用 --no-index 复检一次，好给出准确的拒绝原因。
    const patternIgnored = run("git", ["check-ignore", "-q", "--no-index", "--", rel], rootAbs)
    return {
      ok: false,
      reason: patternIgnored.code === 0 ? "内部含已跟踪文件，不能整体删除" : "未被 git 忽略",
    }
  }

  const tracked = run("git", ["ls-files", "--", rel], rootAbs)
  if (tracked.code !== 0) {
    return { ok: false, reason: `git ls-files 失败: ${tracked.stderr.trim() || tracked.code}` }
  }
  if (tracked.stdout.trim()) return { ok: false, reason: "内部含已跟踪文件" }

  const untracked = run(
    "git",
    ["ls-files", "--others", "--exclude-standard", "--", rel],
    rootAbs,
  )
  if (untracked.code !== 0) {
    return {
      ok: false,
      reason: `git ls-files --others 失败: ${untracked.stderr.trim() || untracked.code}`,
    }
  }
  if (untracked.stdout.trim()) return { ok: false, reason: "内部含未跟踪且未忽略的文件" }

  return { ok: true, abs }
}

/** worktree 必须是它自己的 git 根（防止 config.json 指向主仓/子目录）。 */
function verifyWorktreeRoot(dir: string, run: CommandRunner): string | null {
  const top = run("git", ["rev-parse", "--show-toplevel"], dir)
  if (top.code !== 0) {
    return `不是 git worktree: ${top.stderr.trim() || top.code}`
  }
  const topAbs = top.stdout.trim()
  if (!samePath(topAbs, dir)) {
    return `worktree 根不匹配（git: ${topAbs}，ws: ${path.resolve(dir)}）`
  }
  return null
}

/** config.json 里该 project 的主仓路径（用于「绝不清理主仓」的兜底判断）。 */
function sourceRepoPath(wsPath: string, project: string): string | null {
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(wsPath, "config.json"), "utf-8"),
    ) as { repos?: Array<{ name?: string; main_path?: string }> }
    return cfg.repos?.find((r) => r.name === project)?.main_path ?? null
  } catch {
    return null
  }
}

/** 解析出的 worktree 若与主仓同一路径 → 拒绝（自动清理绝不碰用户主仓）。 */
function sourceRepoConflict(wsPath: string, project: string, dir: string): string | null {
  const main = sourceRepoPath(wsPath, project)
  if (main && samePath(main, dir)) {
    return `worktree 与主仓同一路径（不清理主仓）: ${dir}`
  }
  return null
}

// ── One-worktree sweep ───────────────────────────────────────────────

export interface SweepWorktreeOptions {
  run?: CommandRunner
  measureCap?: number
  leftoverMeasureCap?: number
}

/**
 * Discover → verify → measure → delete build artifacts in ONE worktree.
 * Never throws for per-path failures; the result carries ok / skipped / failed.
 */
export async function sweepWorktree(
  project: string,
  dir: string,
  opts: SweepWorktreeOptions = {},
): Promise<ProjectCleanupResult> {
  const run = opts.run ?? defaultRun
  const result: ProjectCleanupResult = {
    project,
    dir,
    ok: true,
    removed_count: 0,
    removed: [],
    freed_bytes: 0,
    skipped: [],
    failed: [],
    leftovers: [],
    leftover_count: 0,
  }

  let dirStat: fs.Stats
  try {
    dirStat = fs.statSync(dir)
  } catch {
    result.ok = false
    result.error = `worktree 不在盘: ${dir}`
    return result
  }
  if (!dirStat.isDirectory()) {
    result.ok = false
    result.error = `worktree 不是目录: ${dir}`
    return result
  }

  const rootError = verifyWorktreeRoot(dir, run)
  if (rootError) {
    result.ok = false
    result.error = rootError
    return result
  }

  const status = run("git", ["status", "--porcelain", "-z", "--ignored=traditional"], dir)
  if (status.code !== 0) {
    result.ok = false
    result.error = `git status 失败: ${status.stderr.trim() || status.code}`
    return result
  }

  const ignored = parseIgnoredEntries(status.stdout)
  const candidates: IgnoredEntry[] = []
  const leftovers: IgnoredEntry[] = []
  for (const entry of ignored) {
    if (classifyIgnoredEntry(entry) === "candidate") candidates.push(entry)
    else leftovers.push(entry)
  }

  for (const candidate of candidates) {
    const verified = verifyIgnoredPath(dir, candidate.path, run)
    if (!verified.ok) {
      if (result.skipped.length < SKIPPED_CAP) {
        result.skipped.push({ path: candidate.path, reason: verified.reason })
      }
      continue
    }
    const measured = await measureTree(verified.abs, opts.measureCap ?? CANDIDATE_MEASURE_CAP)
    try {
      await removePath(verified.abs)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      result.failed.push({ path: candidate.path, message })
      result.ok = false
      continue
    }
    result.removed_count += 1
    result.freed_bytes += measured.bytes
    if (result.removed.length < REMOVED_CAP) {
      result.removed.push({ path: candidate.path, kind: candidate.kind, bytes: measured.bytes })
    }
  }

  result.leftovers = await measureLeftovers(dir, leftovers, opts.leftoverMeasureCap ?? LEFTOVER_MEASURE_CAP)
  result.leftover_count = leftovers.length
  return result
}

/** Measure (never delete) non-whitelist ignored entries. Largest first, capped. */
async function measureLeftovers(
  dir: string,
  entries: IgnoredEntry[],
  entryCap: number,
): Promise<CleanupLeftoverItem[]> {
  const measured: CleanupLeftoverItem[] = []
  for (const entry of entries) {
    if (measured.length >= LEFTOVER_CAP) break
    const abs = resolveInside(dir, entry.path)
    let bytes: number | null = null
    if (abs) {
      const m = await measureTree(abs, entryCap)
      bytes = m.truncated ? null : m.bytes
    }
    measured.push({ path: entry.path, kind: entry.kind, bytes })
  }
  measured.sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1) || a.path.localeCompare(b.path))
  return measured
}

// ── Orchestrator ─────────────────────────────────────────────────────

function parseJSONSafe<T>(raw: string | null | undefined, fallback: T): T {
  if (raw == null) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

interface CleanupTaskRow {
  id: string
  project_ids: string | null
  workspace_id: string | null
  status: string
}

export function createArchiveCleaner(deps: ArchiveCleanupDeps): TaskArchiveCleaner {
  const run = deps.run ?? defaultRun
  const now = deps.now ?? (() => new Date())

  const reportPath = (taskId: string): string =>
    path.join(deps.taskHomeService.homePath(taskId), "archive", "cleanup.json")

  const writeReport = (report: ArchiveCleanupReport): void => {
    const file = reportPath(report.taskId)
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(report, null, 2), "utf-8")
      try {
        fs.renameSync(tmp, file)
      } catch {
        // Windows 上极端情况下 rename 失败（目标被占用）→ 直接覆盖，读侧容忍坏 JSON。
        fs.writeFileSync(file, JSON.stringify(report, null, 2), "utf-8")
        try {
          fs.rmSync(tmp, { force: true })
        } catch {
          /* best-effort */
        }
      }
    } catch (err: unknown) {
      console.error(
        `[ArchiveCleanup] writing cleanup.json failed for ${report.taskId} (non-fatal):`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  const readReport = (taskId: string): ArchiveCleanupReport | null => {
    try {
      const parsed = JSON.parse(fs.readFileSync(reportPath(taskId), "utf-8")) as ArchiveCleanupReport
      return parsed && typeof parsed === "object" ? parsed : null
    } catch {
      return null
    }
  }

  const loadRow = (taskId: string): { row: CleanupTaskRow; projects: string[]; wsPath: string | null } => {
    const row = deps.db
      .prepare("SELECT id, project_ids, workspace_id, status FROM tasks WHERE id = ?")
      .get(taskId) as CleanupTaskRow | undefined
    if (!row) throw new Error(`archive cleanup: task ${taskId} not found`)
    if (row.status !== "done") {
      throw new Error(`archive cleanup only runs for done tasks (task ${taskId} status='${row.status}')`)
    }
    const projects = parseJSONSafe<string[]>(row.project_ids, [])
    let wsPath: string | null = null
    if (row.workspace_id) {
      const ws = deps.db
        .prepare("SELECT path FROM workspaces WHERE id = ?")
        .get(row.workspace_id) as { path?: string } | undefined
      wsPath = ws?.path ?? null
    }
    return { row, projects, wsPath }
  }

  const cleanupTask = async (taskId: string): Promise<ArchiveCleanupReport> => {
    const { projects, wsPath } = loadRow(taskId)
    const report: ArchiveCleanupReport = {
      taskId,
      startedAt: now().toISOString(),
      finishedAt: null,
      status: "running",
      total_freed_bytes: 0,
      projects: [],
    }
    writeReport(report)

    try {
      if (!wsPath || !fs.existsSync(wsPath)) {
        report.status = "failed"
        report.error = `任务绑定的 workspace 路径不可用: ${wsPath ?? "未绑定"}`
      } else {
        for (const project of projects) {
          const resolved = resolveProjectDir(wsPath, project)
          if (!resolved.dir) {
            report.projects.push({
              project,
              dir: null,
              ok: false,
              removed_count: 0,
              removed: [],
              freed_bytes: 0,
              skipped: [],
              failed: [],
              leftovers: [],
              leftover_count: 0,
              error: resolved.error ?? "worktree 不可定位",
            })
          } else {
            const conflict = sourceRepoConflict(wsPath, project, resolved.dir)
            if (conflict) {
              report.projects.push({
                project,
                dir: resolved.dir,
                ok: false,
                removed_count: 0,
                removed: [],
                freed_bytes: 0,
                skipped: [],
                failed: [],
                leftovers: [],
                leftover_count: 0,
                error: conflict,
              })
            } else {
              const result = await sweepWorktree(project, resolved.dir, { run })
              report.projects.push(result)
              report.total_freed_bytes += result.freed_bytes
            }
          }
          writeReport(report) // 逐 project 落盘 — 归档台可渐进显示
        }
        const okCount = report.projects.filter((p) => p.ok).length
        report.status =
          report.projects.length === 0 || okCount === report.projects.length
            ? "done"
            : okCount === 0
              ? "failed"
              : "partial"
      }
    } catch (err: unknown) {
      report.status = "failed"
      report.error = err instanceof Error ? err.message : String(err)
    }

    report.finishedAt = now().toISOString()
    writeReport(report)
    if (report.status === "failed") {
      console.error(
        `[ArchiveCleanup] task ${taskId} cleanup failed:`,
        report.error ?? report.projects.find((p) => p.error)?.error ?? "unknown",
      )
    } else {
      console.log(
        `[ArchiveCleanup] task ${taskId} → ${report.status}, freed ${report.total_freed_bytes} bytes, ` +
          `${report.projects.reduce((n, p) => n + p.leftover_count, 0)} ignored leftovers listed`,
      )
    }
    return report
  }

  /**
   * Agent 兜底：删除人明确点名的 ignored 路径（leftover 或自动清扫失败项）。
   * 与自动清扫共用同一套校验；受保护路径 / 越界 / 含跟踪文件一律拒绝。
   */
  const cleanLeftovers = async (
    taskId: string,
    project: string,
    paths: string[],
  ): Promise<{ report: ArchiveCleanupReport; results: CleanupLeftoversResult[] }> => {
    const { projects, wsPath } = loadRow(taskId)
    if (!projects.includes(project)) {
      throw new Error(`project '${project}' 不属于任务 ${taskId}`)
    }
    if (!wsPath || !fs.existsSync(wsPath)) {
      throw new Error(`任务绑定的 workspace 路径不可用: ${wsPath ?? "未绑定"}`)
    }
    const resolved = resolveProjectDir(wsPath, project)
    if (!resolved.dir) throw new Error(resolved.error ?? `worktree 不可定位: ${project}`)
    const conflict = sourceRepoConflict(wsPath, project, resolved.dir)
    if (conflict) throw new Error(conflict)

    const report =
      readReport(taskId) ?? {
        taskId,
        startedAt: now().toISOString(),
        finishedAt: null,
        status: "done",
        total_freed_bytes: 0,
        projects: [],
      }
    let projectResult = report.projects.find((p) => p.project === project)
    if (!projectResult) {
      projectResult = {
        project,
        dir: resolved.dir,
        ok: true,
        removed_count: 0,
        removed: [],
        freed_bytes: 0,
        skipped: [],
        failed: [],
        leftovers: [],
        leftover_count: 0,
      }
      report.projects.push(projectResult)
    }

    const results: CleanupLeftoversResult[] = []
    for (const raw of paths) {
      const rel = raw.replace(/\\/g, "/").replace(/\/+$/, "")
      const verified = verifyIgnoredPath(resolved.dir, rel, run)
      if (!verified.ok) {
        results.push({ path: rel, ok: false, reason: verified.reason })
        continue
      }
      let kind: "dir" | "file" = "file"
      try {
        kind = (await fs.promises.lstat(verified.abs)).isDirectory() ? "dir" : "file"
      } catch {
        /* measured below, deletion is idempotent */
      }
      const measured = await measureTree(verified.abs, CANDIDATE_MEASURE_CAP)
      try {
        await removePath(verified.abs)
      } catch (err: unknown) {
        results.push({
          path: rel,
          ok: false,
          reason: `删除失败: ${err instanceof Error ? err.message : String(err)}`,
        })
        continue
      }
      projectResult.removed_count += 1
      projectResult.freed_bytes += measured.bytes
      if (projectResult.removed.length < REMOVED_CAP) {
        projectResult.removed.push({ path: rel, kind, bytes: measured.bytes })
      }
      const idx = projectResult.leftovers.findIndex((item) => item.path === rel)
      if (idx >= 0) {
        projectResult.leftovers.splice(idx, 1)
        projectResult.leftover_count = Math.max(0, projectResult.leftover_count - 1)
      }
      projectResult.failed = projectResult.failed.filter((f) => f.path !== rel)
      results.push({ path: rel, ok: true, bytes: measured.bytes })
    }

    // Agent 补删成功后，project / 总体状态可自愈（failed 清空即恢复 ok）。
    projectResult.ok = projectResult.failed.length === 0 && !projectResult.error
    const okCount = report.projects.filter((p) => p.ok).length
    report.status =
      report.projects.length === 0 || okCount === report.projects.length
        ? "done"
        : okCount === 0
          ? "failed"
          : "partial"
    report.total_freed_bytes = report.projects.reduce((n, p) => n + p.freed_bytes, 0)
    report.finishedAt = now().toISOString()
    writeReport(report)
    return { report, results }
  }

  return { cleanupTask, cleanLeftovers, readReport }
}
