// packages/server/src/services/tasks/archiving-service.ts
//
// task-phase-redesign (ticket 08) — archiving 编排 (K11 / 票 08 归并面):
// the LAST phase accepted → persisted 'archiving' (票 07 beginArchiving) →
// THIS orchestrator merges the task-home draft-exclusive artifacts back into
// each selected project's worktree, one archive commit per project, push, and
// into that branch's open PR (or an archive PR) — and ONLY THEN is the task
// 'done' (K3: done 的判定含 git 成功; US15: git 失败停 archiving 可重试, 不假 done).
//
// 归并面 (decisions/08 §1 — 只剩 task home 草稿期独有件, .scratch 已随 seed/
// phase PR 进仓库):
//   - {home}/docs/adr/**.md      → 目标 docs/adr/ 扫最大编号顺延重写
//                                  (文件名 NNNN-slug.md, 尾行 `> Synced from
//                                  task <id> (<date>)` 溯源)
//   - {home}/context-notes.md    → per-project 分节术语 append 进目标
//                                  CONTEXT.md 术语表 (append-only; 同名不同义
//                                  不写, 记入冲突报告 — K11 人工冲突不阻塞
//                                  状态机, PR review 是它的裁决 gate)
//
// project 归属 (SKILL v3 现状: ADR 平铺, 术语按 `## <project>` 分节 — 票内
// Exploration 记录的适配裁决): ADR ① docs/adr/<project>/ 子目录; ② 头部
// `Project: <name>` 标记; ③ 单 project 任务全归它; ④ 否则 unattributed 进报告.
//
// 幂等 (AC4): {home}/archive/state.json 记 project 粒度完成 + 稳定 date;
// 双保险 = 目标文件含本 task marker 即跳过顺延、术语同名即跳过、commit 前
// diff --cached 判空、push 天然幂等。retry 跳过已完成 project (A 不重复 commit).
//
// git 面: 全部经可注入的 run(cmd,args,cwd) (生产 = spawnSync, 测试 = 真 git +
// 本地 bare origin fixture)。PR 面: 仓库无既有 gh/PR 代码 (票 08 Exploration
// grep 结论) → 默认 handler: 非 github.com remote → skipped (本地/自托管场景
// push 即归档落地); github.com → gh pr list --head 命中即并入开放 PR (push
// 天然带入), 否则 gh pr create (body = 该 project 归档报告, 冲突清单在其中).

import fs from "fs"
import path from "path"
import { spawnSync } from "child_process"
import type Database from "better-sqlite3"
import { TaskDAO } from "../../db/dao"
import type { TaskHomeService } from "./task-home-service"

// ── Pure helpers (unit-tested, no fs) ────────────────────────────────

/** `0003-use-git.md` → { num: 3, slug: 'use-git' }; anything else → null. */
export function parseAdrFileName(name: string): { num: number; slug: string } | null {
  const m = /^(\d+)-(.+)\.md$/i.exec(path.basename(name))
  if (!m) return null
  return { num: parseInt(m[1], 10), slug: m[2] }
}

/** Canonical 4-digit ADR file name (ticket: `NNNN-slug.md`). */
export function formatAdrFileName(num: number, slug: string): string {
  return `${String(num).padStart(4, "0")}-${slug}.md`
}

/** Provenance tail line appended to every merged ADR (K11 溯源). */
export function adrMarker(taskId: string, date: string): string {
  return `> Synced from task ${taskId} (${date})`
}

export interface AdrDoc {
  /** file NAME (basename) within docs/adr — its number/slug are advisory. */
  file: string
  content: string
}

export interface AdrWrite {
  /** target file name (renumbered). */
  file: string
  content: string
  sourceFile: string
}

export interface AdrMergePlan {
  writes: AdrWrite[]
  /** incoming files skipped as already merged (target carries our marker). */
  skipped: string[]
}

/**
 * Plan the ADR renumber/rewrite. `existing` = target docs/adr files (retry
 * re-scans a tree that may already hold this task's synced files). Rules:
 *  - incoming whose slug matches an existing file carrying THIS task's marker
 *    → skipped (idempotent retry — AC4 "A 不重复 commit" belt);
 *  - next number = max number across ALL existing files + 1 (synced ones keep
 *    their taken slots), incoming sorted by own number (stable);
 *  - unparseable incoming names → next numbers, basename (minus .md) as slug;
 *  - merged content = source content (trailing ws trimmed) + one blank line +
 *    the marker line.
 */
export function planAdrMerge(incoming: AdrDoc[], existing: AdrDoc[], taskId: string, date: string): AdrMergePlan {
  const marker = adrMarker(taskId, date)
  const syncedSlugs = new Set<string>()
  let max = 0
  for (const e of existing) {
    const parsed = parseAdrFileName(e.file)
    if (parsed && parsed.num > max) max = parsed.num
    if (e.content.includes(marker) && parsed) syncedSlugs.add(parsed.slug)
  }
  const writes: AdrWrite[] = []
  const skipped: string[] = []
  const withNum = incoming.map((d, i) => ({ d, i, num: parseAdrFileName(d.file)?.num ?? null }))
  withNum.sort((a, b) => {
    if (a.num !== null && b.num !== null) return a.num - b.num || a.i - b.i
    if (a.num !== null) return -1
    if (b.num !== null) return 1
    return a.i - b.i
  })
  let next = max + 1
  for (const { d } of withNum) {
    const parsed = parseAdrFileName(d.file)
    if (parsed && syncedSlugs.has(parsed.slug)) {
      skipped.push(d.file)
      continue
    }
    const slug = parsed ? parsed.slug : d.file.replace(/\.md$/i, "").trim()
    writes.push({
      file: formatAdrFileName(next, slug),
      content: `${d.content.replace(/\s+$/, "")}\n\n${marker}\n`,
      sourceFile: d.file,
    })
    next += 1
  }
  return { writes, skipped }
}

export interface NoteSection {
  /** '## ' heading text ('' = preamble before the first heading). */
  heading: string
  body: string
}

/** Split context-notes.md into `## ` sections (per-project 分节 per SKILL v3). */
export function parseContextNotesSections(content: string): NoteSection[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n")
  const sections: NoteSection[] = []
  let heading = ""
  let buf: string[] = []
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line)
    if (m) {
      if (buf.some((l) => l.trim())) sections.push({ heading, body: buf.join("\n") })
      heading = m[1]
      buf = []
    } else {
      buf.push(line)
    }
  }
  if (buf.some((l) => l.trim())) sections.push({ heading, body: buf.join("\n") })
  return sections
}

/** Attribute note sections to projects (heading contains the project name,
 *  case-insensitive; longest-name wins). The preamble (heading '') counts as a
 *  whole-file attribution ONLY when the task has exactly one project —
 *  otherwise it is unattributed. Returns per-project note text + leftovers. */
export function attributeNoteSections(
  sections: NoteSection[],
  projectNames: string[],
): { perProject: Record<string, string[]>; unattributed: string[] } {
  const perProject: Record<string, string[]> = {}
  const unattributed: string[] = []
  for (const s of sections) {
    if (!s.body.trim()) continue
    if (s.heading === "") {
      if (projectNames.length === 1) {
        ;(perProject[projectNames[0]] ??= []).push(s.body)
      } else {
        unattributed.push(s.body)
      }
      continue
    }
    const lower = s.heading.toLowerCase()
    const match = projectNames
      .filter((p) => lower.includes(p.toLowerCase()))
      .sort((a, b) => b.length - a.length)[0]
    if (match) (perProject[match] ??= []).push(s.body)
    else unattributed.push(s.body)
  }
  return { perProject, unattributed }
}

export interface TermEntry {
  term: string
  definition: string
}

/** Extract terms from a notes section: markdown table rows (header/separator
 *  rows skipped) and bullets `- **Term** — def` / `- Term: def` (半角/全角冒号,
 *  em/en dash). */
export function parseTermEntries(md: string): TermEntry[] {
  const out: TermEntry[] = []
  const seen = new Set<string>()
  const push = (term: string, definition: string): void => {
    const t = stripBold(term).trim()
    const d = definition.trim()
    if (!t || !d) return
    const key = normKey(t)
    if (seen.has(key)) return
    seen.add(key)
    out.push({ term: t, definition: d })
  }
  for (const raw of md.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim()
    if (line.startsWith("|")) {
      const cells = line.split("|").slice(1, -1).map((c) => c.trim())
      if (cells.length < 2) continue
      if (/^:?-{2,}:?$/.test(cells[0])) continue
      const term = stripBold(cells[0])
      if (/^(term|术语|术語|glossary)$/i.test(term)) continue
      push(term, cells[1])
      continue
    }
    const bullet = /^[-*]\s+(.+)$/.exec(line)
    if (!bullet) continue
    let core = bullet[1].trim()
    let term: string | null = null
    let def = ""
    let m = /^\*\*(.+?)\*\*\s*(?:[—–]|:|：)\s*(.+)$/.exec(core)
    if (m) {
      term = m[1]
      def = m[2]
    } else {
      m = /^(.+?)\s*[—–]\s*(.+)$/.exec(core) || /^(.+?)[:：]\s*(.+)$/.exec(core)
      if (m) {
        term = stripBold(m[1])
        def = m[2]
      }
    }
    if (term) push(term, def)
  }
  return out
}

function stripBold(s: string): string {
  return s.replace(/^\*\*(.*)\*\*$/, "$1")
}

/** Compare key: whitespace collapsed + lowercased (definitions may differ only
 *  in spacing/width without being a real conflict). */
function normDef(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}
function normKey(s: string): string {
  return normDef(s).toLowerCase()
}

export interface TermConflict {
  term: string
  incoming: string
  existing: string
}

export interface GlossaryAppendPlan {
  /** Full new file content (targetMd + appended rows), or the untouched
   *  targetMd when nothing is appended. */
  output: string
  appended: TermEntry[]
  unchanged: TermEntry[]
  conflicts: TermConflict[]
}

const GLOSSARY_HEADING_RE = /^#{1,4}\s+.*(glossary|术语表|術語表)/i

/**
 * append-only 术语合并 (K11): NEVER touches an existing line. New terms go
 * into the glossary table (created when missing — `targetMd === null`
 * bootstraps a minimal CONTEXT.md). Same term + same def → unchanged; same
 * term + different def → conflict (NOT written, the caller reports it into
 * the archive report / PR body — 人的裁决 gate = 既有 PR review).
 */
export function planGlossaryAppend(targetMd: string | null, entries: TermEntry[]): GlossaryAppendPlan {
  const result: GlossaryAppendPlan = { output: targetMd ?? "", appended: [], unchanged: [], conflicts: [] }
  if (!targetMd) {
    const rows = entries.map((e) => `| **${e.term}** | ${normDef(e.definition)} |`)
    result.output = [
      "# Context",
      "",
      "## Glossary",
      "",
      "| Term | Definition |",
      "|------|-----------|",
      ...rows,
      "",
    ].join("\n")
    result.appended = [...entries]
    return result
  }
  const lines = targetMd.replace(/\r\n/g, "\n").split("\n")

  // Locate the glossary table (heading match, then the first contiguous |-block).
  let tableStart = -1
  let tableEnd = -1
  let headingLine = -1
  for (let i = 0; i < lines.length; i++) {
    if (!GLOSSARY_HEADING_RE.test(lines[i])) continue
    headingLine = i
    let j = i + 1
    while (j < lines.length && !lines[j].trim().startsWith("|")) j++
    if (j < lines.length) {
      tableStart = j
      let k = j
      while (k < lines.length && lines[k].trim().startsWith("|")) k++
      tableEnd = k - 1
    }
    break
  }

  const existing = new Map<string, string>() // normKey(term) → normDef(def)
  let columns = 2
  if (tableStart >= 0) {
    for (let i = tableStart; i <= tableEnd; i++) {
      const cells = lines[i].trim().split("|").slice(1, -1).map((c) => c.trim())
      if (cells.length < 2) continue
      columns = Math.max(columns, cells.length)
      if (/^:?-{2,}:?$/.test(cells[0])) continue
      const term = stripBold(cells[0])
      if (/^(term|术语|术語|glossary)$/i.test(term)) continue
      existing.set(normKey(term), normDef(cells[1]))
    }
  }

  const newRows: string[] = []
  for (const e of entries) {
    const key = normKey(e.term)
    const prev = existing.get(key)
    const def = normDef(e.definition)
    if (prev !== undefined) {
      if (prev === def) result.unchanged.push(e)
      else result.conflicts.push({ term: e.term, incoming: e.definition.trim(), existing: prev })
      continue
    }
    existing.set(key, def)
    const cells = [`**${e.term}**`, def, ...Array(Math.max(0, columns - 2)).fill("")]
    newRows.push(`| ${cells.join(" | ")} |`)
    result.appended.push(e)
  }
  if (newRows.length === 0) {
    result.output = targetMd
    return result
  }
  if (tableStart >= 0) {
    const out = [...lines]
    out.splice(tableEnd + 1, 0, ...newRows)
    result.output = out.join("\n")
    return result
  }
  // No table — glossary section after the heading, or a fresh section at EOF.
  const block = ["## Glossary", "", "| Term | Definition |", "|------|-----------|", ...newRows, ""]
  if (headingLine >= 0) {
    const out = [...lines]
    out.splice(headingLine + 1, 0, "", ...block.slice(2))
    result.output = out.join("\n")
    return result
  }
  const sep = targetMd.endsWith("\n") ? "" : "\n"
  result.output = `${targetMd}${sep}\n${block.join("\n")}`
  return result
}

// ── Orchestration ────────────────────────────────────────────────────

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}
/** Injectable command runner (production = spawnSync; tests = real git). */
export type CommandRunner = (cmd: string, args: string[], cwd: string) => CommandResult

export interface PrContext {
  project: string
  worktreePath: string
  branch: string
  title: string
  body: string
}
export interface PrResult {
  action: "skipped" | "merged-into-open" | "created" | "none"
  url?: string
  note?: string
}
export type PrHandler = (ctx: PrContext, run: CommandRunner) => PrResult | Promise<PrResult>

export interface ProjectArchiveResult {
  project: string
  ok: boolean
  /** Skipped because the project-granular state file already recorded it done. */
  skippedByState?: boolean
  adrMerged: number
  adrSkipped: string[]
  termsAppended: number
  termConflicts: TermConflict[]
  commit: string | null
  pushed: boolean
  pr: PrResult | null
  error?: string
}

export interface ArchiveReport {
  taskId: string
  date: string
  ok: boolean
  projects: ProjectArchiveResult[]
  /** home ADRs with no attributable project (进报告, 不阻塞 done). */
  unattributedAdrs: string[]
  /** note sections whose heading matched no project. */
  unattributedNotes: number
  error?: string
}

export interface ArchivingDeps {
  db: Database.Database
  taskHomeService: TaskHomeService
  /** tasks-service.endArchiving — the ONLY writer of 'done' (K3). */
  onComplete: (taskId: string) => void
  now?: () => Date
  pr?: PrHandler
  run?: CommandRunner
}

const defaultRun: CommandRunner = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, {
    cwd,
    timeout: 120000,
    encoding: "utf-8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  })
  return {
    code: r.status ?? -1,
    stdout: (r.stdout ?? "").toString(),
    stderr: (r.stderr ?? "").toString() + (r.error ? ` ${r.error.message}` : ""),
  }
}

/** Default PR handler (no existing gh/PR code in the repo — 票 08 grep).
 *  Local/self-hosted remotes (bare-repo fixtures, Gitea, …) → 'skipped': the
 *  pushed branch IS the archive landing, review happens outside GitHub. */
const defaultPrHandler: PrHandler = (ctx, run) => {
  const remote = run("git", ["remote", "get-url", "origin"], ctx.worktreePath)
  if (remote.code !== 0 || !remote.stdout.trim()) {
    return { action: "skipped", note: "no origin remote" }
  }
  if (!/github\.com[:/]/i.test(remote.stdout)) {
    return { action: "skipped", note: "non-GitHub remote — branch push is the archive landing" }
  }
  const list = run("gh", ["pr", "list", "--head", ctx.branch, "--state", "open", "--json", "url", "-q", ".[0].url"], ctx.worktreePath)
  const url = list.stdout.trim()
  if (list.code === 0 && url && url !== "null") {
    return { action: "merged-into-open", url }
  }
  const create = run("gh", ["pr", "create", "--head", ctx.branch, "--title", ctx.title, "--body", ctx.body], ctx.worktreePath)
  if (create.code !== 0) {
    throw new Error(`gh pr create failed for '${ctx.branch}': ${create.stderr.trim() || create.stdout.trim()}`)
  }
  const created = create.stdout.trim().split("\n").pop() ?? ""
  return { action: "created", url: created || undefined }
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "")
}

interface ProjectState {
  status: "done"
  commit: string | null
  completedAt: string
}
interface ArchiveState {
  date: string
  startedAt: string
  projects: Record<string, ProjectState>
}

export interface TaskArchiver {
  archiveTask(taskId: string): Promise<ArchiveReport>
}

function parseJSONSafe<T>(raw: string | null | undefined, fallback: T): T {
  if (raw == null) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** Recursively list docs/adr markdown (excl. index/README). Returns home-adr
 *  relative paths (forward slashes) — a first path segment matching a project
 *  name is the per-project grouping (SKILL 平铺现状的向前兼容). */
function walkAdrFiles(adrRoot: string): Array<{ rel: string; content: string }> {
  const out: Array<{ rel: string; content: string }> = []
  if (!fs.existsSync(adrRoot)) return out
  const walk = (dir: string, prefix: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name
      const abs = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        walk(abs, rel)
        continue
      }
      if (!/\.md$/i.test(ent.name) || /^(index|readme)\.md$/i.test(ent.name)) continue
      out.push({ rel, content: fs.readFileSync(abs, "utf-8") })
    }
  }
  walk(adrRoot, "")
  return out
}

/** Attribute one flat ADR: header marker `Project: <name>` within the first
 *  15 lines, else the single-project default, else unattributed. */
function attributeAdr(content: string, projectNames: string[]): string | null {
  const head = content.split("\n", 15).join("\n")
  const m = /^\s*>?\s*Project:\s*(\S+)\s*$/im.exec(head)
  if (m) {
    const hit = projectNames.find((p) => p.toLowerCase() === m[1].toLowerCase())
    if (hit) return hit
  }
  if (projectNames.length === 1) return projectNames[0]
  return null
}

interface WorktreeRef {
  dir: string
  branch: string
}

function resolveWorktree(wsPath: string, projectName: string, run: CommandRunner): WorktreeRef {
  const cfg = parseJSONSafe<{ repos?: Array<{ name?: string; worktree_path?: string; branch?: string }> }>(
    fs.existsSync(path.join(wsPath, "config.json")) ? fs.readFileSync(path.join(wsPath, "config.json"), "utf-8") : "",
    {},
  )
  const entry = (cfg.repos ?? []).find((r) => r.name === projectName)
  const dir = entry?.worktree_path || path.join(wsPath, "projects", projectName)
  if (!fs.existsSync(dir)) {
    throw new Error(`worktree not found for project '${projectName}': ${dir}`)
  }
  let branch = entry?.branch ?? ""
  if (!branch) {
    const b = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], dir)
    if (b.code !== 0) throw new Error(`not a git worktree for '${projectName}' at ${dir}: ${b.stderr.trim()}`)
    branch = b.stdout.trim()
  }
  if (!branch || branch === "HEAD") throw new Error(`worktree '${projectName}' is on a detached HEAD — cannot push`)
  return { dir, branch }
}

/**
 * The archiving orchestrator. Fire-and-forget safe: per-project failures are
 * collected into the report (never thrown), so the caller stays parked in
 * 'archiving' (US15) and POST /:id/archive/retry continues project-granularly.
 * Throws only for preconditions that make a run meaningless (task gone / non-v4
 * / ws unresolvable ⇒ ALL projects fail ⇒ task parks in archiving).
 */
export function createTaskArchiver(deps: ArchivingDeps): TaskArchiver {
  const run = deps.run ?? defaultRun
  const pr = deps.pr ?? defaultPrHandler
  const now = deps.now ?? (() => new Date())
  const taskDAO = new TaskDAO(deps.db)

  const archiveTask = async (taskId: string): Promise<ArchiveReport> => {
    const row = taskDAO.getById(taskId)
    if (!row) throw new Error(`archiveTask: task ${taskId} not found`)
    const spec = parseJSONSafe<{ format?: string }>(row.task_spec, {})
    if (spec.format !== "v4") throw new Error(`archiveTask: task ${taskId} is not v4 (format='${spec.format ?? ""}')`)
    const projectNames = parseJSONSafe<string[]>(row.project_ids, [])
    const home = deps.taskHomeService.homePath(taskId)

    // ── state (project 粒度幂等续跑) ────────────────────────────────
    const stateDir = path.join(home, "archive")
    const stateFile = path.join(stateDir, "state.json")
    let state: ArchiveState
    if (fs.existsSync(stateFile)) {
      state = parseJSONSafe<ArchiveState>(fs.readFileSync(stateFile, "utf-8"), { date: ymd(now()), startedAt: new Date().toISOString(), projects: {} })
    } else {
      state = { date: ymd(now()), startedAt: new Date().toISOString(), projects: {} }
    }
    const saveState = (): void => {
      fs.mkdirSync(stateDir, { recursive: true })
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf-8")
    }

    // ── 归并面采集 (home) ───────────────────────────────────────────
    const adrRoot = path.join(home, "docs", "adr")
    const adrFiles = walkAdrFiles(adrRoot)
    const adrByProject: Record<string, AdrDoc[]> = {}
    const unattributedAdrs: string[] = []
    for (const f of adrFiles) {
      const seg = f.rel.includes("/") ? f.rel.split("/")[0] : null
      const project =
        (seg && projectNames.find((p) => p.toLowerCase() === seg.toLowerCase())) ||
        attributeAdr(f.content, projectNames)
      if (!project) {
        unattributedAdrs.push(f.rel)
        continue
      }
      const base = path.basename(f.rel)
      ;(adrByProject[project] ??= []).push({
        file: base,
        content: `${f.content}\n\nProject: ${project}\n`, // marker 行随文件进目标仓库, 归属自描述
      })
    }
    const notesFile = path.join(home, "context-notes.md")
    let notesByProject: Record<string, string[]> = {}
    let unattributedNotes = 0
    if (fs.existsSync(notesFile)) {
      const sections = parseContextNotesSections(fs.readFileSync(notesFile, "utf-8"))
      const attr = attributeNoteSections(sections, projectNames)
      notesByProject = attr.perProject
      unattributedNotes = attr.unattributed.length
    }

    const emptyReport = (error: string): ArchiveReport => ({
      taskId, date: state.date, ok: false, projects: projectNames.map((p) => ({
        project: p, ok: false, adrMerged: 0, adrSkipped: [], termsAppended: 0, termConflicts: [], commit: null, pushed: false, pr: null, error,
      })), unattributedAdrs, unattributedNotes, error,
    })

    const workspaceId = row.workspace_id
    if (!workspaceId) return emptyReport("任务未绑定 workspace — 归档目标 worktree 不可定位")
    const ws = deps.db.prepare("SELECT path FROM workspaces WHERE id = ?").get(workspaceId) as { path: string } | undefined
    if (!ws || !fs.existsSync(ws.path)) return emptyReport(`任务绑定的 workspace 路径不可用: ${ws?.path ?? workspaceId}`)
    const wsPath = ws.path

    // ── per-project merge (sequential; 每步成功后 state 落盘) ───────
    const results: ProjectArchiveResult[] = []
    for (const projectName of projectNames) {
      if (state.projects[projectName]?.status === "done") {
        results.push({
          project: projectName, ok: true, skippedByState: true,
          commit: state.projects[projectName].commit ?? null,
          adrMerged: 0, adrSkipped: [], termsAppended: 0, termConflicts: [], pushed: true, pr: null,
        })
        continue
      }
      const r: ProjectArchiveResult = {
        project: projectName, ok: false, adrMerged: 0, adrSkipped: [], termsAppended: 0, termConflicts: [], commit: null, pushed: false, pr: null,
      }
      results.push(r)
      try {
        const wt = resolveWorktree(wsPath, projectName, run)
        const writtenRel: string[] = []

        // ADR 顺延
        const incoming = adrByProject[projectName] ?? []
        const targetAdrDir = path.join(wt.dir, "docs", "adr")
        const existing: AdrDoc[] = fs.existsSync(targetAdrDir)
          ? fs.readdirSync(targetAdrDir)
              .filter((n) => /\.md$/i.test(n) && !/^(index|readme)\.md$/i.test(n))
              .map((n) => ({ file: n, content: fs.readFileSync(path.join(targetAdrDir, n), "utf-8") }))
          : []
        const plan = planAdrMerge(incoming, existing, taskId, state.date)
        r.adrSkipped = plan.skipped
        for (const w of plan.writes) {
          const targetAbs = path.join(targetAdrDir, w.file)
          if (fs.existsSync(targetAbs) && fs.readFileSync(targetAbs, "utf-8") === w.content) continue
          fs.mkdirSync(targetAdrDir, { recursive: true })
          fs.writeFileSync(targetAbs, w.content, "utf-8")
          writtenRel.push(path.posix.join("docs/adr", w.file))
          r.adrMerged += 1
        }

        // 术语 append (CONTEXT.md 术语表, append-only)
        const noteBodies = notesByProject[projectName] ?? []
        const terms = noteBodies.flatMap((b) => parseTermEntries(b))
        if (terms.length > 0) {
          const ctxAbs = path.join(wt.dir, "CONTEXT.md")
          const targetMd = fs.existsSync(ctxAbs) ? fs.readFileSync(ctxAbs, "utf-8") : null
          const gloss = planGlossaryAppend(targetMd, terms)
          r.termConflicts = gloss.conflicts
          r.termsAppended = gloss.appended.length
          if (gloss.appended.length > 0) {
            fs.writeFileSync(ctxAbs, gloss.output, "utf-8")
            writtenRel.push("CONTEXT.md")
          }
        }

        // 归档 commit
        const commitMsg = `chore(archive): ${row.name} syncback ${state.date}`
        if (writtenRel.length > 0) {
          const add = run("git", ["add", "--", ...writtenRel], wt.dir)
          if (add.code !== 0) throw new Error(`git add failed: ${add.stderr.trim()}`)
          const diff = run("git", ["diff", "--cached", "--quiet"], wt.dir)
          if (diff.code !== 0) {
            const commit = run("git", ["commit", "-m", commitMsg], wt.dir)
            if (commit.code !== 0) throw new Error(`git commit failed: ${commit.stderr.trim() || commit.stdout.trim()}`)
            const head = run("git", ["rev-parse", "HEAD"], wt.dir)
            r.commit = head.code === 0 ? head.stdout.trim() : null
          }
        }

        // push (git 失败 → 本 project 失败停 archiving — US15)
        const push = run("git", ["push", "-u", "origin", wt.branch], wt.dir)
        if (push.code !== 0) {
          throw new Error(`git push origin ${wt.branch} failed: ${push.stderr.trim() || push.stdout.trim()}`)
        }
        r.pushed = true

        // 并入开放 PR 或开归档 PR (冲突清单进 PR 描述 — AC11/K11)
        if (r.commit) {
          const body = buildProjectReportMd(row.name, taskId, state.date, r, incoming)
          r.pr = await pr({ project: projectName, worktreePath: wt.dir, branch: wt.branch, title: commitMsg, body }, run)
        } else {
          r.pr = { action: "none", note: "no archive commit (nothing new to merge)" }
        }

        r.ok = true
        state.projects[projectName] = { status: "done", commit: r.commit, completedAt: new Date().toISOString() }
        saveState()
      } catch (err: unknown) {
        r.ok = false
        r.error = err instanceof Error ? err.message : String(err)
        console.error(`[Archiving] project '${projectName}' failed for task ${taskId} (task stays 'archiving', retry continues here):`, r.error)
      }
    }

    const ok = results.every((r) => r.ok)
    const report: ArchiveReport = { taskId, date: state.date, ok, projects: results, unattributedAdrs, unattributedNotes }
    try {
      fs.mkdirSync(stateDir, { recursive: true })
      fs.writeFileSync(
        path.join(stateDir, "report.md"),
        buildOverallReportMd(row.name, report, adrByProject, unattributedAdrs),
        "utf-8",
      )
    } catch (err: unknown) {
      console.error(`[Archiving] writing archive report failed (non-fatal):`, err instanceof Error ? err.message : String(err))
    }
    if (ok) deps.onComplete(taskId)
    return report
  }

  return { archiveTask }
}

function buildProjectReportMd(
  taskName: string,
  taskId: string,
  date: string,
  r: ProjectArchiveResult,
  incoming: AdrDoc[],
): string {
  const lines = [
    `## ${r.project} — 归档同步 (${taskName})`,
    "",
    `- task: ${taskId}`,
    `- syncback: ${date}`,
    `- ADR 合并: ${r.adrMerged} 新 / ${r.adrSkipped.length} 已在库`,
    `- 术语 append: ${r.termsAppended} 新`,
    "",
  ]
  if (r.termConflicts.length > 0) {
    lines.push("### ⚠ 术语冲突（同名不同义 — 未自动合并，请在此 PR review 裁决）", "", "| 术语 | 任务侧定义 | 仓库现有定义 |", "|------|-----------|-------------|")
    for (const c of r.termConflicts) lines.push(`| ${c.term} | ${c.incoming} | ${c.existing} |`)
    lines.push("")
  }
  if (incoming.length > 0) {
    lines.push("### 归并的 ADR", "")
    for (const a of incoming) lines.push(`- ${a.file}`)
    lines.push("")
  }
  return lines.join("\n")
}

function buildOverallReportMd(
  taskName: string,
  report: ArchiveReport,
  adrByProject: Record<string, AdrDoc[]>,
  unattributedAdrs: string[],
): string {
  const lines = [
    `# 归档报告 — ${taskName}`,
    "",
    `- task: ${report.taskId}`,
    `- date: ${report.date}`,
    `- 结果: ${report.ok ? "全部 project 归档成功 → done" : "存在失败 project — 任务停在 archiving，POST /:id/archive/retry 幂等续跑"}`,
    "",
    "## 项目",
    "",
    "| project | ok | ADR | 术语 | 冲突 | commit | push | PR |",
    "|---|---|---|---|---|---|---|---|",
  ]
  for (const p of report.projects) {
    lines.push(
      `| ${p.project} | ${p.ok ? "✓" : "✗"}${p.skippedByState ? " (state-skipped)" : ""} | ${p.adrMerged} | ${p.termsAppended} | ${p.termConflicts.length} | ${p.commit ? p.commit.slice(0, 8) : "-"} | ${p.pushed ? "✓" : "✗"} | ${p.pr ? p.pr.action : "-"} |`,
    )
    if (p.error) lines.push("", `> ❗ ${p.project}: ${p.error}`, "")
    for (const c of p.termConflicts) {
      lines.push("", `> 术语冲突 **${c.term}** — 任务侧「${c.incoming}」 vs 仓库「${c.existing}」（未写入，待 PR review 裁决）`)
    }
  }
  if (unattributedAdrs.length > 0) {
    lines.push("", "## 未归属 ADR（多 project 任务且无子目录/`Project:` 标记 — 留在 home, 人工认领）", "")
    for (const a of unattributedAdrs) lines.push(`- docs/adr/${a}`)
  }
  if (report.unattributedNotes > 0) {
    lines.push("", `## context-notes 未归属分节: ${report.unattributedNotes} 段（标题不含任何 project 名）`)
  }
  return lines.join("\n") + "\n"
}
