// packages/web-app/e2e/taskboard-flow-3-pause-inject-resume.spec.ts
//
// 票 10 流③ —— 执行中 → ⏸ → 注入干预 → 恢复 → 日志见 ⚑ 高亮行、LIVE 卡计数 ×1。
//
// 真链路（零 mock、零 skip；R1/R5/R7）：真实 v4 任务 + 真实触发轮 —— bash 节点先在
// 执行仓落一个 commit，再 `sleep` 停驻（一个真在跑的节点；pause 无运行节点会 409，
// 这条流必须活在引擎里）。⏸/▶/注入全走壳右栏真按钮（票06 三分支弹框），
// POST /pause、POST /resume{intervention} 真发；留痕 = ExecutionLifecycle.resume
// 当下写的 agent_events('intervention') 行（票06 唯一落库点），读取面 = 既有
// GET agent-events 的孪生映射 → 控制台「⚑ 人工干预」高亮行 + LIVE 卡 ×N。
//
// ⚠ 复核名单（对最终 tip）：LIVE 卡 ×N 的口径（本轮断言 ×1 —— 单发干预时
// 「最近干预目标节点累计」与「当前节点」两种口径同值）；review-fixer 若改
// 计数归属节点的定义，本条 ×1 断言需要在最终 tip 上复跑确认。
//
// 运行：pnpm -C <worktree>/packages/web-app test:e2e:taskboard-v2。

import { test, expect } from "@playwright/test"
import * as path from "path"
import {
  SEL,
  clickTab,
  gitAt,
  gitHead,
  log,
  logError,
  openConsole,
  shotDir,
  tbv2BootFlow,
  tbv2DbGet,
  tbv2Env,
  tbv2InterventionEventCount,
  tbv2RootExecs,
  tbv2ServerAvailable,
  tbv2Until,
  tbv2WaitRunningNode,
  type TbFlowHandles,
} from "./helpers/taskboard-v2-helpers"

test.describe.configure({ mode: "serial" })

let handles: TbFlowHandles | null = null

test.beforeAll(async () => {
  if (!(await tbv2ServerAvailable())) {
    throw new Error(`server unavailable at ${tbv2Env().serverUrl} — 票10 流③ 不允许 skip`)
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

test("流③ running → ⏸ → 注入干预 → 恢复 → ⚑ 高亮行 + LIVE 卡 ⚑干预×1", async ({ page }) => {
  test.setTimeout(360_000)

  // ── boot：真在跑的轮（bash 先落 commit 再 sleep 停驻）──
  handles = await tbv2BootFlow({ flow: "f3", parkSeconds: 480, churnEverySeconds: 0, churnRounds: 0 })
  const taskId = handles.taskId
  const { execId, nodeId } = await tbv2WaitRunningNode(handles)

  // ── UI：开壳 → ⏸（真点击，真 POST）──
  await openConsole(page, taskId)
  const pauseBtn = page.locator(SEL.railPause())
  await expect(pauseBtn).toBeVisible({ timeout: 30_000 })
  const pauseRespP = page.waitForResponse((r) => r.url().includes(`/api/tasks/${taskId}/pause`) && r.request().method() === "POST")
  await pauseBtn.click()
  const pauseResp = await pauseRespP
  expect(pauseResp.status(), "rail ⏸ → POST pause 应 200").toBe(200)

  // 真实副作用①（DB）：绑定执行行落 paused；壳 chrome 派生「已暂停」
  await tbv2Until(() => {
    const row = tbv2RootExecs(taskId).find((r) => r.id === execId)
    return row && row.status === "paused" ? row : null
  }, 30_000, "execution row never flipped to paused")
  await expect(page.locator(SEL.railResume())).toBeVisible({ timeout: 30_000 })

  // ── 恢复 → 三分支弹框 → ⚑ 注入并继续 ──
  await page.locator(SEL.railResume()).click()
  await expect(page.locator(SEL.injectDialog())).toBeVisible({ timeout: 15_000 })
  const intervention = `E2E_TBV2 干预 ${handles.run} — 方向不变：保持现改动，勿动其它文件，继续跑`
  await page.locator(SEL.injectText()).fill(intervention)
  const resumeRespP = page.waitForResponse((r) => r.url().includes(`/api/tasks/${taskId}/resume`) && r.request().method() === "POST")
  await page.locator(SEL.injectConfirm()).click()
  const resumeResp = await resumeRespP
  expect(resumeResp.status(), "⚑ 注入并继续 → POST resume 应 200").toBe(200)

  // 真实副作用②（DB，票06 权威 SQL）：resume 当下落的 intervention 事件行
  const ivCount = await tbv2Until(() => {
    const n = tbv2InterventionEventCount(execId)
    return n >= 1 ? n : null
  }, 30_000, "no agent_events('intervention') row for the resumed execution")
  expect(ivCount, "单发干预 = 1 行留痕").toBe(1)
  const evRow = tbv2DbGet<{ content: string }>(
    `SELECT ae.content FROM agent_events ae JOIN node_executions ne ON ae.node_execution_id = ne.id
      WHERE ne.execution_id = ? AND ae.event_type = 'intervention' LIMIT 1`,
    execId,
  )
  const evContent = JSON.parse(evRow!.content) as { nodeId?: string; nodeName?: string; prompt?: string }
  expect(evContent.nodeId, "留痕指向被打断的节点").toBe(nodeId)
  expect(evContent.prompt, "留痕携带干预原文").toContain(handles.run)

  // 真实副作用③（DB）：恢复后执行重新 running（引擎在飞）
  await tbv2Until(() => {
    const row = tbv2RootExecs(taskId).find((r) => r.id === execId)
    return row && row.status === "running" ? row : null
  }, 30_000, "execution never resumed to running")

  // ── UI：日志见 ⚑ 高亮行；LIVE 卡 ⚑ 干预×1 ──
  await clickTab(page, "console")
  await expect(page.locator(SEL.interventionLog())).toBeVisible({ timeout: 40_000 })
  const line = page.locator(SEL.interventionLine())
  await expect(line).toHaveCount(1, { timeout: 30_000 })
  await expect(line).toContainText("⚑ 人工干预")
  await expect(line).toContainText(handles.run)

  // 恢复后 5s 轮才拉到 ⚑（壳 fetchAgentEvents 节拍）→ LIVE 卡 chip 出现
  await expect(page.locator(SEL.liveCard()).locator(SEL.interventionChip())).toContainText("⚑ 干预×1", { timeout: 40_000 })
  await page.screenshot({ path: path.join(shotDir("flow3"), "flow3-intervention-line.png") })

  // 反假跑终证：新 commit 区间仍然真实可数（恢复=从该节点重跑，git 现场没被谎报）
  const repoDir = handles.repoWorkDir()
  const subjects = gitAt(["log", "-2", "--pretty=%s"], repoDir)
  expect(subjects.includes("tbv2"), `git log carries the round's own commits, got: ${subjects}`).toBe(true)
  log(`f3 ok: pause→inject→resume on exec ${execId.slice(0, 8)} node ${nodeId}; intervention rows=${ivCount}; HEAD=${gitHead(repoDir).slice(0, 8)}`)
})
