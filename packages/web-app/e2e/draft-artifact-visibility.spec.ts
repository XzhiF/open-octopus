// packages/web-app/e2e/draft-artifact-visibility.spec.ts
//
// #53 起草面产物可见性 — 浏览器穿线（票 04）：
//   ① v4 draft + agent 视角「只写盘不写契约」(phases[] 空) → 「草稿批次」区
//      仍出现批次行（PP1 修透：可见性不再被 phases[] 门控）
//   ② 展开批次 → 文件 chips → 点 spec.md → PhaseSpecDialog 内容 UTF-8 干净
//   ③ 外部再写一批 + [↻] 手刷 → 新批次出现（刷新通路）
//   ④ [建骨架并对位] → phase 行出现 + ● P1 + 入队清单 phases/spec 绿（磁盘已核）
//   ⑤ Phase 行 ▾ 展开 → spec ✓ 灯 + 票 chips；点票 chip → 弹窗开在该票（PP2 修透）
//   ⑥ manifest 行 = 「规格快照」新名
//   ⑦ DELETE 清草稿 + home。
//
// 纪律同 task-authoring-v4（UI 动作走浏览器、断言回 API+fs；E2E_TD_ 隔离；
// server/web 不可达整文件 skip）。R1 的「agent 真会话触发」一项按成本口径
// SKIP（机制证据 = use-batch-tree 单测 AC1/AC2）。

import { test, expect } from "@playwright/test"
import fs from "fs"
import path from "path"
import {
  SERVER_URL,
  TASK_E2E_ORG,
  log,
  isServerAvailable,
  getTask,
  createTask,
  taskHomePath,
  ensureScreenshotDir,
  screenshotPath,
} from "./helpers/task-domain-helpers"

const WEB_URL = process.env.E2E_WEB_URL ?? "http://localhost:3000"
const UNIQ = `e2e53-${Date.now().toString(36)}`
const BATCH_A = `${UNIQ}-a`
const BATCH_B = `${UNIQ}-b`
const TODAY = (() => {
  const d = new Date()
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`
})()

let serverOk = false
let webOk = false
let taskId: string | null = null

async function deleteTaskRaw(id: string): Promise<void> {
  try {
    await fetch(`${SERVER_URL}/api/tasks/${id}`, { method: "DELETE" })
  } catch {
    /* best-effort */
  }
}

async function putHomeFile(rel: string, content: string): Promise<void> {
  const res = await fetch(`${SERVER_URL}/api/tasks/${taskId}/home-file`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: rel, content }),
  })
  if (!res.ok) throw new Error(`putHomeFile ${rel} → ${res.status} ${await res.text()}`)
}

test.beforeAll(async () => {
  serverOk = await isServerAvailable()
  try {
    const res = await fetch(`${WEB_URL}/tasks`, { signal: AbortSignal.timeout(3000) })
    webOk = res.ok || res.status < 500
  } catch {
    webOk = false
  }
  ensureScreenshotDir()
  if (!serverOk || !webOk) log(`skip: server=${serverOk} web=${webOk}`)
})

test.afterAll(async () => {
  if (taskId) await deleteTaskRaw(taskId)
})

test.describe("#53 起草面产物可见性穿线", () => {
  test("落盘即现 → 直扫区/对位/建骨架/行内展开/manifest 新名", async ({ page }) => {
    test.skip(!serverOk || !webOk, "dev server / web not reachable")

    // ① 造 live 前置：v4 draft（phases 不写）+ 批次 A 三文件直写磁盘
    const task = await createTask({ org: TASK_E2E_ORG, name: `E2E_TD #53 ${UNIQ}`, task_spec: { format: "v4" } })
    taskId = task.id
    await putHomeFile(`.scratch/${TODAY}/${BATCH_A}/spec.md`, "# 计费核心 MVP\n\n价格配置 DB 化，一次调用端到端算对钱。\n\n## Key Decisions\n\n| # | Decision | Conclusion | Reason |\n|---|---|---|---|\n| 1 | 边界 | 纯观测 | 用户拍板 |\n")
    await putHomeFile(`.scratch/${TODAY}/${BATCH_A}/issues/01-price-db.md`, "# 01 价格表 DB 化\n\n验收：四类单价入库。\n")
    await putHomeFile(`.scratch/${TODAY}/${BATCH_A}/issues/09-e2e-verify.md`, "# 09 E2E 收口\n\n验收：全局计费页可对账。\n")

    // batch-tree API 真相先行（fs↔API）
    const tree0 = await (await fetch(`${SERVER_URL}/api/tasks/${taskId}/batch-tree`)).json()
    expect(tree0.batches.map((b: { slug: string }) => b.slug)).toContain(BATCH_A)

    // 进看板 → 打开草稿卡
    await page.goto(`${WEB_URL}/tasks`)
    const card = page.locator(`[data-task-column="draft"] [data-task-id="${taskId}"]`)
    await expect(card).toBeVisible({ timeout: 15_000 })
    await card.click()
    const dialog = page.getByRole("dialog")
    await expect(dialog.locator("[data-authoring-workspace]")).toBeVisible({ timeout: 20_000 })

    // ② PP1 核心断言：phases[] 为空（契约面「尚无 phase」），磁盘批次行已在
    await expect(dialog.locator("[data-phase-bind-empty]")).toBeVisible()
    const rowA = dialog.locator(`[data-batch-row="${BATCH_A}"]`)
    await expect(rowA).toBeVisible({ timeout: 10_000 })
    await expect(rowA).toContainText("spec✓")
    await expect(rowA).toContainText("票×2")
    await expect(dialog.locator(`[data-batch-adopt="${BATCH_A}"]`)).toBeVisible() // ○ 未对位 + 建骨架
    await page.screenshot({ path: screenshotPath("53-01-draft-batches-pp1.png") })

    // ③ 展开批次 A → chips → 点 spec.md → 弹窗 UTF-8 干净
    await dialog.locator(`[data-batch-toggle="${BATCH_A}"]`).click()
    await expect(dialog.locator(`[data-batch-file=".scratch/${TODAY}/${BATCH_A}/spec.md"]`)).toBeVisible()
    await dialog.locator(`[data-batch-file=".scratch/${TODAY}/${BATCH_A}/issues/09-e2e-verify.md"]`).click()
    const editor = page.locator("[data-spec-editor]")
    await expect(editor).toBeVisible({ timeout: 10_000 })
    await expect(editor).toContainText("E2E 收口") // 中文干净（RC1b 反证）
    await page.screenshot({ path: screenshotPath("53-02-file-dialog.png") })
    await page.keyboard.press("Escape")
    await expect(editor).toBeHidden({ timeout: 5_000 })

    // ④ 外部直写批次 B + [↻] 手刷 → 新批出现（刷新通路）
    await putHomeFile(`.scratch/${TODAY}/${BATCH_B}/spec.md`, "# 聚合报表\n\n日报聚合可对账。\n")
    await dialog.locator("[data-batch-refresh]").click()
    await expect(dialog.locator(`[data-batch-row="${BATCH_B}"]`)).toBeVisible({ timeout: 10_000 })

    // ⑤ 建骨架并对位（批次 A）→ phase 行 + ● P1 + 清单磁盘判定绿
    await dialog.locator(`[data-batch-adopt="${BATCH_A}"]`).click()
    await expect(dialog.locator("[data-phase-bind-card='1']")).toBeVisible({ timeout: 10_000 })
    const rowA2 = dialog.locator(`[data-batch-row="${BATCH_A}"]`)
    await expect(rowA2.locator(`[data-batch-matched="${BATCH_A}"]`)).toHaveText("● P1")
    await expect(dialog.getByTestId("enqueue-checklist-v4")).toContainText("磁盘已核")
    await expect(dialog.locator("[data-checklist-v4='phases']")).toContainText("✅")
    await expect(dialog.locator("[data-checklist-v4='spec']")).toContainText("✅")
    await page.screenshot({ path: screenshotPath("53-03-adopt-and-gate.png") })

    // ⑥ PP2 核心断言：Phase 行 ▾ 展开 = spec ✓ 灯 + 票 chips（不点小图标不开弹窗）。
    // 2026-09-12 分层改版：首个 phase 默认已展开 → 先点收起、再点展开验证 toggle。
    await expect(dialog.locator("[data-phase-expand-panel='1']")).toBeVisible({ timeout: 10_000 })
    await dialog.locator("[data-phase-expand-toggle='1']").click()
    await expect(dialog.locator("[data-phase-expand-panel='1']")).toHaveCount(0)
    await dialog.locator("[data-phase-expand-toggle='1']").click()
    await expect(dialog.locator("[data-phase-spec-disk='1']")).toContainText("spec.md ✓")
    await expect(dialog.locator(`[data-phase-ticket=".scratch/${TODAY}/${BATCH_A}/issues/01-price-db.md"]`)).toBeVisible()
    await expect(dialog.locator(`[data-phase-ticket=".scratch/${TODAY}/${BATCH_A}/issues/09-e2e-verify.md"]`)).toBeVisible()
    await expect(dialog.locator("[data-phase-summary='1']")).toContainText("Key Decisions 1 条")
    await page.screenshot({ path: screenshotPath("53-04-inline-expand.png") })
    // 点票 chip 开弹窗并定位在该票（批次域整列：spec 与另一票可切换）
    await dialog.locator(`[data-phase-ticket=".scratch/${TODAY}/${BATCH_A}/issues/01-price-db.md"]`).click()
    await expect(editor).toBeVisible({ timeout: 10_000 })
    await expect(editor).toContainText("价格表 DB 化")
    await page.keyboard.press("Escape")

    // ⑦ manifest 降位新名
    await expect(dialog.locator("[data-manifest-viewer-row]")).toContainText("规格快照")

    // DB↔API 交叉：phases 一行且 specPath 指真实批次目录
    const after = await getTask(taskId)
    const phases = (after.task_spec as unknown as { phases: Array<Record<string, unknown>> }).phases
    expect(phases).toHaveLength(1)
    expect(String(phases[0].specPath)).toBe(`./.scratch/${TODAY}/${BATCH_A}/spec.md`)
    expect(String(phases[0].name)).toBe("计费核心 MVP") // spec 首标题 = phase 名
    expect(phases[0].workflowRef).toBe("built-in/matt-spec-dev")

    // ⑧ 清理（home 路径 DELETE 前捕获，删后轮询落盘批次树消失）
    const home = taskHomePath(taskId)
    expect(home).toBeTruthy()
    await deleteTaskRaw(taskId)
    await expect.poll(() => fs.existsSync(path.join(home!, ".scratch")), { timeout: 8_000 }).toBe(false)
    taskId = null
  })
})
