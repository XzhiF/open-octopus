import fs from "fs"
import path from "path"
import { resolveWikiRootCompat } from "./knowledge/wiki/paths"
import { spawnGit } from "./knowledge/wiki/wiki-git"
import { getBuiltInClonesDir, getClonesDir } from "./agent/paths"
import { readCloneChangesSince, type CloneChangeEntry } from "./agent/clone-changes"
import type {
  TodayAcceptanceRow,
  TodayDAO,
  TodayExecutionRow,
  TodaySessionRow,
  TodayTaskRow,
} from "../db/dao/today-dao"
import type { TokenUsageDAO } from "../db/dao/token-usage-dao"
import type { LedgerCost } from "@octopus/shared"

/**
 * 「今日」页数据装配（一次请求 = 当天整体工作状态）。
 *
 * 设计纪律（2026-11-07 定稿）：
 * - 小结只用统计，不用 LLM；
 * - 时间线与变动都是**精选**，不做全量流水；
 * - 分身只记「资产变更」（版本/技能/记忆/文件），不为派出/合并/回收造事件。
 *
 * 时间线入选规则：任务状态跃迁 · 分身资产变更 · 知识入库 · 你做出的决定；
 * 普通消息不占位。每个类目有配额（见 TIMELINE_QUOTA），超额按优先级截断。
 */

export type TodayChangeCat = "task" | "agent" | "clone" | "know"
export type TodayTimelineKind = "chat" | "task" | "agent" | "clone" | "know" | "now"

export interface TodayChange {
  ts: string
  cat: TodayChangeCat
  title: string
  meta?: string
}

export interface TodayTimelineNode {
  ts: string
  kind: TodayTimelineKind
  title: string
  detail?: string
  meta?: string
  tone?: "ok" | "warn" | "bad" | "info"
}

export interface TodayDigest {
  generated_at: string
  date: string
  weekday: string
  window: { since: string }
  consumption: {
    tokens: number
    input_tokens: number
    output_tokens: number
    cache_read_tokens: number
    cache_creation_tokens: number
    calls: number
    cost: LedgerCost
    cache_hit_rate: number | null
    cache_saved: LedgerCost
    split: Array<{ bucket: "chat" | "task" | "system"; tokens: number; share: number }>
  }
  stats: {
    tasks: {
      changed: number
      breakdown: Array<{ key: string; label: string; count: number }>
    }
    chats: { sessions: number; converted: number; running: number }
    clones: {
      total: number
      changed: number
      version: number
      skill: number
      memory: number
      file: number
    }
    knowledge: { added: number; updated: number; compiles: number; available: boolean }
  }
  timeline: { nodes: TodayTimelineNode[]; candidates: number; rule: string }
  changes: { items: TodayChange[]; total: number }
  now: { count: number; pending: string[] }
}

export interface TodayDigestDeps {
  todayDAO: TodayDAO
  tokenUsageDAO: TokenUsageDAO
  /** 内存流中的对话数（header 的运行指示走同一来源）；缺省 0。 */
  runningSessionCount?: () => number
  /** 测试注入：当前时间与分身目录根 / wiki 根。 */
  now?: () => Date
  cloneRoots?: { user: string; builtIn: string }
  wikiRoot?: string | null
}

/** 时间线类目配额：精选，不是流水。 */
const TIMELINE_QUOTA: Record<Exclude<TodayTimelineKind, "now">, number> = {
  chat: 1,
  task: 4,
  agent: 1,
  clone: 2,
  know: 2,
}
const TIMELINE_MAX = 9
const CHANGES_MAX = 12

const TIMELINE_RULE =
  "入选：任务状态跃迁 · 分身资产变更（版本/技能/记忆/文件）· 知识入库 · 你做出的决定；普通消息不占位"

const TASK_STATUS_LABEL: Record<string, string> = {
  done: "完成",
  awaiting_review: "待验收",
  failed: "失败",
  running: "执行中",
  ready: "待执行",
  draft: "草稿",
  archiving: "归档中",
  aborted: "已中止",
}
const TASK_STATUS_ORDER = [
  "done",
  "awaiting_review",
  "failed",
  "running",
  "ready",
  "draft",
  "archiving",
  "aborted",
]

interface Candidate extends TodayTimelineNode {
  priority: number
  cat?: TodayChangeCat
}

export function buildTodayDigest(deps: TodayDigestDeps): TodayDigest {
  const now = deps.now ? deps.now() : new Date()
  const startOfDay = new Date(now)
  startOfDay.setHours(0, 0, 0, 0)
  const sinceMs = startOfDay.getTime()
  const sinceIso = startOfDay.toISOString()
  const nowIso = now.toISOString()

  const ledger = deps.tokenUsageDAO.todayLedger(sinceMs)
  const tasks = safe(() => deps.todayDAO.listTasksTouched(sinceIso), [] as TodayTaskRow[])
  const acceptances = safe(() => deps.todayDAO.listAcceptancesSince(sinceIso), [] as TodayAcceptanceRow[])
  const executions = safe(() => deps.todayDAO.listExecutionsStartedSince(sinceIso), [] as TodayExecutionRow[])
  const sessions = safe(() => deps.todayDAO.listSessionsTouched(sinceIso), [] as TodaySessionRow[])
  const versions = safe(() => deps.todayDAO.listVersionsSince(sinceIso), [])
  const skillEvolution = safe(() => deps.todayDAO.listSkillChangesSince(sinceIso), [])
  const modelCalls = safe(() => deps.todayDAO.listRecentModelCalls(sinceMs), [])

  const cloneDirs = listCloneDirs(deps.cloneRoots)
  const cloneChanges: Array<{ clone: string; entry: CloneChangeEntry }> = []
  for (const clone of cloneDirs) {
    for (const entry of safe(() => readCloneChangesSince(clone.dir, sinceMs), [] as CloneChangeEntry[])) {
      cloneChanges.push({ clone: clone.name, entry })
    }
  }

  const wiki = readWikiToday(deps.wikiRoot, sinceIso)

  // ── 统计 ───────────────────────────────────────────────────────
  const statusCounts = new Map<string, number>()
  for (const task of tasks) statusCounts.set(task.status, (statusCounts.get(task.status) ?? 0) + 1)
  const taskBreakdown = TASK_STATUS_ORDER
    .map((key) => ({ key, label: TASK_STATUS_LABEL[key] ?? key, count: statusCounts.get(key) ?? 0 }))
    .filter((row) => row.count > 0)

  const converted = safe(
    () => deps.todayDAO.countTasksFromSessions(sessions.map((s) => s.id)),
    0,
  )
  const running = safe(() => deps.runningSessionCount?.() ?? 0, 0)

  const memoryChanges = cloneChanges.filter((c) => c.entry.kind === "memory")
  const fileChanges = cloneChanges.filter((c) => c.entry.kind === "file")
  const skillChanges = cloneChanges.filter((c) => c.entry.kind === "skill")
  const changedClones = new Set<string>([
    ...cloneChanges.map((c) => c.clone),
    ...versions.map((v) => v.agent_name),
  ])

  // ── 变动候选 ───────────────────────────────────────────────────
  const candidates: Candidate[] = []
  const push = (c: Candidate) => candidates.push(c)

  // 任务：立项 / 起跑 / 完成失败 / 待验收 / 验收决策
  const taskById = new Map(tasks.map((t) => [t.id, t]))
  for (const task of tasks) {
    if (task.created_at >= sinceIso) {
      push({
        ts: task.created_at,
        kind: "task",
        cat: "task",
        title: `「${task.name}」立项`,
        meta: "草稿",
        priority: 30,
      })
    }
  }
  for (const exec of executions) {
    if (!exec.task_id) continue
    const task = taskById.get(exec.task_id)
    if (!task) continue
    const ts = exec.started_at
    if (!ts) continue
    push({
      ts,
      kind: "task",
      cat: "task",
      title: `「${task.name}」${roundLabel(exec.phase_index, exec.round_index)} 起跑`,
      meta: exec.workflow_name,
      priority: 35,
    })
  }
  for (const task of tasks) {
    if (!task.completed_at || task.completed_at < sinceIso) continue
    const failed = task.status === "failed" || task.status === "aborted"
    push({
      ts: task.completed_at,
      kind: "task",
      cat: "task",
      title: failed ? `「${task.name}」失败` : `「${task.name}」完成`,
      tone: failed ? "bad" : "ok",
      priority: failed ? 90 : 80,
    })
  }
  for (const task of tasks) {
    if (task.status !== "awaiting_review") continue
    if (task.completed_at && task.completed_at >= sinceIso) continue
    push({
      ts: task.updated_at,
      kind: "task",
      cat: "task",
      title: `「${task.name}」待验收`,
      meta: "等你过验收",
      tone: "warn",
      priority: 70,
    })
  }
  for (const acc of acceptances) {
    const name = acc.task_name ?? acc.task_id
    const passed = acc.decision === "accepted"
    push({
      ts: acc.decided_at,
      kind: "task",
      cat: "task",
      title: `「${name}」${roundLabel(acc.phase_index, acc.round_index)} 验收${passed ? "通过" : "打回"}`,
      detail: acc.feedback?.trim() || undefined,
      tone: passed ? "ok" : "bad",
      priority: 100,
    })
  }

  // 对话：当天最早一段开工
  const firstSession = sessions
    .filter((s) => s.created_at >= sinceIso)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))[0]
  if (firstSession) {
    push({
      ts: firstSession.created_at,
      kind: "chat",
      title: `「${firstSession.title}」开工`,
      detail: firstSession.clone_name ? `分身 ${firstSession.clone_name}` : "主对话",
      priority: 25,
    })
  }

  // Agent：模型切换（从账本序列推断，非事件表）
  const modelSwitch = detectModelSwitch(modelCalls, sessions)
  if (modelSwitch) {
    push({
      ts: modelSwitch.ts,
      kind: "agent",
      cat: "agent",
      title: "会话模型切换",
      detail: `${modelSwitch.from} → ${modelSwitch.to}`,
      meta: modelSwitch.title ? `「${modelSwitch.title}」` : undefined,
      priority: 24,
    })
  }

  // Agent：技能演化台账（时间线配额让给模型切换；这里主要进右侧变动流）
  for (const evo of skillEvolution) {
    push({
      ts: evo.timestamp,
      kind: "agent",
      cat: "agent",
      title: `技能演化 · ${evo.skill_name}`,
      detail: evo.summary,
      meta: evo.change_type,
      priority: 20,
    })
  }

  // 分身资产
  for (const v of versions) {
    push({
      ts: v.published_at,
      kind: "clone",
      cat: "clone",
      title: `${v.agent_name} 版本发布`,
      detail: v.changelog?.trim() || undefined,
      meta: `v${v.version}`,
      tone: "ok",
      priority: 60,
    })
  }
  for (const { clone, entry } of skillChanges) {
    push({
      ts: entry.ts,
      kind: "clone",
      cat: "clone",
      title: `${clone} 技能变更`,
      detail: entry.summary,
      priority: 55,
    })
  }
  for (const { clone, entry } of memoryChanges) {
    push({
      ts: entry.ts,
      kind: "clone",
      cat: "clone",
      title: `${clone} 记忆更新`,
      detail: entry.summary || deltaText(entry.delta_chars, "字"),
      meta: entry.path,
      priority: 45,
    })
  }
  for (const { clone, entry } of fileChanges) {
    push({
      ts: entry.ts,
      kind: "clone",
      cat: "clone",
      title: `${clone} 文件修改`,
      detail: deltaText(entry.delta_lines, "行") || deltaText(entry.delta_chars, "字"),
      meta: entry.path,
      priority: 40,
    })
  }

  // 知识入库
  for (const commit of wiki.commits) {
    push({
      ts: commit.ts,
      kind: "know",
      cat: "know",
      title: `知识编译 ${commit.subject || commit.hash.slice(0, 7)}`,
      detail: `+${commit.added} 新页 · ~${commit.modified} 更新`,
      meta: commit.hash.slice(0, 7),
      tone: "ok",
      priority: 50,
    })
  }

  // ── 精选：按类目配额截断，再按时间排序 ───────────────────────────
  const used: Record<string, number> = {}
  const picked = candidates
    .slice()
    .sort((a, b) => b.priority - a.priority || b.ts.localeCompare(a.ts))
    .filter((c) => {
      const kind = c.kind as Exclude<TodayTimelineKind, "now">
      used[kind] = (used[kind] ?? 0) + 1
      return used[kind] <= TIMELINE_QUOTA[kind]
    })
    .slice(0, TIMELINE_MAX)
    .sort((a, b) => a.ts.localeCompare(b.ts))

  // 「现在」：待验收任务 + 当天失败
  const pending: string[] = []
  for (const task of tasks) {
    if (task.status === "awaiting_review") pending.push(`验收「${task.name}」`)
    if (pending.length >= 3) break
  }
  if (pending.length === 0) {
    for (const task of tasks) {
      if (task.status === "failed") pending.push(`处理失败「${task.name}」`)
      if (pending.length >= 3) break
    }
  }

  const timelineNodes: TodayTimelineNode[] = picked.map(({ priority: _p, cat: _c, ...node }) => node)
  // 「现在」永远有：没有待办也要给出一个「到今天此刻」的落点。
  timelineNodes.push({
    ts: nowIso,
    kind: "now",
    title: pending.length > 0 ? `现在：${pending.length} 件事等你` : "现在：没有待办",
    detail: pending.length > 0 ? pending.join(" · ") : undefined,
    tone: "info",
  })

  // ── 变动流（右侧）：同一批候选，去重后按时间倒序 ──────────────────
  const changeItems: TodayChange[] = []
  const seen = new Set<string>()
  for (const c of candidates.slice().sort((a, b) => b.ts.localeCompare(a.ts))) {
    if (!c.cat) continue
    if (c.cat === "agent" && c.title === "会话模型切换" && !c.detail) continue
    const key = `${c.cat}|${c.title}|${c.ts}`
    if (seen.has(key)) continue
    seen.add(key)
    changeItems.push({ ts: c.ts, cat: c.cat, title: c.title, meta: c.meta ?? c.detail })
    if (changeItems.length >= CHANGES_MAX) break
  }

  const weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][now.getDay()]

  return {
    generated_at: nowIso,
    date: localDate(now),
    weekday,
    window: { since: sinceIso },
    consumption: {
      tokens: ledger.tokens,
      input_tokens: ledger.inputTokens,
      output_tokens: ledger.outputTokens,
      cache_read_tokens: ledger.cacheReadTokens,
      cache_creation_tokens: ledger.cacheCreationTokens,
      calls: ledger.calls,
      cost: ledger.cost,
      cache_hit_rate: ledger.cacheHitRate,
      cache_saved: ledger.cacheSaved,
      split: ledger.split,
    },
    stats: {
      tasks: { changed: tasks.length, breakdown: taskBreakdown },
      chats: { sessions: sessions.length, converted, running },
      clones: {
        total: cloneDirs.length,
        changed: changedClones.size,
        version: versions.length,
        skill: skillChanges.length,
        memory: memoryChanges.length,
        file: fileChanges.length,
      },
      knowledge: {
        added: wiki.added,
        updated: wiki.updated,
        compiles: wiki.compiles,
        available: wiki.available,
      },
    },
    timeline: {
      nodes: timelineNodes,
      candidates: candidates.length,
      rule: TIMELINE_RULE,
    },
    changes: { items: changeItems, total: changeItems.length },
    now: { count: pending.length, pending },
  }
}

// ── 内部工具 ─────────────────────────────────────────────────────

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

function localDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

function roundLabel(phase: number | null | undefined, round: number | null | undefined): string {
  const p = typeof phase === "number" ? `P${phase + 1}` : ""
  const r = typeof round === "number" ? `R${round + 1}` : ""
  return [p, r].filter(Boolean).join("/") || "轮次"
}

function deltaText(delta: number | undefined, unit: string): string | undefined {
  if (typeof delta !== "number" || delta === 0) return undefined
  const abs = Math.abs(delta)
  const text = abs >= 1000 ? `${(abs / 1000).toFixed(1)}k` : String(abs)
  return `${delta > 0 ? "+" : "-"}${text} ${unit}`
}

interface CloneDirInfo {
  name: string
  dir: string
  type: "user" | "built-in"
}

/** 分身目录 = 资产真相源；同名时用户目录优先（与 getCloneDirectory 的 built-in 优先相反，
 *  这里只用于读变更台账，两者目录不会同时存在同名分身）。 */
function listCloneDirs(roots?: { user: string; builtIn: string }): CloneDirInfo[] {
  const bases: Array<{ base: string; type: "user" | "built-in" }> = [
    { base: roots?.user ?? getClonesDir(), type: "user" },
    { base: roots?.builtIn ?? getBuiltInClonesDir(), type: "built-in" },
  ]
  const out: CloneDirInfo[] = []
  const seen = new Set<string>()
  for (const { base, type } of bases) {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(base, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue
      if (seen.has(entry.name)) continue
      seen.add(entry.name)
      out.push({ name: entry.name, dir: path.join(base, entry.name), type })
    }
  }
  return out
}

interface WikiCommit {
  hash: string
  ts: string
  subject: string
  added: number
  modified: number
}

/**
 * 当天的 wiki 编译记录。wiki 是 git 仓，一次编译 = 一次 commit —— 页面级
 * 「新增/更新」只有 git 分得清（DB 的 upsert 无法区分首建与改写）。
 * git 不可用（未装/未初始化）→ available:false，不造假数字。
 */
function readWikiToday(
  injectedRoot: string | null | undefined,
  sinceIso: string,
): { commits: WikiCommit[]; added: number; updated: number; compiles: number; available: boolean } {
  const empty = { commits: [] as WikiCommit[], added: 0, updated: 0, compiles: 0, available: false }
  let root: string
  try {
    root = injectedRoot ?? resolveWikiRootCompat()
  } catch {
    return empty
  }
  if (!root || !fs.existsSync(path.join(root, ".git"))) return empty

  try {
    const git = spawnGit(root, 5000)
    const result = git.run([
      "log",
      `--since=${sinceIso}`,
      "--name-status",
      "--pretty=format:__OCTO__%H\t%ct\t%s",
    ])
    if (result.status !== 0) return empty

    const commits: WikiCommit[] = []
    let current: WikiCommit | null = null
    for (const raw of result.stdout.split("\n")) {
      const line = raw.trim()
      if (!line) continue
      if (line.startsWith("__OCTO__")) {
        const [hash, ct, ...rest] = line.slice("__OCTO__".length).split("\t")
        current = {
          hash,
          ts: new Date(Number(ct) * 1000).toISOString(),
          subject: rest.join("\t"),
          added: 0,
          modified: 0,
        }
        commits.push(current)
        continue
      }
      if (!current) continue
      const [status, file] = line.split("\t")
      if (!file || !file.endsWith(".md")) continue
      const base = path.basename(file)
      if (base === "INDEX.md" || base === "LOG.md" || base === "SCHEMA.md") continue
      if (status === "A") current.added++
      else if (status === "M") current.modified++
    }

    return {
      commits: commits.sort((a, b) => a.ts.localeCompare(b.ts)),
      added: commits.reduce((sum, c) => sum + c.added, 0),
      updated: commits.reduce((sum, c) => sum + c.modified, 0),
      compiles: commits.length,
      available: true,
    }
  } catch {
    return empty
  }
}

interface ModelSwitch {
  ts: string
  from: string
  to: string
  title?: string
}

/** 模型切换 = 同一会话内相邻两次调用 model 不同。取当天最后一次切换。 */
function detectModelSwitch(
  calls: Array<{ session_id: string; timestamp: number; model: string | null }>,
  sessions: TodaySessionRow[],
): ModelSwitch | null {
  const lastBySession = new Map<string, string>()
  let latest: ModelSwitch | null = null
  const titleById = new Map(sessions.map((s) => [s.id, s.title]))

  for (const call of calls) {
    if (!call.model) continue
    const prev = lastBySession.get(call.session_id)
    lastBySession.set(call.session_id, call.model)
    if (!prev || prev === call.model) continue
    const candidate: ModelSwitch = {
      ts: new Date(call.timestamp).toISOString(),
      from: prev,
      to: call.model,
      title: titleById.get(call.session_id),
    }
    if (!latest || candidate.ts >= latest.ts) latest = candidate
  }
  return latest
}