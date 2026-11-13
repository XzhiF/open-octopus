import { randomUUID } from "crypto"
import fs from "fs"
import path from "path"
import {
  mergeLlmUsageSummaries, emptyTokenUsage, totalTokens,
  type CabinInitState, type LlmUsageSummary, type ModelUsageBreakdown, type TokenUsage, type LedgerCost,
} from "@octopus/shared"
import type { CabinDAO } from "../../db/dao/cabin-dao"
import type {
  WorkspaceDAO, AgentSessionDAO, TaskDAO, ExecutionDAO, AcceptanceDAO,
} from "../../db/dao"
import { SessionCacheContextDAO } from "../../db/dao"
import type { TokenUsageDAO } from "../../db/dao/token-usage-dao"
import type { ExecutionLinkDAO } from "../../db/dao/execution-link-dao"
import type { FindingRow } from "../../db/dao/findings-dao"
import { pricePreviewSql } from "../../db/price-sql"
import type {
  CabinRow, CabinIterationRow, CabinJobRow, CabinJobEventRow, CabinStatus, CabinJobKind, CabinJobEventKind,
} from "../../db/types"
import type { WorkspaceService } from "../workspace"
import type { TasksService } from "../tasks/tasks-service"
import type { RepoSyncService } from "../tasks/repo-sync-service"
import { getSessionService } from "../agent/session-service"
import { gitOps } from "../git-ops"
import { WorkspaceGit, type SpecWorktreeEntry } from "../workspace-git"
import { deriveTaskView } from "../tasks/derive-task-view"
import type { RoundEvidenceService } from "../tasks/round-evidence-service"
import type { IncidentStore } from "../supervision/incident-store"
import type { FindingOpsService } from "../knowledge/findings"
import { MAX_PARALLEL_WORKSPACES } from "../scheduler/concurrency"
import { deriveCabinView, type DerivedCabinView, type DeriveCabinInput } from "./derive-cabin-view"
import type { CabinInitService } from "./cabin-init-service"
import { isInitComplete } from "./cabin-init-service"
import { ensureRepoCloned, readCabinConfig, writeCabinConfigRepos, type CabinRepoEntry } from "./cabin-repos"
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

const now = () => new Date().toISOString()
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err))

function parseMetadata(metadata: string | null | undefined): Record<string, unknown> | null {
  if (!metadata) return null
  try { return JSON.parse(metadata) as Record<string, unknown> } catch { return null }
}

function askDisplayType(metadata: string | null | undefined): boolean {
  return parseMetadata(metadata)?.displayType === "ask_user_question"
}

function firstAskQuestion(metadata: string | null | undefined): string | undefined {
  const questions = parseMetadata(metadata)?.questions
  if (!Array.isArray(questions)) return undefined
  const q = questions[0] as { question?: unknown } | undefined
  return typeof q?.question === "string" ? q.question : undefined
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
}

/** ASCII workspace slug — WorkspaceService.create forbids non-ASCII names;
 *  the Chinese display name stays on cabins.name (plan conflict 6e). */
function workspaceSlug(cabinPath: string, id: string): string {
  const base = path.basename(cabinPath).replace(/[^a-zA-Z0-9_-]/g, "-") || "cabin"
  return `cabin-${base}-${id.slice(0, 6)}`
}

/**
 * CabinService — directory-bound long-lived cockpit.
 * Identity + lifecycle (soft archive / reopen / dormant) + G1 cascade delete
 * + iterations + dispatch ledger. Composes the existing workspace/session/task
 * infrastructure; init orchestration lives in CabinInitService.
 */
export class CabinService {
  private infra: CabinInfra | null = null
  private git = new WorkspaceGit()
  private archiveHook: ((cabinId: string) => Promise<void>) | null = null

  constructor(private cabin: CabinDAO) {}

  bindInfra(infra: CabinInfra): void { this.infra = infra }
  /** P5 wires cabin-level sediment (G3) here; archive stays soft until then. */
  setArchiveHook(hook: (cabinId: string) => Promise<void>): void { this.archiveHook = hook }

  private mustGet(id: string): CabinRow {
    const row = this.cabin.findById(id)
    if (!row) throw new CabinNotFoundError(id)
    return row
  }

  create(input: { name: string; path: string; requirements?: string; org?: string | null; repos?: string[] }): CabinRow {
    const existing = this.cabin.findByPath(input.path)
    if (existing) return existing
    const id = randomUUID()
    const ts = now()
    const row: CabinRow = {
      id, name: input.name, path: input.path,
      workspace_id: null, main_session_id: null,
      requirements: input.requirements ?? "",
      status: "draft", mainline_strategy: "clean-main",
      org: input.org ?? null, init_state: null, cockpit_prefs: null,
      focused_job_id: null, version: 1,
      created_at: ts, updated_at: ts, last_active_at: ts, archived_at: null,
    }
    this.cabin.insert(row)
    if (this.infra) {
      // Scaffold WITHOUT repos: clones land in init gate 3, worktrees in gate 4.
      const ws = this.infra.workspaceService.create({
        name: workspaceSlug(input.path, id),
        path: input.path,
        repos: [],
        repo_group: input.org ?? null,
        description: `作战舱：${input.name}`,
      })
      this.infra.workspaceDAO.update(ws.id, { cabin_id: id })
      this.cabin.bindWorkspace(id, ws.id, now())
      if (input.repos && input.repos.length > 0) {
        writeCabinConfigRepos(input.path, input.repos.map((n) => ({ group: "", name: n, repoName: n })))
      }
      const session = getSessionService().createSession({ cwd: input.path, workspace_id: ws.id })
      this.infra.agentSessionDAO.updateSession(session.id, {
        cabin_id: id, title: `${input.name} · 舱主对话`,
      })
      new SessionCacheContextDAO(this.infra.agentSessionDAO.getDb())
        .setActiveExpert(session.id, "cabin-orchestrator", "clone")
      this.cabin.bindSession(id, session.id, now())
    }
    return this.mustGet(id)
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
        if (m.id && m.name && !this.cabin.findById(m.id)) {
          const ts = now()
          let requirements = ""
          try { requirements = fs.readFileSync(path.join(cabinPath, ".cabin", "requirements.md"), "utf-8") } catch { /* optional */ }
          let status: CabinStatus = "draft"
          try {
            const st = JSON.parse(fs.readFileSync(path.join(cabinPath, ".cabin", "init-state.json"), "utf-8")) as CabinInitState
            if (Array.isArray(st.items) && isInitComplete(st)) status = "active"
          } catch { /* no gate snapshot → draft */ }
          this.cabin.insert({
            id: m.id, name: m.name, path: cabinPath,
            workspace_id: null, main_session_id: null,
            requirements, status, mainline_strategy: "clean-main",
            org: m.org ?? null, init_state: null, cockpit_prefs: null,
            focused_job_id: null, version: 1,
            created_at: m.createdAt ?? ts, updated_at: ts, last_active_at: ts, archived_at: null,
          })
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
    this.cabin.updateStatus(id, to, now())
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

  /** dormant -> active: worktree self-heal + fire-and-forget mainline refresh. */
  wake(id: string): CabinRow {
    const row = this.transition(id, ["dormant"], "active")
    this.cabin.updateFields(id, row.version, { last_active_at: now() }, now())
    this.selfHeal(id)
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
    this.cabin.updateStatus(id, "dormant", now())
    return this.mustGet(id)
  }

  /** C11 auto threshold sweep: idle active cabins (no running / no person
   *  attention, idle >= per-cabin threshold) -> dormant. threshold<=0 disables.
   *  Returns the ids dormited this pass for the job outcome. */
  sweepDormant(nowMs: number, defaultThresholdMs: number): string[] {
    const dormited: string[] = []
    for (const row of this.cabin.list("active")) {
      const threshold = this.dormantThresholdMs(row, defaultThresholdMs)
      if (threshold <= 0) continue
      const last = row.last_active_at ? Date.parse(row.last_active_at) : 0
      if (!last || nowMs - last < threshold) continue
      const { view } = this.getView(row.id)
      if (view.health.running > 0) continue
      if (view.attention.some((a) => a.awaiting === "person")) continue
      this.cabin.updateStatus(row.id, "dormant", now())
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

  /** G1 destructive cascade (delete only; archive NEVER cascades). Running
   *  tasks must be aborted first — same guard as TasksService.deleteTask. */
  delete(id: string): void {
    const row = this.mustGet(id)
    const infra = this.infra
    const tasks = infra ? infra.taskDAO.findByCabinId(id) : []
    if (tasks.some((t) => t.status === "running")) {
      throw new CabinStatusConflictError(id, "running-tasks", "delete")
    }
    this.cabin.transaction(() => {
      this.cabin.deleteEventsByCabin(id)
      this.cabin.deleteJobsByCabin(id)
      this.cabin.deleteIterationsByCabin(id)
      if (infra) {
        if (row.workspace_id) {
          for (const e of infra.executionDAO.listByWorkspace(row.workspace_id)) infra.executionDAO.deleteById(e.id)
        }
        for (const t of tasks) {
          for (const e of infra.executionDAO.listTaskInstances(t.id, 1000)) infra.executionDAO.deleteById(e.id)
        }
        for (const t of tasks) {
          if (infra.tasksService) infra.tasksService.deleteTask(t.id)
          else infra.taskDAO.softDelete(t.id)
        }
        for (const s of infra.agentSessionDAO.listByCabinId(id)) infra.agentSessionDAO.softDelete(s.id)
        if (row.workspace_id) infra.workspaceDAO.deleteById(row.workspace_id)
      }
      this.cabin.delete(id)
    })
    // Disk worktrees: best-effort, outside the DB transaction. The cabin
    // directory itself is the user's — never rm -rf it here.
    for (const e of readCabinConfig(row.path).repos) {
      if (e.main_path && e.worktree_path) {
        void gitOps.worktreeRemove(e.main_path, e.worktree_path).catch((err) => {
          console.error(`[CabinService] worktree remove failed for ${id}/${e.name}:`, errMsg(err))
        })
      }
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
  setFocus(id: string, version: number, jobId: string | null): CabinRow {
    return this.patch(id, version, { focused_job_id: jobId })
  }
  touch(id: string): void {
    const row = this.mustGet(id)
    this.cabin.updateFields(id, row.version, { last_active_at: now() }, now())
  }

  // ── derived view (K3: computed on read, never stored) ──

  getView(id: string): { cabin: CabinRow; view: DerivedCabinView } {
    const row = this.mustGet(id)
    const jobs = this.cabin.listJobs(id)
    const iterations = this.cabin.listIterations(id)
    const tasks: DeriveCabinInput["tasks"] = []
    const executions: DeriveCabinInput["executions"] = []
    const taskRows = this.infra ? this.infra.taskDAO.findByCabinId(id) : []
    const execToTask = new Map<string, string>()
    const sessionToTask = new Map<string, string>()
    if (this.infra) {
      for (const t of taskRows) {
        const execs = this.infra.executionDAO.listTaskInstances(t.id, 200)
        const acceptances = this.infra.acceptanceDAO.listByTask(t.id)
        const derived = deriveTaskView(t, execs, acceptances)
        tasks.push({
          id: t.id, name: t.name, status: derived.taskStatus,
          iteration_id: t.iteration_id ?? null, repo: t.repo_group ?? null, branch: null,
        })
        for (const e of execs) {
          executions.push({ id: e.id, task_id: t.id, status: e.status })
          execToTask.set(e.id, t.id)
        }
        if (t.source_chat_session_id) sessionToTask.set(t.source_chat_session_id, t.id)
        if (t.doer_session_id) sessionToTask.set(t.doer_session_id, t.id)
      }
    }
    const view = deriveCabinView({
      cabin: { id: row.id, status: row.status, focused_job_id: row.focused_job_id },
      tasks, executions,
      incidents: this.gatherIncidents(taskRows.map((t) => t.id), execToTask),
      asks: this.gatherAsks(row, executions, execToTask, sessionToTask),
      findings: this.listFindings(id, "open").map((f) => ({ id: f.id, title: f.title, status: f.status })),
      jobs: jobs.map((j) => ({ id: j.id, kind: j.kind, ref_id: j.ref_id, title: j.title, priority: j.priority })),
      iterations: iterations.map((it) => ({ id: it.id, code: it.code, name: it.name, sort_order: it.sort_order, status: it.status })),
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

  /** C4：两类 ask —— workflow pending_interaction 执行 + 舱会话里末条未答的
   *  ask_user_question 卡（message-filter 同构：其后有「用户回答了以下问题」即已答）。 */
  private gatherAsks(
    row: CabinRow,
    executions: DeriveCabinInput["executions"],
    execToTask: Map<string, string>,
    sessionToTask: Map<string, string>,
  ): DeriveCabinInput["asks"] {
    const infra = this.infra
    if (!infra) return []
    const asks: DeriveCabinInput["asks"] = []
    const taskName = new Map<string, string>()
    for (const t of infra.taskDAO.findByCabinId(row.id)) taskName.set(t.id, t.name)
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
        question = firstAskQuestion(msg?.metadata)
      } catch { /* interaction_messages absent on old DBs */ }
      asks.push({
        id: e.id, task_id: tid,
        title: `${(tid && taskName.get(tid)) || "工作流"} · 待回答`, question,
      })
    }
    for (const s of infra.agentSessionDAO.listByCabinId(row.id)) {
      const { items } = infra.agentSessionDAO.findMessagesBySession(s.id, { limit: 200 })
      // findMessagesBySession 已按 created_at 升序返回（message-filter 同构）。
      const asc = items
      let lastAskIdx = -1
      for (let i = 0; i < asc.length; i++) {
        if (askDisplayType(asc[i].metadata)) lastAskIdx = i
      }
      if (lastAskIdx < 0) continue
      const answered = asc.slice(lastAskIdx + 1).some(
        (m) => m.role === "user" && m.content.includes("用户回答了以下问题"),
      )
      if (answered) continue
      asks.push({
        id: asc[lastAskIdx].id, task_id: sessionToTask.get(s.id) ?? null,
        title: `${s.title || "舱会话"} · 待回答`, question: firstAskQuestion(asc[lastAskIdx].metadata),
      })
    }
    return asks
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
    return readCabinConfig(row.path).repos
  }

  /** Clone (if needed) + cut a cabin worktree for one repo; merges the entry
   *  into config.json.repos[] via the existing spec-meta writer. */
  addRepo(id: string, name: string): SpecWorktreeEntry {
    const row = this.mustGet(id)
    if (!row.org) throw new Error("cabin has no org — cannot clone repos")
    const config = readCabinConfig(row.path)
    const existing = config.repos.find((r) => r.name === name && r.worktree_path && r.branch && r.main_path)
    if (existing) return existing as SpecWorktreeEntry
    const res = ensureRepoCloned(row.org, name)
    if ("error" in res) throw new Error(res.error)
    const branch = `cabin-${row.id.slice(0, 8)}`
    const entry = this.git.initWorktreeOne(row.path, { name, source_path: res.localPath }, branch, row.org)
    const kept = config.repos.filter((r): r is SpecWorktreeEntry =>
      r.name !== name && Boolean(r.main_path && r.worktree_path && r.branch))
    this.git.writeSpecWorktreeMeta(row.path, [...kept, entry], config.name)
    return entry
  }

  // ── iterations ──
  listIterations(cabinId: string): CabinIterationRow[] { return this.cabin.listIterations(cabinId) }
  createIteration(cabinId: string, input: { code: string; name: string; sort_order?: number }): CabinIterationRow {
    this.mustGet(cabinId)
    const ts = now()
    const row: CabinIterationRow = {
      id: randomUUID(), cabin_id: cabinId, code: input.code, name: input.name,
      sort_order: input.sort_order ?? 0, status: "pending", created_at: ts, updated_at: ts,
    }
    this.cabin.insertIteration(row)
    return row
  }
  updateIteration(cabinId: string, id: string, fields: { name?: string; sort_order?: number; status?: "pending" | "active" | "done" }): CabinIterationRow {
    const row = this.mustIterationInCabin(cabinId, id)
    this.cabin.updateIteration(row.id, fields, now())
    return this.cabin.findIteration(row.id)!
  }
  /** Delete a milestone; member tasks are unbound (tasks.iteration_id single
   *  writer, S2 app-level cascade) — the tasks themselves stay untouched. */
  deleteIteration(cabinId: string, id: string): { unbound: number } {
    const row = this.mustIterationInCabin(cabinId, id)
    let unbound = 0
    if (this.infra) {
      for (const t of this.infra.taskDAO.findByCabinId(cabinId)) {
        if (t.iteration_id !== row.id) continue
        const res = this.infra.taskDAO.updateWithVersion(t.id, { iteration_id: null }, t.version)
        if (res.changes > 0) unbound += 1
      }
    }
    this.cabin.deleteIteration(row.id)
    return { unbound }
  }
  private mustIterationInCabin(cabinId: string, id: string): CabinIterationRow {
    this.mustGet(cabinId)
    const row = this.cabin.findIteration(id)
    if (!row || row.cabin_id !== cabinId) throw new CabinNotFoundError(`${cabinId}/iteration:${id}`)
    return row
  }

  // ── dispatch ledger (C2/C6/C8) ──
  listJobs(cabinId: string): CabinJobRow[] { return this.cabin.listJobs(cabinId) }
  getJob(id: string): CabinJobRow | undefined { return this.cabin.findJob(id) }
  dispatchJob(cabinId: string, input: {
    kind: CabinJobKind; ref_id?: string | null; session_id?: string | null; iteration_id?: string | null
    title: string; mandate?: unknown; prompt?: string | null; priority?: number
  }): CabinJobRow {
    this.mustGet(cabinId)
    const row: CabinJobRow = {
      id: randomUUID(), cabin_id: cabinId, kind: input.kind,
      ref_id: input.ref_id ?? null, session_id: input.session_id ?? null,
      iteration_id: input.iteration_id ?? null, title: input.title,
      mandate: input.mandate ? JSON.stringify(input.mandate) : null,
      prompt: input.prompt ?? null, priority: input.priority ?? 0,
      created_at: now(), ended_at: null,
    }
    this.cabin.insertJob(row)
    this.appendEvent(row.id, cabinId, "dispatch", "orchestrator", { title: row.title, mandate: input.mandate ?? null })
    return row
  }
  setJobPriority(id: string, priority: number): void { this.cabin.updateJobPriority(id, priority) }

  /** C8 提优先：priority + 任务类 bump next_fire_at（ready 才可触发；其余状态
   *  仅 claim 排序生效，不炸）。 */
  async bumpJobPriority(cabinId: string, jobId: string, priority: number): Promise<void> {
    const job = this.mustJobInCabin(cabinId, jobId)
    this.cabin.updateJobPriority(jobId, priority)
    if (job.kind === "task" && job.ref_id && this.infra?.tasksService) {
      const task = this.infra.taskDAO.getById(job.ref_id)
      if (task?.status === "ready") {
        try {
          await this.infra.tasksService.triggerTask(job.ref_id)
        } catch (err) {
          console.warn(`[CabinService] priority bump trigger skipped: ${errMsg(err)}`)
        }
      }
    }
  }

  private mustJobInCabin(cabinId: string, jobId: string): CabinJobRow {
    const job = this.cabin.findJob(jobId)
    if (!job || job.cabin_id !== cabinId) throw new CabinNotFoundError(`${cabinId}/job:${jobId}`)
    return job
  }

  /** C2 agent 可知：舱内任务清单（派生状态，单写者=任务行）。 */
  listTasksView(cabinId: string): Array<{
    id: string; name: string; status: string; iteration_id: string | null
    iteration_code: string | null; workspace_id: string | null; session_id: string | null
  }> {
    this.mustGet(cabinId)
    if (!this.infra) return []
    const iterations = this.cabin.listIterations(cabinId)
    return this.infra.taskDAO.findByCabinId(cabinId).map((t) => {
      const execs = this.infra!.executionDAO.listTaskInstances(t.id, 200)
      const acceptances = this.infra!.acceptanceDAO.listByTask(t.id)
      return {
        id: t.id, name: t.name,
        status: deriveTaskView(t, execs, acceptances).taskStatus,
        iteration_id: t.iteration_id ?? null,
        iteration_code: iterations.find((it) => it.id === t.iteration_id)?.code ?? null,
        workspace_id: t.workspace_id ?? null,
        session_id: t.source_chat_session_id ?? null,
      }
    })
  }

  /** C2/K3：作业 status 派生自底层实体（task→deriveTaskView / execution /
   *  subagent_runs），不镜像存储。transport = 传输层通道（D6）。 */
  listJobsView(cabinId: string): Array<CabinJobRow & {
    status: string; transport: string; iteration_code: string | null
  }> {
    this.mustGet(cabinId)
    const iterations = this.cabin.listIterations(cabinId)
    const db = this.cabin.getDb()
    return this.cabin.listJobs(cabinId).map((j) => {
      let status = "unknown"
      if (j.kind === "task" && j.ref_id && this.infra) {
        const t = this.infra.taskDAO.getById(j.ref_id)
        if (t) {
          const execs = this.infra.executionDAO.listTaskInstances(t.id, 200)
          const acceptances = this.infra.acceptanceDAO.listByTask(t.id)
          status = deriveTaskView(t, execs, acceptances).taskStatus
        }
      } else if (j.kind === "workflow" && j.ref_id) {
        const row = db.prepare("SELECT status FROM executions WHERE id = ?").get(j.ref_id) as { status?: string } | undefined
        status = row?.status ?? "unknown"
      } else if (j.kind === "subagent" && j.ref_id) {
        const row = db.prepare("SELECT status FROM subagent_runs WHERE id = ?").get(j.ref_id) as { status?: string } | undefined
        status = row?.status ?? "unknown"
      }
      const transport = j.kind === "task" ? "task-thread" : j.kind === "workflow" ? "workflow-engine" : "sdk-agent"
      const iteration_code = iterations.find((it) => it.id === j.iteration_id)?.code ?? null
      return { ...j, status, transport, iteration_code }
    })
  }

  /** S5 拉取主线：clean-main → syncToDefaultBranch（镜像），pin → pullLatest。 */
  async pullRepo(cabinId: string, name: string): Promise<{ branch: string; commit: string }> {
    const row = this.mustGet(cabinId)
    const entry = readCabinConfig(row.path).repos.find((r) => r.name === name)
    if (!entry?.main_path) throw new Error(`repo not in cabin: ${name}`)
    if (row.mainline_strategy === "clean-main") {
      return gitOps.syncToDefaultBranch(entry.main_path)
    }
    const target = entry.worktree_path ?? entry.main_path
    await gitOps.pullLatest(target)
    const info = await gitOps.getBranchInfo(target)
    const commit = await gitOps.getHeadCommit(target)
    return { branch: info.branch, commit }
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
      byJob.push({ job_id: null, kind: "chat", label: "orchestrator 主对话", ref_id: row.main_session_id, ...(chat ?? EMPTY_USAGE) })
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
      byJob.push({ job_id: j.id, kind: "workflow", label: j.title, ref_id: j.ref_id, ...(s ?? EMPTY_USAGE) })
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
      if (cost.usd != null) { subCostUsd = (subCostUsd ?? 0) + cost.usd; subPriced += 1 }
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