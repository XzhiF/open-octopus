// task-phase-redesign 票 11: 五列看板 + v4 角标/超预算纯函数契约。
// (v2 时代的「6 列」断言由本票 AC2 五列契约取代 — 见票内 ## Exploration。)
import { describe, it, expect, vi } from "vitest"
import {
  TASK_COLUMNS,
  STATUS_TO_COLUMN,
  COLUMN_STATUSES,
  groupTasksByStatus,
  tasksForColumn,
  effectiveStatusOf,
  computePhaseBadge,
  phaseBudgetMs,
  overBudgetRoundOf,
  PHASE_BUDGET_DEFAULT_MS,
  type TaskBoardStatus,
} from "../task-board"
import type { Task } from "@octopus/shared"
import type { TaskDerivedView } from "@/lib/tasks-api"

function makeTask(partial: Partial<Task> & { id: string }): Task {
  return {
    org: "default",
    name: partial.id,
    status: "draft",
    task_spec: { goal: "g", ac: ["a"], resources: [], authoring_resources: [] },
    authoring_resources: [],
    resources: [],
    skills: [],
    project_ids: [],
    workflow_ref: undefined,
    version: 1,
    source_chat_session_id: null,
    deleted_at: null,
    created_at: "2026-08-17T00:00:00Z",
    updated_at: "2026-08-17T00:00:00Z",
    completed_at: null,
    ...partial,
  } as Task
}

// ── 五列结构 (K3 / AC2) ─────────────────────────────────────────────

describe("TASK_COLUMNS (票 11 五列)", () => {
  it("exposes the five v4 kanban columns in lifecycle order", () => {
    const ids = TASK_COLUMNS.map((c) => c.id)
    expect(ids).toEqual(["draft", "ready", "running", "awaiting_review", "done"])
  })

  it("labels each column in the spec lifecycle order (草稿/待执行/执行中/待验收/完成)", () => {
    const labels = TASK_COLUMNS.map((c) => c.label)
    expect(labels).toEqual(["草稿", "待执行", "执行中", "待验收", "完成"])
  })

  it("STATUS_TO_COLUMN is exhaustive over TaskStatusSchema (the 票 07 widening point)", () => {
    const all: TaskBoardStatus[] = [
      "draft", "ready", "running", "awaiting_review", "archiving",
      "done", "failed", "aborted",
    ]
    expect(Object.keys(STATUS_TO_COLUMN).sort()).toEqual([...all].sort())
    // 票 11 归属决策：awaiting_review→待验收列；archiving→执行中列；
    // failed/aborted（仅 v3 可持久，K13）→完成（终态）列。
    expect(STATUS_TO_COLUMN.awaiting_review).toBe("awaiting_review")
    expect(STATUS_TO_COLUMN.archiving).toBe("running")
    expect(STATUS_TO_COLUMN.failed).toBe("done")
    expect(STATUS_TO_COLUMN.aborted).toBe("done")
    expect(STATUS_TO_COLUMN.done).toBe("done")
    // Every mapped column id exists in TASK_COLUMNS (no orphan buckets).
    const columnIds = new Set(TASK_COLUMNS.map((c) => c.id))
    for (const col of Object.values(STATUS_TO_COLUMN)) expect(columnIds.has(col)).toBe(true)
    // COLUMN_STATUSES 与 STATUS_TO_COLUMN 互为逆映射且覆盖全部状态。
    const flattened = Object.values(COLUMN_STATUSES).flat().sort()
    expect(flattened).toEqual([...all].sort())
  })
})

// ── groupTasksByStatus + tasksForColumn ─────────────────────────────

describe("groupTasksByStatus", () => {
  it("returns all 8 buckets even when input is empty (反假跑, Record<TaskStatus> 穷尽)", () => {
    const grouped = groupTasksByStatus([])
    const bucketKeys = Object.keys(grouped).sort()
    const expected: TaskBoardStatus[] = [
      "draft", "ready", "running", "awaiting_review", "archiving",
      "done", "failed", "aborted",
    ]
    expect(bucketKeys).toEqual([...expected].sort())
    for (const key of expected) expect(grouped[key]).toEqual([])
  })

  it("places tasks into matching status bucket incl. the two v4 states", () => {
    const tasks = [
      makeTask({ id: "a", status: "draft" }),
      makeTask({ id: "b", status: "ready" }),
      makeTask({ id: "c", status: "running" }),
      makeTask({ id: "ar", status: "awaiting_review" }),
      makeTask({ id: "av", status: "archiving" }),
    ]
    const grouped = groupTasksByStatus(tasks)
    expect(grouped.draft.map((t) => t.id)).toEqual(["a"])
    expect(grouped.ready.map((t) => t.id)).toEqual(["b"])
    expect(grouped.running.map((t) => t.id)).toEqual(["c"])
    expect(grouped.awaiting_review.map((t) => t.id)).toEqual(["ar"])
    expect(grouped.archiving.map((t) => t.id)).toEqual(["av"])
    expect(grouped.done).toEqual([])
  })

  it("does not mutate the input tasks array", () => {
    const tasks = [makeTask({ id: "a", status: "draft" })]
    const snapshot = [...tasks]
    groupTasksByStatus(tasks)
    expect(tasks).toEqual(snapshot)
  })

  it("tasksForColumn folds archiving into 执行中 and failed/aborted into 完成", () => {
    const grouped = groupTasksByStatus([
      makeTask({ id: "r1", status: "running" }),
      makeTask({ id: "av", status: "archiving" }),
      makeTask({ id: "f", status: "failed" }),
      makeTask({ id: "ab", status: "aborted" }),
      makeTask({ id: "d", status: "done" }),
      makeTask({ id: "ar", status: "awaiting_review" }),
    ])
    expect(tasksForColumn(grouped, "running").map((t) => t.id)).toEqual(["r1", "av"])
    expect(tasksForColumn(grouped, "done").map((t) => t.id)).toEqual(["d", "f", "ab"])
    expect(tasksForColumn(grouped, "awaiting_review").map((t) => t.id)).toEqual(["ar"])
  })
})

// ── effectiveStatusOf — 派生优先的列归属 (票 07 活体交互 #1) ────────

describe("effectiveStatusOf", () => {
  const v4Derived = (taskStatus: string): TaskDerivedView =>
    ({ taskStatus, isV4: true, phaseViews: [] } as unknown as TaskDerivedView)

  it("v4: derived.taskStatus wins over the stale done/failed mirror (待验收归列)", () => {
    const t = makeTask({ id: "x", status: "done" }) // 首 phase round 完成被镜像写成 done
    expect(effectiveStatusOf(t, v4Derived("awaiting_review"))).toBe("awaiting_review")
    expect(STATUS_TO_COLUMN[effectiveStatusOf(t, v4Derived("awaiting_review"))]).toBe("awaiting_review")
  })

  it("v4: persisted draft stays 草稿 (derive 无 draft 输出)", () => {
    const t = makeTask({ id: "x", status: "draft" })
    expect(effectiveStatusOf(t, v4Derived("ready"))).toBe("draft")
  })

  it("v4: persisted aborted outranks (人的决定)", () => {
    const t = makeTask({ id: "x", status: "aborted" })
    expect(effectiveStatusOf(t, v4Derived("running"))).toBe("aborted")
  })

  it("v3 / derived 未加载 → 持久态 verbatim", () => {
    const t = makeTask({ id: "x", status: "failed" })
    expect(effectiveStatusOf(t, undefined)).toBe("failed")
    const v3 = { taskStatus: "failed", isV4: false, phaseViews: [] } as unknown as TaskDerivedView
    expect(effectiveStatusOf(t, v3)).toBe("failed")
  })
})

// ── computePhaseBadge — `Phase i/n · Round m` (US7) ─────────────────

function derivedOf(phaseViews: Array<Partial<TaskDerivedView["phaseViews"][number]> & { index: number; status: string }>): TaskDerivedView {
  return {
    taskStatus: "running",
    isV4: true,
    phaseViews: phaseViews.map((p) => ({
      name: `P${p.index}`, slug: `s${p.index}`, workflowRef: "builtin:x",
      rounds: [], currentRound: null, acceptedRound: null, awaitingRound: null,
      ...p,
    })),
  } as unknown as TaskDerivedView
}

describe("computePhaseBadge", () => {
  it("current = first NON-accepted phase position (票 11 契约)", () => {
    const d = derivedOf([
      { index: 1, status: "accepted" },
      { index: 2, status: "running", currentRound: 3 },
      { index: 3, status: "pending" },
    ])
    expect(computePhaseBadge(d)).toEqual({ phase: 2, total: 3, round: 3 })
  })

  it("awaiting_review phase reports awaitingRound (打回轮号可追溯)", () => {
    const d = derivedOf([
      { index: 1, status: "accepted", acceptedRound: 2, currentRound: 2 },
      { index: 2, status: "awaiting_review", currentRound: 2, awaitingRound: 2 },
    ])
    expect(computePhaseBadge(d)).toEqual({ phase: 2, total: 2, round: 2 })
  })

  it("never-started phase → round null (只渲染 Phase i/n)", () => {
    const d = derivedOf([{ index: 1, status: "pending" }])
    expect(computePhaseBadge(d)).toEqual({ phase: 1, total: 1, round: null })
  })

  it("all accepted (archiving/done 窗口) → last phase position", () => {
    const d = derivedOf([
      { index: 1, status: "accepted", currentRound: 1 },
      { index: 2, status: "accepted", currentRound: 2 },
    ])
    expect(computePhaseBadge(d)).toEqual({ phase: 2, total: 2, round: 2 })
  })

  it("v3 / missing derived → null (v3 卡不渲染角标，不回归)", () => {
    expect(computePhaseBadge(undefined)).toBeNull()
    expect(computePhaseBadge({ taskStatus: "running", isV4: false, phaseViews: [] })).toBeNull()
  })
})

// ── ⏳ 超预算 (AC4) ─────────────────────────────────────────────────

describe("phaseBudgetMs", () => {
  it("defaults to 1.5h (K2)", () => {
    vi.stubEnv("NEXT_PUBLIC_PHASE_BUDGET_MS", "")
    expect(phaseBudgetMs()).toBe(PHASE_BUDGET_DEFAULT_MS)
    expect(PHASE_BUDGET_DEFAULT_MS).toBe(5_400_000)
  })

  it("env-injected threshold wins (e2e/vitest 注入小值)", () => {
    vi.stubEnv("NEXT_PUBLIC_PHASE_BUDGET_MS", "1000")
    expect(phaseBudgetMs()).toBe(1000)
  })

  it("garbage / non-positive env falls back to default", () => {
    vi.stubEnv("NEXT_PUBLIC_PHASE_BUDGET_MS", "abc")
    expect(phaseBudgetMs()).toBe(PHASE_BUDGET_DEFAULT_MS)
    vi.stubEnv("NEXT_PUBLIC_PHASE_BUDGET_MS", "-5")
    expect(phaseBudgetMs()).toBe(PHASE_BUDGET_DEFAULT_MS)
    vi.unstubAllEnvs()
  })
})

describe("overBudgetRoundOf", () => {
  const now = Date.parse("2026-09-01T12:00:00Z")

  it("in-flight round older than budget → its (phase, round) id", () => {
    const d = derivedOf([
      {
        index: 1, status: "accepted", currentRound: 1,
      },
      {
        index: 2, status: "running", currentRound: 1,
        rounds: [
          {
            roundIndex: 1, state: "running", decision: null,
            exec: { id: "e2", status: "running", phase_index: 2, round_index: 1, created_at: "2026-09-01T10:00:00Z" },
          },
        ],
      },
    ])
    // 2h 在跑：3h 阈值 → 不标；1.5h 默认阈值 → ⏳ 命中 (AC4 env 缩阈值同理)
    expect(overBudgetRoundOf(d, now, 10_800_000)).toBeNull()
    expect(overBudgetRoundOf(d, now, PHASE_BUDGET_DEFAULT_MS)).toEqual({ phaseIndex: 2, roundIndex: 1 })
  })

  it("terminal rounds never flag (created_at-only payload, advisory 对在跑轮)", () => {
    const d = derivedOf([
      {
        index: 1, status: "awaiting_review", currentRound: 1, awaitingRound: 1,
        rounds: [
          {
            roundIndex: 1, state: "failed", decision: null,
            exec: { id: "e1", status: "failed", phase_index: 1, round_index: 1, created_at: "2026-08-01T00:00:00Z" },
          },
        ],
      },
    ])
    expect(overBudgetRoundOf(d, now, 1000)).toBeNull()
  })

  it("v3 / missing derived → null", () => {
    expect(overBudgetRoundOf(undefined, now, 1000)).toBeNull()
    expect(overBudgetRoundOf({ taskStatus: "running", isV4: false, phaseViews: [] }, now, 1000)).toBeNull()
  })
})
