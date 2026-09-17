// packages/server/src/services/tasks/derive-task-view.ts
//
// deriveTaskView — the SINGLE source of truth for v4 task/phase display state
// (task-phase-redesign K3/K6, Implementation Decision ③, ticket 03).
//
// Why derive-and-never-store (K3): persisting a mirrored status caused the #54
// race (镜像竞态). Here the truth is computed on read from three immutable
// facts — the task row (persisted human decisions: aborted/done), the round
// executions (machine outcome) and the acceptance ledger (human 验收). Consumers
// (票 07 acceptance API 409-check + GET view, 票 11 kanban/timeline) call this
// and MUST NOT re-implement any branch of the matrix.
//
// Invariants (K3):
//   • a v4 task NEVER derives 'failed' — failure is a round-level fact; a
//     terminal round without an acceptance row parks the phase (and task) in
//     'awaiting_review' ("失败不是红死状态而是待处理", US8).
//   • 'draft' is not in the v4 output enum (the board's 草稿 column reads the
//     persisted status; the derived view describes the execution contract).
//   • 'paused' is the ONLY output value with no persisted counterpart: the truth
//     lives on executions.status='paused' (ExecutionLifecycle.pause), and nothing
//     ever writes a paused task row. The host of a pause is the RUN, not the task
//     — that is what keeps the execution layer unaware of tasks, since not every
//     workflow has one bound.
//   • persisted 'aborted'/'done' outrank everything (task status only mirrors
//     human decisions — abort beats an in-flight exec, abort beats a pause, done
//     beats archiving).
//   • suspension outranks 'archiving'/'awaiting_review' but not 'running': those
//     two are states that can still make progress, so a brake must beat them, or
//     the card would sit in 待验收 with its accept button lit.
//   • last phase accepted → 'archiving' (K6; 票 08 flips the ledger to done
//     once git succeeds, which is why 'done' can only come from the row).
//   • Non-v4 (v3/generic/composite) tasks pass through untouched:
//     isV4=false, phaseViews=[], taskStatus mirrors task.status verbatim
//     ('failed' stays legal there — K13 旧链零破坏).
//
// PURE: no DAO / DB / fs / network / clock imports (票 03 AC3) — everything it
// needs arrives as arguments; same input → same output, idempotent (spec R2
// makes acceptance-ledger/optimistic-lock interleaving safe: any read order
// yields a consistent view).

import {
  taskSpecSchema,
  type TaskPhase,
  type TaskSpec,
  type TaskStatus,
} from "@octopus/shared"
import type {
  ExecutionRow,
  TaskPhaseAcceptanceRow,
  TaskRow,
} from "../../db/types"

// ── Output vocabulary ────────────────────────────────────────────────

/** v4-derived task status enum (AC2 — no 'failed', no 'draft'). Shared's
 *  TaskStatusSchema now carries 'awaiting_review'/'archiving' (extended by
 *  ticket 07); this LOCAL union stays deliberately narrower than TaskStatus —
 *  it is the derive output vocabulary (draft/failed/aborted-persisted are
 *  input-side passthrough states that derivation itself never produces for
 *  v4), not a mirror of the wire enum. Review ⑧: comment corrected, type kept. */
export type DerivedTaskStatus =
  | "ready"
  | "running"
  | "paused"
  | "awaiting_review"
  | "archiving"
  | "done"
  | "aborted"

/** Per-phase display status (timeline rows, 票 11). 'pending' covers both
 *  "never started" and "only rejected rounds so far, next round not dispatched
 *  yet" — the latter is a transient window inside the 票 07 request. */
export type DerivedPhaseStatus =
  | "pending"
  | "running"
  | "paused"
  | "awaiting_review"
  | "accepted"

/** Normalized outcome of one round's execution row. Terminal = succeeded |
 *  failed | cancelled; pending/running/paused are in-flight (all three hold the
 *  task's slot — see isInFlight). */
export type TaskRoundState =
  | "pending"
  | "running"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled"

/** Human decision overlay on a round (latest ledger row wins). */
export type TaskRoundDecision = "accepted" | "rejected"

// ── Input contracts (structural Picks — full DB rows satisfy them) ───

/** Only these TaskRow columns feed the derivation. */
export type DeriveTaskInput = Pick<TaskRow, "id" | "status" | "task_spec">
/** Only these ExecutionRow columns feed the derivation. `workflow_ref` rides
 *  along for the round view's ACTUALLY-RUN display (ADR-0018 打回路由: a fix
 *  round executes task-fix while the phase stays bound to its dev flow — the
 *  timeline must show what really ran, not the frozen binding). */
export type DeriveExecutionInput = Pick<
  ExecutionRow,
  "id" | "status" | "workflow_ref" | "phase_index" | "round_index" | "created_at"
>
/** Only these ledger columns feed the derivation. */
export type DeriveAcceptanceInput = Pick<
  TaskPhaseAcceptanceRow,
  "id" | "phase_index" | "round_index" | "decision" | "decided_at"
>

// ── Views ────────────────────────────────────────────────────────────

export interface TaskRoundView {
  roundIndex: number
  /** The round's execution row (latest one if the same (phase,round) carries
   *  duplicates — chain-level retry belt, defensive tie-break by created_at). */
  exec: DeriveExecutionInput
  state: TaskRoundState
  /** Latest human decision on this exact round, or null (未验收). */
  decision: TaskRoundDecision | null
}

export interface TaskPhaseView {
  /** 1-based, mirrors TaskPhase.index. */
  index: number
  name: string
  slug: string
  /** Display passthrough for the timeline (票 11: 名/状态/workflow/round 史). */
  workflowRef: string
  status: DerivedPhaseStatus
  /** Ascending by roundIndex. Rounds exist only where an execution exists
   *  (1 exec = 1 round, K4) — a ledger row for a missing exec is ignored in
   *  this list but still counts toward acceptedRound (账本为真相). */
  rounds: TaskRoundView[]
  /** Max round_index seen (null = never started) — 票 07's 409 round-match. */
  currentRound: number | null
  /** Round carrying the effective 'accepted' decision (null = not accepted). */
  acceptedRound: number | null
  /** Round that is terminal-and-unreviewed while the phase is awaiting_review
   *  (null otherwise) — 票 07 validates the acceptance targets exactly this. */
  awaitingRound: number | null
}

export interface TaskView {
  /** v4: always within DerivedTaskStatus (never 'failed', AC2).
   *  Non-v4: verbatim mirror of task.status. */
  taskStatus: TaskStatus | DerivedTaskStatus
  isV4: boolean
  /** [] for non-v4; one entry per spec.phases (ascending index) for v4. */
  phaseViews: TaskPhaseView[]
}

// ── exec status → round state ────────────────────────────────────────

// Vocabulary: shared ExecutionStatusSchema (workspace.ts). Terminal statuses:
// completed / completed_with_failures / failed / rejected / cancelled /
// skipped. Everything else (pending / running / paused / pending_approval /
// pending_resume / FUTURE additions) is in-flight — an unrecognized status
// must never fabricate awaiting_review, so the default leans toward "running".
const ROUND_STATE_BY_EXEC_STATUS: Record<string, TaskRoundState> = {
  pending: "pending",
  running: "running",
  // The task-pause work's whole input: ExecutionLifecycle.pause() hard-kills the
  // in-flight node and lands the execution on 'paused' — that row IS the pause, and
  // the task side only ever derives it (no persisted task status, no migration).
  paused: "paused",
  // Approval / interaction waits are the engine ALIVE and parked in a human's queue —
  // nobody pressed pause, so they must NOT display as 已暂停 (that would bury the
  // actual to-do, "需要你审批").
  pending_approval: "running",
  pending_resume: "running",
  completed: "succeeded",
  // Chain finished but some nodes failed — still terminal for the human gate.
  completed_with_failures: "succeeded",
  failed: "failed",
  rejected: "failed",
  cancelled: "cancelled",
  skipped: "cancelled",
  // 'aborted' is written straight to the row by both task abort and reconcile's reap
  // (it is deliberately absent from ExecutionStatusSchema). Without this key the
  // `?? "running"` default reported a dead round as live, pinning the card at 执行中
  // forever — and that state closes all three human exits (accept needs
  // awaiting_review, trigger needs persisted 'ready', advance needs accepted→pending),
  // leaving only 中止/退回草稿. Same terminal bucket as skipped.
  aborted: "cancelled",
}

function roundStateOf(execStatus: string): TaskRoundState {
  return ROUND_STATE_BY_EXEC_STATUS[execStatus] ?? "running"
}

/** Actively burning compute — 'pending' counts (queued, not yet claimed). 'paused'
 *  is deliberately excluded: the phase/task branches need 「有东西真在跑」 distinct
 *  from 「人在踩刹车」, and running has to win when both somehow appear.
 *
 *  Note the separation this encodes: 'paused' is still IN FLIGHT in the occupancy
 *  sense (it holds ux_exec_task_active's latch and one concurrency credit), and the
 *  branches below rely on that — a paused round must never reach the
 *  「末轮终态且无验收」 awaiting_review branch, or the acceptance gate opens mid-pause. */
function isActivelyRunning(state: TaskRoundState): boolean {
  return state === "pending" || state === "running"
}

// ── internals ────────────────────────────────────────────────────────

function parseV4Spec(taskSpecJson: string): TaskSpec | null {
  let raw: unknown
  try {
    raw = JSON.parse(taskSpecJson)
  } catch {
    return null
  }
  const parsed = taskSpecSchema.safeParse(raw)
  if (!parsed.success) return null
  // format is the SOLE v4 discriminator (K13).
  if (parsed.data.format !== "v4") return null
  return parsed.data
}

/** Ledger decision normalized; anything else → null (treated as no decision). */
function normalizeDecision(decision: string): TaskRoundDecision | null {
  if (decision === "accepted" || decision === "rejected") return decision
  return null
}

/** Latest row per round_index from an already-arbitrary list, tie-break:
 *  time field asc → id asc (matches AcceptanceDAO ordering conventions). */
function latestByRound<T extends { id: string }>(
  rows: readonly T[],
  roundOf: (r: T) => number | null,
  timeOf: (r: T) => string,
): Map<number, T> {
  const out = new Map<number, T>()
  for (const r of rows) {
    const ri = roundOf(r)
    if (ri === null) continue
    const prev = out.get(ri)
    if (
      prev === undefined ||
      timeOf(r) > timeOf(prev) ||
      (timeOf(r) === timeOf(prev) && r.id >= prev.id)
    ) {
      out.set(ri, r)
    }
  }
  return out
}

function buildPhaseView(
  phase: TaskPhase,
  phaseExecs: readonly DeriveExecutionInput[],
  phaseAccs: readonly DeriveAcceptanceInput[],
): TaskPhaseView {
  const execByRound = latestByRound(
    phaseExecs,
    (e) => e.round_index,
    (e) => e.created_at,
  )
  const accByRound = latestByRound(
    phaseAccs,
    (a) => a.round_index,
    (a) => a.decided_at,
  )

  const rounds: TaskRoundView[] = [...execByRound.keys()]
    .sort((a, b) => a - b)
    .map((ri) => {
      const exec = execByRound.get(ri) as DeriveExecutionInput
      return {
        roundIndex: ri,
        exec,
        state: roundStateOf(exec.status),
        decision: normalizeDecision(accByRound.get(ri)?.decision ?? "") ,
      }
    })

  let acceptedRound: number | null = null
  for (const [ri, a] of accByRound) {
    if (normalizeDecision(a.decision) === "accepted" && (acceptedRound === null || ri > acceptedRound)) {
      acceptedRound = ri
    }
  }

  let status: DerivedPhaseStatus
  if (acceptedRound !== null) {
    // 人的放行覆盖一切 display 状态 (含在跑 exec 的异常窗口, 也含踩着刹车的轮).
    status = "accepted"
  } else if (rounds.some((r) => isActivelyRunning(r.state))) {
    status = "running"
  } else if (rounds.some((r) => r.state === "paused")) {
    // 暂停必须排在 awaiting_review 之前: 落到 awaiting_review 就等于向验收闸
    // (tasks-service 认的是 awaiting_review ∧ awaitingRound === round_index) 放行,
    // 而需求明令暂停期间不可验收 —— 且这条错法既无编译错误也无红测.
    status = "paused"
  } else if (rounds.length > 0 && rounds[rounds.length - 1].decision === null) {
    // 最新轮到达终态 (成/败/取消) 且无验收记录 → 待验收.
    status = "awaiting_review"
  } else {
    // 未开跑, 或最新轮已被 rejected 而新 round 尚未落行 (票 07 同请求内瞬态).
    status = "pending"
  }

  const currentRound = rounds.length > 0 ? rounds[rounds.length - 1].roundIndex : null
  return {
    index: phase.index,
    name: phase.name,
    slug: phase.slug,
    workflowRef: phase.workflowRef,
    status,
    rounds,
    currentRound,
    acceptedRound,
    awaitingRound: status === "awaiting_review" ? currentRound : null,
  }
}

// ── the one truth ────────────────────────────────────────────────────

/**
 * Derive the display state of a task from its row + round executions +
 * acceptance ledger. Pure & idempotent — safe to call on every GET / every
 * SSE fold (spec R2). `executions` / `acceptances` must already be scoped to
 * THIS task by the caller (票03: `executions.task_id` — the join through the scheduler's tables is gone);
 * rows for other phases/rounds are ignored defensively, never throw.
 */
export function deriveTaskView(
  task: DeriveTaskInput,
  executions: readonly DeriveExecutionInput[],
  acceptances: readonly DeriveAcceptanceInput[],
): TaskView {
  const spec = parseV4Spec(task.task_spec)
  if (!spec) {
    // v3 / generic / composite / corrupt spec → verbatim mirror (K13).
    return { taskStatus: task.status as TaskStatus, isV4: false, phaseViews: [] }
  }

  const phases = spec.phases ?? []
  const phaseViews = phases.map((p) =>
    buildPhaseView(
      p,
      executions.filter((e) => e.phase_index === p.index),
      acceptances.filter((a) => a.phase_index === p.index),
    ),
  )

  // Global in-flight scan: includes orphan rows (phase_index outside spec —
  // e.g. a spec-r2 rewrite dropped a phase while its round still runs).
  const anyRunning = executions.some(
    (e) => e.phase_index !== null && isActivelyRunning(roundStateOf(e.status)),
  )

  // Suspension is read off phaseViews, NOT via the orphan-inclusive global scan above —
  // deliberately asymmetric. An orphaned paused round (spec-r2 dropped its phase while
  // the round sat paused) would otherwise pin the task at 'paused' forever, since
  // reconcile now exempts paused rows from the strand reap. A phase the spec no longer
  // declares must not be able to hold the whole task hostage. 'running' keeps the global
  // scan to preserve 票 03's existing orphan behaviour.
  const anyPaused = phaseViews.some((p) => p.status === "paused")

  const last = phaseViews.length > 0 ? phaseViews[phaseViews.length - 1] : null
  let taskStatus: DerivedTaskStatus
  if (task.status === "aborted") {
    taskStatus = "aborted" // 中止优先 (票 03 prompt 不变量序)
  } else if (task.status === "done") {
    taskStatus = "done" // 归档器 (票 08) 是 done 的唯一写者
  } else if (anyRunning) {
    taskStatus = "running" // 有东西真在跑就别说自己停了
  } else if (anyPaused) {
    // 踩刹车压过「等你放行」与「归档编排中」—— 这两个都是可以继续推进的状态,
    // 让它们赢会让卡片停在待验收列、验收按钮照旧亮着, 与「暂停期间不可验收」冲突.
    taskStatus = "paused"
  } else if (last !== null && last.status === "accepted") {
    taskStatus = "archiving" // K6: 末验收 → archiving
  } else if (phaseViews.some((p) => p.status === "awaiting_review")) {
    taskStatus = "awaiting_review"
  } else {
    taskStatus = "ready" // 含 draft 镜像 + accepted 中段等待下一轮
  }

  return { taskStatus, isV4: true, phaseViews }
}
