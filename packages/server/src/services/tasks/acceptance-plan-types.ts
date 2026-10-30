// packages/server/src/services/tasks/acceptance-plan-types.ts
//
// 验收方案（2026-10-30 AI-native 验收）—— 轮末由独立「验收规划 Agent」产出的
// 机器可读验收方案，落盘在 phase 批次目录：
//
//   acceptance-plan-r{N}.json   — 正本（Zod 校验；本文件是唯一契约）
//   acceptance-plan-r{N}.md     — 人读版（Agent 写；缺失时 server 由 JSON 渲染）
//   acceptance-plan-r{N}.status.json — 生成状态（generating/ready/failed）
//   acceptance-evidence-r{N}.json    — 喂给规划 Agent 的证据清单（server 预计算）
//
// 为什么要有它（用户 2026-10-30）：旧的第三步把 spec 用户故事原句当核对项，
// 人面对「一条条文案」不知道该怎么验。方案要求每条都带：怎么验（howTo）、
// 证据指针（evidenceRefs）、机器建议（machine）。机器只建议，人逐项确认。
//
// 本文件只放契约 + 纯函数（映射成旧 PlaybookPayload、渲染 md），不碰 fs / DB。

import { z } from "zod"
import type { PlaybookItem, PlaybookPayload, PlaybookSection } from "./playbook-types"

// ── on-disk file names ────────────────────────────────────────────────

export const planJsonName = (roundIndex: number): string => `acceptance-plan-r${roundIndex}.json`
export const planMdName = (roundIndex: number): string => `acceptance-plan-r${roundIndex}.md`
export const planStatusName = (roundIndex: number): string => `acceptance-plan-r${roundIndex}.status.json`
export const planEvidenceName = (roundIndex: number): string => `acceptance-evidence-r${roundIndex}.json`

// ── Zod schema (the wire contract) ────────────────────────────────────

export const PlanHowToKindSchema = z.enum(["run", "open", "check"])
export type PlanHowToKind = z.infer<typeof PlanHowToKindSchema>

export const PlanHowToSchema = z.object({
  kind: PlanHowToKindSchema,
  /** 给人看的一步（「在服务里执行 curl …」「打开 http://localhost:3000/xxx」）。 */
  text: z.string().min(1),
  /** kind=run 时的可执行命令（server 只读校验；Chat 可代为执行）。 */
  command: z.string().optional(),
  /** kind=open/check 时的文件/页面指针。 */
  path: z.string().optional(),
  /** 这一步看起来「通过」是什么样。 */
  expect: z.string().optional(),
})
export type PlanHowTo = z.infer<typeof PlanHowToSchema>

export const PlanEvidenceRefSchema = z.object({
  kind: z.enum(["diff", "test", "report", "docs", "preview"]),
  label: z.string().min(1),
  path: z.string().optional(),
  detail: z.string().optional(),
  /** server 校验路径不存在时打标 —— 诚实显示「缺证据」，绝不编内容。 */
  missing: z.boolean().optional(),
})
export type PlanEvidenceRef = z.infer<typeof PlanEvidenceRefSchema>

export const PlanMachineSchema = z.object({
  /** pass=机器已能判定通过；warn=有风险/部分通过；human=必须人判断。 */
  verdict: z.enum(["pass", "warn", "human"]),
  /** 为什么给这个建议（一句话，人可推翻）。 */
  why: z.string().min(1),
  /** 机器证据命令（若有；窗口/Chat 的「跑一下」按钮用它）。 */
  command: z.string().optional(),
  /** 修完/重跑后如何复核。 */
  recheck: z.string().optional(),
})
export type PlanMachine = z.infer<typeof PlanMachineSchema>

export const PlanItemSchema = z.object({
  /** 稳定 id（checks 的键）；server 规范化为 plan:<ticket>:<n>。 */
  id: z.string().min(1),
  /** 票名基（打回时 reopen 该票）；plan:spec 类兜底可写 "spec"。 */
  ticket: z.string().min(1),
  title: z.string().min(1),
  /** 来自 spec 的用户故事/场景原文（可空）。 */
  story: z.string().default(""),
  /** 这一项「通过」的判定标准（人话）。 */
  expect: z.string().min(1),
  /** 至少一步「怎么验」—— 这是方案存在的意义。 */
  howTo: z.array(PlanHowToSchema).min(1),
  /** 明细核对点（可选）。 */
  criteria: z.array(z.string()).default([]),
  evidenceRefs: z.array(PlanEvidenceRefSchema).default([]),
  machine: PlanMachineSchema,
})
export type PlanItem = z.infer<typeof PlanItemSchema>

export const AcceptancePlanSchema = z.object({
  version: z.literal("1"),
  task_id: z.string().min(1),
  phase_index: z.number().int().positive(),
  round_index: z.number().int().positive(),
  generated_at: z.string().min(1),
  planner: z.string().default("acceptance-planner"),
  goal: z.string().default(""),
  /** 最多 8 项（与人一次能走完的量同律，见 PLAYBOOK_STEP_BUDGET）。 */
  items: z.array(PlanItemSchema).min(1).max(8),
  coverage: z.object({
    found: z.array(z.string()).default([]),
    missing: z.array(z.string()).default([]),
  }).default({ found: [], missing: [] }),
  /** server 侧校验发现的诚实缺口（缺证据路径 / 重复 id …）。 */
  warnings: z.array(z.string()).default([]),
})
export type AcceptancePlan = z.infer<typeof AcceptancePlanSchema>

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
  ticket?: string
  title?: string
  story?: string
  howTo?: PlanHowTo[]
  criteria?: string[]
  evidenceRefs?: PlanEvidenceRef[]
  machine?: PlanMachine
}

export type PlannedPlaybookItem = PlaybookItem & PlaybookItemPlanFields

/** Map a validated plan onto the legacy PlaybookPayload shape so every existing
 *  consumer (ledger, gate, PlaybookPanel fallback) works without changes. */
export function planToPlaybook(
  plan: AcceptancePlan,
  status: PlanSummary,
): PlaybookPayload {
  const items: PlannedPlaybookItem[] = plan.items.map((it) => ({
    id: it.id,
    op: it.title,
    expect: it.expect,
    evidence: it.criteria.length ? it.criteria.join(" · ") : undefined,
    ticket: it.ticket,
    title: it.title,
    story: it.story,
    howTo: it.howTo,
    criteria: it.criteria,
    evidenceRefs: it.evidenceRefs,
    machine: it.machine,
    ...(it.howTo.find((h) => h.kind === "run" && h.command?.trim())
      ? { probe: { command: it.howTo.find((h) => h.kind === "run" && h.command?.trim())!.command!.trim() } }
      : {}),
  }))
  const sections: PlaybookSection[] = items.length
    ? [{ kind: "walk", title: "验收方案", source: `acceptance-plan-r${plan.round_index}.json`, items }]
    : []
  return {
    available: items.length > 0,
    goal: plan.goal,
    specRevised: false,
    budget: {
      steps: items.length,
      estMin: Math.max(1, Math.ceil(items.length * 1.3)),
      over: items.length > 8,
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
    `> ${plan.generated_at} · ${plan.planner} 生成 · 机器只建议，逐项由人确认`,
    "",
  ]
  if (plan.goal) lines.push(`**目标**：${plan.goal}`, "")
  plan.items.forEach((it, i) => {
    lines.push(`## ${i + 1}. ${it.title}`, "")
    if (it.story) lines.push(`- 用户故事：${it.story}`)
    lines.push(`- 通过标准：${it.expect}`)
    lines.push(`- 机器建议：${it.machine.verdict.toUpperCase()} — ${it.machine.why}`)
    if (it.howTo.length) {
      lines.push("- 怎么验：")
      for (const h of it.howTo) {
        lines.push(`  - [${h.kind}] ${h.text}${h.command ? ` \`${h.command}\`` : ""}${h.path ? ` (${h.path})` : ""}`)
      }
    }
    if (it.evidenceRefs.length) {
      lines.push("- 证据：")
      for (const e of it.evidenceRefs) {
        lines.push(`  - ${e.label}${e.path ? ` — ${e.path}` : ""}${e.missing ? "（缺证据）" : ""}`)
      }
    }
    if (it.criteria.length) {
      lines.push("- 核对点：")
      for (const c of it.criteria) lines.push(`  - ${c}`)
    }
    lines.push("")
  })
  if (plan.coverage.found.length || plan.coverage.missing.length) {
    lines.push(`> 来源：${plan.coverage.found.join(" · ") || "无"}${plan.coverage.missing.length ? ` ｜ 缺：${plan.coverage.missing.join(" · ")}` : ""}`)
  }
  return lines.join("\n")
}
