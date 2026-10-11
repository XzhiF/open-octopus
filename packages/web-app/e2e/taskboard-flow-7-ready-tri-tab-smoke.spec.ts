// packages/web-app/e2e/taskboard-flow-7-ready-tri-tab-smoke.spec.ts
//
// 票 11 流⑦ —— 待执行「💬 对话 · ▤ 规格 · ◆ 节点」三签态 UI-only 烟测（功能票收官张）。
//
// 零 LLM 诚实边界（helpers/tbv2SeedReadyTask 头注逐字）：seed = REST 直建 v4 任务
// 走到 ready（fixture 仓 + org 索引 + home 批次 spec/票 + POST /ready），**不调
// /trigger、不等 dispatcher** —— 全程零真 provider 调用、零执行行。单跑目标 <60s。
//
// 观测链 = 产品自身（票 07/08/09/10 已落组件，锚点现读不猜）：
//   看板 ready 列卡 → 深链开统一壳（/tasks?task=）→ tab-assembly ready 装配
//   （三签齐 + 默认落「◆ 节点」，files/usage/artifacts/console/review 绝迹）
//   → StaticNodesTab 按绑定流 YAML 声明序全 ○（用时/成本 `—`、汇总 0/N 等待触发、
//   展开行「— 未执行 · 等待触发 —」）→ ReadySpecTab = SpecPanel 只读镜像（六行
//   入队清单全 ✓ + 写控件不渲染）→ ReadyChatReplay = 草稿期会话全史回放（水印 +
//   两消息上屏 + 零输入硬闸；本 seed 挂了会话走回放路，空态「草稿期会话不存在」
//   分支由票08 单测钉）→ 右栏 ReadyTokenBadge 有账出账（seed 写一行 execution_id
//   NULL 的 llm_calls），点开浮层含命中率与「完整台账」target=_blank、Esc 收回
//   → 关窗回板 → API/DB 终对账（derived 仍 ready、phase 零轮、executions=0 行）。
//
// 运行：pnpm -C <worktree>/packages/web-app test:e2e:taskboard-v2（先决条件：
// worktree 栈已起 —— helpers 头注环境说明 + docs/agents/windows-bash.md）。

import { test, expect } from "@playwright/test"
import * as path from "path"
import {
  SEL,
  activeTabKey,
  clickTab,
  log,
  logError,
  openConsole,
  shotDir,
  tbv2Derived,
  tbv2Env,
  tbv2RootExecs,
  tbv2SeedReadyTask,
  tbv2ServerAvailable,
  tbv2Until,
  waitCardColumn,
  type TbReadyHandles,
} from "./helpers/taskboard-v2-helpers"

// 票 07/08/09/10 组件的 data-* 锚（与各自单测逐字同源，不在 helpers 重复登记）。
const R = {
  tabBtn: (key: string) => `[data-testid="console-tab-${key}"]`,
  staticTab: () => `[data-testid="static-nodes-tab"]`,
  wfPill: () => `[data-testid="static-nodes-wf-pill"]`,
  summary: () => `[data-testid="static-nodes-summary"]`,
  nodeRows: () => `[data-tab-host="nodes"] [data-static-node-row]`,
  nodeRow: (id: string) => `[data-testid="static-node-row-${id}"]`,
  nodeEvents: (id: string) => `[data-testid="static-node-events-${id}"]`,
  specTab: () => `[data-testid="ready-spec-tab"]`,
  specPanel: () => `[data-tab-host="spec"] [data-spec-panel]`,
  checklistRow: (id: string) => `[data-tab-host="spec"] [data-checklist-v4="${id}"]`,
  readonlyBadge: () => `[data-ready-spec-readonly-badge]`,
  toolbar: () => `[data-ready-spec-toolbar]`,
  replay: () => `[data-testid="ready-chat-replay"]`,
  watermark: () => `[data-testid="ready-chat-watermark"]`,
  chatLog: () => `[data-testid="ready-chat-log"]`,
  chatEmpty: () => `[data-testid="ready-chat-empty"]`,
  badge: () => `[data-testid="ready-token-badge"]`,
  triggerBtn: () => `[data-task-trigger]`,
  popover: () => `[data-slot="popover-content"]`,
  closeBtn: () => `[data-run-console] button[aria-label="关闭"]`,
}

test.describe.configure({ mode: "serial" })

let handles: TbReadyHandles | null = null
let serverAvailable = false

test.beforeAll(async () => {
  serverAvailable = await tbv2ServerAvailable()
  if (!serverAvailable) {
    throw new Error(`server unavailable at ${tbv2Env().serverUrl} — 票11 流⑦ 不允许 skip`)
  }
})

test.afterAll(async () => {
  if (handles) {
    try {
      await handles.cleanup()
    } catch (err: unknown) {
      logError(`afterAll cleanup: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
})

test("流⑦ 待执行三签 —— 装配/静态节点/规格只读/对话回放/右栏账台/关窗回板（零 trigger 零 LLM）", async ({ page }) => {
  test.setTimeout(120_000)
  const tStart = Date.now()

  // ── seed：REST 直建 v4 → 挂草稿会话（2 消息 + 1 行会话账）→ ready；**不 trigger** ──
  handles = await tbv2SeedReadyTask({ flow: "f7" })
  const taskId = handles.taskId
  log(`f7 seeded at +${Date.now() - tStart}ms (task=${taskId})`)

  // 看板：卡诚实停在 ready 列
  await waitCardColumn(page, taskId, "ready")

  // ── 深链开壳：三签齐 + 默认落「◆ 节点」；六签形态页签绝迹（装配表 ready 行）──
  await openConsole(page, taskId)
  await expect
    .poll(async () => activeTabKey(page), { timeout: 20_000, message: "ready 态默认页签应为 nodes" })
    .toBe("nodes")
  await expect(page.locator(R.tabBtn("chat"))).toBeVisible()
  await expect(page.locator(R.tabBtn("spec"))).toBeVisible()
  await expect(page.locator(R.tabBtn("nodes"))).toBeVisible()
  expect(await page.locator("[data-console-tabs] [data-console-tab]").count(), "ready 装配应恰为三签").toBe(3)
  for (const gone of ["files", "usage", "artifacts", "console", "review"]) {
    await expect(page.locator(R.tabBtn(gone))).toHaveCount(0)
  }
  // 语境 token（顶栏）：未点火如实「⚡ 待触发」
  await expect(page.locator(SEL.consoleRoot())).toContainText("⚡ 待触发")

  // ── ◆ 节点：绑定流 YAML 声明序全 ○（用时/成本 —、汇总 0/N 等待触发）──
  await expect(page.locator(R.staticTab())).toBeVisible({ timeout: 20_000 })
  await expect(page.locator(R.wfPill())).toContainText("budget-test")
  const rowIds = await page.$$eval(
    R.nodeRows(),
    (els) => els.map((e) => (e as HTMLElement).dataset.staticNodeRow ?? ""),
  )
  expect(rowIds, "节点行 = 绑定流顶层节点声明序").toEqual(handles.nodeIds)
  for (const id of handles.nodeIds) {
    const row = page.locator(R.nodeRow(id))
    await expect(row).toBeVisible()
    await expect(row).toContainText("○")
    await expect(row).toContainText("—")
  }
  await expect(page.locator(R.summary())).toContainText(`0/${handles.nodeIds.length} 完成 · 等待触发`)
  // 展开一行 = 未执行占位（原型 nodeEvents ready 分支）
  await page.locator(R.nodeRow(handles.nodeIds[0]!)).click()
  await expect(page.locator(R.nodeEvents(handles.nodeIds[0]!))).toContainText("— 未执行 · 等待触发 —")

  // ── ▤ 规格：只读镜像上屏 + 六行清单全 ✓ + 写控件不渲染 ──
  await clickTab(page, "spec")
  await expect(page.locator(R.specTab())).toBeVisible({ timeout: 20_000 })
  await expect(page.locator(R.specPanel())).toBeVisible()
  await expect(page.locator(R.toolbar())).toContainText("要改请走右栏「↩ 回草稿」")
  await expect(page.locator(R.readonlyBadge())).toContainText("只读")
  // gate 已过 + 批次落盘 → 六行全 ✓（useBatchTree 磁盘直扫，等一拍现算）
  await tbv2Until(async () => {
    for (const id of ["phases", "spec", "bind", "inputs", "runbook", "repos"]) {
      const txt = (await page.locator(R.checklistRow(id)).first().textContent().catch(() => "")) ?? ""
      if (!txt.includes("✓")) return null
    }
    return true
  }, 20_000, "六行入队清单未全 ✓（gate 已过态不应有 ✗/⏳）")
  // 写控件单源换装（readOnly）：加 phase / spec·绑定入口 / auto_advance 行 / 复选框 —— 全部不渲染
  for (const sel of ["[data-phase-add-open]", "[data-phase-spec-button]", "[data-phase-bind-button]", "[data-autoadvance-row]", 'input[type="checkbox"]']) {
    expect(await page.locator(`[data-tab-host="spec"] ${sel}`).count(), `${sel} 不得出现在只读镜像`).toBe(0)
  }

  // ── 💬 对话：草稿期会话全史只读回放（seed 挂了会话 → 走回放路，非空态）──
  await clickTab(page, "chat")
  const replay = page.locator(R.replay())
  await expect(replay).toBeVisible({ timeout: 20_000 })
  await expect
    .poll(() => replay.getAttribute("data-replay-state"), { timeout: 20_000, message: "回放应经真端点取数落 ready 态" })
    .toBe("ready")
  await expect(page.locator(R.watermark())).toContainText("只读回放 · 草稿期对话")
  await expect(page.locator(R.chatLog())).toContainText(handles.userMarker)
  await expect(page.locator(R.chatLog())).toContainText(handles.aiMarker)
  await expect(page.locator(R.chatEmpty())).toHaveCount(0)
  // 只读硬闸：对话宿主内零输入通道（无 form/输入框/textarea）
  expect(await page.locator(`${SEL.host("chat")} [data-chat-form]`).count()).toBe(0)
  expect(await page.locator(`${SEL.host("chat")} input, ${SEL.host("chat")} textarea`).count()).toBe(0)

  // ── 右栏账台角标：有账出账（tok/▾），常驻「⚡ 触发」上方；点开浮层含命中率 + 完整台账新标签 ──
  const badge = page.locator(R.badge())
  await expect(badge).toBeVisible({ timeout: 20_000 })
  const railOrder = await page.$$eval(
    `[data-rail-acts] ${R.badge()}, [data-rail-acts] ${R.triggerBtn()}`,
    (els) => els.map((e) => (e.hasAttribute("data-task-trigger") ? "trigger" : "badge")),
  )
  expect(railOrder, "角标常驻「⚡ 触发」上方（DOM 序 badge→trigger）").toEqual(["badge", "trigger"])
  await badge.click()
  const popover = page.locator(R.popover())
  await expect(popover).toBeVisible({ timeout: 10_000 })
  await expect(popover).toContainText("缓存命中率")
  const ledgerLink = popover.locator('a:has-text("完整台账")')
  await expect(ledgerLink).toHaveAttribute("target", "_blank")
  await expect(ledgerLink).toHaveAttribute("href", /\/system\/billing/)
  // 收回：Esc 出口随 Radix 白拿（右栏不推挤、触发钮原样在场）
  await page.keyboard.press("Escape")
  await expect(popover).toBeHidden({ timeout: 10_000 })
  await expect(page.locator(R.triggerBtn())).toBeVisible()

  await page.screenshot({ path: path.join(shotDir("flow7"), "flow7-ready-tri-tab.png") })

  // ── 关窗回板 ──
  await page.locator(R.closeBtn()).click()
  await expect(page.locator(SEL.consoleRoot())).toHaveCount(0, { timeout: 10_000 })
  await waitCardColumn(page, taskId, "ready")

  // ── 终对账（服务端真相）：仍 ready、phase 零轮、零执行行 —— 全程零 trigger/零 LLM ──
  const derived = await tbv2Derived(taskId)
  expect(derived.taskStatus, "未点火的派生态应稳定在 ready").toBe("ready")
  expect(derived.isV4, "v4 任务").toBe(true)
  expect(derived.phaseViews.length, "单 phase 视图在场").toBe(1)
  expect(derived.phaseViews[0]!.rounds.length, "ready 未点火 = 该相零轮").toBe(0)
  expect(tbv2RootExecs(taskId), "零执行行（不经 dispatcher）").toHaveLength(0)

  const elapsed = Date.now() - tStart
  log(`f7 ok: 三签烟测全链 ${Math.round(elapsed / 1000)}s（回放=挂会话路 · 角标=有账路 · 零 trigger）`)
  expect(elapsed, "AC: 单跑目标 <60s").toBeLessThan(60_000)
})
