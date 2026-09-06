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
//   • persisted 'aborted'/'done' outrank everything (task status only mirrors
//     human decisions — abort beats an in-flight exec, done beats archiving).
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
  | "awaiting_review"
  | "accepted"

/** Normalized outcome of one round's execution row. Terminal = succeeded |
 *  failed | cancelled; pending/running are in-flight. */
export type TaskRoundState =
  | "pending"
  | "running"
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
  paused: "running",
  pending_approval: "running",
  pending_resume: "running",
  completed: "succeeded",
  // Chain finished but some nodes failed — still terminal for the human gate.
  completed_with_failures: "succeeded",
  failed: "failed",
  rejected: "failed",
  cancelled: "cancelled",
  skipped: "cancelled",
}

function roundStateOf(execStatus: string): TaskRoundState {
  return ROUND_STATE_BY_EXEC_STATUS[execStatus] ?? "running"
}

function isInFlight(state: TaskRoundState): boolean {
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
    // 人的放行覆盖一切 display 状态 (含在跑 exec 的异常窗口).
    status = "accepted"
  } else if (rounds.some((r) => isInFlight(r.state))) {
    status = "running"
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
 * THIS task by the caller (票 07 joins via the task's schedules/workspaces);
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
  const anyInFlight = executions.some(
    (e) => e.phase_index !== null && isInFlight(roundStateOf(e.status)),
  )

  const last = phaseViews.length > 0 ? phaseViews[phaseViews.length - 1] : null
  let taskStatus: DerivedTaskStatus
  if (task.status === "aborted") {
    taskStatus = "aborted" // 中止优先 (票 03 prompt 不变量序)
  } else if (task.status === "done") {
    taskStatus = "done" // 归档器 (票 08) 是 done 的唯一写者
  } else if (anyInFlight) {
    taskStatus = "running"
  } else if (last !== null && last.status === "accepted") {
    taskStatus = "archiving" // K6: 末验收 → archiving
  } else if (phaseViews.some((p) => p.status === "awaiting_review")) {
    taskStatus = "awaiting_review"
  } else {
    taskStatus = "ready" // 含 draft 镜像 + accepted 中段等待下一轮
  }

  return { taskStatus, isV4: true, phaseViews }
}
