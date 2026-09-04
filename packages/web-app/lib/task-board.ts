// packages/web-app/lib/task-board.ts
//
// /tasks kanban columns + grouping for the first-class `tasks` domain (v2-D1,
// SG14 — read `Task`, NOT `SchedulerJob`).
//
// task-phase-redesign v4 (票 11, K3/US7/US8): the board is now the FIVE-column
// lifecycle 草稿/待执行/执行中/待验收/完成:
//   draft            → 草稿
//   ready            → 待执行
//   running+archiving→ 执行中 (archiving 卡片加 ⚠归档中 徽标 — K6 末验收态仍是
//                       「在跑」的人机语义；票 08 是 done 唯一写者)
//   awaiting_review  → 待验收 (琥珀高亮 — US8「失败不是红死状态而是待处理」)
//   done+failed+aborted → 完成 (终态列；failed/aborted 仅 v3 可持久 (K13)，
//                       卡片状态行自证真实终态)
//
// v4 列归属用 `effectiveStatusOf`（derived.taskStatus 优先）：票 07 活体交互 #1
// 指出首 phase round 终态会把**持久** tasks.status 镜像写成 done/failed，若按
// 持久态归列，待验收任务会错进「完成」列。派生不存 = 无镜像竞态 (K3)。
//
// `groupTasksByStatus` still buckets by the RAW status (8 exhaustive buckets —
// the Record<TaskStatus, …> exhaustiveness point that forces new states to be
// handled, 票 07 发现的 web typecheck 红线); the column layer folds buckets.

import type { Task, TaskStatus } from "@octopus/shared"
import type { TaskDerivedView, TaskPhaseView } from "@/lib/tasks-api"

/** All persisted/displayable task states (v4 K3: + awaiting_review/archiving). */
export type TaskBoardStatus = TaskStatus

/** The five kanban columns (K3 board contract, 票 11 AC2). Ids stay inside the
 *  status vocabulary so `[data-task-column="draft"|"ready"|"running"|
 *  "awaiting_review"|"done"]` selectors keep working; the two v4-only display
 *  states fold into 执行中 (archiving) and 完成 (failed/aborted, v3-only). */
export type TaskBoardColumnId =
  | "draft"
  | "ready"
  | "running"
  | "awaiting_review"
  | "done"

export interface TaskBoardColumn {
  id: TaskBoardColumnId
  label: string
}

/** Five columns in lifecycle order (草稿→待执行→执行中→待验收→完成). */
export const TASK_COLUMNS: readonly TaskBoardColumn[] = [
  { id: "draft", label: "草稿" },
  { id: "ready", label: "待执行" },
  { id: "running", label: "执行中" },
  { id: "awaiting_review", label: "待验收" },
  { id: "done", label: "完成" },
] as const

/** Every persisted status lands in exactly one column (exhaustive against the
 *  shared TaskStatusSchema — adding a state server-side breaks typecheck here
 *  on purpose, 票 07 finding #2). */
export const STATUS_TO_COLUMN: Record<TaskStatus, TaskBoardColumnId> = {
  draft: "draft",
  ready: "ready",
  running: "running",
  archiving: "running", // 归档中留在执行中列 (⚠徽标由卡片渲染)
  awaiting_review: "awaiting_review",
  done: "done",
  failed: "done", // v3-only 终态归「完成」(terminal) 列，卡片状态行自证
  aborted: "done", // 同上
}

/** Reverse view: which buckets each column flattens (render order preserved). */
export const COLUMN_STATUSES: Record<TaskBoardColumnId, readonly TaskStatus[]> = {
  draft: ["draft"],
  ready: ["ready"],
  running: ["running", "archiving"],
  awaiting_review: ["awaiting_review"],
  done: ["done", "failed", "aborted"],
}

export type TasksByStatus = Record<TaskBoardStatus, Task[]>

/** Group tasks into the 8 lifecycle buckets (raw persisted status). Tasks whose
 *  status is not a known column (defensive against future enum additions /
 *  legacy rows) are dropped rather than crashing the kanban. Does NOT mutate
 *  the input array. Callers pass EFFECTIVE statuses (see `effectiveStatusOf`). */
export function groupTasksByStatus(tasks: Task[]): TasksByStatus {
  const grouped: TasksByStatus = {
    draft: [],
    ready: [],
    running: [],
    awaiting_review: [],
    archiving: [],
    done: [],
    failed: [],
    aborted: [],
  }
  for (const task of tasks) {
    const status = task.status as string
    if (status in grouped) {
      ;(grouped as Record<string, Task[]>)[status].push(task)
    }
  }
  return grouped
}

/** Flatten the buckets belonging to one column (column render order). */
export function tasksForColumn(grouped: TasksByStatus, column: TaskBoardColumnId): Task[] {
  return COLUMN_STATUSES[column].flatMap((st) => grouped[st])
}

/** Board column status for a task: derived.taskStatus is the truth for v4
 *  (K3 派生不存; 持久 done/failed 镜像会把待验收任务错归「完成」列 — 票 07
 *  活体交互 #1), EXCEPT persisted draft (derive has no 'draft' output — 草稿列
 *  按设计读持久态) and persisted aborted (人的决定，derive 同样输出 aborted，
 *  但 derived 缺失时也要正确归位). v3 / derived 未加载 → 持久态 verbatim. */
export function effectiveStatusOf(task: Task, derived: TaskDerivedView | undefined): TaskStatus {
  if (!derived || !derived.isV4) return task.status
  if (task.status === "draft" || task.status === "aborted") return task.status
  return derived.taskStatus
}

// ── v4 卡片角标 `Phase i/n · Round m` (US7, 票 11 AC2/AC3) ─────────────

export interface PhaseBadge {
  /** 1-based position of the CURRENT phase = first phaseView whose status is
   *  not 'accepted' (全部 accepted → 末位，覆盖 archiving/done 窗口). */
  phase: number
  /** n = phaseViews.length. */
  total: number
  /** awaitingRound ?? currentRound of the current phase; null = 该 phase 未开跑. */
  round: number | null
}

export function computePhaseBadge(derived: TaskDerivedView | undefined): PhaseBadge | null {
  if (!derived || !derived.isV4 || derived.phaseViews.length === 0) return null
  const views = derived.phaseViews
  const current: TaskPhaseView = views.find((p) => p.status !== "accepted") ?? views[views.length - 1]
  return {
    phase: current.index,
    total: views.length,
    round: current.awaitingRound ?? current.currentRound,
  }
}

// ── ⏳ 超预算徽标 (K2/US17/D18 advisory, 票 11 AC4) ──────────────────

/** K2 拆分预算：coding agent 1h（含 E2E ≤1.5h）→ 1.5h 默认阈值. */
export const PHASE_BUDGET_DEFAULT_MS = 5_400_000

/** Client-side threshold (advisory only — 运行期不做真杀, D18):
 *  `NEXT_PUBLIC_PHASE_BUDGET_MS` (Next inlines NEXT_PUBLIC_* at build; e2e/
 *  dev 注入小值验 ⏳ 出现) ?? 1.5h. NaN / ≤0 falls back to the default.
 *  静态成员访问是硬要求 — 动态 `process.env[key]` 不会被 Next 编译期替换. */
export function phaseBudgetMs(): number {
  const raw = process.env.NEXT_PUBLIC_PHASE_BUDGET_MS
  const n = raw === undefined || raw === "" ? NaN : Number(raw)
  return Number.isFinite(n) && n > 0 ? n : PHASE_BUDGET_DEFAULT_MS
}

/** The first IN-FLIGHT round (pending/running) that has been executing longer
 *  than `budgetMs`, or null. derived 只带 exec.created_at（无 completed_at），
 *  所以超预算徽标天然只对在跑轮成立 — 终态轮的用时核对归票 12 三栏执行摘要. */
export function overBudgetRoundOf(
  derived: TaskDerivedView | undefined,
  now: number,
  budgetMs: number,
): { phaseIndex: number; roundIndex: number } | null {
  if (!derived || !derived.isV4) return null
  for (const pv of derived.phaseViews) {
    for (const r of pv.rounds) {
      if (r.state !== "pending" && r.state !== "running") continue
      const started = Date.parse(r.exec.created_at)
      if (Number.isNaN(started)) continue
      if (now - started > budgetMs) return { phaseIndex: pv.index, roundIndex: r.roundIndex }
    }
  }
  return null
}
