// packages/server/src/services/tasks/playbook-types.ts
//
// 验收面 v2.1 数据契约(ADR-0022 / spec S2·S3)。Server-authoritative shapes;
// web mirrors these in lib/tasks-api.ts (same treatment as VerifySummary —
// the wire contract, hand-duplicated on both ends, tsc catches drift via the
// route's declared return type). ChecksFile is the on-disk JSON the acceptance
// panel writes via PUT /:id/home-file (acceptance-checks-r{N}.json).

export type PlaybookItemKind = "walk" | "probe" | "claim"

export interface PlaybookItem {
  /** stable across recompile (source-derived + seq) — the checkbox key. */
  id: string
  op: string
  expect: string
  /** 反假跑: the real pass condition (from ticket Pass criteria / plan 反假跑). */
  evidence?: string
  /** probe items carry the literal command (面板 [▶执行] 就地跑; v2.2 已接线). */
  probe?: { command: string }
  /** 生命周期命令(起服/就绪轮询/收尾)。历史编译清单的遗留字段；
   *  验收方案（v2）不再产出它，保留只为旧 payload 解码不漂移。 */
  lifecycle?: "start" | "ready" | "teardown"
  /** ── 验收方案扩展（2026-10-31 两层化；缺 tier 时按场景处理）── */
  /** case=人验收场景（可判定）；check=机器证据（只读，不判定）。 */
  tier?: "case" | "check"
  title?: string
  story?: string
  /** 人层场景起点（不写命令）。 */
  setup?: string
  /** 人层场景步骤（open / do / observe）。 */
  steps?: import("./acceptance-plan-types").PlanStep[]
  tickets?: string[]
  /** 机器证据的按需复核命令（不自动跑）。 */
  recheck?: string
  // —— 旧 v1 方案字段（历史消息兼容；新方案不再写入）——
  ticket?: string
  howTo?: import("./acceptance-plan-types").PlanHowTo[]
  criteria?: string[]
  evidenceRefs?: import("./acceptance-plan-types").PlanEvidenceRef[]
  machine?: import("./acceptance-plan-types").PlanMachine
}

export interface PlaybookSection {
  kind: PlaybookItemKind
  title: string
  /** provenance, e.g. "issues/11-e2e-full-link.md" / "e2e-test-plan.md". */
  source: string
  items: PlaybookItem[]
}

export interface PlaybookCarryover {
  id: string
  fromRound: number
  decision: "skipped" | "failed"
  note?: string
  op: string
  expect: string
}

export interface PlaybookBudget {
  steps: number
  estMin: number
  over: boolean
  degraded: boolean
}

export interface PlaybookPayload {
  /** false = no source compiled any step (all-contract-files-missing). */
  available: boolean
  goal: string
  /** round-report has a `## Spec 修订` block — expectations may have shifted. */
  specRevised: boolean
  budget: PlaybookBudget
  sections: PlaybookSection[]
  /** ticket-name → full AC list (rendered collapsed; NOT checkable here). */
  finePrint: Array<{ ticket: string; acs: string[] }>
  carryover: PlaybookCarryover[]
  coverage: {
    found: string[]
    missing: string[]
    /** v2 方案：故事 → 场景、AC → 机器证据的覆盖登记。 */
    stories?: Array<{ story: string; case_id: string }>
    acs?: Array<{ ac: string; check_ids: string[] }>
  }
  /** 验收方案状态（2026-10-30）：ready = 本轮清单来自规划 Agent；
   *  generating/failed/missing = 无清单，窗口显示方案状态卡（无场景硬闸）。 */
  plan?: import("./acceptance-plan-types").PlanSummary
  /** 方案生成时 server 校验发现的诚实缺口（缺证据路径等）。 */
  planWarnings?: string[]
}

// ── on-disk checks file (acceptance-checks-r{N}.json) ────────────────

export type CheckDecision = "pass" | "fail" | "skip"
/** 剧本探针单发执行（POST /:id/playbook/run）的同步结果。 */
export type ProbeState = "passed" | "failed" | "timeout"
export interface ProbeRunResult {
  state: ProbeState
  exit_code: number | null
  duration_ms: number
  tail: string[]
}
export interface CheckEntry {
  decision: CheckDecision
  /** required when decision is fail/skip — rides into reject feedback / carryover. */
  note: string
  at: string
  /** 最近一次机器探针盖章（面板据结果自动写 ✓/✗ 时留痕,carryover 也能看到）。 */
  probe?: { state: ProbeState; exit_code: number | null; at: string }
}
export interface ChecksFile {
  version: "1"
  task_id?: string
  round_index?: number
  checks: Record<string, CheckEntry>
}
