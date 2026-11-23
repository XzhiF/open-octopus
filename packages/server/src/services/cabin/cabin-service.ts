import { randomUUID } from "crypto"
import fs from "fs"
import os from "os"
import path from "path"
import {
  mergeLlmUsageSummaries, emptyTokenUsage, totalTokens,
  type CabinInitState, type LlmUsageSummary, type ModelUsageBreakdown, type TokenUsage, type LedgerCost,
  type CabinWorkRow, type CabinAskEnvelope,
} from "@octopus/shared"
import type { CabinDAO } from "../../db/dao/cabin-dao"
import type {
  WorkspaceDAO, AgentSessionDAO, TaskDAO, ExecutionDAO, AcceptanceDAO,
} from "../../db/dao"
import { SessionCacheContextDAO } from "../../db/dao"
import type { CabinDelegationDAO } from "../../db/dao/cabin-delegation-dao"
import type { TokenUsageDAO } from "../../db/dao/token-usage-dao"
import type { ExecutionLinkDAO } from "../../db/dao/execution-link-dao"
import type { FindingRow } from "../../db/dao/findings-dao"
import { pricePreviewSql } from "../../db/price-sql"
import type {
  CabinRow, CabinJobRow, CabinJobEventRow, CabinStatus, CabinJobKind, CabinJobEventKind,
} from "../../db/types"
import type { WorkspaceService } from "../workspace"
import type { TasksService } from "../tasks/tasks-service"
import type { RepoSyncService } from "../tasks/repo-sync-service"
import { getSessionService } from "../agent/session-service"
import { isStreamActive } from "../agent/agent-service"
import { UNNAMED_CABIN_NAME } from "./cabin-naming"
import { gitOps } from "../git-ops"
import { WorkspaceGit, type SpecWorktreeEntry } from "../workspace-git"
import { deriveTaskView } from "../tasks/derive-task-view"
import type { RoundEvidenceService } from "../tasks/round-evidence-service"
import type { IncidentStore } from "../supervision/incident-store"
import type { FindingOpsService } from "../knowledge/findings"
import { MAX_PARALLEL_WORKSPACES } from "../scheduler/concurrency"
import { deriveCabinView, type DerivedCabinView, type DeriveCabinInput } from "./derive-cabin-view"
import { assignHandles } from "./cabin-handles"
import type { CabinInitService } from "./cabin-init-service"
import { isInitComplete } from "./cabin-init-service"
import {
  ensureRepoCloned, readCabinConfig, writeCabinConfigRepos,
  mergeCabinRepoEntry, removeCabinRepoEntry, repoSource, resolveCabinRepo,
  projectKey, localRepoEntry, orgRepoEntry, worktreeDirFor, isPathInside,
  isGitRepo, readLocalRepoInfo, defaultMainlineBranch,
  type CabinRepoEntry, type CabinProjectInput,
} from "./cabin-repos"
import { scopeCabinFindings } from "./cabin-knowledge"

export class CabinNotFoundError extends Error {
  constructor(id: string) { super(`cabin not found: ${id}`); this.name = "CabinNotFoundError" }
}
export class CabinVersionConflictError extends Error {
  constructor(id: string) { super(`cabin version conflict: ${id}`); this.name = "CabinVersionConflictError" }
}
export class CabinStatusConflictError extends Error {
  constructor(id: string, from: string, to: string) { super(`cabin status conflict: ${id} ${from}->${to}`); this.name = "CabinStatusConflictError" }
}
/** 项目入参不合法（路径/来源）——route 归 400，不当 500。 */
export class CabinRepoInputError extends Error {
  constructor(message: string) { super(message); this.name = "CabinRepoInputError" }
}

/** 显式开工作树时目标已存在（活 worktree）——不覆盖、不删除。 */
export class WorktreeConflictError extends Error {
  constructor(message: string) { super(message); this.name = "WorktreeConflictError" }
}

/** 项目 wire 视图（git 富化由 route 追加）。 */
export interface CabinRepoView {
  key: string
  name: string
  source: "org" | "local"
  org: string | null
  group: string | null
  repoName: string | null
  main_path: string | null
  local_path: string | null
  external: boolean
  mainline_branch: string | null
  worktree_path: string | null
  branch: string | null
  worktrees: Array<{ path: string; branch: string; instance: string; created_at?: string }>
}

/** 本舱变更窗的文件行（DiffFileEntry 同形 + 未跟踪标记）。 */
export interface CabinWorktreeChangeFile {
  path: string
  /** rename/copy 来源（status R/C）。 */
  oldPath?: string
  /** M / A / D / R / C / T；未跟踪的新文件 = "?"。 */
  status: string
  adds: number
  dels: number
  binary?: boolean
  untracked?: boolean
}

/** 本舱变更窗的唯一目标仓库（= 本舱 cwd 本身）。数组形态保留是为了复用
 *  编队「作战详情 → 变更」的树 / 统计模型，实际只会有一个元素。 */
export interface CabinWorktreeChangeRepo {
  name: string
  /** 比对目录 = 本舱 cwd（cabin.path）。 */
  dir: string | null
  branch: string | null
  /** HEAD 短 SHA；空仓（还没提交）= null，此时只列未跟踪文件。 */
  head: string | null
  /** 失败原因（目录不在 / 不是 git 仓）。 */
  error: string | null
  truncated: boolean
  files: CabinWorktreeChangeFile[]
}

export interface CabinWorktreeChanges {
  /** 本舱 cwd 绝对路径。 */
  dir: string
  repos: CabinWorktreeChangeRepo[]
}

/** 单仓文件列表上限（与回合变更面板 REPO_FILE_CAP 同口径）。 */
const WORKTREE_CHANGE_FILE_CAP = 3000

/** 仍占用项目锚点的任务状态（解绑前必须收尾）。 */
const LIVE_TASK_STATUSES = new Set([
  "running", "ready", "queued", "pending", "paused", "awaiting_review", "awaiting_archive",
])

function parseProjectIds(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []
  } catch {
    return []
  }
}

const now = () => new Date().toISOString()
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err))

function parseMetadata(metadata: string | null | undefined): Record<string, unknown> | null {
  if (!metadata) return null
  try { return JSON.parse(metadata) as Record<string, unknown> } catch { return null }
}

function parseQuestions(value: unknown): unknown[] | null {
  let raw = value
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw) } catch { return null }
  }
  // 三种历史形态：tool input 的 { questions: [...] }、metadata 直接存数组、
  // SSE / interaction 的包装对象。
  if (Array.isArray(raw)) return raw
  const qs = (raw as { questions?: unknown } | null)?.questions
  return Array.isArray(qs) ? qs : null
}

function firstQuestionText(questions: unknown[] | null): string | undefined {
  const q = questions?.[0] as { question?: unknown } | undefined
  return typeof q?.question === "string" ? q.question : undefined
}

/** 工作流 interaction_messages：问题正文只从 metadata 取。 */
function questionsFromMetadata(metadata: string | null | undefined): unknown[] | null {
  const meta = parseMetadata(metadata)
  if (meta?.displayType !== "ask_user_question") return null
  return parseQuestions(meta.questions)
}

/** 作者提问信封里与「归属」相关的字段（design 23 §2 / 25 §5.6）。 */
interface AuthorAskPayload {
  authorAsk?: unknown
  askMessageId?: unknown
  askReceiptFor?: unknown
  /** design 24 / 26：富化信封（镜像卡 payload 上带全量字段）。 */
  authorSessionId?: unknown
  cabinId?: unknown
  decision?: unknown
  intent?: unknown
  options?: unknown
  recommendation?: unknown
  blocking?: unknown
  phase?: unknown
  origin?: unknown
  questions?: unknown
}

/** 一条提问的稳定 id：镜像卡用信封里的 askMessageId，原卡就是消息行 id。
 *  舱主会话的镜像卡与作者线程的原卡因此指向同一个 askId。 */
function authorAskId(payload: AuthorAskPayload | undefined, fallback: string): string {
  if (payload?.authorAsk && typeof payload.askMessageId === "string" && payload.askMessageId) {
    return payload.askMessageId
  }
  return fallback
}

/** 会话标题 → 展示名：v5 未命名舱的「undefined · 舱主对话」去掉占位前缀。 */
function sessionLabel(title: string | null | undefined): string {
  const cleaned = (title ?? "").replace(/^undefined\s*(·\s*)?/i, "").trim()
  return cleaned || "舱会话"
}

/** 信封体积纪律（design 26 §4.1）：不把整段 transcript 塞进 attention。 */
function clip(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined
  const s = value.trim()
  if (!s) return undefined
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function clipOptions(value: unknown): CabinAskEnvelope["options"] {
  if (!Array.isArray(value)) return undefined
  const out: NonNullable<CabinAskEnvelope["options"]> = []
  for (const item of value.slice(0, 12)) {
    const o = item as { label?: unknown; impact?: unknown; description?: unknown } | null
    const label = clip(o?.label, 80)
    if (!label) continue
    const impact = clip(o?.impact, 160)
    const description = clip(o?.description, 160)
    out.push({ label, ...(impact ? { impact } : {}), ...(description ? { description } : {}) })
  }
  return out.length > 0 ? out : undefined
}

function clipRecommendation(value: unknown): CabinAskEnvelope["recommendation"] {
  if (!value || typeof value !== "object") return undefined
  const r = value as { label?: unknown; reason?: unknown }
  const label = clip(r.label, 120)
  const reason = clip(r.reason, 240)
  if (!label && !reason) return undefined
  return { ...(label ? { label } : {}), ...(reason ? { reason } : {}) }
}

function clipPhase(value: unknown): CabinAskEnvelope["phase"] {
  if (!value || typeof value !== "object") return undefined
  const p = value as { index?: unknown; round?: unknown }
  const index = typeof p.index === "number" ? p.index : undefined
  const round = typeof p.round === "number" ? p.round : undefined
  return index === undefined && round === undefined ? undefined : { ...(index !== undefined ? { index } : {}), ...(round !== undefined ? { round } : {}) }
}

/** AskUserQuestion 原对象：只留 questions 数组（选项描述等原样，供卡组件渲染）。 */
function clipQuestions(value: unknown[] | null | undefined): CabinAskEnvelope["questions"] {
  if (!value || value.length === 0) return undefined
  return { questions: value.slice(0, 6) }
}

/** 从镜像卡 payload 解出信封；没有票据 / 工作流提问返回 undefined。 */
function askEnvelopeFromPayload(
  payload: AuthorAskPayload,
  messageId: string,
  questions: unknown[] | null,
): CabinAskEnvelope | undefined {
  if (!payload.authorAsk) return undefined
  const askId = clip(payload.askMessageId, 200)
  if (!askId) return undefined
  const originRaw = payload.origin
  const origin = originRaw === "session" || originRaw === "delegation" || originRaw === "workflow"
    ? originRaw
    : undefined
  // 工作流执行提问没有决策票据：v1 不为它开问答窗（design 26 §9）。
  if (origin === "workflow") return undefined
  const authorSessionId = clip(payload.authorSessionId, 200)
  const decision = clip(payload.decision, 200)
  const intent = clip(payload.intent, 400)
  const options = clipOptions(payload.options)
    ?? clipOptions((questions?.[0] as { options?: unknown } | undefined)?.options)
  const recommendation = clipRecommendation(payload.recommendation)
  const phase = clipPhase(payload.phase)
  const questionBody = clipQuestions(questions)
  return {
    ask_id: askId,
    message_id: messageId,
    ...(authorSessionId ? { author_session_id: authorSessionId } : {}),
    ...(origin ? { origin } : {}),
    ...(decision ? { decision } : {}),
    ...(intent ? { intent } : {}),
    ...(options ? { options } : {}),
    ...(recommendation ? { recommendation } : {}),
    ...(typeof payload.blocking === "boolean" ? { blocking: payload.blocking } : {}),
    ...(phase ? { phase } : {}),
    ...(questionBody ? { questions: questionBody } : {}),
  }
}

/** 信封完整度：镜像卡（有决策 / 选项 / 问题体）优先于作者线程原卡。 */
function askEnvelopeScore(env: CabinAskEnvelope): number {
  return (env.questions ? 4 : 0) + (env.options?.length ? 2 : 0)
    + (env.decision ? 1 : 0) + (env.author_session_id ? 1 : 0)
}

/** 会话消息：metadata（clone / interaction / 修好后的 agent-chat）优先；
 *  老行只有 tool_calls 里的 AskUserQuestion —— 一并兜住，避免升级前的提问
 *  在舱里永远看不到。 */
function questionsFromMessage(row: { metadata?: string | null; tool_calls?: string | null }): unknown[] | null {
  const fromMeta = questionsFromMetadata(row.metadata)
  if (fromMeta) return fromMeta
  if (!row.tool_calls) return null
  let parsed: unknown
  try { parsed = JSON.parse(row.tool_calls) } catch { return null }
  const wrapped = parsed as { tool_calls?: unknown } | null
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(wrapped?.tool_calls) ? wrapped.tool_calls : []
  for (const item of list) {
    const tc = item as { name?: unknown; input?: unknown; result?: unknown } | null
    if (tc?.name !== "AskUserQuestion") continue
    return parseQuestions(tc.input ?? tc.result)
  }
  return null
}

const EMPTY_USAGE: LlmUsageSummary = {
  totalCalls: 0,
  usage: emptyTokenUsage(),
  totals: { tokens: 0, cost: { usd: null, complete: false }, cacheHitRate: null },
}

/** C7 byJob 行：chat（orchestrator 主对话）/ task / workflow 三种 llm_calls 口径。 */
export interface CabinUsageJob extends LlmUsageSummary {
  job_id: string | null
  kind: "chat" | "task" | "workflow"
  label: string
  ref_id: string | null
  /** 项目锚点（chat / 未归属为空数组）。 */
  project_keys?: string[]
}

/** C7 子代理单列行（subagent_runs 口径，不与 llm_calls 盲加）。 */
export interface CabinUsageSubagent {
  id: string
  job_id: string | null
  label: string
  status: string
  usage: TokenUsage
  tokens: number
  cost: LedgerCost
}

export interface CabinUsageDTO {
  /** llm_calls 口径合计（chat execution_id IS NULL + 执行），不含子代理。 */
  summary: LlmUsageSummary & { modelBreakdown: Record<string, ModelUsageBreakdown> }
  byJob: CabinUsageJob[]
  /** 子代理单列（subagent_runs token + 试算成本）。 */
  subagents: { count: number; usage: TokenUsage; tokens: number; cost: LedgerCost; runs: CabinUsageSubagent[] }
  /** 全口径 = llm_calls + 子代理（各算一次，防双算）。 */
  grand: LlmUsageSummary
  timing: { duration_ms: number }
}

/** Late-bound composition (SW-BP15: ctor stays append-only). Wired in index.ts
 *  once WorkspaceService/TasksService/DAOs exist; absent in pure unit tests. */
export interface CabinInfra {
  workspaceService: WorkspaceService
  workspaceDAO: WorkspaceDAO
  agentSessionDAO: AgentSessionDAO
  taskDAO: TaskDAO
  executionDAO: ExecutionDAO
  acceptanceDAO: AcceptanceDAO
  tasksService?: TasksService
  repoSync?: RepoSyncService
  initService?: CabinInitService
  roundEvidence?: RoundEvidenceService
  /** P4：attention 矩阵（C4）+ 知识 scoping（G4）+ 消耗聚合（C7）。 */
  incidentStore?: IncidentStore
  findingOps?: FindingOpsService
  tokenUsageDAO?: TokenUsageDAO
  execLinks?: ExecutionLinkDAO
  /** design 25 §4.2：独立委派（第二种工作实体）。 */
  cabinDelegationDAO?: CabinDelegationDAO
  /** 任务主线程此刻是否有 chat 流在跑（编队「作者在推进」用）；测试可注入。 */
  isSessionStreaming?: (sessionId: string) => boolean
}

/** ASCII workspace slug — WorkspaceService.create forbids non-ASCII names;
 *  the Chinese display name stays on cabins.name (plan conflict 6e). */
function workspaceSlug(cabinPath: string, id: string): string {
  const base = path.basename(cabinPath).replace(/[^a-zA-Z0-9_-]/g, "-") || "cabin"
  // 自动目录本身就以 cabin- 开头（cabin-1115-162104-f01335），再前缀一次会变
  // cabin-cabin-…（plan §4.1 顺手清理）。
  const stem = base.startsWith("cabin-") ? base : `cabin-${base}`
  return `${stem}-${id.slice(0, 6)}`
}

/** 不选目录时的默认工作空间（I4）：与任务目录同族
 *  ~/.octopus/workspaces/cabin-<MMDD>-<HHmmss>-<rand6>。
 *  路径由**服务端**生成：workspaceService.create 会 mkdir -p 并铺骨架，
 *  前端不再自己拼路径（plan §4.1）。 */
function autoWorkspacePath(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0")
  const stamp = `${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  const rand = randomUUID().replace(/-/g, "").slice(0, 6)
  return path.join(os.homedir(), ".octopus", "workspaces", `cabin-${stamp}-${rand}`)
}

/** POST /api/cabins body（v5）：`path` 可省略 = 新建工作空间；
 *  `projects[]` 是跨 org 的关联关系（写入 config.json.repos[].group）；
 *  `name` 也可省略 —— 空名先落「未命名舱」，init 开头按需求取名。 */
export interface CreateCabinInput {
  name?: string
  path?: string
  requirements?: string
  org?: string | null
  /** 老调用方：单 org + 仓库名列表（与 projects 二选一，projects 优先）。 */
  repos?: string[]
  /** 项目关联：ORG（org+repo）/ 本地（localPath，舱内相对）/ 外部（absolutePath + external）。 */
  projects?: CabinProjectInput[]
}

export interface CreateCabinResult {
  cabin: CabinRow
  /** false = 这个目录已经是一个舱（一目录一舱，I3）。客户端据此改为“打开”。 */
  created: boolean
}

/**
 * CabinService — directory-bound long-lived cockpit.
 * Identity + lifecycle (soft archive / reopen / dormant) + G1 cascade delete
 * + dispatch ledger. Composes the existing workspace/session/task
 * infrastructure; init orchestration lives in CabinInitService.
 */
export class CabinService {
  private infra: CabinInfra | null = null
  private git = new WorkspaceGit()
  private archiveHook: ((cabinId: string) => Promise<void>) | null = null
  /** status 变更广播（组合根接 SSE）：自动打盹/活动唤醒都要让前端即时换态。 */
  private statusHook: ((cabinId: string, status: CabinStatus) => void) | null = null
  private viewHook: ((cabinId: string) => void) | null = null

  constructor(private cabin: CabinDAO) {}

  bindInfra(infra: CabinInfra): void { this.infra = infra }
  /** P5 wires cabin-level sediment (G3) here; archive stays soft until then. */
  setArchiveHook(hook: (cabinId: string) => Promise<void>): void { this.archiveHook = hook }
  setStatusHook(hook: (cabinId: string, status: CabinStatus) => void): void { this.statusHook = hook }

  /** 派生视图（attention / 编队）变脏的即时广播：delegation / decision 等
   *  状态变化不必等 useCabin 的 30s 轮询。 */
  setViewHook(hook: (cabinId: string) => void): void { this.viewHook = hook }

  notifyViewChanged(cabinId: string): void { this.viewHook?.(cabinId) }

  /** 唯一的状态写口：落库 + 广播（手动/自动/唤醒全部走这里）。 */
  private setStatus(id: string, status: CabinStatus): void {
    this.cabin.updateStatus(id, status, now())
    this.statusHook?.(id, status)
  }

  private mustGet(id: string): CabinRow {
    const row = this.cabin.findById(id)
    if (!row) throw new CabinNotFoundError(id)
    return row
  }

  /** 兼容旧调用：只要行，不要 created 标记。 */
  create(input: CreateCabinInput): CabinRow {
    return this.createWithResult(input).cabin
  }

  /** 建舱入参 → config 条目。本地项目只登记不克隆；失败返回 null（init 门禁报）。 */
  private projectEntryFromInput(
    cabinPath: string, p: CabinProjectInput, fallbackOrg: string | null,
  ): CabinRepoEntry | null {
    if (p.source === "local") {
      const raw = p.absolutePath?.trim() || p.localPath?.trim()
      if (!raw) return null
      const abs = path.isAbsolute(raw) ? raw : path.resolve(cabinPath, raw)
      const name = p.name?.trim() || p.repo?.trim() || path.basename(abs)
      try {
        return localRepoEntry(cabinPath, { name, absPath: abs })
      } catch {
        return { name, source: "local", main_path: abs, local_path: raw, external: p.external }
      }
    }
    const orgName = p.org?.trim() || fallbackOrg || ""
    const repoName = p.repo?.trim() || p.name?.trim() || ""
    if (!repoName) return null
    return orgRepoEntry({ name: repoName, org: orgName || undefined, group: orgName || undefined })
  }

  /**
   * v4 建舱入口：`path` 省略 → 服务端自动建工作空间；`projects[]` → config.json
   * 带 group（跨 org 关联）。同目录已有舱时**不报错**，返回 created:false 让 UI
   * 改成「打开」（I3；保持老调用方 attach 语义不变）。
   */
  createWithResult(input: CreateCabinInput): CreateCabinResult {
    const cabinPath = input.path?.trim() || autoWorkspacePath()
    const existing = this.cabin.findByPath(cabinPath)
    if (existing) return { cabin: existing, created: false }
    const name = input.name?.trim() || UNNAMED_CABIN_NAME
    const org = input.org ?? input.projects?.find((p) => p.org)?.org ?? null
    const id = randomUUID()
    const ts = now()
    const row: CabinRow = {
      id, name, path: cabinPath,
      workspace_id: null, main_session_id: null,
      requirements: input.requirements ?? "",
      status: "draft", mainline_strategy: "clean-main",
      org, init_state: null, cockpit_prefs: null,
      version: 1,
      created_at: ts, updated_at: ts, last_active_at: ts, archived_at: null, deleted_at: null,
    }
    this.cabin.insert(row)
    if (this.infra) {
      // Scaffold WITHOUT repos: clones land in init gate 3, worktrees in gate 4.
      const ws = this.infra.workspaceService.create({
        name: workspaceSlug(cabinPath, id),
        path: cabinPath,
        repos: [],
        repo_group: org,
        description: `作战舱：${name}`,
      })
      this.infra.workspaceDAO.update(ws.id, { cabin_id: id })
      this.cabin.bindWorkspace(id, ws.id, now())
      const projectEntries: CabinRepoEntry[] = (input.projects ?? [])
        .map((p) => this.projectEntryFromInput(cabinPath, p, org))
        .filter((e): e is CabinRepoEntry => !!e)
      const legacyEntries: CabinRepoEntry[] = (input.repos ?? [])
        .filter(Boolean)
        .map((n) => ({ group: "", name: n, repoName: n }))
      const repoEntries = projectEntries.length > 0 ? projectEntries : legacyEntries
      if (repoEntries.length > 0) writeCabinConfigRepos(cabinPath, repoEntries)
      const session = getSessionService().createSession({
        cwd: cabinPath, workspace_id: ws.id, cabin_id: id,
      })
      this.infra.agentSessionDAO.updateSession(session.id, {
        cabin_id: id, title: `${name} · 舱主对话`,
      })
      new SessionCacheContextDAO(this.infra.agentSessionDAO.getDb())
        .setActiveExpert(session.id, "cabin-orchestrator", "clone")
      this.cabin.bindSession(id, session.id, now())
    }
    return { cabin: this.mustGet(id), created: true }
  }

  /** Register an existing directory; reuse if a cabin already owns it. A
   *  .cabin/manifest.json with no DB row (lost DB / out-of-band dir) restores
   *  identity instead of re-scaffolding. */
  attach(cabinPath: string, name?: string): CabinRow {
    const existing = this.cabin.findByPath(cabinPath)
    if (existing) return existing
    const manifestPath = path.join(cabinPath, ".cabin", "manifest.json")
    if (fs.existsSync(manifestPath)) {
      try {
        const m = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as {
          id?: string; name?: string; org?: string | null
          main_session_id?: string | null; createdAt?: string
        }
        // 软删（2026-11-15）之后目录里的 manifest 还在：那个 id 对应的是墓碑行，
        // 不能 insert（主键冲突），要把它复原成活行 —— 承认「这个目录本来就是这个舱」。
        const tombstone = m.id ? this.cabin.findAnyById(m.id) : undefined
        if (m.id && m.name && (!tombstone || tombstone.deleted_at)) {
          const ts = now()
          let requirements = ""
          try { requirements = fs.readFileSync(path.join(cabinPath, ".cabin", "requirements.md"), "utf-8") } catch { /* optional */ }
          let status: CabinStatus = "draft"
          try {
            const st = JSON.parse(fs.readFileSync(path.join(cabinPath, ".cabin", "init-state.json"), "utf-8")) as CabinInitState
            if (Array.isArray(st.items) && isInitComplete(st)) status = "active"
          } catch { /* no gate snapshot → draft */ }
          if (tombstone) {
            this.cabin.revive(m.id, {
              name: m.name, path: cabinPath, status, requirements, org: m.org ?? null,
            }, ts)
          } else {
            this.cabin.insert({
              id: m.id, name: m.name, path: cabinPath,
              workspace_id: null, main_session_id: null,
              requirements, status, mainline_strategy: "clean-main",
              org: m.org ?? null, init_state: null, cockpit_prefs: null,
              version: 1,
              created_at: m.createdAt ?? ts, updated_at: ts, last_active_at: ts, archived_at: null,
              deleted_at: null,
            })
          }
          if (this.infra) {
            const ws = this.infra.workspaceDAO.findByPath(cabinPath)
            if (ws) {
              this.cabin.bindWorkspace(m.id, ws.id, now())
              this.infra.workspaceDAO.update(ws.id, { cabin_id: m.id })
            }
            if (m.main_session_id && this.infra.agentSessionDAO.findById(m.main_session_id)) {
              this.cabin.bindSession(m.id, m.main_session_id, now())
              this.infra.agentSessionDAO.updateSession(m.main_session_id, { cabin_id: m.id })
            }
          }
          return this.mustGet(m.id)
        }
      } catch { /* corrupt manifest → fresh create */ }
    }
    return this.create({ name: name ?? path.basename(cabinPath), path: cabinPath })
  }

  get(id: string): CabinRow { return this.mustGet(id) }
  list(status?: CabinStatus): CabinRow[] { return this.cabin.list(status) }

  private transition(id: string, from: CabinStatus[], to: CabinStatus): CabinRow {
    const row = this.mustGet(id)
    if (!from.includes(row.status)) throw new CabinStatusConflictError(id, row.status, to)
    this.setStatus(id, to)
    return this.mustGet(id)
  }

  /** draft -> initializing, then the gate runs async (202 semantics). */
  init(id: string): CabinRow {
    const row = this.transition(id, ["draft"], "initializing")
    const initService = this.infra?.initService
    if (initService) {
      void initService.runGate(id).catch((err) => {
        console.error(`[CabinService] runGate crashed for ${id}:`, errMsg(err))
      })
    }
    return row
  }

  /** dormant -> active: worktree self-heal + fire-and-forget mainline refresh.
   *  已醒 → 幂等返回（活动心跳可能比「叫醒」按钮先一步把舱叫醒）。 */
  wake(id: string): CabinRow {
    const row = this.mustGet(id)
    if (row.status === "active") return row
    const next = this.transition(id, ["dormant"], "active")
    this.cabin.updateFields(id, next.version, { last_active_at: now() }, now())
    this.selfHeal(id)
    return this.mustGet(id)
  }

  /**
   * 互动信号（C11 重做：打盹由「人有没有来」驱动，不是状态锁）。
   *   dormant → active：静默叫醒（不跑 self-heal —— 打盹从未回收工作树，
   *     self-heal 只留给手动 wake）。
   *   active  → touch：刷新空闲计时，避免聊着聊着被判成打盹。
   * 其余状态（draft/initializing/archived）不动。
   * @param atMs 互动发生的客户端时刻：晚到的旧心跳不能把刚打盹的舱叫醒。
   */
  activity(id: string, atMs?: number): CabinRow {
    const row = this.mustGet(id)
    if (row.status === "dormant") {
      const sleptAt = row.updated_at ? Date.parse(row.updated_at) : 0
      if (typeof atMs === "number" && Number.isFinite(atMs) && sleptAt > atMs) return row
      const ts = now()
      this.setStatus(id, "active")
      const fresh = this.mustGet(id)
      this.cabin.updateFields(id, fresh.version, { last_active_at: ts }, ts)
      return this.mustGet(id)
    }
    if (row.status === "active") this.touch(id)
    return this.mustGet(id)
  }

  /** C1 soft archive: status only, keep tasks/worktrees/history; NO cascade. */
  archive(id: string): CabinRow {
    const row = this.transition(id, ["active", "dormant"], "archived")
    this.cabin.updateFields(id, row.version, { archived_at: now() }, now())
    if (this.archiveHook) {
      void this.archiveHook(id).catch((err) => {
        console.error(`[CabinService] archive sediment hook failed for ${id}:`, errMsg(err))
      })
    }
    return this.mustGet(id)
  }

  /** C1 reopen: archived -> active, self-heal, no re-init gate. */
  reopen(id: string): CabinRow {
    const row = this.transition(id, ["archived"], "active")
    this.cabin.updateFields(id, row.version, { archived_at: null, last_active_at: now() }, now())
    this.selfHeal(id)
    return this.mustGet(id)
  }

  /** C11 manual sleep: active -> dormant. Three guards (no running exec, no
   *  person-awaiting attention) so dormiting never orphans live work. */
  dormant(id: string): CabinRow {
    const row = this.mustGet(id)
    if (row.status !== "active") throw new CabinStatusConflictError(id, row.status, "dormant")
    const { view } = this.getView(id)
    if (view.health.running > 0) throw new CabinStatusConflictError(id, "running-tasks", "dormant")
    if (view.attention.some((a) => a.awaiting === "person")) {
      throw new CabinStatusConflictError(id, "awaiting-person", "dormant")
    }
    this.setStatus(id, "dormant")
    return this.mustGet(id)
  }

  /** C11 auto threshold sweep: idle active cabins (no running / no queued /
   *  no person attention, idle >= per-cabin threshold) -> dormant.
   *  threshold<=0 disables. Returns the ids dormited this pass for the job outcome. */
  sweepDormant(nowMs: number, defaultThresholdMs: number): string[] {
    const dormited: string[] = []
    for (const row of this.cabin.list("active")) {
      const threshold = this.dormantThresholdMs(row, defaultThresholdMs)
      if (threshold <= 0) continue
      const last = row.last_active_at ? Date.parse(row.last_active_at) : 0
      if (!last || nowMs - last < threshold) continue
      const { view } = this.getView(row.id)
      if (view.health.running > 0) continue
      // 排队中的作业随时会被拉起：这时打盹的标签会骗人（「在睡觉」却马上开工）。
      if (view.health.queued > 0) continue
      if (view.attention.some((a) => a.awaiting === "person")) continue
      this.setStatus(row.id, "dormant")
      dormited.push(row.id)
    }
    return dormited
  }

  private dormantThresholdMs(row: CabinRow, defaultMs: number): number {
    try {
      const prefs = JSON.parse(row.cockpit_prefs ?? "{}") as { dormantMinutes?: unknown }
      if (typeof prefs.dormantMinutes === "number" && Number.isFinite(prefs.dormantMinutes)) {
        return prefs.dormantMinutes * 60_000
      }
    } catch { /* malformed prefs → default */ }
    return defaultMs
  }

  private selfHeal(id: string): void {
    const row = this.mustGet(id)
    if (!this.infra || !row.workspace_id) return
    const ws = this.infra.workspaceDAO.findById(row.workspace_id)
    if (!ws) return
    try {
      this.infra.workspaceService.ensureWorktreesForReuse(ws)
    } catch (err) {
      console.error(`[CabinService] worktree self-heal failed for ${id}:`, errMsg(err))
    }
    const names = readCabinConfig(row.path).repos.map((r) => r.name).filter(Boolean)
    if (names.length > 0) {
      this.infra.repoSync?.syncProjectsForTask(id, row.org ?? undefined, names)
    }
  }

  /**
   * 删除舱（2026-11-15 用户口径：**软删除**，跟任务一样 —— 平台计费，账不能删）。
   *
   * 行留在 `cabins` 表里（`deleted_at` 非空），列表/接口从此看不见它；任务与会话
   * 跟着软删（隐藏但不丢），**execution / llm_calls / Trace / 验收历史一律保留** ——
   * 计费与审计要能追（工作空间行也留着，executions 外键指着它）。
   *
   * 本地文件默认**不动**；`deleteFiles: true`（确认弹框里勾选）才连同舱目录
   * （`row.path`）一起删。目录是用户选的，所以带一层防呆：根目录 / home /
   * home 的父级一律拒绝。
   *
   * 正在跑的任务必须先停 —— 和 TasksService.deleteTask 同一个守卫。
   */
  delete(id: string, opts: { deleteFiles?: boolean } = {}): { deleted_files: boolean } {
    const row = this.mustGet(id)
    const infra = this.infra
    const tasks = infra ? infra.taskDAO.findByCabinId(id) : []
    if (tasks.some((t) => t.status === "running")) {
      throw new CabinStatusConflictError(id, "running-tasks", "delete")
    }
    const ts = now()
    this.cabin.transaction(() => {
      // 任务 / 会话软删（隐藏），execution 行故意不删：那是计费与历史的账本。
      for (const t of tasks) {
        if (infra?.tasksService) infra.tasksService.deleteTask(t.id)
        else infra?.taskDAO.softDelete(t.id)
      }
      if (infra) {
        for (const s of infra.agentSessionDAO.listByCabinId(id)) infra.agentSessionDAO.softDelete(s.id)
      }
      // 工作空间行**保留**：executions 外键指着它，删了就等于毁掉计费账本；
      // 而且任务工作空间本来就是「删任务留空间」，舱沿用同一条规矩。
      this.cabin.softDelete(id, ts)
    })
    // 磁盘工作树：尽力而为，事务外（与原来一致）。
    for (const e of readCabinConfig(row.path).repos) {
      if (e.main_path && e.worktree_path) {
        void gitOps.worktreeRemove(e.main_path, e.worktree_path).catch((err) => {
          console.error(`[CabinService] worktree remove failed for ${id}/${e.name}:`, errMsg(err))
        })
      }
    }
    const deletedFiles = opts.deleteFiles ? this.removeCabinDir(row) : false
    return { deleted_files: deletedFiles }
  }

  /** 勾了「同时删除本地文件」才走这里。目录是用户选的，先过防呆再 rm -rf。 */
  private removeCabinDir(row: CabinRow): boolean {
    const raw = row.path?.trim()
    if (!raw || !path.isAbsolute(raw)) {
      console.error(`[CabinService] 拒绝删除非绝对路径的舱目录: ${row.id} ${raw ?? ""}`)
      return false
    }
    const target = path.resolve(raw)
    const home = path.resolve(os.homedir())
    const guarded = new Set([
      path.parse(target).root, // "/"
      home,
      path.dirname(home), // /Users
    ])
    if (guarded.has(target) || target.length <= 3) {
      console.error(`[CabinService] 拒绝删除受保护的路径: ${row.id} ${target}`)
      return false
    }
    try {
      fs.rmSync(target, { recursive: true, force: true })
      return true
    } catch (err) {
      console.error(`[CabinService] 舱目录删除失败: ${row.id} ${target}`, errMsg(err))
      return false
    }
  }

  /** Optimistic-lock field update (single call — multiple fields, one version bump). */
  patch(id: string, version: number, fields: Parameters<CabinDAO["updateFields"]>[2]): CabinRow {
    const ok = this.cabin.updateFields(id, version, fields, now())
    if (!ok) throw new CabinVersionConflictError(id)
    return this.mustGet(id)
  }

  patchMeta(id: string, version: number, fields: Partial<Pick<CabinRow, "name" | "mainline_strategy" | "org">>): CabinRow {
    return this.patch(id, version, fields)
  }
  setRequirements(id: string, version: number, requirements: string): CabinRow {
    return this.patch(id, version, { requirements })
  }
  updateCockpitPrefs(id: string, version: number, prefs: unknown): CabinRow {
    return this.patch(id, version, { cockpit_prefs: JSON.stringify(prefs) })
  }
  touch(id: string): void {
    const row = this.mustGet(id)
    this.cabin.updateFields(id, row.version, { last_active_at: now() }, now())
  }

  // ── derived view (K3: computed on read, never stored) ──

  getView(id: string): { cabin: CabinRow; view: DerivedCabinView } {
    const row = this.mustGet(id)
    const jobs = this.cabin.listJobs(id)
    const tasks: DeriveCabinInput["tasks"] = []
    const executions: DeriveCabinInput["executions"] = []
    const taskRows = this.infra ? this.infra.taskDAO.findByCabinId(id) : []
    const execToTask = new Map<string, string>()
    const sessionToTask = new Map<string, string>()
    // design 25 §4.1：句柄 / 颜色由创建顺序 + id hash 派生，不落库。
    const taskHandles = assignHandles(
      taskRows.map((t) => ({ id: t.id, created_at: t.created_at })), "task",
    )
    if (this.infra) {
      for (const t of taskRows) {
        const execs = this.infra.executionDAO.listTaskInstances(t.id, 200)
        const acceptances = this.infra.acceptanceDAO.listByTask(t.id)
        const derived = deriveTaskView(t, execs, acceptances)
        const handle = taskHandles.get(t.id)
        // 入队 gate 的静态前提：v4、至少一个 phase、每个 phase 都绑了 workflowRef。
        // 全满足才把 draft 认成「待入列」；半草稿不会进 attention。
        const enqueueReady = derived.isV4
          && derived.phaseViews.length > 0
          && derived.phaseViews.every((p) => !!p.workflowRef)
        tasks.push({
          id: t.id, name: t.name, status: derived.taskStatus,
          rawStatus: t.status, enqueueReady,
          repo: t.repo_group ?? null, branch: null,
          ...(handle ? { handle: handle.handle, color: handle.color } : {}),
        })
        for (const e of execs) {
          executions.push({ id: e.id, task_id: t.id, status: e.status })
          execToTask.set(e.id, t.id)
        }
        if (t.source_chat_session_id) sessionToTask.set(t.source_chat_session_id, t.id)
        if (t.doer_session_id) sessionToTask.set(t.doer_session_id, t.id)
      }
    }
    // 独立委派（design 25 §4.2）：读侧归一化 —— 与任务同一种 attention 形状。
    const delegationRows = this.infra?.cabinDelegationDAO?.listByCabin(id) ?? []
    const delegationHandles = assignHandles(
      delegationRows.map((d) => ({ id: d.id, created_at: d.created_at })), "delegation",
    )
    const isStreaming = this.infra?.isSessionStreaming ?? isStreamActive
    const view = deriveCabinView({
      cabin: { id: row.id, status: row.status },
      tasks, executions,
      incidents: this.gatherIncidents(taskRows.map((t) => t.id), execToTask),
      asks: this.gatherAsks(row, executions, execToTask, sessionToTask),
      findings: this.listFindings(id, "open").map((f) => ({ id: f.id, title: f.title, status: f.status })),
      jobs: jobs.map((j) => ({
        id: j.id, kind: j.kind, ref_id: j.ref_id, title: j.title,
        agent_running: !!j.session_id && isStreaming(j.session_id),
      })),
      delegations: delegationRows.map((d) => {
        const h = delegationHandles.get(d.id)
        return {
          id: d.id, title: d.title, state: d.state,
          ...(d.result_summary ? { summary: d.result_summary } : {}),
          ...(h ? { handle: h.handle, color: h.color } : {}),
        }
      }),
      acked: [...this.ackedAttentionIds(id)],
      maxWorkers: MAX_PARALLEL_WORKSPACES,
    })
    return { cabin: row, view }
  }

  /** C4：waiting_human incidents（runtime_incidents 无 task_id，经 executions 反查）。 */
  private gatherIncidents(taskIds: string[], execToTask: Map<string, string>): DeriveCabinInput["incidents"] {
    const store = this.infra?.incidentStore
    if (!store || taskIds.length === 0) return []
    return store.listWaitingHumanByTasks(taskIds).map((r) => ({
      id: r.id, task_id: execToTask.get(r.executionId) ?? null, status: r.status, title: r.summary,
    }))
  }

  /** C4：两类 ask —— workflow pending_interaction 执行 + 舱会话里的 ask_user_question 卡。
   *
   *  并发纪律（2026-11-16）：编队里多个任务可能同时来问；attention 必须**逐条**
   *  列出，不能只取会话末条。判据：
   *   · 每条提问独立判断是否已答 —— 其后存在「用户回答了以下问题」用户消息，
   *     或该卡 metadata 已被 recordCardDecision 写上 activity.decision（就地作答
   *     卡走这条）；答掉一条不会顺带把别的会话 / 别的卡标成已答。
   *   · 会话集合 = 舱绑定会话 ∪ 舱任务的主线程会话（UI 直建任务可能没把
   *     cabin_id 写回会话，只靠 sessionToTask 会漏掉）。 */
  private gatherAsks(
    row: CabinRow,
    executions: DeriveCabinInput["executions"],
    execToTask: Map<string, string>,
    sessionToTask: Map<string, string>,
  ): DeriveCabinInput["asks"] {
    const infra = this.infra
    if (!infra) return []
    const asks: DeriveCabinInput["asks"] = []
    const taskRows = infra.taskDAO.findByCabinId(row.id)
    const taskName = new Map<string, string>()
    for (const t of taskRows) taskName.set(t.id, t.name)
    const db = this.cabin.getDb()
    for (const e of executions) {
      if (e.status !== "pending_interaction") continue
      const tid = execToTask.get(e.id) ?? null
      let question: string | undefined
      try {
        const msg = db.prepare(
          `SELECT metadata FROM interaction_messages
           WHERE execution_id = ? AND metadata LIKE '%ask_user_question%'
           ORDER BY created_at DESC LIMIT 1`,
        ).get(e.id) as { metadata: string | null } | undefined
        question = firstQuestionText(questionsFromMetadata(msg?.metadata))
      } catch { /* interaction_messages absent on old DBs */ }
      asks.push({
        id: e.id, task_id: tid,
        title: `${(tid && taskName.get(tid)) || "工作流"} · 待回答`, question,
      })
    }

    // 会话 → 标题 / 归属任务（舱绑定会话优先，任务主线程兜底补全）。
    // v5 建舱时舱名还没起，主会话标题会落成「undefined · 舱主对话」；
    // 展示层兜底去掉前缀，别再把这个占位词带进「等你答」。
    const sessions = new Map<string, { label: string; taskId: string | null }>()
    for (const s of infra.agentSessionDAO.listByCabinId(row.id)) {
      sessions.set(s.id, { label: sessionLabel(s.title), taskId: sessionToTask.get(s.id) ?? null })
    }
    for (const t of taskRows) {
      if (!t.source_chat_session_id || sessions.has(t.source_chat_session_id)) continue
      sessions.set(t.source_chat_session_id, { label: sessionLabel(t.name), taskId: t.id })
    }

    // 先把每个会话的消息各查一次；再做两遍扫描：
    //   ① 收集「已答」—— 决策账本（cockpit 作答的唯一权威）+ 镜像卡上的
    //      activity.decision + 回执 askReceiptFor；
    //   ② 逐条投卡 —— 同一 askId（舱主会话镜像卡 / 作者线程原卡）只投一次。
    // 2026-11-16 修复：以前只认「用户回答了以下问题」用户消息，在 cockpit 里
    // 按决策卡作答时作者线程没有这条消息，同一个任务答过的历史提问会一轮轮
    // 累积在「需要你」里。账本是跨会话的事实源，必须参与判定。
    const perSession = new Map<string, Array<{
      id: string; role: string; content: string; metadata: string | null; tool_calls: string | null
    }>>()
    for (const sessionId of sessions.keys()) {
      try {
        perSession.set(sessionId, db.prepare(
          `SELECT id, role, content, metadata, tool_calls FROM messages
           WHERE session_id = ? ORDER BY created_at ASC, rowid ASC`,
        ).all(sessionId) as Array<{
          id: string; role: string; content: string; metadata: string | null; tool_calls: string | null
        }>)
      } catch { /* messages table absent / weird row — skip this session */ }
    }

    const answered = this.answeredAskIds(row.id)
    // design 26 §4.1：同一 askId 的信封只留最全的一份（镜像卡 payload 优先，
    // 作者线程原卡兜底 questions）。信封随后挂到对应 attention 项上。
    const envelopes = new Map<string, CabinAskEnvelope>()
    const keepEnvelope = (env: CabinAskEnvelope | undefined) => {
      if (!env) return
      const prev = envelopes.get(env.ask_id)
      if (!prev || askEnvelopeScore(env) > askEnvelopeScore(prev)) envelopes.set(env.ask_id, env)
    }
    for (const rows of perSession.values()) {
      for (const r of rows) {
        const activity = parseMetadata(r.metadata)?.activity as Record<string, unknown> | null | undefined
        const payload = activity?.payload as AuthorAskPayload | undefined
        if (!payload) continue
        const askId = authorAskId(payload, r.id)
        if (payload.authorAsk && activity?.decision) answered.add(askId)
        if (typeof payload.askReceiptFor === "string") answered.add(payload.askReceiptFor)
        if (payload.authorAsk) {
          keepEnvelope(askEnvelopeFromPayload(
            payload, r.id, parseQuestions(payload.questions) ?? questionsFromMessage(r),
          ))
        }
      }
    }

    const seen = new Set<string>()
    for (const [sessionId, rows] of perSession) {
      const info = sessions.get(sessionId)!
      // 最后一条「用户回答了以下问题」的位置：只有它之后的提问才算未答。
      let lastAnswerIdx = -1
      let lastAssistantIdx = -1
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].role === "user" && rows[i].content.includes("用户回答了以下问题")) lastAnswerIdx = i
        if (rows[i].role === "assistant") lastAssistantIdx = i
      }
      for (let i = 0; i < rows.length; i++) {
        const questions = questionsFromMessage(rows[i])
        if (!questions) continue
        if (i < lastAnswerIdx) continue
        // 原生 AskUserQuestion 是 assistant 行；其后又出现了 assistant 消息，
        // 说明这一轮早已继续/放弃（例：舱初始化那张旧卡被自由文本回复后一直
        // 挂在「等你答」里）。mirror 卡是 user 行，不受此判据影响。
        if (rows[i].role === "assistant" && i < lastAssistantIdx) continue
        // 就地作答卡：选择写回 activity.decision 后即便同一条消息没有后续
        // 用户回复，也已经答过 —— 不能一直在「待回答」里挂着。
        const activity = parseMetadata(rows[i].metadata)?.activity as Record<string, unknown> | null | undefined
        if (activity && typeof activity === "object" && !Array.isArray(activity)
          && (activity as { decision?: unknown }).decision) continue
        const askId = authorAskId(activity?.payload as AuthorAskPayload | undefined, rows[i].id)
        if (answered.has(askId) || seen.has(askId)) continue
        seen.add(askId)
        // 没有镜像卡信封（作者线程原卡 / 旧数据）：给一份最小信封 ——
        // 至少让「等你答」窗能就地把问题体渲染出来；提交若 404 由窗内回退。
        const envelope = envelopes.get(askId) ?? {
          ask_id: askId,
          message_id: rows[i].id,
          ...(clipQuestions(questions) ? { questions: clipQuestions(questions) } : {}),
        }
        asks.push({
          id: askId, task_id: info.taskId,
          title: `${info.label} · 待回答`, question: firstQuestionText(questions),
          ask: envelope,
        })
      }
    }
    return asks
  }

  /** 完成回流 ack（2026-11-19 用户 #9）：只写 cabin_attention_acks，**不发消息、
   *  不唤醒任务/会话** —— 「确认不会回复了」就是把这条从待处理态收掉。
   *  幂等；未知 item_id 也照存（读侧只按 id 过滤 notice）。 */
  ackAttention(cabinId: string, itemId: string, actor: "person" | "orchestrator" = "person"): { acked: boolean } {
    this.mustGet(cabinId)
    const db = this.cabin.getDb()
    const result = db.prepare(
      "INSERT OR IGNORE INTO cabin_attention_acks (id, cabin_id, item_id, actor, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(randomUUID(), cabinId, itemId, actor, now())
    if (Number(result.changes ?? 0) > 0) {
      try { this.notifyViewChanged(cabinId) } catch { /* view hook optional */ }
    }
    return { acked: true }
  }

  /** 本舱已收项的 attention id（derive 读侧过滤用）。老库缺表时返回空集。 */
  private ackedAttentionIds(cabinId: string): Set<string> {
    const out = new Set<string>()
    try {
      const rows = this.cabin.getDb().prepare(
        "SELECT item_id FROM cabin_attention_acks WHERE cabin_id = ?",
      ).all(cabinId) as Array<{ item_id: string }>
      for (const r of rows) if (r.item_id) out.add(r.item_id)
    } catch { /* old DB — table added by applySchema on next start */ }
    return out
  }

  /** 人主动忽略一条提问（旧卡 / 不再需要回答的那条）。把 decision 写回原消息
   *  metadata（与就地作答同一处），派生的 attention 与决策队列随即不再列出。
   *  不转达、不写决策账本 —— 忽略没有「答案」可转达。
   *  工作流 pending_interaction 没有会话消息行，返回 dismissed: 0。 */
  dismissAsk(cabinId: string, askId: string): { dismissed: number } {
    const row = this.mustGet(cabinId)
    const infra = this.infra
    if (!infra) return { dismissed: 0 }
    const db = this.cabin.getDb()
    const sessionIds = new Set<string>()
    for (const s of infra.agentSessionDAO.listByCabinId(row.id)) sessionIds.add(s.id)
    for (const t of infra.taskDAO.findByCabinId(row.id)) {
      if (t.source_chat_session_id) sessionIds.add(t.source_chat_session_id)
    }
    const at = now()
    const update = db.prepare("UPDATE messages SET metadata = ? WHERE id = ?")
    let dismissed = 0
    for (const sessionId of sessionIds) {
      let rows: Array<{ id: string; metadata: string | null }> = []
      try {
        rows = db.prepare("SELECT id, metadata FROM messages WHERE session_id = ?")
          .all(sessionId) as typeof rows
      } catch { continue }
      for (const r of rows) {
        const meta = parseMetadata(r.metadata)
        const activity = meta?.activity as Record<string, unknown> | undefined
        const payload = activity?.payload as AuthorAskPayload | undefined
        if (authorAskId(payload, r.id) !== askId) continue
        if (activity?.decision) continue
        const next = {
          ...(meta ?? {}),
          activity: {
            ...(activity ?? {}),
            decision: { id: "dismissed", label: "已忽略", source: "dismiss", at },
          },
        }
        update.run(JSON.stringify(next), r.id)
        dismissed += 1
      }
    }
    if (dismissed > 0) {
      try { this.notifyViewChanged(cabinId) } catch { /* view hook optional */ }
    }
    return { dismissed }
  }

  /** 本舱决策账本里已经答过的 askId（cross-session 事实源）。 */
  private answeredAskIds(cabinId: string): Set<string> {
    const out = new Set<string>()
    try {
      const rows = this.cabin.getDb().prepare(
        "SELECT payload FROM cabin_job_events WHERE cabin_id = ? AND kind = 'decision'",
      ).all(cabinId) as Array<{ payload: string | null }>
      for (const r of rows) {
        const askId = parseMetadata(r.payload)?.askId
        if (typeof askId === "string" && askId) out.add(askId)
      }
    } catch { /* old DB — no ledger yet */ }
    return out
  }

  // ── knowledge (S7 / G4 read-time scoping) ──

  /** G4：舱 scoped findings —— 读时按 raw origin→task 锚点过滤，不改 schema。 */
  listFindings(cabinId: string, status?: "open" | "resolved" | "ignored"): FindingRow[] {
    const row = this.mustGet(cabinId)
    const ops = this.infra?.findingOps
    if (!ops) return []
    const repoNames = new Set(readCabinConfig(row.path).repos.map((r) => r.name).filter(Boolean))
    const taskDAO = this.infra?.taskDAO
    return scopeCabinFindings(ops.list(status), {
      root: ops.root, cabinId, cabinRepoNames: repoNames,
      taskById: (tid) => taskDAO?.getById(tid) ?? undefined,
    })
  }

  // ── repos (config.json.repos[] contract, decision #3) ──

  listRepos(id: string): CabinRepoEntry[] {
    const row = this.mustGet(id)
    return readCabinConfig(row.path).repos.map((r) => ({ ...r, source: repoSource(r) }))
  }

  /** 项目视图（wire 形态）：来源 / 路径 / 主线 / worktree；git 富化由 route 做。 */
  repoViews(id: string): CabinRepoView[] {
    const row = this.mustGet(id)
    return readCabinConfig(row.path).repos.map((entry) => {
      const { mainPath, external } = resolveCabinRepo(row.path, entry)
      return {
        key: projectKey(entry),
        name: entry.name,
        source: repoSource(entry),
        org: entry.org || entry.group || null,
        group: entry.group || null,
        repoName: entry.repoName || null,
        main_path: mainPath,
        local_path: entry.local_path ?? null,
        external: entry.external === true || (entry.source === "local" && external),
        mainline_branch: entry.mainline_branch ?? null,
        worktree_path: entry.worktree_path ?? null,
        branch: entry.branch ?? null,
        worktrees: entry.worktrees ?? [],
      }
    })
  }

  /** 绑定一个项目：ORG 只克隆 + 登记主线；本地/外部只校验 + 登记。
   *  **绝不预建 worktree**（worktree 是执行时产物）。 */
  addRepo(id: string, input: CabinProjectInput): CabinRepoEntry {
    const row = this.mustGet(id)
    const name = (input.name || input.repo || "").trim()
    if (!name) throw new CabinRepoInputError("项目名不能为空")

    if (input.source === "local") {
      const raw = input.absolutePath?.trim() || input.localPath?.trim()
      if (!raw) throw new CabinRepoInputError("本地项目需要 localPath 或 absolutePath")
      const abs = path.isAbsolute(raw) ? raw : path.resolve(row.path, raw)
      if (!fs.existsSync(abs) || !isGitRepo(abs)) throw new CabinRepoInputError(`不是 git 仓库：${abs}`)
      if (!isPathInside(row.path, abs) && !input.external) {
        throw new CabinRepoInputError("舱目录之外的仓库需要显式登记（external: true）")
      }
      return mergeCabinRepoEntry(row.path, localRepoEntry(row.path, { name, absPath: abs }))
    }

    const org = (input.org || row.org || "").trim()
    if (!org) throw new Error("cabin has no org — cannot clone repos")
    const res = ensureRepoCloned(org, name)
    if ("error" in res) throw new Error(res.error)
    const info = readLocalRepoInfo(res.localPath)
    return mergeCabinRepoEntry(row.path, orgRepoEntry({
      name, org, group: org, mainPath: res.localPath,
      mainline: info.branch ?? defaultMainlineBranch(res.localPath),
    }))
  }

  /** 解绑：只动 config，不动磁盘（worktree / 主仓都保留）。
   *  有活跃作业仍指向这个项目 → 409（不静默把作业变成「未归属」）。 */
  removeRepo(id: string, name: string): { removed: boolean } {
    const row = this.mustGet(id)
    const entry = readCabinConfig(row.path).repos.find((r) => r.name === name)
    if (!entry) return { removed: false }
    const live = LIVE_TASK_STATUSES
    const busy = this.infra?.taskDAO.findByCabinId(id).find((t) => {
      if (!live.has(t.status)) return false
      const ids = parseProjectIds(t.project_ids)
      return ids.includes(name) || ids.includes(entry.repoName ?? name)
    })
    if (busy) throw new Error(`项目上有活跃任务「${busy.name}」，先收尾再解绑`)
    return { removed: removeCabinRepoEntry(row.path, name) }
  }

  /** 显式开工作树（唯一会产生 worktree 的舱内入口；作业另有自己的路径）。
   *  主实例落 `projects/<name>`；重复开同分支 → 409（不覆盖）；
   *  换分支 → 并行实例 `projects/<instance>/<name>`，登记进 `worktrees[]`。 */
  openRepoWorktree(
    id: string, name: string, opts: { branch?: string; instance?: string } = {},
  ): CabinRepoEntry {
    const row = this.mustGet(id)
    const entry = readCabinConfig(row.path).repos.find((r) => r.name === name)
    if (!entry) throw new Error(`repo not in cabin: ${name}`)
    const { mainPath } = resolveCabinRepo(row.path, entry)
    if (!mainPath || !fs.existsSync(mainPath)) throw new Error(`主仓不可用：${mainPath ?? name}`)

    // 主线分支（如 main）通常已被主仓检出：worktree 必须落在自己的分支上。
    // 默认切一条舱分支；要特定分支就显式传，git 会拒绝「同一分支检出两次」。
    const branch = opts.branch?.trim() || `cabin-${row.id.slice(0, 8)}`

    if (entry.worktree_path && this.git.worktreeAlive(entry.worktree_path)) {
      if (entry.branch === branch) {
        throw new WorktreeConflictError(`worktree_exists: ${entry.name} 的 ${branch} 已有工作树`)
      }
      const instance = opts.instance?.trim() || `wt-${Date.now().toString(36)}`
      const wtPath = worktreeDirFor(row.path, entry.name, instance)
      const fresh = this.git.initWorktreeOne(
        row.path,
        { name: entry.name, source_path: mainPath, group: entry.group },
        branch, row.org ?? "", { clobber: false, worktreePath: wtPath },
      )
      const next = mergeCabinRepoEntry(row.path, {
        ...entry,
        worktrees: [
          ...(entry.worktrees ?? []),
          { path: fresh.worktree_path, branch, instance, created_at: now() },
        ],
      })
      return next
    }

    const wtPath = opts.instance?.trim()
      ? worktreeDirFor(row.path, entry.name, opts.instance)
      : worktreeDirFor(row.path, entry.name)
    if (!isPathInside(row.path, path.dirname(wtPath))) {
      throw new CabinRepoInputError(`工作树路径越界：${wtPath}`)
    }
    const fresh = this.git.initWorktreeOne(
      row.path,
      { name: entry.name, source_path: mainPath, group: entry.group },
      branch, row.org ?? "", { clobber: false, worktreePath: wtPath },
    )
    return mergeCabinRepoEntry(row.path, {
      ...entry,
      worktree_path: fresh.worktree_path,
      branch: fresh.branch,
    })
  }

  // ── dispatch ledger (C2/C6/C8) ──
  listJobs(cabinId: string): CabinJobRow[] { return this.cabin.listJobs(cabinId) }
  getJob(id: string): CabinJobRow | undefined { return this.cabin.findJob(id) }
  dispatchJob(cabinId: string, input: {
    kind: CabinJobKind; ref_id?: string | null; session_id?: string | null
    title: string; mandate?: unknown; prompt?: string | null
  }): CabinJobRow {
    this.mustGet(cabinId)
    const row: CabinJobRow = {
      id: randomUUID(), cabin_id: cabinId, kind: input.kind,
      ref_id: input.ref_id ?? null, session_id: input.session_id ?? null,
      title: input.title,
      mandate: input.mandate ? JSON.stringify(input.mandate) : null,
      prompt: input.prompt ?? null,
      created_at: now(), ended_at: null,
    }
    this.cabin.insertJob(row)
    this.appendEvent(row.id, cabinId, "dispatch", "orchestrator", { title: row.title, mandate: input.mandate ?? null })
    return row
  }

  /** C2 agent 可知：舱内任务清单（派生状态，单写者=任务行）。 */
  listTasksView(cabinId: string): Array<{
    id: string; name: string; status: string
    workspace_id: string | null; session_id: string | null
  }> {
    this.mustGet(cabinId)
    if (!this.infra) return []
    return this.infra.taskDAO.findByCabinId(cabinId).map((t) => {
      const execs = this.infra!.executionDAO.listTaskInstances(t.id, 200)
      const acceptances = this.infra!.acceptanceDAO.listByTask(t.id)
      return {
        id: t.id, name: t.name,
        status: deriveTaskView(t, execs, acceptances).taskStatus,
        workspace_id: t.workspace_id ?? null,
        session_id: t.source_chat_session_id ?? null,
      }
    })
  }

  /** 文档查看器（2026-11-19 用户 #4）：本舱可读文档根。
   *  = 舱目录 + 本舱任务 workspace（产物写在 workspace 与它的 `.task` 里）。
   *  UI 只把聊天里出现的绝对路径交给 /doc；根外一律 403，不做任意路径读取。 */
  docRoots(cabinId: string): string[] {
    const row = this.mustGet(cabinId)
    const roots: string[] = []
    if (row.path) roots.push(path.resolve(row.path))
    if (this.infra) {
      for (const t of this.infra.taskDAO.findByCabinId(cabinId)) {
        const wsPath = t.workspace_id ? this.infra.workspaceDAO.findPathById(t.workspace_id) : null
        if (wsPath) roots.push(path.resolve(wsPath.replace(/^~/, os.homedir())))
      }
    }
    return [...new Set(roots)]
  }

  /** C2/K3：作业 status 派生自底层实体（task→deriveTaskView / execution /
   *  subagent_runs），不镜像存储。transport = 传输层通道（D6）。
   *
   *  `agent_running` 也是派生态（不落库）：cabin_jobs.session_id 指向任务主线程，
   *  主线程正在流式 = 作者 agent 在推进（典型场景：人刚答完决策，watchdog /
   *  汐音把答案转达给作者，作者在任务线程里干活，而任务生命周期仍是 ready）。
   *  编队拿它把「待执行」换成「作者在推进」，避免看起来没人在跑。 */
  listJobsView(cabinId: string): Array<CabinJobRow & {
    status: string; transport: string; project_keys: string[]; agent_running: boolean
  }> {
    const cabinRow = this.mustGet(cabinId)
    const db = this.cabin.getDb()
    const projects = readCabinConfig(cabinRow.path).repos
    const isStreaming = this.infra?.isSessionStreaming ?? isStreamActive
    return this.cabin.listJobs(cabinId).map((j) => {
      let status = "unknown"
      let project_keys: string[] = []
      if (j.kind === "task" && j.ref_id && this.infra) {
        const t = this.infra.taskDAO.getById(j.ref_id)
        if (t) {
          const execs = this.infra.executionDAO.listTaskInstances(t.id, 200)
          const acceptances = this.infra.acceptanceDAO.listByTask(t.id)
          status = deriveTaskView(t, execs, acceptances).taskStatus
          project_keys = this.anchorsOfTask(t.repo_group, t.project_ids, projects)
        }
      } else if (j.kind === "workflow" && j.ref_id) {
        const row = db.prepare("SELECT status FROM executions WHERE id = ?").get(j.ref_id) as { status?: string } | undefined
        status = row?.status ?? "unknown"
        project_keys = this.anchorsOfWorkflow(j.ref_id, projects)
      } else if (j.kind === "subagent" && j.ref_id) {
        // 子代理自己的 cwd 优先；没记就回落到所属会话的 cwd（同一工作现场）。
        const row = db.prepare(
          `SELECT r.status, COALESCE(NULLIF(r.cwd, ''), s.cwd) AS cwd
             FROM subagent_runs r LEFT JOIN sessions s ON s.id = r.session_id
            WHERE r.id = ?`,
        ).get(j.ref_id) as { status?: string; cwd?: string | null } | undefined
        status = row?.status ?? "unknown"
        project_keys = this.anchorsOfCwd(row?.cwd ?? null, projects)
      }
      const transport = j.kind === "task" ? "task-thread" : j.kind === "workflow" ? "workflow-engine" : "sdk-agent"
      const agent_running = !!j.session_id && isStreaming(j.session_id)
      return { ...j, status, transport, project_keys, agent_running }
    })
  }

  /**
   * design 25 §4.2 读侧归一化：把 task 与 delegation 映射成同一种 WorkRow。
   * 编队 / attention / reminder 都只读这一处 —— 写侧保持独立，读侧只有一个入口。
   * `#1` 是立项的任务，`D1` 是跑一趟的委派。
   */
  listWorkView(cabinId: string): CabinWorkRow[] {
    this.mustGet(cabinId)
    const jobs = this.listJobsView(cabinId).filter((j) => j.kind === "task" && j.ref_id)
    const taskHandles = assignHandles(
      jobs.map((j) => ({ id: j.ref_id as string, created_at: j.created_at })), "task",
    )
    const delegations = this.infra?.cabinDelegationDAO?.listByCabin(cabinId) ?? []
    const delegationHandles = assignHandles(
      delegations.map((d) => ({ id: d.id, created_at: d.created_at })), "delegation",
    )
    return [
      ...jobs.map((j) => {
        const h = taskHandles.get(j.ref_id as string)
        return {
          id: j.ref_id as string, kind: "task" as const,
          handle: h?.handle ?? "#?", color: h?.color ?? 0,
          title: j.title, status: j.status,
          session_id: j.session_id, job_id: j.id,
        } satisfies CabinWorkRow
      }),
      ...delegations.map((d) => {
        const h = delegationHandles.get(d.id)
        return {
          id: d.id, kind: "delegation" as const,
          handle: h?.handle ?? "D?", color: h?.color ?? 0,
          title: d.title, status: d.state,
          session_id: d.doer_session_id, job_id: d.id,
        } satisfies CabinWorkRow
      }),
    ]
  }

  // ── 作业 → 项目锚点（不加列；拿不到就是 []，不猜）────────────────
  /** task：repo_group + project_ids 与舱项目求交；命中多个全返回。 */
  private anchorsOfTask(
    repoGroup: string | null, projectIds: string, projects: CabinRepoEntry[],
  ): string[] {
    const wanted = new Set(parseProjectIds(projectIds))
    if (repoGroup) wanted.add(repoGroup)
    if (wanted.size === 0) return []
    const keys: string[] = []
    for (const entry of projects) {
      const names = [entry.name, entry.repoName].filter(Boolean) as string[]
      if (names.some((n) => wanted.has(n))) keys.push(projectKey(entry))
    }
    return keys
  }

  /** workflow：execution → workspace.config.repos；恰好一个项目才归属。 */
  private anchorsOfWorkflow(executionId: string, projects: CabinRepoEntry[]): string[] {
    const db = this.cabin.getDb()
    const exec = db.prepare("SELECT workspace_id FROM executions WHERE id = ?").get(executionId) as
      { workspace_id?: string } | undefined
    if (!exec?.workspace_id) return []
    const ws = db.prepare("SELECT path FROM workspaces WHERE id = ?").get(exec.workspace_id) as
      { path?: string } | undefined
    if (!ws?.path) return []
    // workspace 的项目登记在磁盘 config.json（表里没有 config 列）。
    let names: string[] = []
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(ws.path, "config.json"), "utf-8")) as
        { repos?: Array<{ name?: string }> }
      names = (raw.repos ?? []).map((r) => r.name ?? "").filter(Boolean)
    } catch {
      return []
    }
    const keys = projects
      .filter((entry) => names.includes(entry.name) || names.includes(entry.repoName ?? ""))
      .map(projectKey)
    return keys.length === 1 ? keys : []
  }

  /** subagent：cwd 与项目主仓的最长前缀；唯一命中才归属。 */
  private anchorsOfCwd(cwd: string | null, projects: CabinRepoEntry[]): string[] {
    if (!cwd) return []
    // cwd 可能是已删除的目录：对不存在的路径沿父链 realpath（/var → /private/var）。
    const real = (p: string): string => {
      try {
        return fs.realpathSync.native(p)
      } catch {
        const parent = path.dirname(p)
        return parent === p ? path.resolve(p) : path.join(real(parent), path.basename(p))
      }
    }
    const target = real(cwd)
    let best: { key: string; len: number } | null = null
    let tie = false
    for (const entry of projects) {
      if (!entry.main_path) continue
      const base = real(entry.main_path)
      const pref = base.endsWith(path.sep) ? base : base + path.sep
      if (target !== base && !target.startsWith(pref)) continue
      const len = base.length
      if (!best || len > best.len) { best = { key: projectKey(entry), len }; tie = false }
      else if (len === best.len) tie = true
    }
    if (!best || tie) return []
    return [best.key]
  }

  /** S5 拉取主线：clean-main → syncToDefaultBranch（镜像，主仓永远干净在默认分支），
   *  pin → fetch + merge --ff-only（只快进，分叉直接报，不动主仓历史）。 */
  async pullRepo(cabinId: string, name: string): Promise<{ branch: string; commit: string }> {
    const row = this.mustGet(cabinId)
    const entry = readCabinConfig(row.path).repos.find((r) => r.name === name)
    if (!entry) throw new Error(`repo not in cabin: ${name}`)
    const { mainPath } = resolveCabinRepo(row.path, entry)
    if (!mainPath) throw new Error(`repo 没有主仓路径：${name}`)
    if (row.mainline_strategy === "clean-main") {
      return gitOps.syncToDefaultBranch(mainPath)
    }
    return gitOps.pullFastForward(entry.worktree_path ?? mainPath)
  }

  /** P3 变更窗：任务总账跨仓聚合（round-diff scope=task，现有服务零改动）。 */
  async changesSummary(cabinId: string): Promise<{
    totals: { commits: number; additions: number; dels: number; files: number }
    repos: Array<{ name: string; tasks: number; commits: number }>
    tasks: Array<{ id: string; name: string; status: string; commits: number; additions: number; dels: number; files: number; available: boolean }>
  }> {
    this.mustGet(cabinId)
    const rows = this.infra ? this.infra.taskDAO.findByCabinId(cabinId) : []
    const evidence = this.infra?.roundEvidence
    const tasks: Array<{ id: string; name: string; status: string; commits: number; additions: number; dels: number; files: number; available: boolean }> = []
    const perRepo = new Map<string, { tasks: number; commits: number }>()
    const totals = { commits: 0, additions: 0, dels: 0, files: 0 }
    for (const t of rows) {
      let payload: { available: boolean; aggregate: { commits: number; additions: number; dels: number; files: number }; repos: Array<{ name: string; commits: number }> } | null = null
      if (evidence) {
        try {
          payload = await evidence.getRoundDiff(t.id, "task")
        } catch {
          payload = null
        }
      }
      const agg = payload?.available ? payload.aggregate : { commits: 0, additions: 0, dels: 0, files: 0 }
      tasks.push({ id: t.id, name: t.name, status: t.status, ...agg, available: !!payload?.available })
      totals.commits += agg.commits
      totals.additions += agg.additions
      totals.dels += agg.dels
      totals.files += agg.files
      for (const r of payload?.available ? payload.repos : []) {
        const cur = perRepo.get(r.name) ?? { tasks: 0, commits: 0 }
        cur.tasks += 1
        cur.commits += r.commits
        perRepo.set(r.name, cur)
      }
    }
    return {
      totals,
      repos: [...perRepo.entries()].map(([name, v]) => ({ name, ...v })),
      tasks,
    }
  }

  /**
   * v22 十三轮（问题 #1）：本舱变更窗 —— 本舱 cwd 的工作区改动。
   *
   * 口径 = 舱目录（`cabin.path`）**本身**这一个 git 仓库的 `git diff HEAD`
   * （已提交 + 未提交净额）+ 未跟踪新文件（状态记 "?"，.gitignore 已排除）。
   * 不再扫 `config.json.repos` 下登记的项目：变更只关注 cwd 自己。
   * 出现条件 = cwd 本身是一个独立 git 仓库（`.git` 在 cwd），由 route 用同一个
   * `isGitRepo` 判给前端决定右栏按钮是否渲染。
   *
   * 只读：不提交、不暂存、不写任何文件。cwd 不是 git 仓 / 空仓 → error / head=null。
   */
  async worktreeChanges(cabinId: string): Promise<CabinWorktreeChanges> {
    const row = this.mustGet(cabinId)
    const root = path.resolve(row.path)
    const view: CabinWorktreeChangeRepo = {
      name: path.basename(root) || root, dir: root, branch: null, head: null,
      error: null, truncated: false, files: [],
    }
    try {
      if (!fs.existsSync(root)) throw new Error("工作区不存在")
      if (!isGitRepo(root)) throw new Error("不是 git 仓库")
      // 分支 / HEAD 是 best-effort：空仓（还没有提交）两者都会失败，但仍要列未跟踪文件。
      try {
        const info = await gitOps.getBranchInfo(root)
        view.branch = info.detached ? "detached" : info.branch
      } catch {
        view.branch = null
      }
      let head: string | null = null
      try {
        head = (await gitOps.getHeadCommit(root)).slice(0, 7)
      } catch {
        head = null // 空仓：还没有提交，下面只列未跟踪文件
      }
      view.head = head
      if (head) {
        const stat = await gitOps.diffStatWorktree(root, "HEAD", WORKTREE_CHANGE_FILE_CAP)
        view.files.push(...stat.files)
        view.truncated = stat.truncated
      }
      // 未跟踪文件不在 `git diff` 里 —— 单独列出（读不到不等于没改动，best-effort）。
      let untracked: string[] = []
      try {
        untracked = await gitOps.listUntracked(root)
      } catch {
        untracked = []
      }
      for (const p of untracked) {
        if (view.files.length >= WORKTREE_CHANGE_FILE_CAP) { view.truncated = true; break }
        const st = await gitOps.statUntracked(root, p)
        view.files.push({ ...st, status: "?", untracked: true })
      }
    } catch (err) {
      view.error = errMsg(err)
    }
    return { dir: root, repos: [view] }
  }

  /** 本舱变更窗：单文件 unified patch（点开才拉）。untracked=true 走 /dev/null 一侧。 */
  async worktreeChangePatch(
    cabinId: string,
    repoName: string,
    relPath: string,
    untracked: boolean,
  ): Promise<{ patch: string; truncated: boolean }> {
    const row = this.mustGet(cabinId)
    const resolvedRoot = path.resolve(row.path)
    const name = path.basename(resolvedRoot) || resolvedRoot
    if (repoName !== name) throw new CabinNotFoundError(`repo not in cabin: ${repoName}`)
    if (!isGitRepo(resolvedRoot)) throw new Error("不是 git 仓库")
    if (!relPath || relPath.includes("\0") || path.isAbsolute(relPath)) {
      throw new CabinRepoInputError(`非法文件路径: ${relPath}`)
    }
    const abs = path.resolve(resolvedRoot, relPath)
    if (abs !== resolvedRoot && !abs.startsWith(resolvedRoot + path.sep)) {
      throw new CabinRepoInputError(`路径越出仓库根: ${relPath}`)
    }
    if (untracked) return gitOps.diffPatchForUntracked(resolvedRoot, relPath)
    return gitOps.diffPatchForWorktree(resolvedRoot, "HEAD", relPath)
  }
  appendEvent(jobId: string, cabinId: string, kind: CabinJobEventKind, actor: string, payload: unknown): CabinJobEventRow {
    const row: CabinJobEventRow = {
      id: randomUUID(), job_id: jobId, cabin_id: cabinId, kind, actor,
      payload: JSON.stringify(payload ?? {}), created_at: now(),
    }
    this.cabin.appendEvent(row)
    return row
  }
  listEvents(jobId: string): CabinJobEventRow[] { return this.cabin.listEvents(jobId) }
  listTrace(cabinId: string): CabinJobEventRow[] { return this.cabin.listEventsByCabin(cabinId) }

  // ── usage (C7：舱级完整消耗，llm_calls_costed 派生 + 子代理单列防双算) ──

  usage(cabinId: string): CabinUsageDTO {
    const row = this.mustGet(cabinId)
    const infra = this.infra
    const tokenUsage = infra?.tokenUsageDAO
    const emptyResult: CabinUsageDTO = {
      summary: { ...EMPTY_USAGE, modelBreakdown: {} },
      byJob: [], subagents: { count: 0, usage: emptyTokenUsage(), tokens: 0, cost: { usd: null, complete: false }, runs: [] },
      grand: EMPTY_USAGE, timing: { duration_ms: 0 },
    }
    if (!infra || !tokenUsage) return emptyResult

    const tasks = infra.taskDAO.findByCabinId(cabinId)
    const jobs = this.cabin.listJobs(cabinId)
    const projects = readCabinConfig(row.path).repos
    const jobByTask = new Map(jobs.filter((j) => j.kind === "task" && j.ref_id).map((j) => [j.ref_id as string, j]))
    const jobBySubagent = new Map(jobs.filter((j) => j.kind === "subagent" && j.ref_id).map((j) => [j.ref_id as string, j]))

    const byJob: CabinUsageJob[] = []
    const llmParts: LlmUsageSummary[] = []
    const chatSessionIds = new Set<string>()
    const execIds = new Set<string>()
    let durationMs = 0

    // orchestrator 主对话（chat 口径：execution_id IS NULL，防与执行双算）
    if (row.main_session_id) {
      chatSessionIds.add(row.main_session_id)
      const chat = tokenUsage.aggregateLlmCallsBy("session_id", [row.main_session_id], ["l.execution_id IS NULL"]).get(row.main_session_id)
      byJob.push({
        job_id: null, kind: "chat", label: "orchestrator 主对话", ref_id: row.main_session_id,
        project_keys: [], ...(chat ?? EMPTY_USAGE),
      })
      if (chat) llmParts.push(chat)
    }

    // 舱任务：复用 TasksService.taskUsage（chat guard + rounds + aux 已内置）
    for (const t of tasks) {
      let summary: LlmUsageSummary = EMPTY_USAGE
      if (infra.tasksService) {
        try {
          const usage = infra.tasksService.taskUsage(t.id)
          summary = usage.summary
          durationMs += usage.timing?.duration_ms ?? 0
        } catch { /* task deleted mid-read */ }
      }
      byJob.push({
        job_id: jobByTask.get(t.id)?.id ?? null, kind: "task", label: t.name, ref_id: t.id,
        project_keys: this.anchorsOfTask(t.repo_group, t.project_ids, projects),
        totalCalls: summary.totalCalls, usage: summary.usage, totals: summary.totals,
      })
      llmParts.push(summary)
      if (t.source_chat_session_id) chatSessionIds.add(t.source_chat_session_id)
      if (t.doer_session_id) chatSessionIds.add(t.doer_session_id)
      if (infra.execLinks) {
        for (const e of infra.execLinks.listTaskUsageExecutions(t.id)) execIds.add(e.id)
      }
    }

    // workflow 作业：execution 口径
    for (const j of jobs) {
      if (j.kind !== "workflow" || !j.ref_id) continue
      execIds.add(j.ref_id)
      const s = tokenUsage.aggregateLlmCallsBy("execution_id", [j.ref_id]).get(j.ref_id)
      byJob.push({
        job_id: j.id, kind: "workflow", label: j.title, ref_id: j.ref_id,
        project_keys: this.anchorsOfWorkflow(j.ref_id, projects), ...(s ?? EMPTY_USAGE),
      })
      if (s) llmParts.push(s)
    }

    // 子代理单列：subagent_runs（舱会话派生的 + 作业引用的），token 不走 llm_calls
    const db = this.cabin.getDb()
    const sessionIds = infra.agentSessionDAO.listByCabinId(cabinId).map((s) => s.id)
    if (row.main_session_id && !sessionIds.includes(row.main_session_id)) sessionIds.push(row.main_session_id)
    const subRows: SubagentRunLite[] = []
    const seen = new Set<string>()
    if (sessionIds.length > 0) {
      const ph = sessionIds.map(() => "?").join(",")
      for (const r of db.prepare(`SELECT * FROM subagent_runs WHERE session_id IN (${ph})`).all(...sessionIds) as SubagentRunLite[]) {
        if (!seen.has(r.id)) { seen.add(r.id); subRows.push(r) }
      }
    }
    for (const j of jobs) {
      if (j.kind !== "subagent" || !j.ref_id || seen.has(j.ref_id)) continue
      const r = db.prepare("SELECT * FROM subagent_runs WHERE id = ?").get(j.ref_id) as SubagentRunLite | undefined
      if (r) { seen.add(r.id); subRows.push(r) }
    }
    const subUsage = emptyTokenUsage()
    let subCostUsd: number | null = null
    let subPriced = 0
    const runs: CabinUsageSubagent[] = []
    for (const r of subRows) {
      const usage: TokenUsage = {
        inputTokens: r.input_tokens, outputTokens: r.output_tokens,
        cacheReadTokens: r.cache_read_tokens, cacheCreationTokens: r.cache_creation_tokens,
      }
      subUsage.inputTokens += usage.inputTokens
      subUsage.outputTokens += usage.outputTokens
      subUsage.cacheReadTokens += usage.cacheReadTokens
      subUsage.cacheCreationTokens += usage.cacheCreationTokens
      const cost = this.deriveSubagentCost(db, r)
      // cost.usd 已判空 → 只累计「已定价」子代理行（subPriced 是分母）。
      if (cost.usd != null) { subCostUsd = (subCostUsd ?? 0) + cost.usd; subPriced += 1 } // ledger-ok: 见上一行判空
      runs.push({
        id: r.id, job_id: jobBySubagent.get(r.id)?.id ?? null,
        label: r.description || r.agent_type || "子代理", status: r.status,
        usage, tokens: totalTokens(usage), cost,
      })
    }
    const subTokens = totalTokens(subUsage)
    const subCost: LedgerCost = { usd: subCostUsd, complete: subRows.length > 0 && subPriced === subRows.length }

    const summary = mergeLlmUsageSummaries(llmParts) ?? EMPTY_USAGE
    const modelBreakdown = tokenUsage.aggregateLlmCallsByModel([...chatSessionIds], [...execIds])
    const grandParts: LlmUsageSummary[] = [...llmParts]
    if (subRows.length > 0) {
      grandParts.push({ totalCalls: subRows.length, usage: subUsage, totals: { tokens: subTokens, cost: subCost, cacheHitRate: null } })
    }
    return {
      summary: { ...summary, modelBreakdown },
      byJob,
      subagents: { count: subRows.length, usage: subUsage, tokens: subTokens, cost: subCost, runs },
      grand: mergeLlmUsageSummaries(grandParts) ?? EMPTY_USAGE,
      timing: { duration_ms: durationMs },
    }
  }

  /** 与 SubagentRunService.deriveCost 同公式（price-sql 试算，读时派生不落库）。 */
  private deriveSubagentCost(db: ReturnType<CabinDAO["getDb"]>, r: SubagentRunLite): LedgerCost {
    const total = r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_creation_tokens
    if (total <= 0 || !r.model) return { usd: null, complete: false }
    try {
      const ts = Date.parse(r.ended_at ?? r.started_at ?? "")
      const priced = db.prepare(pricePreviewSql()).get({
        model: r.model,
        timestamp: Number.isFinite(ts) ? ts : Date.now(),
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        cacheCreationTokens: r.cache_creation_tokens,
        cacheReadTokens: r.cache_read_tokens,
      }) as { cost_usd: number | null } | undefined
      const usd = priced?.cost_usd ?? null
      return { usd, complete: usd != null }
    } catch {
      return { usd: null, complete: false }
    }
  }
}

/** subagent_runs 读面最小形（usage 聚合用，不拖 SubagentRunDAO 依赖）。 */
interface SubagentRunLite {
  id: string
  session_id: string
  agent_type: string | null
  description: string | null
  status: string
  model: string | null
  started_at: string | null
  ended_at: string | null
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
}