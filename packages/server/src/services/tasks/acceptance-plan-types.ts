// packages/server/src/services/tasks/acceptance-plan-types.ts
//
// 验收方案（2026-10-30 AI-native 验收；2026-10-31 两层化）—— 轮末由独立
// 「验收规划 Agent」产出的机器可读验收方案，落盘在 phase 批次目录：
//
//   acceptance-plan-r{N}.json   — 正本（Zod 校验；本文件是唯一契约）
//   acceptance-plan-r{N}.md     — 人读版（Agent 写；缺失时 server 由 JSON 渲染）
//   acceptance-plan-r{N}.status.json — 生成状态（generating/ready/failed）
//   acceptance-evidence-r{N}.json    — 喂给规划 Agent 的证据清单（server 预计算）
//
// 为什么分层（用户 2026-10-31）：简单工具任务也会因为「一票一 AC」被摊成 8 条
// 人验项，人被迫把 agent 的测试清单再执行一遍。两层分工：
//
//   cases  —— 人验收。1–3 条**场景**：打开 → 操作 → 看到什么。消费方是人。
//   checks —— 机器证据。本轮已经验证了什么、证据在哪。消费方是 agent/机器，
//             不要求人逐项确认，也不主动批量重跑（e2e/慢命令只按需点名）。
//
// 本文件只放契约 + 纯函数（v1 兼容转换、映射成旧 PlaybookPayload、渲染 md），
// 不碰 fs / DB。

import { z } from "zod"
import type { PlaybookItem, PlaybookPayload, PlaybookSection } from "./playbook-types"

// ── on-disk file names ────────────────────────────────────────────────

export const planJsonName = (roundIndex: number): string => `acceptance-plan-r${roundIndex}.json`
export const planMdName = (roundIndex: number): string => `acceptance-plan-r${roundIndex}.md`
export const planStatusName = (roundIndex: number): string => `acceptance-plan-r${roundIndex}.status.json`
export const planEvidenceName = (roundIndex: number): string => `acceptance-evidence-r${roundIndex}.json`

/** 人层场景上限（一个 phase = 一个故事；场景按故事切，不按功能点切）。 */
export const PLAN_CASE_BUDGET = 3
/** 机器证据上限（按证据来源组织：单测/集成/契约/e2e/verify…）。 */
export const PLAN_CHECK_BUDGET = 20

// ── v2 wire contract (2026-10-31) ─────────────────────────────────────

export const PlanStepKindSchema = z.enum(["open", "do", "observe"])
export type PlanStepKind = z.infer<typeof PlanStepKindSchema>

export const PlanStepSchema = z.object({
  /** open=去哪 / do=做什么 / observe=看到什么。 */
  kind: PlanStepKindSchema,
  /** 人话一步（「打开搜索页」「输入短语」）。 */
  text: z.string().min(1),
  /** kind=open 时的 URL 或文件路径。 */
  target: z.string().optional(),
  /** kind=do 时可填的输入值/操作对象。 */
  value: z.string().optional(),
  /** 这一步看起来「对」是什么样（通常配 observe）。 */
  expect: z.string().optional(),
  /** 仅旧方案兼容：原来的 run 步保留命令，可按需就地跑。 */
  command: z.string().optional(),
})
export type PlanStep = z.infer<typeof PlanStepSchema>

export const PlanEvidenceRefSchema = z.object({
  kind: z.enum(["diff", "test", "report", "docs", "preview"]),
  label: z.string().min(1),
  path: z.string().optional(),
  detail: z.string().optional(),
  /** server 校验路径不存在时打标 —— 诚实显示「缺证据」，绝不编内容。 */
  missing: z.boolean().optional(),
})
export type PlanEvidenceRef = z.infer<typeof PlanEvidenceRefSchema>

/** 人验收：一条完整场景。 */
export const PlanCaseSchema = z.object({
  /** 稳定 id（checks 的键）；server 规范化为 case:<n>。 */
  id: z.string().min(1),
  title: z.string().min(1),
  /** 对应的用户故事/场景原文（可空）。 */
  story: z.string().default(""),
  /** 起点（如「用 runbook 起服务」「已有样例数据」）；不写命令。 */
  setup: z.string().optional(),
  steps: z.array(PlanStepSchema).min(1).max(8),
  /** 这一条场景「通过」的判定标准（一句人话）。 */
  expect: z.string().min(1),
  /** 关联票名基（打回时 reopen）。一个场景可对应多张票。 */
  tickets: z.array(z.string()).default([]),
  evidenceRefs: z.array(PlanEvidenceRefSchema).default([]),
})
export type PlanCase = z.infer<typeof PlanCaseSchema>

/** 机器证据：本轮已经验证了什么（不再要求人逐项签）。 */
export const PlanCheckSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  tickets: z.array(z.string()).default([]),
  /** 覆盖的 AC 标识/简述。 */
  covers: z.array(z.string()).default([]),
  evidenceRefs: z.array(PlanEvidenceRefSchema).default([]),
  /** 只按需点名时用的复核命令；不自动跑、不批量跑。 */
  recheck: z.string().optional(),
})
export type PlanCheck = z.infer<typeof PlanCheckSchema>

export const PlanCoverageSchema = z.object({
  /** 每个用户故事对应哪条场景（保证不漏）。 */
  stories: z.array(z.object({ story: z.string(), case_id: z.string() })).default([]),
  /** 每个 AC 被哪些机器证据覆盖。 */
  acs: z.array(z.object({ ac: z.string(), check_ids: z.array(z.string()) })).default([]),
  found: z.array(z.string()).default([]),
  missing: z.array(z.string()).default([]),
}).default({ stories: [], acs: [], found: [], missing: [] })
export type PlanCoverage = z.infer<typeof PlanCoverageSchema>

export const AcceptancePlanSchema = z.object({
  version: z.literal("2"),
  task_id: z.string().min(1),
  phase_index: z.number().int().positive(),
  round_index: z.number().int().positive(),
  generated_at: z.string().min(1),
  planner: z.string().default("acceptance-planner"),
  goal: z.string().default(""),
  /** 人验收：1–3 条场景（纯工具任务也至少 1 条「用一次」）。 */
  cases: z.array(PlanCaseSchema).min(1).max(PLAN_CASE_BUDGET),
  /** 机器证据：不要求人逐项确认。 */
  checks: z.array(PlanCheckSchema).max(PLAN_CHECK_BUDGET).default([]),
  coverage: PlanCoverageSchema,
  /** server 侧校验发现的诚实缺口（缺证据路径 / 覆盖不全 …）。 */
  warnings: z.array(z.string()).default([]),
})
export type AcceptancePlan = z.infer<typeof AcceptancePlanSchema>

// ── v1 contract (kept for in-flight plans written before 2026-10-31) ───

export const PlanHowToKindSchema = z.enum(["run", "open", "check"])
export type PlanHowToKind = z.infer<typeof PlanHowToKindSchema>

export const PlanHowToSchema = z.object({
  kind: PlanHowToKindSchema,
  text: z.string().min(1),
  command: z.string().optional(),
  path: z.string().optional(),
  expect: z.string().optional(),
})
export type PlanHowTo = z.infer<typeof PlanHowToSchema>

export const PlanMachineSchema = z.object({
  verdict: z.enum(["pass", "warn", "human"]),
  why: z.string().min(1),
  command: z.string().optional(),
  recheck: z.string().optional(),
})
export type PlanMachine = z.infer<typeof PlanMachineSchema>

export const PlanItemSchema = z.object({
  id: z.string().min(1),
  ticket: z.string().min(1),
  title: z.string().min(1),
  story: z.string().default(""),
  expect: z.string().min(1),
  howTo: z.array(PlanHowToSchema).min(1),
  criteria: z.array(z.string()).default([]),
  evidenceRefs: z.array(PlanEvidenceRefSchema).default([]),
  machine: PlanMachineSchema,
})
export type PlanItem = z.infer<typeof PlanItemSchema>

export const LegacyAcceptancePlanSchema = z.object({
  version: z.literal("1"),
  task_id: z.string().min(1),
  phase_index: z.number().int().positive(),
  round_index: z.number().int().positive(),
  generated_at: z.string().min(1),
  planner: z.string().default("acceptance-planner"),
  goal: z.string().default(""),
  items: z.array(PlanItemSchema).min(1).max(8),
  coverage: z.object({
    found: z.array(z.string()).default([]),
    missing: z.array(z.string()).default([]),
  }).default({ found: [], missing: [] }),
  warnings: z.array(z.string()).default([]),
})
export type LegacyAcceptancePlan = z.infer<typeof LegacyAcceptancePlanSchema>

/** Read either contract version and normalize to v2 (v1 is converted in memory).
 *  Never rewrites the file; the original v1 plan stays readable for audit. */
export function parseAcceptancePlan(raw: unknown): { plan: AcceptancePlan; warnings: string[] } | null {
  const v2 = AcceptancePlanSchema.safeParse(raw)
  if (v2.success) return { plan: v2.data, warnings: [] }
  const v1 = LegacyAcceptancePlanSchema.safeParse(raw)
  if (!v1.success) return null
  return convertLegacyPlan(v1.data)
}

/** v1 → v2: `machine.verdict === "pass"` 的项归为机器证据，其余归为人场景。
 *  id 原样保留 —— 已有 checks 文件里的历史勾选仍对得上（旧方案在飞轮次）。 */
export function convertLegacyPlan(v1: LegacyAcceptancePlan): { plan: AcceptancePlan; warnings: string[] } {
  const cases: PlanCase[] = []
  const checks: PlanCheck[] = []
  for (const it of v1.items) {
    if (it.machine.verdict === "pass") {
      checks.push({
        id: it.id,
        title: it.title,
        tickets: it.ticket && it.ticket !== "spec" ? [it.ticket] : [],
        covers: it.criteria,
        evidenceRefs: it.evidenceRefs,
        ...(it.machine.command?.trim()
          ? { recheck: it.machine.command.trim() }
          : it.howTo.find((h) => h.kind === "run" && h.command?.trim())
            ? { recheck: it.howTo.find((h) => h.kind === "run" && h.command?.trim())!.command!.trim() }
            : {}),
      })
      continue
    }
    const steps: PlanStep[] = it.howTo.map((h) => {
      if (h.kind === "open") return { kind: "open" as const, text: h.text, target: h.path, expect: h.expect }
      if (h.kind === "run") return { kind: "do" as const, text: h.text, command: h.command, expect: h.expect }
      return { kind: "observe" as const, text: h.text, target: h.path, expect: h.expect }
    })
    cases.push({
      id: it.id,
      title: it.title,
      story: it.story,
      steps: steps.length ? steps : [{ kind: "observe", text: it.expect }],
      expect: it.expect,
      tickets: it.ticket && it.ticket !== "spec" ? [it.ticket] : [],
      evidenceRefs: it.evidenceRefs,
    })
  }
  // 旧方案可能全是机器建议通过；人层至少留一条「用一次」的场景，绝不退化成签测试报告。
  if (!cases.length) {
    cases.push({
      id: "case:legacy-review",
      title: "实际用一次本轮交付",
      story: "",
      steps: [{ kind: "observe", text: "按下面证据表任选一条，确认结果与本轮目标一致" }],
      expect: "本轮交付能达到汇报里的目标",
      tickets: [],
      evidenceRefs: [],
    })
  }
  const warnings = [
    ...v1.warnings,
    "旧版验收方案（v1）已按机器建议分层：pass 项转为机器证据，其余转为人验收场景",
  ]
  return {
    plan: {
      version: "2",
      task_id: v1.task_id,
      phase_index: v1.phase_index,
      round_index: v1.round_index,
      generated_at: v1.generated_at,
      planner: v1.planner,
      goal: v1.goal,
      cases,
      checks,
      coverage: {
        stories: cases.filter((c) => c.story.trim()).map((c) => ({ story: c.story, case_id: c.id })),
        acs: [],
        found: v1.coverage.found,
        missing: v1.coverage.missing,
      },
      warnings,
    },
    warnings,
  }
}

// ── status file ───────────────────────────────────────────────────────

export type AcceptancePlanStatus = "generating" | "ready" | "failed" | "missing"

export interface AcceptancePlanStatusFile {
  status: AcceptancePlanStatus
  started_at?: string
  finished_at?: string
  error?: string
  execution_id?: string
  plan_path?: string
}

/** Payload-level view attached to PlaybookPayload.plan（web 镜像同名类型）。 */
export interface PlanSummary {
  status: AcceptancePlanStatus
  source?: string
  generated_at?: string
  error?: string
  /** 引导是否已唤醒主 Chat（窗口横幅据此说「已交给 Chat」）。 */
  guide_woken_at?: string
}

// ── evidence manifest (fed to the planner) ────────────────────────────

export interface AcceptanceEvidenceManifest {
  task_id: string
  task_name: string
  phase_index: number
  round_index: number
  phase_name: string
  goal: string
  batch_rel_dir: string
  batch_abs_dir: string
  spec_path: string | null
  round_report_path: string | null
  e2e_ticket_path: string | null
  e2e_test_plan_path: string | null
  files: Array<{ path: string; bytes: number }>
  repos: Array<{
    name: string
    commits: number
    additions: number
    dels: number
    files: Array<{ path: string; adds: number; dels: number }>
  }>
  verify: unknown | null
  runbook: unknown | null
  acceptance_criteria: string[]
  plan_output: { json_abs: string; md_abs: string }
  generated_at: string
}

// ── plan → PlaybookPayload mapping (legacy consumers stay working) ────

/** Extension fields the plan adds to a PlaybookItem. Optional everywhere so
 *  old compiled playbooks and old web clients keep decoding unchanged. */
export interface PlaybookItemPlanFields {
  /** case=人验收场景（可判定）；check=机器证据（不判定）。缺省按 case 处理。 */
  tier?: "case" | "check"
  title?: string
  story?: string
  /** 人层场景起点（如「用 runbook 起服务」）；不写命令。 */
  setup?: string
  /** 人层场景步骤（open / do / observe）。 */
  steps?: PlanStep[]
  tickets?: string[]
  /** 机器证据的按需复核命令（不自动跑）。 */
  recheck?: string
  // legacy v1 fields (kept for old cards / compiled playbooks)
  ticket?: string
  howTo?: PlanHowTo[]
  criteria?: string[]
  machine?: PlanMachine
}

export type PlannedPlaybookItem = PlaybookItem & PlaybookItemPlanFields

/** Map a validated plan onto the legacy PlaybookPayload shape so every existing
 *  consumer (ledger, gate, panel) works without changes. Two sections:
 *  walk = human cases (checkable), claim = machine evidence (read-only table). */
export function planToPlaybook(
  plan: AcceptancePlan,
  status: PlanSummary,
): PlaybookPayload {
  const source = `acceptance-plan-r${plan.round_index}.json`
  const caseItems: PlannedPlaybookItem[] = plan.cases.map((c) => {
    const runStep = c.steps.find((s) => s.command?.trim())
    return {
      id: c.id,
      op: c.title,
      expect: c.expect,
      ticket: c.tickets[0],
      tickets: c.tickets,
      title: c.title,
      story: c.story,
      setup: c.setup,
      steps: c.steps,
      evidenceRefs: c.evidenceRefs,
      tier: "case",
      ...(runStep ? { probe: { command: runStep.command!.trim() } } : {}),
    }
  })
  const checkItems: PlannedPlaybookItem[] = plan.checks.map((ck) => ({
    id: ck.id,
    op: ck.title,
    expect: ck.covers.length ? `覆盖 ${ck.covers.join(" · ")}` : "（本轮已记录验证证据）",
    evidence: ck.covers.length ? ck.covers.join(" · ") : undefined,
    ticket: ck.tickets[0],
    tickets: ck.tickets,
    title: ck.title,
    criteria: ck.covers,
    evidenceRefs: ck.evidenceRefs,
    tier: "check",
    ...(ck.recheck?.trim() ? { recheck: ck.recheck.trim(), probe: { command: ck.recheck.trim() } } : {}),
  }))
  const sections: PlaybookSection[] = []
  if (caseItems.length) sections.push({ kind: "walk", title: "你要验的", source, items: caseItems })
  if (checkItems.length) sections.push({ kind: "claim", title: "本轮验证了什么", source, items: checkItems })
  return {
    available: caseItems.length > 0 || checkItems.length > 0,
    goal: plan.goal,
    specRevised: false,
    budget: {
      steps: caseItems.length,
      estMin: Math.max(1, Math.ceil(caseItems.length * 1.3)),
      over: caseItems.length > PLAN_CASE_BUDGET,
      degraded: false,
    },
    sections,
    finePrint: [],
    carryover: [],
    coverage: plan.coverage,
    plan: status,
    planWarnings: plan.warnings,
  }
}

/** Human-readable plan md (server fallback when the agent didn't write one). */
export function renderPlanMd(plan: AcceptancePlan): string {
  const lines: string[] = [
    `# 验收方案 · Phase ${plan.phase_index} Round ${plan.round_index}`,
    "",
    `> ${plan.generated_at} · ${plan.planner} 生成 · 人验场景只留核心，机器证据供参考`,
    "",
  ]
  if (plan.goal) lines.push(`**目标**：${plan.goal}`, "")

  lines.push(`## 一、你要验的（${plan.cases.length} 条场景）`, "")
  plan.cases.forEach((c, i) => {
    lines.push(`### ${i + 1}. ${c.title}`, "")
    if (c.story) lines.push(`- 用户故事：${c.story}`)
    if (c.setup) lines.push(`- 起点：${c.setup}`)
    lines.push(`- 通过标准：${c.expect}`)
    if (c.tickets.length) lines.push(`- 关联票：${c.tickets.join(" · ")}`)
    lines.push("- 步骤：")
    c.steps.forEach((s, n) => {
      const label = s.kind === "open" ? "打开" : s.kind === "do" ? "操作" : "看"
      const tail = s.target ? ` — ${s.target}` : s.value ? ` — ${s.value}` : ""
      const expect = s.expect ? `（预期：${s.expect}）` : ""
      lines.push(`  ${n + 1}. [${label}] ${s.text}${tail}${expect}`)
    })
    if (c.evidenceRefs.length) {
      lines.push("- 证据：")
      for (const e of c.evidenceRefs) {
        lines.push(`  - ${e.label}${e.path ? ` — ${e.path}` : ""}${e.missing ? "（缺证据）" : ""}`)
      }
    }
    lines.push("")
  })

  lines.push(`## 二、本轮验证了什么（${plan.checks.length} 项机器证据，供参考）`, "")
  if (!plan.checks.length) {
    lines.push("（没有登记机器证据 —— 人工场景步骤是唯一验收依据）", "")
  }
  plan.checks.forEach((ck, i) => {
    lines.push(`### ${i + 1}. ${ck.title}`, "")
    if (ck.covers.length) lines.push(`- 覆盖：${ck.covers.join(" · ")}`)
    if (ck.tickets.length) lines.push(`- 关联票：${ck.tickets.join(" · ")}`)
    if (ck.evidenceRefs.length) {
      lines.push("- 证据：")
      for (const e of ck.evidenceRefs) {
        lines.push(`  - ${e.label}${e.path ? ` — ${e.path}` : ""}${e.missing ? "（缺证据）" : ""}`)
      }
    }
    if (ck.recheck) lines.push(`- 按需复核：\`${ck.recheck}\``)
    lines.push("")
  })

  const storyLine = plan.coverage.stories.length
    ? plan.coverage.stories.map((s) => `${s.story} → ${s.case_id}`).join(" · ")
    : "未登记"
  lines.push(`> 故事覆盖：${storyLine}`)
  if (plan.coverage.acs.length) lines.push(`> AC 覆盖：${plan.coverage.acs.length} 条已登记`)
  if (plan.coverage.found.length || plan.coverage.missing.length) {
    lines.push(`> 来源：${plan.coverage.found.join(" · ") || "无"}${plan.coverage.missing.length ? ` ｜ 缺：${plan.coverage.missing.join(" · ")}` : ""}`)
  }
  return lines.join("\n")
}
