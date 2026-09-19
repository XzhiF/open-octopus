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

// ── 实票方言（2026-09-19 活体回归：六单 + B/C 在盘票全编 0 步的修复锁）──

// 照抄 ~/.octopus/tasks/5db37385…/luhn-chain-1/issues/03-e2e-luhn-walkthrough.md 的节结构
const REAL_API_TICKET = `# Ticket 03: 双仓端到端走查 —— 起 admin 验 Luhn 链路

Status: done
Blocked by: 02
Type: e2e

## 目的
验 AC3：票 01 产物经票 02 编译进运行中的服务后，HTTP 行为符合 spec。

## 前置
- java-common 仓根：\`mvn -B -pl java-common-util -DskipTests install\`（若 m2 已最新可跳）。

## 走查步骤（机器判据 = 退出码）
1. 起服务：\`cd /repo && java -jar target/app.jar --server.port=18082 &\`
2. 就绪（≤90s）：\`until curl -sf http://localhost:18082/demo > /dev/null; do sleep 2; done\`
3. 真值：\`curl -sf 'http://localhost:18082/demo/luhn?no=4539578763621486'\` → data == true
4. 假值：\`curl -sf 'http://localhost:18082/demo/luhn?no=4539578763621487'\` → data == false
5. 垃圾：\`curl -sf 'http://localhost:18082/demo/luhn?no=abc'\` → HTTP 200 且 data == false（不得 500）
6. 收尾：kill java 进程，确认 18082 拒连。

产出 \`e2e-report.md\`（步骤/命令/响应/结论 PASS|FAIL）。

## 结果摘要 (2026-09-19 e2e 节点)
**PASS**。服务起于 18082（4s 就绪）；四条 curl 断言全中。
`

// 照抄 …/usage-admin-3/issues/05-e2e-usage-page.md 的节结构（browser 走查）
const REAL_BROWSER_TICKET = `# 05 · e2e（browser 走查）：菜单→筛选→展开→聚合对账

Type: e2e · Status: done
走查模式：**browser 走查**（本 phase 验收面是 UI——Playwright + 截图证据，全 phase 唯一起浏览器的一张）

## 走查步骤（真实环境）

1. 前置数据态：库中已有 ≥2 个 source、≥2 个 model、≥1 条多调用 trace。
2. 系统管理 → 点「Token 使用」→ 列表渲染，列齐全，时间倒序。
3. 筛 source=chat → 行数变化且与 \`curl /api/usage/llm-calls?source=chat\` 一致。
4. 点一条多调用行展开 → 树中逐调用四字段可见，轮小计 = 手算 Σ。
5. 切聚合 tab，dim 逐切 4 值 → 屏上总量/cost/占比与 \`curl /api/usage/aggregate\` 三方一致。

## 证据要求

截图 + curl/sqlite 对照表贴票尾；任一断言不符 = 不放行。
`

describe("T02 AC5 — 实票方言编译（Type:/走查步骤/行内命令/证据要求）", () => {
  it("API 级票（裸 Type: e2e + curl 步）→ probe 步带命令与 →后断言，不再空面板", () => {
    const p = compile({ e2eTicket: { name: "03-e2e-luhn-walkthrough.md", content: REAL_API_TICKET }, e2eTestPlan: null, roundReport: null })
    expect(p.available).toBe(true)
    const sec = p.sections.find((s) => s.title === "03-e2e-luhn-walkthrough")
    expect(sec?.kind).toBe("probe")
    const probes = sec?.items ?? []
    expect(probes.length).toBeGreaterThanOrEqual(3)
    expect(probes.some((i) => i.probe?.command.includes("demo/luhn?no=4539578763621486"))).toBe(true)
    const t3 = probes.find((i) => i.probe?.command.includes("4539578763621486"))
    expect(t3?.expect).toBe("data == true")
    // 结果摘要(执行侧回写)不得变成步
    expect(p.sections.flatMap((s) => s.items).some((i) => i.op.includes("四条 curl 断言全中"))).toBe(false)
  })

  it("browser 票（走查模式行 + 多箭头 UI 步）→ walk 步，末箭头拆预期，证据要求兜底", () => {
    const p = compile({ e2eTicket: { name: "05-e2e-usage-page.md", content: REAL_BROWSER_TICKET }, e2eTestPlan: null, roundReport: null })
    expect(p.available).toBe(true)
    const sec = p.sections.find((s) => s.title === "05-e2e-usage-page")
    expect(sec?.kind).toBe("walk")
    const items = sec?.items ?? []
    expect(items).toHaveLength(5)
    // 多箭头行按最后一个箭头拆：操作含中间段，预期只留渲染判据
    expect(items[1].op).toContain("点「Token 使用」")
    expect(items[1].expect).toMatch(/列表渲染，列齐全/)
    expect(items.every((i) => i.op.length > 0 && i.expect.length > 0)).toBe(true)
  })

  it("票存在但两副词表都读不懂 → spec AC 兜底不再被掐死（诚实记缺）", () => {
    const p = compile({
      e2eTicket: { name: "99-e2e-mystery.md", content: "# 99\n\n随便写了点散文,没有任何步骤结构。\n" },
      specMd: "# S\n## Acceptance Criteria\n- AC1: 甲\n- AC2: 乙",
      e2eTestPlan: null, roundReport: null,
    })
    expect(p.available).toBe(true)
    const specSec = p.sections.find((s) => s.source === "spec.md")
    expect(specSec?.items).toHaveLength(2)
    expect(p.coverage.missing.join()).toContain("99-e2e-mystery.md 无可解析步骤")
    // 兜底时票的 AC 仍进 finePrint（此票无 AC 节则空 finePrint 不报错）
    expect(p.finePrint.find((f) => f.ticket === "spec")?.acs).toHaveLength(2)
  })

  it("正典模板票不受方言影响（既有 fixture 路径不变）", () => {
    const p = compile()
    const probes = p.sections.flatMap((s) => s.items).filter((i) => i.probe)
    expect(probes.some((i) => i.probe?.command.includes("playwright test"))).toBe(true)
    const plan = p.sections.find((s) => s.source === "e2e-test-plan.md")
    expect(plan?.items.length).toBeGreaterThan(0)
  })

  it("实票 dialect 步 id 稳定（跨编译可勾选复现）", () => {
    const a = compile({ e2eTicket: { name: "03-e2e-luhn-walkthrough.md", content: REAL_API_TICKET }, e2eTestPlan: null, roundReport: null })
    const b = compile({ e2eTicket: { name: "03-e2e-luhn-walkthrough.md", content: REAL_API_TICKET }, e2eTestPlan: null, roundReport: null })
    expect(a.sections.flatMap((s) => s.items).map((i) => i.id)).toEqual(b.sections.flatMap((s) => s.items).map((i) => i.id))
  })
})

describe("T02 AC6 — ③ 管道步 lifecycle（hasRunbook 时起服/就绪/收尾折提示）", () => {
  const LIFE_TICKET = `# 03 · e2e
Type: e2e
## 走查步骤
1. 起服务：\`cd r && java -jar app.jar &\`
2. 就绪：\`until curl -sf http://localhost:18082/demo; do sleep 2; done\`
3. 真值：\`curl -sf 'http://localhost:18082/demo/luhn?no=123'\` → data == true
4. 收尾：\`kill java\`
`
  it("有 runbook → start/ready/teardown 打标，curl 断言步不打标", () => {
    const p = compile({ e2eTicket: { name: "03-e2e-luhn.md", content: LIFE_TICKET }, e2eTestPlan: null, roundReport: null, hasRunbook: true })
    const items = p.sections.flatMap((s) => s.items)
    expect(items.find((i) => i.probe?.command.includes("java -jar"))?.lifecycle).toBe("start")
    expect(items.find((i) => i.probe?.command.startsWith("until"))?.lifecycle).toBe("ready")
    expect(items.find((i) => i.probe?.command.startsWith("kill"))?.lifecycle).toBe("teardown")
    expect(items.find((i) => i.probe?.command.includes("demo/luhn"))?.lifecycle).toBeUndefined()
  })
  it("无 runbook → 全部保持可跑（不打标），否则没人起服务", () => {
    const p = compile({ e2eTicket: { name: "03-e2e-luhn.md", content: LIFE_TICKET }, e2eTestPlan: null, roundReport: null })
    expect(p.sections.flatMap((s) => s.items).every((i) => !i.lifecycle)).toBe(true)
  })
})
