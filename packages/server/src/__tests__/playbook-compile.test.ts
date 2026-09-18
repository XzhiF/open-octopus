// packages/server/src/__tests__/playbook-compile.test.ts
//
// 验收剧本编译器单测(spec T02)。fixtures 用**真实** task-author 产物形状
// (照抄 .scratch/task-authoring-v3/issues/11-e2e-full-link.md 的节结构 +
// octo-xzf-spec-to-tasks 的 e2e-test-plan.md 格式)——解析即契约,格式漂移这里先炸。

import { describe, it, expect } from "vitest"
import { compilePlaybook, PLAYBOOK_STEP_BUDGET, type PlaybookInputs } from "../services/tasks/playbook-compile"

const E2E_TICKET = `# 11 — E2E 全链路：验收剧本

## What to build
端到端闭环:创建任务→入队→执行→验收台→剧本出现。覆盖 US1/2/3。

## Blocked by
09 · 10

## Status
done

## Acceptance Criteria
- [x] AC1: 剧本从末张票编译 ≥3 步带 op+expect
- [x] AC2: 勾选刷新持久(acceptance-checks.json)
- [x] AC3: 预览起停+探活 ready→stop 无残留
- [x] AC4: ✗ 存在时通过 disabled;打回反馈预填并重开票
- [x] AC5: 未决弹层列票号;ledger 记 skip

## Verification Method
**Verification type**: browser E2E（Playwright）

**Verification steps**:
\`\`\`bash
pnpm build && pnpm dev &
cd packages/web-app && pnpm playwright test e2e/playbook.spec.ts
\`\`\`

**Pass criteria**: 全部用例 PASS 且 screenshot 落盘
**Failure handling**: Max 3 fix attempts then SKIP
`

const E2E_TEST_PLAN = `# E2E 测试计划

## 前置条件
- [ ] 后端服务已启动

## 测试步骤

### Step 1: 剧本渲染 (spec-001)
- 页面: http://localhost:3000/tasks/t-1
- 操作: 点开验收台实物 tab
- 断言: 剧本①-④齐全,走查步 ≥3
- 反假跑: 至少 1 步带预期句

### Step 2: 预览起停 (spec-002)
- 页面: 同上
- 操作: ▶ 启动预览,等 ready
- 断言: 状态条 starting→ready;↗ 打开端口有响应
- 反假跑: 真 curl 到 url,非 mock

### Step 3: 通过写台账 (spec-003)
- 操作: 勾完点验收通过,确认弹层
- 断言: ledger .md 落批次目录
- 反假跑: 叙述 tab 可见 + server grep 命中
`

const ROUND_REPORT = `# Round 1 交付报告

## 票执行摘要
端到端闭环:剧本编译 + 预览起停全链打通

## Spec 修订
- KD2 预览超时改 2h
`

function compile(patch: Partial<PlaybookInputs> = {}): ReturnType<typeof compilePlaybook> {
  return compilePlaybook({
    roundIndex: 1,
    e2eTicket: { name: "11-e2e-full-link.md", content: E2E_TICKET },
    e2eTestPlan: E2E_TEST_PLAN,
    roundReport: ROUND_REPORT,
    specMd: "# 验收剧本 Spec\n\n## Acceptance Criteria\n- AC-x: 兜底",
    ...patch,
  })
}

describe("T02 AC1 — 全料编译", () => {
  const p = compile()
  it("available + goal from round-report", () => {
    expect(p.available).toBe(true)
    expect(p.goal).toMatch(/端到端闭环/)
  })
  it("steps within budget, each has op+expect", () => {
    const items = p.sections.flatMap((s) => s.items)
    expect(items.length).toBeGreaterThan(0)
    expect(items.length).toBeLessThanOrEqual(PLAYBOOK_STEP_BUDGET)
    for (const it of items) {
      expect(it.id).toMatch(/^(walk|probe|claim):/)
      expect(it.op.length).toBeGreaterThan(0)
      expect(it.expect.length).toBeGreaterThan(0)
    }
  })
  it("probe items carry command from ticket bash", () => {
    const probes = p.sections.flatMap((s) => s.items).filter((i) => i.probe)
    expect(probes.some((i) => i.probe?.command.includes("playwright test"))).toBe(true)
  })
  it("finePrint collects the FULL ticket AC list (5) even if steps merged", () => {
    const fp = p.finePrint.find((f) => f.ticket === "11-e2e-full-link")
    expect(fp?.acs).toHaveLength(5)
    expect(fp?.acs[0]).toMatch(/剧本从末张票编译/)
  })
  it("plan 反假跑 → evidence; 断言 → expect", () => {
    const plan = p.sections.find((s) => s.source === "e2e-test-plan.md")
    expect(plan?.items[0].evidence).toMatch(/预期句/)
    expect(plan?.items[0].expect).toMatch(/剧本①-④齐全/)
  })
  it("coverage.found lists all four sources", () => {
    expect(p.coverage.found).toEqual(expect.arrayContaining(["e2e-test-plan.md", "round-report.md", "spec.md"]))
    expect(p.coverage.found.some((f) => f.includes("11-e2e"))).toBe(true)
  })
  it("spec_revised flagged", () => { expect(p.specRevised).toBe(true) })
  it("ids are deterministic across compiles", () => {
    const a = compile().sections.flatMap((s) => s.items).map((i) => i.id)
    const b = compile().sections.flatMap((s) => s.items).map((i) => i.id)
    expect(a).toEqual(b)
  })
})

describe("T02 AC2 — 缺料降级不崩", () => {
  it("all missing → available:false + full missing list, no throw", () => {
    const p = compilePlaybook({ roundIndex: 1 })
    expect(p.available).toBe(false)
    expect(p.sections).toHaveLength(0)
    expect(p.coverage.missing).toEqual(expect.arrayContaining(["末张 NN-e2e-*.md", "e2e-test-plan.md", "round-report.md", "spec.md"]))
  })
  it("only spec.md (no e2e ticket) → AC fallback into finePrint, still available", () => {
    const p = compilePlaybook({ roundIndex: 1, specMd: "# S\n## Acceptance Criteria\n- AC1: x\n- AC2: y" })
    expect(p.available).toBe(true)
    expect(p.finePrint.find((f) => f.ticket === "spec")?.acs).toHaveLength(2)
  })
})

describe("T02 AC3 — 爆表降档", () => {
  it(">budget steps → degraded, collapses to ≤budget", () => {
    const bigPlan = `## 测试步骤\n` + Array.from({ length: 12 }, (_, i) =>
      `### Step ${i + 1}: S${i}\n- 操作: op${i}\n- 断言: exp${i}`).join("\n\n")
    const p = compile({ e2eTestPlan: bigPlan })
    expect(p.budget.degraded).toBe(true)
    expect(p.budget.steps).toBeLessThanOrEqual(PLAYBOOK_STEP_BUDGET)
  })
})

describe("T02 AC4 — carryover(上轮 skip/fail)", () => {
  const checks = { version: "1" as const, checks: {
    "walk:plan:1": { decision: "skip" as const, note: "环境问题", at: "t" },
    "walk:plan:2": { decision: "fail" as const, note: "预览起不来", at: "t" },
    "walk:plan:3": { decision: "pass" as const, note: "", at: "t" },
  } }
  const p = compile({ roundIndex: 2, prevChecks: { round: 1, data: checks } })
  it("skip+fail resurface (top section), pass 销账 absent", () => {
    expect(p.carryover.map((c) => c.decision).sort()).toEqual(["failed", "skipped"])
    expect(p.carryover.find((c) => c.decision === "skipped")?.note).toBe("环境问题")
    expect(p.carryover.find((c) => c.decision === "failed")?.op).toMatch(/启动预览/)
    const flat = p.sections.flatMap((s) => s.items)
    expect(flat.some((i) => i.id.includes("plan:3"))).toBe(false)
  })
  it("carryover section is first + ids co-stamped", () => {
    expect(p.sections[0].title).toMatch(/上轮未结/)
    expect(p.carryover.every((c) => c.id.startsWith("co:"))).toBe(true)
  })
})
