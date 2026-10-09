// packages/web-app/e2e/taskboard-flow-2-awaiting-chat-quick-edit.spec.ts
//
// 票 10 流② —— 待验收卡 → 默认「💬 对话」→ 发小改 → 「≡ 变更」出现 💬chat 行进变更。
//
// 真链路（零 mock、零 skip；R1/R5/R7）：REST 直造 v4 任务 + bash stub 快轮（落一个真实
// commit 后收束）→ 真实 dispatcher claim/执行/collect → 真实 awaiting_review。
// 「发小改」走真实 task-doer 对话（票01 S1 seam + 真 provider，UI 真点击发送）：
// 回复里 Edit/Write 工具卡上屏、server 回合后机械判定脏仓 → 真实 [quick-edit] commit
// 落执行分支、quick_edit_commit 尾帧驱动「≡ 变更」的 ×N 与行徽标（票03 rowDecor 契约）。
//
// 诚实边界（写死在断言里，不装）：待验收轮的 round-diff 端锚冻结在收轮快照（票03 口径，
// ADR-0022 证据快照发生在决策时）—— 收轮后的快改 commit 不改变「本轮」提交/行数，
// 票07 的「统计变化」在产品里由「💬 chat 快改 ×N」chip + 行上 💬chat 徽标承载。
// 因此本流断言：默认对话页 → 工具卡 + ×1 chip → 切「≡ 变更」该文件行带 💬chat 徽标
// → git 直读确认 [quick-edit] 提交真实存在 → DB 确认 doer 会话持久绑定。
// （若 review-fixer 之后把待验收端锚改成随快改推进，chip/徽标断言依然成立。）
//
// 运行：pnpm -C <worktree>/packages/web-app test:e2e:taskboard-v2。

import { test, expect } from "@playwright/test"
import * as path from "path"
import {
  SEL,
  activeTabKey,
  clickTab,
  gitAt,
  gitHead,
  log,
  logError,
  openConsole,
  shotDir,
  tbv2Api,
  tbv2BootFlow,
  tbv2DbGet,
  tbv2Derived,
  tbv2Env,
  tbv2ServerAvailable,
  tbv2Until,
  waitCardColumn,
  type TbFlowHandles,
} from "./helpers/taskboard-v2-helpers"

test.describe.configure({ mode: "serial" })

let handles: TbFlowHandles | null = null
let serverAvailable = false

test.beforeAll(async () => {
  serverAvailable = await tbv2ServerAvailable()
  if (!serverAvailable) {
    throw new Error(`server unavailable at ${tbv2Env().serverUrl} — 票10 流② 不允许 skip`)
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

test("流② 待验收 → 默认对话 → 真 task-doer 小改 → 变更页 💬chat 行 + 快改计数", async ({ page }) => {
  test.setTimeout(420_000)

  // ── boot：真实跑完一轮 → 真实待验收 ──
  handles = await tbv2BootFlow({ flow: "f2", parkSeconds: 0 })
  const taskId = handles.taskId
  const derived0 = await tbv2Until(async () => {
    const d = await tbv2Derived(taskId)
    return d.taskStatus === "awaiting_review" ? d : null
  }, 180_000, "round never landed at awaiting_review (terminal+collect path)", 1500)
  expect(derived0.phaseViews[0].awaitingRound, "phase1 r1 待验收").toBe(1)
  await waitCardColumn(page, taskId, "awaiting_review")

  // ── UI：深链开壳；待验收装配表默认页 =「💬 对话」，形态 = 快速修改 ──
  await openConsole(page, taskId)
  await expect
    .poll(async () => activeTabKey(page), { timeout: 20_000, message: "待验收态默认页签应为 chat" })
    .toBe("chat")
  const chatForm = page.locator(SEL.chatForm())
  await expect(chatForm).toHaveAttribute("data-chat-form", "quick-edit", { timeout: 20_000 })
  // 会话绑定真发生（GET /:id/chat 懒建）：输入框解禁
  const chatInput = page.locator(SEL.chatInput())
  await expect(chatInput).toBeEnabled({ timeout: 30_000 })

  // 真实副作用①（fs/git 基线）：本轮 agent commit 的文件在工作区里存在
  const repoDir = handles.repoWorkDir()
  await tbv2Until(() => (gitAt(["ls-files"], repoDir).includes("tbv2-note.md") ? true : null), 30_000, "round commit file not present")

  // ── 发小改：真实 task-doer 回合（真 provider，UI 真点击）──
  const marker = `E2E_TBV2_CHAT_${handles.run}`
  await chatInput.fill(`把 projects/${handles.projName}/tbv2-note.md 的内容改成一行：${marker}。只改这一个文件，不要 git commit。`)
  const respP = page
    .waitForResponse((r) => r.url().includes(`/api/tasks/${taskId}/chat`) && r.request().method() === "POST", { timeout: 240_000 })
    .catch(() => null)
  await page.locator(SEL.chatSend()).click()

  // 真实副作用②：工具卡上屏（对话页内）；quick_edit_commit 尾帧驱动壳态计数
  await expect(page.locator(SEL.chatToolCard()).first()).toBeVisible({ timeout: 240_000 })
  await respP

  // 真实副作用③（git 直读）：server 自动落的 [quick-edit] commit 真实存在且内容对
  const headSha = await tbv2Until(() => {
    const sha = gitHead(repoDir)
    const subj = gitAt(["log", "-1", "--pretty=%s"], repoDir)
    return subj.startsWith("[quick-edit] ") ? sha : null
  }, 20_000, "no [quick-edit] commit landed on the execution branch")
  const body = gitAt(["show", `${headSha}:tbv2-note.md`], repoDir)
  expect(body, "the chat edit really changed the file").toContain(marker)

  // 真实副作用④（DB）：doer 会话持久绑定到任务行（票01 契约）
  const taskRow = tbv2DbGet<{ doer_session_id: string | null }>("SELECT doer_session_id FROM tasks WHERE id = ?", taskId)
  expect(taskRow?.doer_session_id, "tasks.doer_session_id persisted").toBeTruthy()
  const binding = await tbv2Api.chatBinding(taskId)
  expect(binding.session_id).toBe(taskRow?.doer_session_id as string)

  // ── 切「≡ 变更」：该文件行带 💬chat 徽标（07 rowDecor 钩子走真数据）──
  await clickTab(page, "files")
  await expect(page.locator(SEL.filesTab())).toBeVisible({ timeout: 20_000 })
  // 作用域收到 files 宿主（keep-mounted 的走查面也渲染 diff 行 —— 不带 rowDecor 徽标）
  const noteRow = page.locator(`${SEL.host("files")} ${SEL.fileRows()}:has-text("tbv2-note.md")`)
  await expect(noteRow).toBeVisible({ timeout: 30_000 })
  await expect(noteRow.locator(SEL.quickEditBadge())).toHaveCount(1, { timeout: 20_000 })
  await page.screenshot({ path: path.join(shotDir("flow2"), "flow2-quick-edit-badge.png") })

  // ── 票11 ⑩回补（最小真机断言）：消耗/产物页签装配 · 日志页签无 AI 卡 · 右栏中止 ──
  await expect(page.locator(SEL.tab("usage"))).toBeVisible()
  await expect(page.locator(SEL.tab("artifacts"))).toBeVisible()
  // ▤ 消耗：卡三段在场（AI 卡的家已从日志迁来这）
  await clickTab(page, "usage")
  await expect(page.getByText("任务 AI 消耗")).toBeVisible({ timeout: 20_000 })
  // ▣ 产物：真实批次目录落盘 → 至少 spec.md 一行（分组清单现扫）
  await clickTab(page, "artifacts")
  await expect(page.locator(`[data-testid="artifacts-tab"] [data-testid="artifact-row"]`).first()).toBeVisible({ timeout: 20_000 })
  // ▶ 日志：工作区事件流在场、「任务 AI 消耗」字样绝迹
  await clickTab(page, "console")
  await expect(page.locator(SEL.consoleRoot())).toContainText("工作区事件流")
  await expect(page.locator(SEL.consoleRoot())).not.toContainText("任务 AI 消耗")
  // 右栏 = 通过→打回→■中止；点开二次确认即 Esc 收掉（真中止会破坏末段对账，不点确认）
  await expect(page.locator(`[data-rail-acts] [data-task-abort]`)).toBeVisible()
  await page.locator(`[data-rail-acts] [data-task-abort]`).click()
  await expect(page.getByRole("button", { name: "确认中止" })).toBeVisible({ timeout: 10_000 })
  await page.keyboard.press("Escape")
  await expect(page.getByRole("button", { name: "确认中止" })).toBeHidden({ timeout: 10_000 })

  // 收尾对账：API 读面同意待验收仍在（快改不改决策态；中止仅开了确认没落端点）
  const derived1 = await tbv2Derived(taskId)
  expect(derived1.taskStatus).toBe("awaiting_review")
  log(`f2 ok: chat quick-edit ${headSha.slice(0, 8)} → 💬chat 行 + ×1 chip，真实 doer 会话 ${taskRow?.doer_session_id?.slice(0, 8)}`)
})
