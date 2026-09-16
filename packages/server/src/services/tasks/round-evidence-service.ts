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
  TaskSpecFieldError,
  type AcceptanceVerify,
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
}

// ── helpers ──────────────────────────────────────────────────────────────

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
