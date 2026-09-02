// packages/server/src/services/tasks/__tests__/derive-task-view.test.ts
//
// Ticket 03 (task-phase-redesign) — deriveTaskView 状态矩阵单测.
//
// Seam under test: deriveTaskView(task, executions, acceptances) — the single
// source of truth for v4 task/phase state (K3/K6, Implementation Decision ③).
// Pure + zero IO (AC3): no DB, no fs, no clock in the tests below.
//
// AC1: parameterized matrix ≥12 combos — running/succeeded/failed execs ×
//      accepted/rejected/no acceptance × first/middle/last phase.
// AC2: invariant — v4 output taskStatus ∈ {ready,running,awaiting_review,
//      archiving,done,aborted}, NEVER failed (失败归 round 层, K3).

import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { deriveTaskView } from "../derive-task-view"
import type {
  DeriveAcceptanceInput,
  DeriveExecutionInput,
  DeriveTaskInput,
  DerivedPhaseStatus,
  DerivedTaskStatus,
} from "../derive-task-view"

// ── Fixtures ────────────────────────────────────────────────────────

/** v4 task_spec with `phaseCount` phases (index 1..n, schema-valid shape). */
function v4Spec(phaseCount: number): string {
  return JSON.stringify({
    format: "v4",
    phases: Array.from({ length: phaseCount }, (_, i) => ({
      index: i + 1,
      name: `phase-${i + 1}`,
      slug: `p${i + 1}`,
      specPath: `.scratch/20260903/p${i + 1}/spec.md`,
      workflowRef: `built-in/task-dev`,
      inputValues: {},
    })),
  })
}

function task(spec: string, status: string): DeriveTaskInput {
  return { id: "t1", status, task_spec: spec }
}

let execSeq = 0
/** Execution fixture — created_at ascends with seq (exec tie-break relies on it). */
function ex(
  phaseIndex: number | null,
  roundIndex: number | null,
  status: string,
): DeriveExecutionInput {
  execSeq += 1
  return {
    id: `e${execSeq}`,
    status,
    phase_index: phaseIndex,
    round_index: roundIndex,
    created_at: `2026-09-03T00:00:${String(execSeq).padStart(2, "0")}.000Z`,
  }
}

let accSeq = 0
/** Acceptance-ledger fixture — decided_at ascends with seq (latest-wins). */
function acc(
  phaseIndex: number,
  roundIndex: number,
  decision: "accepted" | "rejected",
): DeriveAcceptanceInput {
  accSeq += 1
  return {
    id: `a${accSeq}`,
    phase_index: phaseIndex,
    round_index: roundIndex,
    decision,
    decided_at: `2026-09-03T10:00:${String(accSeq).padStart(2, "0")}.000Z`,
  }
}

/** Derived 6-value enum (AC2) — asserted toContain for EVERY matrix row. */
const V4_TASK_STATUSES: DerivedTaskStatus[] = [
  "ready",
  "running",
  "awaiting_review",
  "archiving",
  "done",
  "aborted",
]

// ── AC1 — full state matrix (≥12 combos) ────────────────────────────

interface MatrixCase {
  name: string
  /** tasks.status the service layer would have persisted (镜像输入). */
  persisted: string
  execs: [number, number, string][]
  accs: [number, number, "accepted" | "rejected"][]
  expectTask: DerivedTaskStatus
  expectPhaseStatuses: DerivedPhaseStatus[]
  /** [phaseIndex, roundIndex] the phase view must expose as awaitingRound. */
  expectAwaiting?: [number, number]
}

const MATRIX: MatrixCase[] = [
  // ── first phase (1/3) ──
  {
    name: "P1 · round running → task running",
    persisted: "running",
    execs: [[1, 1, "running"]],
    accs: [],
    expectTask: "running",
    expectPhaseStatuses: ["running", "pending", "pending"],
  },
  {
    name: "P1 · round succeeded · no acceptance → awaiting_review",
    persisted: "running",
    execs: [[1, 1, "completed"]],
    accs: [],
    expectTask: "awaiting_review",
    expectPhaseStatuses: ["awaiting_review", "pending", "pending"],
    expectAwaiting: [1, 1],
  },
  {
    name: "P1 · round FAILED · no acceptance → awaiting_review (never failed, K3)",
    persisted: "running",
    execs: [[1, 1, "failed"]],
    accs: [],
    expectTask: "awaiting_review",
    expectPhaseStatuses: ["awaiting_review", "pending", "pending"],
    expectAwaiting: [1, 1],
  },
  {
    name: "P1 · round cancelled (terminal) · no acceptance → awaiting_review",
    persisted: "running",
    execs: [[1, 1, "cancelled"]],
    accs: [],
    expectTask: "awaiting_review",
    expectPhaseStatuses: ["awaiting_review", "pending", "pending"],
  },
  {
    name: "P1 accepted · P2 not yet dispatched → ready (auto_advance 窗口)",
    persisted: "awaiting_review",
    execs: [[1, 1, "completed"]],
    accs: [[1, 1, "accepted"]],
    expectTask: "ready",
    expectPhaseStatuses: ["accepted", "pending", "pending"],
  },
  {
    name: "P1 accepted · P2 running (auto_advance fired) → running",
    persisted: "awaiting_review",
    execs: [
      [1, 1, "completed"],
      [2, 1, "running"],
    ],
    accs: [[1, 1, "accepted"]],
    expectTask: "running",
    expectPhaseStatuses: ["accepted", "running", "pending"],
  },
  {
    name: "P1 failed→rejected · r2 running → phase running",
    persisted: "awaiting_review",
    execs: [
      [1, 1, "failed"],
      [1, 2, "running"],
    ],
    accs: [[1, 1, "rejected"]],
    expectTask: "running",
    expectPhaseStatuses: ["running", "pending", "pending"],
  },
  {
    name: "P1 failed→rejected · r2 not dispatched → ready (瞬态, dispatch 前)",
    persisted: "awaiting_review",
    execs: [[1, 1, "failed"]],
    accs: [[1, 1, "rejected"]],
    expectTask: "ready",
    expectPhaseStatuses: ["pending", "pending", "pending"],
  },
  // ── middle phase (2/3) ──
  {
    name: "P2 · succeeded · no acceptance (P1 accepted) → awaiting_review",
    persisted: "running",
    execs: [
      [1, 1, "completed"],
      [2, 1, "completed"],
    ],
    accs: [[1, 1, "accepted"]],
    expectTask: "awaiting_review",
    expectPhaseStatuses: ["accepted", "awaiting_review", "pending"],
    expectAwaiting: [2, 1],
  },
  {
    name: "P2 · failed · no acceptance (P1 accepted) → awaiting_review",
    persisted: "running",
    execs: [
      [1, 1, "completed"],
      [2, 1, "failed"],
    ],
    accs: [[1, 1, "accepted"]],
    expectTask: "awaiting_review",
    expectPhaseStatuses: ["accepted", "awaiting_review", "pending"],
  },
  {
    name: "P2 · rejected then r2 running → running (middle)",
    persisted: "running",
    execs: [
      [1, 1, "completed"],
      [2, 1, "failed"],
      [2, 2, "running"],
    ],
    accs: [
      [1, 1, "accepted"],
      [2, 1, "rejected"],
    ],
    expectTask: "running",
    expectPhaseStatuses: ["accepted", "running", "pending"],
  },
  // ── last phase (3/3) ──
  {
    name: "P3 · succeeded · no acceptance → awaiting_review (last, not archiving yet)",
    persisted: "running",
    execs: [
      [1, 1, "completed"],
      [2, 1, "completed"],
      [3, 1, "completed"],
    ],
    accs: [
      [1, 1, "accepted"],
      [2, 1, "accepted"],
    ],
    expectTask: "awaiting_review",
    expectPhaseStatuses: ["accepted", "accepted", "awaiting_review"],
    expectAwaiting: [3, 1],
  },
  {
    name: "P3 · failed · no acceptance → awaiting_review",
    persisted: "running",
    execs: [
      [1, 1, "completed"],
      [2, 1, "completed"],
      [3, 1, "failed"],
    ],
    accs: [
      [1, 1, "accepted"],
      [2, 1, "accepted"],
    ],
    expectTask: "awaiting_review",
    expectPhaseStatuses: ["accepted", "accepted", "awaiting_review"],
  },
  {
    name: "P3 accepted (末 phase) → archiving (K6)",
    persisted: "awaiting_review",
    execs: [
      [1, 1, "completed"],
      [2, 1, "completed"],
      [3, 1, "completed"],
    ],
    accs: [
      [1, 1, "accepted"],
      [2, 1, "accepted"],
      [3, 1, "accepted"],
    ],
    expectTask: "archiving",
    expectPhaseStatuses: ["accepted", "accepted", "accepted"],
  },
  {
    name: "末 accepted + persisted done (归档全绿, 票 08) → done",
    persisted: "done",
    execs: [
      [1, 1, "completed"],
      [2, 1, "completed"],
      [3, 1, "completed"],
    ],
    accs: [
      [1, 1, "accepted"],
      [2, 1, "accepted"],
      [3, 1, "accepted"],
    ],
    expectTask: "done",
    expectPhaseStatuses: ["accepted", "accepted", "accepted"],
  },
  {
    name: "archiving retried mid-way: 末 accepted (r1 failed→r2 accepted) → archiving",
    persisted: "archiving",
    execs: [
      [1, 1, "failed"],
      [1, 2, "completed"],
      [2, 1, "completed"],
      [3, 1, "completed"],
    ],
    accs: [
      [1, 1, "rejected"],
      [1, 2, "accepted"],
      [2, 1, "accepted"],
      [3, 1, "accepted"],
    ],
    expectTask: "archiving",
    expectPhaseStatuses: ["accepted", "accepted", "accepted"],
  },
  // ── task-level overrides ──
  {
    name: "aborted 优先: persisted aborted 覆盖 running exec",
    persisted: "aborted",
    execs: [[1, 1, "running"]],
    accs: [],
    expectTask: "aborted",
    expectPhaseStatuses: ["running", "pending", "pending"],
  },
  {
    name: "fresh ready task · zero execs → ready, all phases pending",
    persisted: "ready",
    execs: [],
    accs: [],
    expectTask: "ready",
    expectPhaseStatuses: ["pending", "pending", "pending"],
  },
]

describe("AC1/AC2 — v4 状态矩阵 (deriveTaskView 全组合)", () => {
  it.each(MATRIX)("$name", (c) => {
    const view = deriveTaskView(
      task(v4Spec(c.expectPhaseStatuses.length), c.persisted),
      c.execs.map(([p, r, s]) => ex(p, r, s)),
      c.accs.map(([p, r, d]) => acc(p, r, d)),
    )
    expect(view.isV4).toBe(true)
    expect(view.taskStatus).toBe(c.expectTask)
    // AC2 invariant — checked on EVERY matrix row.
    expect(V4_TASK_STATUSES).toContain(view.taskStatus)
    expect(view.taskStatus).not.toBe("failed")
    expect(view.phaseViews.map((p) => p.status)).toEqual(c.expectPhaseStatuses)
    // phase index/name/slug mirror the spec (timeline keys, 票 11).
    view.phaseViews.forEach((p, i) => expect(p.index).toBe(i + 1))
    if (c.expectAwaiting) {
      const [pi, ri] = c.expectAwaiting
      expect(view.phaseViews[pi - 1].awaitingRound).toBe(ri)
    }
  })
})

// ── AC2 extras — invariants beyond the matrix ───────────────────────

describe("AC2 — 不变量补充", () => {
  it("draft v4 task derives to ready (输出 enum 无 draft)", () => {
    const view = deriveTaskView(task(v4Spec(2), "draft"), [], [])
    expect(view.taskStatus).toBe("ready")
    expect(V4_TASK_STATUSES).toContain(view.taskStatus)
  })

  it("v4 draft mid-authoring (format=v4, phases 缺省) → ready + 空视图, 不抛", () => {
    const view = deriveTaskView(task(JSON.stringify({ format: "v4" }), "draft"), [], [])
    expect(view.isV4).toBe(true)
    expect(view.phaseViews).toEqual([])
    expect(view.taskStatus).toBe("ready")
  })

  it("done 优先于 running exec (终态镜像, 归档器已收尾)", () => {
    const view = deriveTaskView(
      task(v4Spec(1), "done"),
      [ex(1, 1, "running")],
      [acc(1, 1, "accepted")],
    )
    expect(view.taskStatus).toBe("done")
  })

  it("aborted 优先于末 accepted (不覆盖人的中止)", () => {
    const view = deriveTaskView(
      task(v4Spec(1), "aborted"),
      [ex(1, 1, "completed")],
      [acc(1, 1, "accepted")],
    )
    expect(view.taskStatus).toBe("aborted")
  })

  it("unknown persisted status 不落 failed — 走派生分支", () => {
    const view = deriveTaskView(task(v4Spec(1), "ready"), [ex(1, 1, "failed")], [])
    expect(view.taskStatus).toBe("awaiting_review")
  })
})

// ── round/phase 视图内容 ─────────────────────────────────────────────

describe("phase view 内容 (rounds / acceptedRound / currentRound)", () => {
  it("rounds 按 round_index 升序, 携带 exec/state/decision", () => {
    const view = deriveTaskView(
      task(v4Spec(3), "running"),
      [ex(1, 1, "failed"), ex(1, 2, "running")],
      [acc(1, 1, "rejected")],
    )
    const p1 = view.phaseViews[0]
    expect(p1.rounds.map((r) => r.roundIndex)).toEqual([1, 2])
    expect(p1.rounds[0].state).toBe("failed")
    expect(p1.rounds[0].decision).toBe("rejected")
    expect(p1.rounds[1].state).toBe("running")
    expect(p1.rounds[1].decision).toBeNull()
    expect(p1.rounds[1].exec.status).toBe("running")
    expect(p1.currentRound).toBe(2)
    expect(p1.acceptedRound).toBeNull()
    expect(p1.awaitingRound).toBeNull()
  })

  it("workflowRef/slug/name 透传 spec (时间线渲染, 票 11)", () => {
    const view = deriveTaskView(task(v4Spec(1), "ready"), [], [])
    expect(view.phaseViews[0].name).toBe("phase-1")
    expect(view.phaseViews[0].slug).toBe("p1")
    expect(view.phaseViews[0].workflowRef).toBe("built-in/task-dev")
  })

  it("人的决定覆盖执行结果: failed round accepted → phase accepted", () => {
    const view = deriveTaskView(task(v4Spec(2), "running"), [ex(1, 1, "failed")], [acc(1, 1, "accepted")])
    expect(view.phaseViews[0].status).toBe("accepted")
    expect(view.phaseViews[0].acceptedRound).toBe(1)
    expect(view.phaseViews[0].awaitingRound).toBeNull()
    expect(view.taskStatus).toBe("ready") // 中段 accepted
  })

  it("同轮多行 ledger → decided_at 最新为准 (append-only 纠正语义)", () => {
    const view = deriveTaskView(
      task(v4Spec(1), "running"),
      [ex(1, 1, "completed")],
      [acc(1, 1, "rejected"), acc(1, 1, "accepted")], // a{seq+1} 更晚
    )
    expect(view.phaseViews[0].status).toBe("accepted")
    expect(view.phaseViews[0].rounds[0].decision).toBe("accepted")
  })

  it("同轮多 exec → created_at 最新为准 (链级重试兜底)", () => {
    const view = deriveTaskView(
      task(v4Spec(1), "running"),
      [ex(1, 1, "failed"), ex(1, 1, "running")], // 第二条 created_at 更晚
      [],
    )
    expect(view.phaseViews[0].rounds).toHaveLength(1)
    expect(view.phaseViews[0].rounds[0].state).toBe("running")
    expect(view.taskStatus).toBe("running")
  })

  it("平局 tie-break: 同 created_at 取 id 大者; 同轮多 accepted 取最大 round", () => {
    const tieExecs: DeriveExecutionInput[] = [
      { id: "e-a", status: "failed", phase_index: 1, round_index: 1, created_at: "2026-09-03T00:00:00.000Z" },
      { id: "e-b", status: "running", phase_index: 1, round_index: 1, created_at: "2026-09-03T00:00:00.000Z" },
    ]
    const view = deriveTaskView(task(v4Spec(1), "running"), tieExecs, [])
    expect(view.phaseViews[0].rounds).toHaveLength(1)
    expect(view.phaseViews[0].rounds[0].exec.id).toBe("e-b") // id tie-break

    // 异常账本 (同 phase 两行 accepted) → acceptedRound 取最大 round.
    const dupAccs: DeriveAcceptanceInput[] = [
      { id: "a-1", phase_index: 1, round_index: 1, decision: "accepted", decided_at: "2026-09-03T10:00:00.000Z" },
      { id: "a-2", phase_index: 1, round_index: 2, decision: "accepted", decided_at: "2026-09-03T10:00:01.000Z" },
    ]
    const v2 = deriveTaskView(task(v4Spec(1), "running"), [ex(1, 1, "completed"), ex(1, 2, "completed")], dupAccs)
    expect(v2.phaseViews[0].acceptedRound).toBe(2)
    expect(v2.taskStatus).toBe("archiving")
  })

  it("round_index NULL 的畸形 v4 exec: 不成 round, 但非终态仍保持 running", () => {
    const view = deriveTaskView(task(v4Spec(1), "running"), [ex(1, null, "running")], [])
    expect(view.phaseViews[0].rounds).toEqual([])
    expect(view.taskStatus).toBe("running")
  })

  it("账本有行但 exec 缺失 (归档清理后): acceptedRound 仍认账, rounds 保持空", () => {
    const view = deriveTaskView(task(v4Spec(1), "running"), [], [acc(1, 1, "accepted")])
    expect(view.phaseViews[0].acceptedRound).toBe(1)
    expect(view.phaseViews[0].status).toBe("accepted")
    expect(view.phaseViews[0].rounds).toEqual([])
    expect(view.taskStatus).toBe("archiving")
  })
})

// ── exec 过滤 ────────────────────────────────────────────────────────

describe("executions 过滤", () => {
  it("phase_index NULL 的 v3/generic exec 不参与派生", () => {
    const view = deriveTaskView(task(v4Spec(2), "running"), [ex(null, null, "running")], [])
    expect(view.taskStatus).toBe("ready")
    expect(view.phaseViews[0].rounds).toEqual([])
  })

  it("孤儿 phase_index (spec 外的轮) 非终态 → 仍保持 task running, 但不进 phaseViews", () => {
    const view = deriveTaskView(task(v4Spec(2), "running"), [ex(5, 1, "running")], [])
    expect(view.taskStatus).toBe("running")
    expect(view.phaseViews).toHaveLength(2)
    expect(view.phaseViews.every((p) => p.status === "pending")).toBe(true)
  })
})

// ── exec status → round state 映射表 ────────────────────────────────

describe("exec status → round state 映射", () => {
  const STATUS_MAP: [string, DerivedTaskStatus][] = [
    ["pending", "running"],
    ["running", "running"],
    ["paused", "running"],
    ["pending_approval", "running"],
    ["pending_resume", "running"],
    ["brand_new_status", "running"], // unknown → 保守视为在跑
    ["completed", "awaiting_review"],
    ["completed_with_failures", "awaiting_review"],
    ["failed", "awaiting_review"],
    ["rejected", "awaiting_review"],
    ["cancelled", "awaiting_review"],
    ["skipped", "awaiting_review"],
  ]

  it.each(STATUS_MAP)(
    "exec %s → round 非终态?→task %s",
    (execStatus, expectedTask) => {
      const view = deriveTaskView(task(v4Spec(1), "running"), [ex(1, 1, execStatus)], [])
      expect(view.taskStatus).toBe(expectedTask)
    },
  )

  it("映射明细: completed_with_failures=succeeded / rejected=failed / skipped=cancelled / paused=running", () => {
    const view = deriveTaskView(
      task(
        JSON.stringify({
          format: "v4",
          phases: [1, 2, 3, 4].map((i) => ({
            index: i,
            name: `p${i}`,
            slug: `p${i}`,
            specPath: `s${i}`,
            workflowRef: "built-in/wf",
            inputValues: {},
          })),
        }),
        "running",
      ),
      [ex(1, 1, "completed_with_failures"), ex(2, 1, "rejected"), ex(3, 1, "skipped"), ex(4, 1, "paused")],
      [],
    )
    expect(view.phaseViews[0].rounds[0].state).toBe("succeeded")
    expect(view.phaseViews[1].rounds[0].state).toBe("failed")
    expect(view.phaseViews[2].rounds[0].state).toBe("cancelled")
    expect(view.phaseViews[3].rounds[0].state).toBe("running")
  })
})

// ── 非 v4 (v3/generic) passthrough ──────────────────────────────────

describe("v3/generic passthrough (K13 三处不碰旧链)", () => {
  it("v3 spec → isV4=false, 原样镜像 status (failed 合法)", () => {
    const v3 = JSON.stringify({ goal: "g", ac: ["a"], task_type: "generic" })
    const view = deriveTaskView(task(v3, "failed"), [], [])
    expect(view.isV4).toBe(false)
    expect(view.taskStatus).toBe("failed")
    expect(view.phaseViews).toEqual([])
  })

  it("损坏的 task_spec JSON → passthrough 不抛", () => {
    const view = deriveTaskView(task("{not-json", "ready"), [], [])
    expect(view.isV4).toBe(false)
    expect(view.taskStatus).toBe("ready")
    expect(view.phaseViews).toEqual([])
  })

  it("schema 不合法的 task_spec (phases 缺 slug) → passthrough 不抛", () => {
    const bad = JSON.stringify({ format: "v4", phases: [{ index: 1, name: "x" }] })
    const view = deriveTaskView(task(bad, "running"), [], [])
    expect(view.isV4).toBe(false)
    expect(view.taskStatus).toBe("running")
  })
})

// ── AC3 — 纯函数零 IO ───────────────────────────────────────────────

describe("AC3 — 纯函数零 IO", () => {
  const src = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "derive-task-view.ts"),
    "utf-8",
  )

  it("不 import DAO / better-sqlite3 / fs / os / net (唯一真相可离线单测)", () => {
    expect(src).not.toMatch(/from\s+["'][^"']*(db\/dao|better-sqlite3)/)
    expect(src).not.toMatch(/from\s+["'](node:)?(fs|os|net|http|path|crypto)/)
  })

  it("无 async/await/Date — 同步纯函数, 幂等派生 (R2)", () => {
    expect(src).not.toMatch(/\basync\b|\bawait\b/)
    expect(src).not.toMatch(/Date\.now\(|new Date\(/)
  })

  it("输出对同一输入二次调用深度相等 (幂等)", () => {
    // Fixtures built ONCE — seq-based ids must not advance between calls.
    const inputs: [DeriveTaskInput, DeriveExecutionInput[], DeriveAcceptanceInput[]] = [
      task(v4Spec(2), "running"),
      [ex(1, 1, "completed"), ex(2, 1, "running")],
      [acc(1, 1, "accepted")],
    ]
    const a = deriveTaskView(...inputs)
    const b = deriveTaskView(...inputs)
    expect(a).toEqual(b)
  })
})
