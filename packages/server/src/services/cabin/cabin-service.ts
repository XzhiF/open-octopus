import { randomUUID } from "crypto"
import fs from "fs"
import path from "path"
import type { CabinInitState } from "@octopus/shared"
import type { CabinDAO } from "../../db/dao/cabin-dao"
import type {
  WorkspaceDAO, AgentSessionDAO, TaskDAO, ExecutionDAO, AcceptanceDAO,
} from "../../db/dao"
import { SessionCacheContextDAO } from "../../db/dao"
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
import { deriveCabinView, type DerivedCabinView, type DeriveCabinInput } from "./derive-cabin-view"
import type { CabinInitService } from "./cabin-init-service"
import { isInitComplete } from "./cabin-init-service"
import { ensureRepoCloned, readCabinConfig, writeCabinConfigRepos, type CabinRepoEntry } from "./cabin-repos"

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
        description: `工作舱：${input.name}`,
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
    if (this.infra) {
      for (const t of this.infra.taskDAO.findByCabinId(id)) {
        const execs = this.infra.executionDAO.listTaskInstances(t.id, 200)
        const acceptances = this.infra.acceptanceDAO.listByTask(t.id)
        const derived = deriveTaskView(t, execs, acceptances)
        tasks.push({
          id: t.id, name: t.name, status: derived.taskStatus,
          iteration_id: t.iteration_id ?? null, repo: t.repo_group ?? null, branch: null,
        })
        for (const e of execs) executions.push({ id: e.id, task_id: t.id, status: e.status })
      }
    }
    const view = deriveCabinView({
      cabin: { id: row.id, status: row.status, focused_job_id: row.focused_job_id },
      tasks, executions,
      // P4 wires incident / ask / finding sources into the attention matrix.
      incidents: [], asks: [], findings: [],
      jobs: jobs.map((j) => ({ id: j.id, kind: j.kind, ref_id: j.ref_id, title: j.title, priority: j.priority })),
      iterations: iterations.map((it) => ({ id: it.id, code: it.code, name: it.name, sort_order: it.sort_order, status: it.status })),
      maxWorkers: 5,
    })
    return { cabin: row, view }
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
  updateIteration(id: string, fields: { name?: string; sort_order?: number; status?: "pending" | "active" | "done" }): void {
    this.cabin.updateIteration(id, fields, now())
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
}