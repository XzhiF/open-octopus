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
  /** probe items carry the literal command (P2 will wire a ▶单跑; present now). */
  probe?: { command: string }
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
  coverage: { found: string[]; missing: string[] }
}

// ── on-disk checks file (acceptance-checks-r{N}.json) ────────────────

export type CheckDecision = "pass" | "fail" | "skip"
export interface CheckEntry {
  decision: CheckDecision
  /** required when decision is fail/skip — rides into reject feedback / carryover. */
  note: string
  at: string
}
export interface ChecksFile {
  version: "1"
  task_id?: string
  round_index?: number
  checks: Record<string, CheckEntry>
}
