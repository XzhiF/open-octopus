// packages/web-app/e2e/draft-artifact-visibility.spec.ts
//
// 起草面产物可见性 — 输出区「任务 home 磁盘直扫树」浏览器穿线（2026-09-24 改版：
// 「更多」弹窗 / 草稿批次区退役，改为整棵任务 home 如实直扫）：
//   ① v4 draft + 只写盘不写契约（phases[] 空）→ 输出区仍如实显示磁盘文件（PP1：
//      可见性不被 phases[] 门控）
//   ② 树头显示任务 home 绝对路径；artifacts/ 与 .scratch/ 文件都在列
//   ③ 点文件 → 只读查看弹窗，UTF-8 干净（中文不乱码）
//   ④ 外部再写一批 + [↻] 手刷 → 新文件出现（刷新通路）
//   ⑤ 空目录如实显示（文件系统即真相，不做产物语义过滤）
//   ⑥ DELETE 清草稿 + home。
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
  createTask,
  taskHomePath,
  ensureScreenshotDir,
  screenshotPath,
} from "./helpers/task-domain-helpers"

const WEB_URL = process.env.E2E_WEB_URL ?? "http://localhost:3000"
const UNIQ = `e2e53-${Date.now().toString(36)}`
const BATCH_A = `${UNIQ}-a`
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

/** 直写任务 home 文件（绕过 home-file PUT 的 .scratch 白名单 —— 树是整棵 home
 *  直扫，e2e 用 fs 真相注入 artifacts/ 与 .scratch/ 两侧）。 */
function seedHome(id: string, rel: string, content: string): void {
  const home = taskHomePath(id)
  if (!home) throw new Error(`no home for ${id}`)
  const full = path.join(home, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, "utf-8")
}

function mkdirHome(id: string, rel: string): void {
  const home = taskHomePath(id)
  if (!home) throw new Error(`no home for ${id}`)
  fs.mkdirSync(path.join(home, rel), { recursive: true })
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

test.describe("起草面产物可见性 — 任务 home 磁盘直扫树", () => {
  test("落盘即现 → 完整路径 / 全目录如实 / 只读弹窗 / [↻] 刷新", async ({ page }) => {
    test.skip(!serverOk || !webOk, "dev server / web not reachable")

    // ① 造 live 前置：v4 draft（phases 不写）+ artifacts/ 与 .scratch/ 各落文件
    const task = await createTask({ org: TASK_E2E_ORG, name: `E2E_TD #53 ${UNIQ}`, task_spec: { format: "v4" } })
    taskId = task.id
    const home = taskHomePath(taskId)!
    seedHome(taskId, `artifacts/report.md`, "# 计费核心 MVP\n\n价格配置 DB 化，一次调用端到端算对钱。\n")
    seedHome(taskId, `artifacts/issues/09-e2e-verify.md`, "# 09 E2E 收口\n\n验收：全局计费页可对账。\n")
    seedHome(taskId, `.scratch/${TODAY}/${BATCH_A}/spec.md`, "# 契约草案\n\nphase 化拆分。\n")
    mkdirHome(taskId, "artifacts/empty-dir")

    // home-tree API 真相先行（fs↔API）
    const tree0 = await (await fetch(`${SERVER_URL}/api/tasks/${taskId}/home-tree`)).json()
    const paths0 = (tree0.entries as Array<{ path: string }>).map((e) => e.path)
    expect(paths0).toContain("artifacts/report.md")
    expect(paths0).toContain(`.scratch/${TODAY}/${BATCH_A}/spec.md`)
    expect(paths0).toContain("artifacts/empty-dir/")
    expect(tree0.dir).toBe(home)

    // 进看板 → 打开草稿卡
    await page.goto(`${WEB_URL}/tasks`)
    const card = page.locator(`[data-task-column="draft"] [data-task-id="${taskId}"]`)
    await expect(card).toBeVisible({ timeout: 15_000 })
    await card.click()
    const dialog = page.getByRole("dialog")
    await expect(dialog.locator("[data-authoring-workspace]")).toBeVisible({ timeout: 20_000 })

    // ② 树头 = 任务 home 绝对路径；契约面「尚无 phase」但磁盘文件已在（PP1）
    await expect(dialog.locator("[data-phase-bind-empty]")).toBeVisible()
    await expect(dialog.locator("[data-home-dir]")).toContainText(home, { timeout: 10_000 })
    await expect(dialog.locator('[data-artifacts-file="artifacts/report.md"]')).toBeVisible({ timeout: 10_000 })
    await expect(dialog.locator('[data-artifacts-dir="artifacts/empty-dir/"]')).toBeVisible()
    await page.screenshot({ path: screenshotPath("53-01-home-tree.png") })

    // ③ 点文件 → 只读查看弹窗，UTF-8 干净（中文不乱码）
    await dialog.locator('[data-artifacts-file="artifacts/issues/09-e2e-verify.md"]').click()
    const viewer = page.locator("[data-home-file-content]")
    await expect(viewer).toBeVisible({ timeout: 10_000 })
    await expect(viewer).toContainText("E2E 收口")
    await page.screenshot({ path: screenshotPath("53-02-file-viewer.png") })
    await page.keyboard.press("Escape")
    await expect(viewer).toBeHidden({ timeout: 5_000 })

    // ④ 外部直写新文件 + [↻] 手刷 → 新文件出现（刷新通路）
    seedHome(taskId, "artifacts/late-report.md", "# 迟到产物\n\n聚合报表可对账。\n")
    await dialog.locator("[data-artifacts-refresh]").click()
    await expect(dialog.locator('[data-artifacts-file="artifacts/late-report.md"]')).toBeVisible({ timeout: 10_000 })
    await page.screenshot({ path: screenshotPath("53-03-refresh.png") })

    // ⑤ 折叠目录 → 子树消失，再展开回来（如实视图的交互闸）
    await dialog.locator('[data-artifacts-dir="artifacts/issues/"]').click()
    await expect(dialog.locator('[data-artifacts-file="artifacts/issues/09-e2e-verify.md"]')).toBeHidden({ timeout: 5_000 })
    await dialog.locator('[data-artifacts-dir="artifacts/issues/"]').click()
    await expect(dialog.locator('[data-artifacts-file="artifacts/issues/09-e2e-verify.md"]')).toBeVisible({ timeout: 5_000 })

    // ⑥ 清理（home 路径 DELETE 前捕获，删后轮询 home 目录消失）
    expect(home).toBeTruthy()
    await deleteTaskRaw(taskId)
    await expect.poll(() => fs.existsSync(home), { timeout: 8_000 }).toBe(false)
    taskId = null
  })
})
