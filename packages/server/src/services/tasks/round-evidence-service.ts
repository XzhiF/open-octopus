// packages/server/src/services/tasks/round-evidence-service.ts
//
// 验收面 v2「验货台」(2026-09-16) — the ACCEPTANCE-TIME EVIDENCE service:
// it answers 「这轮到底改了什么 (real diff)」 and 「现在再验一次还绿吗 (live
// re-verify)」 for the task's AWAITING round, off data the platform already
// holds but the panel never used.
//
// WHY (user framing, 2026-09-16): the acceptance modal's evidence was 100%
// agent-authored narration (round-report claims ✅, claims "0 regressions").
// Acceptance is the moment to VERIFY goods, not read reports. Two independent
// facts exist outside the narration:
//   ① every execution row carries start_commit_id → end_commit_id (JSON
//      {projectsDirName: fullSHA}, captured by GitOperations at launch/terminal
//      — the round's REAL change range; SHAs live in the main clone's shared
//      object store, so they outlive the worktree);
//   ② the workspace of a task is retention-immune and still on disk while a
//      round awaits review — so a user-configured verify command can be run
//      THERE, NOW, via the same BashExecutor the engine uses (fresh verdict,
//      fresh timestamp; the report's "复验通过" becomes hearsay we don't need).
//
// Threat model (deliberate, documented): verify commands are USER-authored and
// user-triggered — the same trust class as workflow bash nodes, which run
// agent-authored scripts on this very machine via the same executor. Local
// single-user dev tool; blast radius = the user's own account. It NEVER
// auto-runs: only the explicit ▶复检 button (POST /:id/verify) starts one.
//
// Sessions live IN MEMORY (one per task, running-or-last). A server restart
// loses the map — the verdict .md written into the batch dir is the durable
// truth (and shows up in the 叙述 listing via the existing all=1 scan). No
// schema change, no new table, on purpose: the round is terminal and tiny;
// the batch dir + derived view already own its bookkeeping.

import { existsSync, readFileSync } from "fs"
import path from "path"
import type Database from "better-sqlite3"
import {
  VarPool,
  TASK_VERIFY_EVENT,
  TASK_VERIFY_LOG_EVENT,
  TASK_PREVIEW_EVENT,
  TASK_ARTIFACTS_UPDATE_EVENT,
  TaskSpecFieldError,
  type AcceptanceVerify,
  type AcceptancePreview,
  type TaskSpec,
} from "@octopus/shared"
import { BashExecutor } from "@octopus/engine"
import { ExecutionDAO } from "../../db/dao"
import type { ExecutionRow } from "../../db/types"
import { gitOps, type DiffFileEntry } from "../git-ops"
import type { SSEService } from "../sse"
import type { WorkspaceService } from "../workspace"
import { TaskStatusConflictError } from "./tasks-service"
import type { TasksService } from "./tasks-service"
import type { TaskHomeService } from "./task-home-service"
import type { TaskPhaseView } from "./derive-task-view"
import { compilePlaybook, parseChecksMd, renderChecksMd, checksFileName, ticketBaseFromItemId } from "./playbook-compile"
import type { PlaybookPayload, ChecksFile } from "./playbook-types"

export type { PlaybookPayload, PlaybookSection, PlaybookItem, PlaybookCarryover, PlaybookBudget, ChecksFile, CheckEntry } from "./playbook-types"

// ── payload shapes (mirror: web lib/tasks-api.ts) ─────────────────────

export interface DirGroup {
  dir: string
  additions: number
  dels: number
  files: DiffFileEntry[]
}

export interface RepoDiff {
  name: string
  /** true = honest expiry (evidence gone); groups empty. */
  expired?: boolean
  reason?: "no_workspace" | "no_commits" | "worktree_gone"
  commits: number
  additions: number
  dels: number
  files: number
  /** stat capped (3000) — list truncated; sums are up-to-cap. */
  truncated: boolean
  groups: DirGroup[]
}

export interface RoundDiffPayload {
  /** false when NO repo resolved a live commit pair. */
  available: boolean
  reason?: string
  aggregate: { commits: number; additions: number; dels: number; files: number }
  /** executions.harness_summary.totalInterventions — 「干预 K」 tile; null = no harness data. */
  interventions: number | null
  repos: RepoDiff[]
}

export type VerifyState = "running" | "passed" | "failed" | "aborted" | "timeout"

export interface VerifySummary {
  task_id: string
  execution_id: string
  phase_index: number
  round_index: number
  command: string
  cwd: string
  state: VerifyState
  started_at: string
  ended_at?: string
  exit_code?: number
  duration_ms?: number
  /** home-relative path of the written verdict .md (null = batch dir not
   *  resolvable — SSE-only verdict, honest note in the UI stamp). */
  verdict_path?: string | null
  /** GET carries the last {@link VERIFY_TAIL_LINES} lines — SSE has no replay
   *  on the taskpool channel, so a client that joined mid-run reconstructs here. */
  tail?: string[]
}

const VERIFY_RING_CAP = 5000
const VERIFY_TAIL_LINES = 200
const VERIFY_DEFAULT_TIMEOUT_S = 600
const VERDICT_MAX_TAIL_BYTES = 200_000

// ── live preview (跑起来看) — 长驻进程 + HTTP 探活 (ADR-0022) ──────────
export type PreviewState = "starting" | "ready" | "exited" | "stopped" | "failed"
export interface PreviewSummary {
  task_id: string
  execution_id?: string
  command?: string
  url: string
  state: PreviewState
  /** true = url responds but NO session owns it (user ran pnpm dev themselves). */
  external?: boolean
  started_at?: string
  ended_at?: string
  exit_code?: number
  duration_ms?: number
  /** last stdout lines (for readyPattern debugging; not streamed over SSE). */
  tail?: string[]
}
const PREVIEW_TIMEOUT_S = 7200        // 2h hard cap; every decision auto-stops
const PREVIEW_PROBE_MS = 1500         // readiness poll cadence while starting
const PREVIEW_PROBE_TIMEOUT_MS = 800  // per-probe fetch budget
const PREVIEW_TAIL = 120

/** One in-memory preview session per task. No verdict file — the ledger records it. */
interface PreviewSession {
  summary: PreviewSummary
  lines: string[]
  userAborted: boolean
  ready: boolean
  probeTimer?: ReturnType<typeof setInterval>
  controller: AbortController
  done: boolean
}

/** Evidence frozen while the round is still awaiting (see snapshotEvidence). */
export interface LedgerSnapshot {
  taskId: string
  phaseIndex: number
  roundIndex: number
  phaseName: string
  batchRelDir: string | null
  diff: RoundDiffPayload
  playbook: PlaybookPayload
  verify: VerifySummary | null
  preview: PreviewSummary | null
  checks: ChecksFile | null
}

/** One in-memory verify session per task (running or most recent terminal). */
interface VerifySession {
  summary: VerifySummary
  lines: string[]
  droppedHead: boolean
  userAborted: boolean
  controller: AbortController
  done: boolean
}

export class RoundEvidenceService {
  private readonly execDao: ExecutionDAO
  private readonly sessions = new Map<string, VerifySession>()
  private readonly previewSessions = new Map<string, PreviewSession>()

  constructor(
    db: Database.Database,
    private readonly sse: SSEService,
    private readonly tasksService: TasksService,
    private readonly workspaceService: WorkspaceService,
    private readonly taskHome: TaskHomeService,
  ) {
    this.execDao = new ExecutionDAO(db)
  }

  // ── awaiting-round resolution (the ONLY round this service serves) ─────

  /** The derived view (tasks-service.getTask → derived.phaseViews) picks the
   *  awaiting phase/round — 票03 single-authority, re-read here, never
   *  recomputed. TaskNotFoundError → 404; TaskStatusConflictError → 409. */
  private resolveAwaiting(taskId: string): {
    execRow: ExecutionRow
    phaseIndex: number
    roundIndex: number
    /** home-relative posix batch dir; null on absolute-specPath bypass. */
    batchRelDir: string | null
  } {
    const detail = this.tasksService.getTask(taskId) // 404 first
    const awaiting: TaskPhaseView | undefined = detail.derived.phaseViews.find(
      (p) => p.status === "awaiting_review" && p.awaitingRound !== null,
    )
    const roundIndex = awaiting?.awaitingRound ?? null
    const execId = awaiting?.rounds.find((r) => r.roundIndex === roundIndex)?.exec.id
    if (!awaiting || roundIndex == null || !execId) {
      throw new TaskStatusConflictError("当前无待验收 round — 验货台只对 awaiting_review 的轮次供货")
    }
    const execRow = this.execDao.findById(execId)
    if (!execRow || execRow.task_id !== taskId) {
      throw new TaskStatusConflictError(`待验收轮 ${execId} 的执行行缺失`)
    }
    return {
      execRow,
      phaseIndex: awaiting.index,
      roundIndex,
      batchRelDir: this.batchRelDirOf(detail.task_spec as TaskSpec, awaiting.index),
    }
  }

  /** dirname(specPath) under the home — same rule as TasksService.phaseSpecDir
   *  (kept local: that one is private and returns ABSOLUTE paths; verdict
   *  writes need the home-relative form writeHomeFile accepts). */
  private batchRelDirOf(spec: TaskSpec, phaseIndex: number): string | null {
    const phase = (spec?.phases ?? [])[phaseIndex - 1]
    if (!phase?.specPath) return null
    if (path.isAbsolute(phase.specPath)) return null
    const norm = phase.specPath.replace(/\\/g, "/").replace(/^\.\//, "")
    if (!norm.startsWith(".scratch/")) return null
    const i = norm.lastIndexOf("/")
    return i > 0 ? norm.slice(0, i) : null
  }

  // ── 实物 diff ───────────────────────────────────────────────────────────

  async getRoundDiff(taskId: string): Promise<RoundDiffPayload> {
    const { execRow } = this.resolveAwaiting(taskId)
    const starts = parseCommitMap(execRow.start_commit_id)
    const ends = parseCommitMap(execRow.end_commit_id)
    const names = [...new Set([...Object.keys(starts), ...Object.keys(ends)])]
    const interventions = parseInterventions(execRow.harness_summary)
    if (names.length === 0) {
      return {
        available: false, reason: "no_commits",
        aggregate: { commits: 0, additions: 0, dels: 0, files: 0 },
        interventions, repos: [],
      }
    }

    const ws = this.workspaceService.getById(execRow.workspace_id)
    const repos: RepoDiff[] = []
    for (const name of names) {
      const start = starts[name]
      const end = ends[name]
      if (!start || !end) {
        repos.push(expiredRepo(name, "no_commits"))
        continue
      }
      const dir = this.resolveRepoDir(ws?.path, name)
      if (!dir) {
        repos.push(expiredRepo(name, ws ? "worktree_gone" : "no_workspace"))
        continue
      }
      repos.push(await this.statRepo(dir, name, start, end))
    }

    const live = repos.filter((r) => !r.expired)
    const aggregate = live.reduce(
      (a, r) => ({
        commits: a.commits + r.commits,
        additions: a.additions + r.additions,
        dels: a.dels + r.dels,
        files: a.files + r.files,
      }),
      { commits: 0, additions: 0, dels: 0, files: 0 },
    )
    return {
      available: live.length > 0,
      reason: live.length > 0 ? undefined : "no_commits",
      aggregate,
      interventions,
      repos,
    }
  }

  /** `{ws}/projects/<name>` first (the commit-map keys ARE those dir names);
   *  fall back to ws config.json repos[].worktree_path/main_path — the main
   *  clone shares the object store, so a deleted worktree still resolves SHAs. */
  private resolveRepoDir(wsPath: string | undefined, name: string): string | null {
    if (!wsPath) return null
    const primary = path.join(wsPath, "projects", name)
    if (existsSync(path.join(primary, ".git"))) return primary
    try {
      const cfg = JSON.parse(readFileSync(path.join(wsPath, "config.json"), "utf-8")) as {
        repos?: Array<{ name: string; worktree_path?: string; main_path?: string }>
      }
      const entry = cfg.repos?.find((r) => r.name === name)
      if (entry?.worktree_path && existsSync(entry.worktree_path)) return entry.worktree_path
      if (entry?.main_path && existsSync(entry.main_path)) return entry.main_path
    } catch { /* no/odd config.json — the primary probe already failed */ }
    // a bare projects/<name> dir without .git marker file (fresh clone layout) —
    // still the right cwd if it IS a worktree root; commitExists below decides.
    return existsSync(primary) ? primary : null
  }

  /** One repo's slice: expiry-probe the SHA pair, then rename-aware numstat
   *  stat + first-path-segment grouping (the 「按包分组」 the panel renders). */
  private async statRepo(dir: string, name: string, start: string, end: string): Promise<RepoDiff> {
    const [okStart, okEnd] = await Promise.all([
      gitOps.commitExists(dir, start),
      gitOps.commitExists(dir, end),
    ])
    if (!okStart || !okEnd) return expiredRepo(name, "no_commits")
    if (start === end) {
      return { name, commits: 0, additions: 0, dels: 0, files: 0, truncated: false, groups: [] }
    }
    const [commits, stat] = await Promise.all([
      gitOps.countCommits(dir, start, end),
      gitOps.diffStat(dir, start, end),
    ])
    const byDir = new Map<string, DirGroup>()
    let additions = 0
    let dels = 0
    for (const f of stat.files) {
      additions += f.adds
      dels += f.dels
      const g = f.path.includes("/") ? f.path.split("/")[0]! : "(根)"
      let group = byDir.get(g)
      if (!group) {
        group = { dir: g, additions: 0, dels: 0, files: [] }
        byDir.set(g, group)
      }
      group.files.push(f)
      group.additions += f.adds
      group.dels += f.dels
    }
    return {
      name,
      commits,
      additions,
      dels,
      files: stat.files.length,
      truncated: stat.truncated,
      groups: [...byDir.values()].sort((a, b) => b.additions + b.dels - (a.additions + a.dels)),
    }
  }

  /** Lazy single-file patch (实物 tab row click). Ownership falls out of
   *  resolveAwaiting (exec belongs to this task); repo must exist in the map. */
  async getFilePatch(taskId: string, repo: string, filePath: string): Promise<{ patch: string; truncated: boolean }> {
    const { execRow } = this.resolveAwaiting(taskId)
    const starts = parseCommitMap(execRow.start_commit_id)
    const ends = parseCommitMap(execRow.end_commit_id)
    const start = starts[repo]
    const end = ends[repo]
    if (!start || !end) {
      throw new TaskStatusConflictError(`本轮提交区间不含仓库 ${repo}`)
    }
    const ws = this.workspaceService.getById(execRow.workspace_id)
    const dir = this.resolveRepoDir(ws?.path, repo)
    if (!dir) throw new TaskStatusConflictError(`仓库 ${repo} 的工作区目录已不存在`)
    if (filePath.includes("\0") || path.isAbsolute(filePath)) {
      throw new TaskSpecFieldError(`非法文件路径: ${filePath}`)
    }
    return gitOps.diffPatchFor(dir, start, end, filePath)
  }

  // ── 当场复检 (live re-verification) ────────────────────────────────────

  /** Kicks a BashExecutor run of the task's `acceptance_verify.command` inside
   *  the (alive) task workspace. Gates: awaiting round exists (409) → command
   *  configured (400) → no session running (409) → ws dir alive (409). */
  async startVerify(taskId: string): Promise<VerifySummary> {
    const { execRow, phaseIndex, roundIndex, batchRelDir } = this.resolveAwaiting(taskId)
    const detail = this.tasksService.getTask(taskId)
    const cfg = (detail.task_spec as TaskSpec | undefined)?.acceptance_verify as AcceptanceVerify | undefined
    if (!cfg?.command?.trim()) {
      throw new TaskSpecFieldError("未配置复检命令 — 在验收面板写下验证命令再跑（随任务持久化，全 phase 复用）")
    }
    const prev = this.sessions.get(taskId)
    if (prev && !prev.done) {
      throw new TaskStatusConflictError("复检进行中 — 中止或等它跑完")
    }
    const ws = this.workspaceService.getById(execRow.workspace_id)
    if (!ws || !existsSync(ws.path)) {
      throw new TaskStatusConflictError("工作区目录不在了 — 实物复检不可用（叙述/历史 verdict 仍有效）")
    }
    const cwdAbs = path.resolve(ws.path, cfg.cwd ?? ".")
    const cwdRel = path.relative(ws.path, cwdAbs)
    if (cwdRel.startsWith("..") || path.isAbsolute(cwdRel)) {
      throw new TaskSpecFieldError(`复检 cwd 逃逸出工作区: ${cfg.cwd}`)
    }

    const controller = new AbortController()
    const session: VerifySession = {
      summary: {
        task_id: taskId,
        execution_id: execRow.id,
        phase_index: phaseIndex,
        round_index: roundIndex,
        command: cfg.command,
        cwd: cfg.cwd ?? ".",
        state: "running",
        started_at: new Date().toISOString(),
      },
      lines: [],
      droppedHead: false,
      userAborted: false,
      controller,
      done: false,
    }
    this.sessions.set(taskId, session)
    this.sse.emit("taskpool", {
      event: TASK_VERIFY_EVENT,
      data: { task_id: taskId, execution_id: execRow.id, state: "running" },
    })

    // Fire-and-forget: the route returns 202 + summary; progress rides SSE
    // (task_verify_log lines + task_verify terminal). execute() itself never
    // rejects (timeout/abort come back as status:"failed" without exitCode) —
    // classify below owns that taxonomy.
    const node = {
      id: `verify-${taskId}`,
      type: "bash" as const,
      bash: cfg.command,
      timeout: cfg.timeoutS ?? VERIFY_DEFAULT_TIMEOUT_S,
    }
    const executor = new BashExecutor(
      node,
      new VarPool(),
      {
        cwd: cwdAbs,
        signal: controller.signal,
        executionId: execRow.id,
        onLog: (line: string, stream?: "stdout" | "stderr") => {
          session.lines.push(line)
          if (session.lines.length > VERIFY_RING_CAP) {
            session.lines.splice(0, session.lines.length - VERIFY_RING_CAP)
            if (!session.droppedHead) {
              session.droppedHead = true
              session.lines.unshift("[…日志超长 — 早期行已丢弃，完整输出看 verdict 文件]")
            }
          }
          this.sse.emit("taskpool", {
            event: TASK_VERIFY_LOG_EVENT,
            data: { task_id: taskId, line, stream: stream ?? "stdout" },
          })
        },
      },
    )
    void executor.execute()
      .then((r) => this.settleVerify(taskId, session, batchRelDir, r))
      .catch((err: unknown) => {
        // execute() shouldn't reject; belt-and-braces so a session never sticks running.
        session.summary.state = "failed"
        session.summary.ended_at = new Date().toISOString()
        session.summary.exit_code = -1
        session.done = true
        console.error("[round-evidence] verify crashed:", err instanceof Error ? err.message : err)
        this.sse.emit("taskpool", {
          event: TASK_VERIFY_EVENT,
          data: { task_id: taskId, execution_id: session.summary.execution_id, state: "failed", exit_code: -1, tail: [] },
        })
      })

    return { ...session.summary }
  }

  /** Terminal classification + durable verdict .md (writeHomeFile wrapper →
   *  SSE task_artifacts_update fires for free — the 叙述 list re-fetches it) */
  private settleVerify(
    taskId: string,
    session: VerifySession,
    batchRelDir: string | null,
    r: { status: string; exitCode?: number; durationMs: number; logLines: string[] },
  ): void {
    const s = session.summary
    s.state = classifyVerifyResult(session.userAborted, r)
    s.ended_at = new Date().toISOString()
    s.duration_ms = r.durationMs
    s.exit_code = r.exitCode
    s.verdict_path = null
    session.done = true

    if (batchRelDir) {
      const ts = s.ended_at.replace(/[:.]/g, "-")
      const relPath = `${batchRelDir}/verify-r${s.round_index}-${ts}.md`
      try {
        this.tasksService.writeHomeFile(taskId, relPath, buildVerdictMd(s, session.lines))
        s.verdict_path = relPath
      } catch (err: unknown) {
        // Non-fatal: a racing accept/archive can flip the edit window shut —
        // the SSE terminal + in-memory tail stay honest.
        console.error("[round-evidence] verdict write failed:", err instanceof Error ? err.message : err)
      }
    }
    this.sse.emit("taskpool", {
      event: TASK_VERIFY_EVENT,
      data: {
        task_id: taskId,
        execution_id: s.execution_id,
        state: s.state,
        exit_code: s.exit_code,
        duration_ms: s.duration_ms,
        verdict_path: s.verdict_path,
        tail: session.lines.slice(-3),
      },
    })
  }

  /** GET /:id/verify — session summary (+tail) or null (never ran / restarted). */
  getVerifyStatus(taskId: string): VerifySummary | null {
    const session = this.sessions.get(taskId)
    if (!session) return null
    return { ...session.summary, tail: session.lines.slice(-VERIFY_TAIL_LINES) }
  }

  /** POST /:id/verify/abort — SIGTERM tree-kill via BashExecutor's chain. */
  abortVerify(taskId: string): VerifySummary {
    const session = this.sessions.get(taskId)
    if (!session || session.done) {
      throw new TaskStatusConflictError("没有在跑的复检可中止")
    }
    session.userAborted = true
    session.controller.abort()
    return { ...session.summary }
  }

  // ── 验收剧本 (acceptance playbook) ─────────────────────────────────────

  /** GET /:id/playbook — compile the awaiting round's契约 files into a walk/
   *  probe/claim checklist (ADR-0022). Pure read + {@link compilePlaybook};
   *  missing sources degrade into coverage.missing, never throw (200 with
   *  available:false). resolveAwaiting 409s first (no awaiting → 409). */
  getPlaybook(taskId: string): PlaybookPayload {
    const { roundIndex, batchRelDir } = this.resolveAwaiting(taskId)
    if (!batchRelDir) {
      // absolute specPath bypass — no batch dir to read, honest empty state.
      return compilePlaybook({ roundIndex })
    }
    let listing: Array<{ path: string }> = []
    try {
      listing = this.taskHome.listHomeDir(taskId, batchRelDir, true)
    } catch {
      listing = [] // batch dir not on disk yet
    }
    const byBase = (re: RegExp): string | null => {
      const hit = listing.find((e) => re.test(e.path.split("/").pop() ?? ""))
      return hit ? hit.path : null
    }
    const read = (relPath: string | null): string | null => {
      if (!relPath) return null
      try {
        return this.taskHome.readHomeFile(taskId, relPath).content
      } catch {
        return null // NOT_FOUND/race — treat as missing source
      }
    }
    // latest NN-e2e-*.md (highest leading number), if any.
    const e2ePaths = listing
      .filter((e) => /(^|\/)\d[\d.-]*e2e[^/]*\.md$/i.test(e.path))
      .map((e) => e.path)
      .sort((a, b) => (parseInt(a.match(/\d+/)?.[0] ?? "0", 10) - parseInt(b.match(/\d+/)?.[0] ?? "0", 10)))
    const e2ePath = e2ePaths[e2ePaths.length - 1] ?? null
    // prior round's checks file (acceptance-checks-r{N}.md, N < roundIndex, max).
    const prevPath = listing
      .map((e) => e.path)
      .map((p) => {
        const m = /acceptance-checks-r(\d+)\.md$/.exec(p)
        return m && Number(m[1]) < roundIndex ? { p, r: Number(m[1]) } : null
      })
      .filter((x): x is { p: string; r: number } => x !== null)
      .sort((a, b) => b.r - a.r)[0] ?? null
    let prevChecks: { round: number; data: ChecksFile } | null = null
    if (prevPath) {
      const raw = read(prevPath.p)
      if (raw) {
        const data = parseChecksMd(raw)
        if (data) prevChecks = { round: prevPath.r, data }
      }
    }
    return compilePlaybook({
      roundIndex,
      specMd: read(byBase(/^spec\.md$/i) ?? byBase(/spec.*\.md$/i)),
      e2eTicket: e2ePath
        ? { name: e2ePath.split("/").pop() ?? "e2e.md", content: read(e2ePath) ?? "" }
        : null,
      e2eTestPlan: read(byBase(/^e2e-test-plan\.md$/i)),
      roundReport: read(byBase(/^round-report\.md$/i) ?? byBase(/round.*report.*\.md$/i)),
      prevChecks,
    })
  }

  // ── live preview (跑起来看) ────────────────────────────────────────────

  private previewCfg(taskId: string): AcceptancePreview | undefined {
    const detail = this.tasksService.getTask(taskId)
    return (detail.task_spec as TaskSpec | undefined)?.acceptance_preview as AcceptancePreview | undefined
  }

  /** One bounded HTTP probe — ANY response (2xx/3xx/4xx) means the port is up.
   *  Network error / timeout → false. Never throws. */
  private async probeUrl(url: string): Promise<boolean> {
    try {
      const ctrl = new AbortController()
      const to = setTimeout(() => ctrl.abort(), PREVIEW_PROBE_TIMEOUT_MS)
      try {
        await fetch(url, { method: "GET", signal: ctrl.signal, redirect: "follow" })
        return true // resolved (any status) = port serving
      } finally {
        clearTimeout(to)
      }
    } catch {
      return false
    }
  }

  /** POST /:id/preview — start the task's acceptance_preview command as a
   *  long-lived process in the (alive) workspace; readiness via HTTP probe.
   *  Gates mirror startVerify. NEVER auto-runs (explicit button only). */
  async startPreview(taskId: string): Promise<PreviewSummary> {
    const { execRow } = this.resolveAwaiting(taskId)
    const cfg = this.previewCfg(taskId)
    if (!cfg?.command?.trim()) {
      throw new TaskSpecFieldError("未配置预览命令 — 在验收面板写下起服务的命令(长驻,随任务持久化)")
    }
    let url: string
    try {
      url = new URL(cfg.url).toString()
    } catch {
      throw new TaskSpecFieldError(`预览 url 非法: ${cfg.url}`)
    }
    // 引擎替换语法撞车预检(与 bash 节点同纪律,ADR commit 209a9ce6 教训)。
    if (/\$vars\.|\$\{[^}]*\|/.test(cfg.command)) {
      throw new TaskSpecFieldError("预览命令含引擎替换语法($vars./${x|filter}) — 会被 BashExecutor 误替换,请改写")
    }
    const prev = this.previewSessions.get(taskId)
    if (prev && !prev.done) throw new TaskStatusConflictError("预览已在跑 — 先停止")
    const ws = this.workspaceService.getById(execRow.workspace_id)
    if (!ws || !existsSync(ws.path)) throw new TaskStatusConflictError("工作区目录不在了 — 预览不可用")
    const cwdAbs = path.resolve(ws.path, cfg.cwd ?? ".")
    const cwdRel = path.relative(ws.path, cwdAbs)
    if (cwdRel.startsWith("..") || path.isAbsolute(cwdRel)) {
      throw new TaskSpecFieldError(`预览 cwd 逃逸出工作区: ${cfg.cwd}`)
    }

    const controller = new AbortController()
    const session: PreviewSession = {
      summary: {
        task_id: taskId,
        execution_id: execRow.id,
        command: cfg.command,
        url,
        state: "starting",
        started_at: new Date().toISOString(),
      },
      lines: [],
      userAborted: false,
      ready: false,
      controller,
      done: false,
    }
    this.previewSessions.set(taskId, session)
    this.sse.emit("taskpool", { event: TASK_PREVIEW_EVENT, data: previewData(taskId, session.summary) })

    const node = { id: `preview-${taskId}`, type: "bash" as const, bash: cfg.command, timeout: PREVIEW_TIMEOUT_S }
    const pattern = cfg.readyPattern ? safeRegex(cfg.readyPattern) : null
    const executor = new BashExecutor(node, new VarPool(), {
      cwd: cwdAbs,
      signal: controller.signal,
      executionId: execRow.id,
      onLog: (line: string) => {
        session.lines.push(line)
        if (session.lines.length > PREVIEW_TAIL) session.lines.splice(0, session.lines.length - PREVIEW_TAIL)
      },
    })
    void executor.execute()
      .then((r) => this.settlePreview(taskId, session, r))
      .catch(() => this.settlePreview(taskId, session, { status: "failed", logLines: ["preview crashed"] }))

    // Readiness poller: any HTTP response (+ readyPattern if configured) → ready.
    session.probeTimer = setInterval(() => {
      void (async () => {
        if (session.done || session.ready) return
        const probeOk = await this.probeUrl(url)
        const patOk = pattern ? pattern.test(session.lines.join("\n")) : true
        if (probeOk && patOk) {
          session.ready = true
          session.summary.state = "ready"
          this.stopProbe(session)
          this.sse.emit("taskpool", { event: TASK_PREVIEW_EVENT, data: previewData(taskId, session.summary) })
        }
      })()
    }, PREVIEW_PROBE_MS)

    return { ...session.summary }
  }

  private settlePreview(
    taskId: string,
    session: PreviewSession,
    r: { status: string; exitCode?: number; logLines: string[] },
  ): void {
    if (session.done) return
    this.stopProbe(session)
    session.done = true
    const s = session.summary
    s.ended_at = new Date().toISOString()
    if (s.started_at) s.duration_ms = Date.parse(s.ended_at) - Date.parse(s.started_at)
    if (session.userAborted) s.state = "stopped"
    else if (typeof r.exitCode === "number") s.state = "exited"
    else s.state = "failed"
    s.exit_code = r.exitCode
    this.sse.emit("taskpool", { event: TASK_PREVIEW_EVENT, data: previewData(taskId, s) })
  }

  private stopProbe(session: PreviewSession): void {
    if (session.probeTimer) { clearInterval(session.probeTimer); session.probeTimer = undefined }
  }

  /** GET /:id/preview — session state, or a one-shot external probe (a `pnpm dev`
   *  the user started outside Octopus still shows as openable). */
  async getPreview(taskId: string): Promise<PreviewSummary | null> {
    const session = this.previewSessions.get(taskId)
    if (session) return { ...session.summary, tail: session.lines.slice(-VERIFY_TAIL_LINES) }
    const cfg = this.previewCfg(taskId)
    if (!cfg?.url) return null
    let url: string
    try {
      url = new URL(cfg.url).toString()
    } catch {
      return null
    }
    if (await this.probeUrl(url)) {
      return { task_id: taskId, url, state: "ready", external: true }
    }
    return { task_id: taskId, url, state: "stopped" }
  }

  /** POST /:id/preview/stop — SIGTERM tree via BashExecutor's abort chain. */
  stopPreview(taskId: string): PreviewSummary {
    const session = this.previewSessions.get(taskId)
    if (!session || session.done) throw new TaskStatusConflictError("没有在跑的预览可停止")
    session.userAborted = true
    this.stopProbe(session)
    session.controller.abort()
    return { ...session.summary }
  }

  /** Decision hook (T04): stop any running preview WITHOUT throwing when idle. */
  stopPreviewQuiet(taskId: string): void {
    const session = this.previewSessions.get(taskId)
    if (session && !session.done) {
      session.userAborted = true
      this.stopProbe(session)
      session.controller.abort()
    }
  }

  /** Ledger hook: last-known preview summary (for the台账 line). */
  previewStatus(taskId: string): PreviewSummary | null {
    const s = this.previewSessions.get(taskId)
    return s ? { ...s.summary } : null
  }

  // ── 台账机写 + 打回票重开 (ADR-0022 T04) ──────────────────────────────

  /** Snapshot the awaiting round's evidence BEFORE the decision lands (after
   *  it, resolveAwaiting 409s — the ledger/reopen must be built from a still-
   *  awaiting view). Throws like resolveAwaiting; route wraps best-effort. */
  async snapshotEvidence(taskId: string): Promise<LedgerSnapshot> {
    const { execRow, phaseIndex, roundIndex, batchRelDir } = this.resolveAwaiting(taskId)
    const detail = this.tasksService.getTask(taskId)
    const playbook = this.getPlaybook(taskId)
    const diff = await this.getRoundDiff(taskId)
    const verify = this.sessions.get(taskId)?.summary ?? null
    const preview = this.previewSessions.get(taskId)?.summary ?? null
    let checks: ChecksFile | null = null
    if (batchRelDir) {
      try {
        const raw = this.taskHome.readHomeFile(taskId, `${batchRelDir}/${checksFileName(roundIndex)}`).content
        checks = parseChecksMd(raw)
      } catch {
        checks = null // no checks written this round yet — ledger shows 未决=all
      }
    }
    return {
      taskId, phaseIndex, roundIndex, batchRelDir,
      phaseName: ((detail.task_spec as TaskSpec | undefined)?.phases?.[phaseIndex - 1]?.name) ?? `Phase ${phaseIndex}`,
      diff, playbook, verify, preview, checks,
    }
  }

  /** Build + write acceptance-ledger-r{N}.md (fire-safe — a failed ledger
   *  never flips the decision that already committed). Returns verdict_path. */
  writeLedger(snap: LedgerSnapshot, decision: "accepted" | "rejected"): string | null {
    if (!snap.batchRelDir) return null
    const rel = `${snap.batchRelDir}/acceptance-ledger-r${snap.roundIndex}.md`
    try {
      this.writeEvidenceFile(snap.taskId, rel, buildLedgerMd(snap, decision))
      return rel
    } catch (err: unknown) {
      console.error("[round-evidence] ledger write failed (non-fatal):", err instanceof Error ? err.message : err)
      return null
    }
  }

  /** rejected side-effects: append the 未过项 (✗) section to the just-written
   *  fix-feedback-r{N}.md, and flip each fail item's source ticket done→
   *  reopened. `reopenTickets` (validated body override) is UNIONed with ids
   *  derived from checks so a client that only sends notes still reopens. */
  augmentReject(snap: LedgerSnapshot, reopenTickets?: string[]): { reopened: string[] } {
    const reopened: string[] = []
    if (!snap.batchRelDir) return { reopened }
    const fails = (snap.checks ? Object.entries(snap.checks.checks).filter(([, c]) => c.decision === "fail") : []) as Array<[string, { note: string }]>
    // 1. append 未过项 section to fix-feedback (file written by tasks-service).
    if (fails.length) {
      const fbRel = `${snap.batchRelDir}/fix-feedback-r${snap.roundIndex}.md`
      const flat = snap.playbook.sections.flatMap((s) => s.items)
      const sec =
        `\n\n## 未过项(验收台剧本 ✗)\n\n` +
        fails.map(([id, c]) => {
          const it = flat.find((x) => x.id === id)
          return `- [${ticketBaseFromItemId(id) ?? id}] ${it?.op ?? id}\n  - 预期: ${it?.expect ?? "—"}\n  - 现象: ${c.note || "(未填)"}`
        }).join("\n") + "\n"
      try {
        const cur = this.taskHome.readHomeFile(snap.taskId, fbRel).content
        this.writeEvidenceFile(snap.taskId, fbRel, cur + sec)
      } catch (err: unknown) {
        console.error("[round-evidence] fix-feedback append failed:", err instanceof Error ? err.message : err)
      }
    }
    // 2. flip tickets done→reopened (from fail ids ∪ body override).
    const want = new Set<string>([
      ...fails.map(([id]) => ticketBaseFromItemId(id)).filter((x): x is string => !!x),
      ...(reopenTickets ?? []),
    ])
    if (want.size) {
      let listing: Array<{ path: string }> = []
      try {
        listing = this.taskHome.listHomeDir(snap.taskId, snap.batchRelDir, false)
      } catch {
        listing = []
      }
      for (const base of want) {
        const hit = listing.find((e) => {
          const bn = e.path.split("/").pop() ?? ""
          return bn === `${base}.md` || bn.replace(/\.md$/i, "") === base
        })
        if (!hit) continue
        try {
          const content = this.taskHome.readHomeFile(snap.taskId, hit.path).content
          const flipped = flipTicketStatus(content)
          if (flipped !== content) {
            this.writeEvidenceFile(snap.taskId, hit.path, flipped)
            reopened.push(base)
          }
        } catch (err: unknown) {
          console.error(`[round-evidence] reopen ${base} failed:`, err instanceof Error ? err.message : err)
        }
      }
    }
    return { reopened }
  }

  /** Server-authoritative evidence write — the underlying taskHome door (path/
   *  suffix guards only, NO edit-window gate: a final-phase ledger lands during
   *  'archiving' when user-editing is already closed). Emits the artifacts SSE
   *  so the 叙述 tab re-pulls the new file. */
  private writeEvidenceFile(taskId: string, rel: string, content: string): { path: string; bytes: number } {
    const res = this.taskHome.writeHomeFile(taskId, rel, content)
    this.sse.emit("taskpool", { event: TASK_ARTIFACTS_UPDATE_EVENT, data: { task_id: taskId } })
    return res
  }
}

/** done → reopened under a `## Status` heading (first bare `done` line only),
 *  idempotent. Leaves triage/other statuses untouched. */
function flipTicketStatus(md: string): string {
  const ls = md.replace(/\r\n/g, "\n").split("\n")
  const h = ls.findIndex((l) => /^#{1,6}\s*Status\b/i.test(l))
  if (h < 0) return md
  for (let i = h + 1; i < ls.length; i++) {
    if (/^#{1,6}\s/.test(ls[i])) break
    if (/^\s*done\s*$/i.test(ls[i])) { ls[i] = "reopened"; return ls.join("\n") }
  }
  return md
}

// ── helpers ──────────────────────────────────────────────────────────────

function previewData(taskId: string, s: PreviewSummary): Record<string, unknown> {
  return {
    task_id: taskId, execution_id: s.execution_id, state: s.state, url: s.url,
    external: s.external, exit_code: s.exit_code, duration_ms: s.duration_ms,
  }
}
/** Compile a user readyPattern; a bad regex must not kill a preview — return a
 *  never-matching pattern so readiness falls back to the HTTP probe alone. */
function safeRegex(src: string): RegExp {
  try {
    return new RegExp(src, "i")
  } catch {
    return /(?!)/
  }
}

function parseCommitMap(json: string | null | undefined): Record<string, string> {
  if (!json) return {}
  try {
    const obj = JSON.parse(json) as Record<string, string>
    return obj && typeof obj === "object" ? obj : {}
  } catch {
    return {}
  }
}

function parseInterventions(summary: string | null | undefined): number | null {
  if (!summary) return null
  try {
    const v = JSON.parse(summary) as { totalInterventions?: number }
    return typeof v.totalInterventions === "number" ? v.totalInterventions : null
  } catch {
    return null
  }
}

function expiredRepo(name: string, reason: "no_workspace" | "no_commits" | "worktree_gone"): RepoDiff {
  return { name, expired: true, reason, commits: 0, additions: 0, dels: 0, files: 0, truncated: false, groups: [] }
}

/** BashExecutor 语义（bash.ts execute/catch 实证）：非零退出带 exitCode；
 *  超时/中止走 catch → status:"failed" 无 exitCode，message 在 logLines 尾
 *  （"Timeout after Ns" / "Aborted" / "Execution cancelled before start"）。 */
function classifyVerifyResult(
  userAborted: boolean,
  r: { status: string; exitCode?: number; logLines: string[] },
): VerifyState {
  if (userAborted) return "aborted"
  if (typeof r.exitCode === "number") return r.exitCode === 0 ? "passed" : "failed"
  const tail = r.logLines[r.logLines.length - 1] ?? ""
  if (/Timeout after/i.test(tail)) return "timeout"
  if (/Abort|cancelled/i.test(tail)) return "aborted"
  return "failed"
}

/** The verdict artifact — written by the SERVER, at acceptance time, with its
 *  own timestamp. It outranks the agent's narration by construction, which is
 *  the whole point (v2.1: this becomes the anchor line for 「真项目跑起来」). */
function buildVerdictMd(s: VerifySummary, lines: string[]): string {
  const tailText = lines.slice(-VERIFY_TAIL_LINES).join("\n")
  const clipped =
    tailText.length > VERDICT_MAX_TAIL_BYTES
      ? `[…尾部按字节再截断]\n${tailText.slice(-VERDICT_MAX_TAIL_BYTES)}`
      : tailText
  const verdict =
    s.state === "passed" ? "✅ PASSED" :
    s.state === "timeout" ? "⏱ TIMEOUT" :
    s.state === "aborted" ? "✋ ABORTED" : "❌ FAILED"
  return [
    `# 当场复检 · ${s.state === "passed" ? "PASSED" : s.state.toUpperCase()}`,
    "",
    `> ${s.ended_at ?? s.started_at} · Phase ${s.phase_index} Round ${s.round_index} · 机器写入（验收面 v2 验货台）`,
    "",
    `- 命令: \`${s.command}\``,
    `- cwd: \`${s.cwd}\``,
    `- 退出码: ${s.exit_code ?? "—"} · 用时: ${s.duration_ms != null ? `${Math.round(s.duration_ms / 1000)}s` : "—"}`,
    `- 结论: **${verdict}**`,
    "",
    "## 输出尾部（最后 ≤" + VERIFY_TAIL_LINES + " 行）",
    "",
    "```",
    clipped || "(空)",
    "```",
    "",
  ].join("\n")
}

/** The acceptance ledger — machine-written AT decision time, the evidence chain
 *  that outranks every narration. Aggregates the four independent facts the
 *  panel surfaced (real diff / auto re-verify / live preview / human walkthrough)
 *  into one immutable file (ADR-0022). */
function buildLedgerMd(snap: LedgerSnapshot, decision: "accepted" | "rejected"): string {
  const now = new Date().toISOString()
  const d = snap.diff
  const agg = d.aggregate
  const totalSteps = snap.playbook.sections.reduce((n, sec) => n + sec.items.length, 0)
  const checks = snap.checks?.checks ?? {}
  const decided = Object.keys(checks).length
  const nPass = Object.values(checks).filter((c) => c.decision === "pass").length
  const nFail = Object.values(checks).filter((c) => c.decision === "fail").length
  const nSkip = Object.values(checks).filter((c) => c.decision === "skip").length
  const undecided = Math.max(0, totalSteps - decided)
  const verifyLine = snap.verify
    ? `- 自动复检: \`${snap.verify.command}\` → **${snap.verify.state.toUpperCase()}**` +
        `${snap.verify.exit_code != null ? ` (exit ${snap.verify.exit_code})` : ""} · 用时 ${snap.verify.duration_ms != null ? `${Math.round(snap.verify.duration_ms / 1000)}s` : "—"}${snap.verify.verdict_path ? ` → ${snap.verify.verdict_path}` : ""}`
    : "- 自动复检: 本轮未跑（≠ 失败；如需新鲜裁决请点 ▶ 复检）"
  const previewLine = snap.preview
    ? `- 跑起来看: \`${snap.preview.command ?? ""}\` @ ${snap.preview.url} → ${snap.preview.state.toUpperCase()}` +
        `${snap.preview.external ? "(外部进程)" : ""} · 决策时自动停止`
    : "- 跑起来看: 未使用"
  const stepLines = snap.playbook.sections.flatMap((sec) =>
    sec.items.map((it) => {
      const c = checks[it.id]
      const mark = !c ? "·" : c.decision === "pass" ? "✓" : c.decision === "fail" ? "✗" : "⊘"
      const note = c?.note ? ` — ${c.note}` : ""
      return `  - [${mark}] ${it.op}${c && c.decision !== "pass" ? ` (预期: ${it.expect})${note}` : ""}`
    }),
  )
  const stamp = decision === "accepted" ? "✅ 通过" : "↩ 打回"
  return [
    `# 验收台账 · Phase ${snap.phaseIndex} Round ${snap.roundIndex} · ${stamp}`,
    "",
    `> ${now} · 机器写入（验收面 v2.1 验货台，唯一决策链，不可改）`,
    `> ${snap.phaseName}${snap.playbook.goal ? ` · ${snap.playbook.goal}` : ""}${snap.playbook.specRevised ? " · ⚠ 含 Spec 修订" : ""}`,
    "",
    "## 实物（真 git 区间）",
    d.available
      ? `- ${d.repos.filter((r) => !r.expired).length}/${d.repos.length} repos 有效 · ${agg.commits} commits · +${agg.additions}/−${agg.dels} · ${agg.files} 文件 · 干预 ${d.interventions ?? "—"}`
      : `- 无有效实物 diff（${d.reason ?? "证据过期"}）— 叙述/历史 verdict 仍可参考`,
    "",
    "## 自动复检",
    verifyLine,
    "",
    "## 跑起来看",
    previewLine,
    "",
    "## 人工走查",
    `- 计 ${totalSteps} 步：✓${nPass} · ✗${nFail} · ⊘${nSkip} · 未决 ${undecided}${snap.playbook.budget.degraded ? "（编译降档）" : ""}`,
    ...(stepLines.length ? stepLines : ["  - （无编译步）"]),
    ...(nSkip ? ["", `> ⊘ 跳过项将进入下一轮 carryover（${snap.batchRelDir ? checksFileName(snap.roundIndex + 1) : "?"} 前置），补验或再豁免需新原因。`] : []),
    "",
    "## 决策",
    `- ${stamp} · 触发人 = 验收面板 · autoAdvance/派发由 tasks-service 账本另记`,
    "",
  ].join("\n")
}
