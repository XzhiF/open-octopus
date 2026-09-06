// packages/web-app/e2e/task-authoring-v4.spec.ts
//
// 契约修复（v4-only 创建链路）浏览器穿线 — 一次真实端到端：
//   ① 看板 [+新建任务] → 模板页（v4-only：无类型卡、无 skill 组、有 codebase 段）
//   ② 开始编写 → D15 序列（clone session + POST 直建 v4）→ 进 AuthoringWorkspace
//   ③ DB 真相：task_spec.format==="v4" 且无 task_type 键；home + manifest.json 快照带旗标
//   ④ 右栏「添加 Phase」手动建行（workflow 走内置目录初选）→ 整数组 PUT 落库
//   ⑤ 行上 spec.md → 404 空态 →「创建骨架」→ home-file 落盘（fs 真相）
//   ⑥ 入队清单四行随写入实时变绿（phases/spec/bind 三行 ✅）
//   ⑦ DELETE 清草稿 + home。
//
// Fixture 纪律同 task-phase-* 系（R1/R3：UI 动作走浏览器、断言回 API+DB+fs；
// E2E_TD_ 前缀隔离 R7）。前置：dev server（3001）+ web（3000）在跑；server 或
// web 不可达时整文件 skip（不误报红）。

import { test, expect } from "@playwright/test"
import fs from "fs"
import path from "path"
import {
  SERVER_URL,
  TASK_E2E_ORG,
  log,
  isServerAvailable,
  getTask,
  readTaskRow,
  taskHomePath,
  ensureScreenshotDir,
  screenshotPath,
} from "./helpers/task-domain-helpers"

const WEB_URL = process.env.E2E_WEB_URL ?? "http://localhost:3000"
const UNIQ = `e2ev4-${Date.now().toString(36)}`

async function isWebAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${WEB_URL}/tasks`, { signal: AbortSignal.timeout(3000) })
    return res.ok || res.status < 500
  } catch {
    return false
  }
}

async function deleteTaskRaw(taskId: string): Promise<void> {
  try {
    await fetch(`${SERVER_URL}/api/tasks/${taskId}`, { method: "DELETE" })
  } catch {
    /* best-effort cleanup */
  }
}

let serverOk = false
let webOk = false
let createdTaskId: string | null = null

test.beforeAll(async () => {
  serverOk = await isServerAvailable()
  webOk = await isWebAvailable()
  ensureScreenshotDir()
  if (!serverOk || !webOk) log(`skip: server=${serverOk} web=${webOk}`)
})

test.afterAll(async () => {
  if (createdTaskId) await deleteTaskRaw(createdTaskId)
})

test.describe("契约修复 — v4-only 创建链路穿线", () => {
  test("新建任务 → 直建 v4 → UI 添加 Phase → spec.md 骨架 → 清单变绿", async ({ page }) => {
    test.skip(!serverOk || !webOk, "dev server / web not reachable")

    // ① 模板页（v4-only）
    await page.goto(`${WEB_URL}/tasks`)
    await page.locator("[data-task-new]").click()
    const picker = page.locator("[data-template-picker]")
    await expect(picker).toBeVisible()
    // 类型卡 / skill 组已退役；codebase 段在场
    await expect(page.locator("[data-task-type]")).toHaveCount(0)
    await expect(page.locator("[data-skill-group]")).toHaveCount(0)
    await expect(picker.getByText(/codebase/)).toBeVisible()
    await page.screenshot({ path: screenshotPath("01-template-v4-only.png") })

    // ② 开始编写（不选项目 — 对话/预设可补；创建序列 = session + POST 直建）
    await page.locator("[data-template-create]").click()
    await expect(page.locator("[data-authoring-workspace]")).toBeVisible({ timeout: 20_000 })

    // ③ DB + API 真相：v4 旗标即刻在（不再靠对话 PUT）。UI 创建的 org 来自
    // useOrgs 首项（非 TASK_E2E_ORG），且未传 name（server 落 "Untitled task"，
    // autosave 智能标题在首轮对话前不会动）→ 按名字轮询取最新 draft。
    let mine: { id: string } | undefined
    await expect
      .poll(
        async () => {
          const listed = await (
            await fetch(`${SERVER_URL}/api/tasks?status=draft`)
          ).json()
          mine = (listed.items as Array<{ id: string; name: string; created_at: string }>)
            .filter((t) => t.name === "Untitled task")
            .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0]
          return mine?.id ?? null
        },
        { timeout: 15_000 },
      )
      .toBeTruthy()
    createdTaskId = mine!.id

    const detail = await getTask(mine!.id)
    expect((detail.task_spec as Record<string, unknown>).format).toBe("v4")
    expect("task_type" in (detail.task_spec as object)).toBe(false)
    const row = readTaskRow(mine!.id)
    expect(row).toBeTruthy()
    expect(JSON.parse(row!.task_spec).format).toBe("v4")
    const home = taskHomePath(mine!.id)
    expect(home && fs.existsSync(path.join(home!, "manifest.json"))).toBe(true)
    const snap = JSON.parse(fs.readFileSync(path.join(home!, "manifest.json"), "utf-8"))
    expect(snap.spec.format).toBe("v4")

    // ④ UI 添加 Phase（name → 自动 slug → 目录初选 workflow → 整数组 PUT）
    await expect(page.locator("[data-phase-add-form]")).toBeVisible()
    await page.locator("[data-phase-add-name]").fill(`穿线阶段 ${UNIQ}`)
    await page.locator("[data-phase-add-slug]").fill(`p-${UNIQ}`)
    await page.locator("[data-phase-add-submit]").click()
    await expect(page.locator("[data-phase-bind-card='1']")).toBeVisible({ timeout: 10_000 })
    const afterAdd = await getTask(mine!.id)
    const phases = (afterAdd.task_spec as unknown as { phases: Array<Record<string, unknown>> }).phases
    expect(phases).toHaveLength(1)
    expect(phases[0].slug).toBe(`p-${UNIQ}`)
    expect(String(phases[0].specPath)).toMatch(new RegExp(`^\\./\\.scratch/\\d{8}/p-${UNIQ}/spec\\.md$`))

    // ⑤ spec.md：404 空态 → 创建骨架 → fs 真相
    await page.locator("[data-phase-spec-button='1']").click()
    await expect(page.locator("[data-spec-skeleton-button]")).toBeVisible({ timeout: 10_000 })
    await page.locator("[data-spec-skeleton-button]").click()
    await expect(page.locator("[data-spec-editor]")).toBeVisible({ timeout: 10_000 })
    const specOnDisk = path.join(home!, String(phases[0].specPath).replace(/^\.\/?/, ""))
    await expect
      .poll(() => fs.existsSync(specOnDisk), { timeout: 8000 })
      .toBe(true)
    expect(fs.readFileSync(specOnDisk, "utf-8")).toContain("| # | Decision | Conclusion | Reason |")
    await page.screenshot({ path: screenshotPath("02-phase-skeleton.png") })

    // ⑥ 入队清单：phases/spec/bind 三行转绿（inputs 视绑定流 required 而定，不断言）
    await expect(page.getByTestId("enqueue-checklist-v4")).toBeVisible()
    await expect
      .poll(async () => {
        const t = await getTask(mine!.id)
        const sp = (t.task_spec as unknown as { phases: Array<{ specPath: string }> }).phases
        return sp?.[0]?.specPath ? true : false
      }, { timeout: 10_000 })
      .toBe(true)
    await expect(page.locator("[data-checklist-v4='phases']")).toContainText("✅", { timeout: 15_000 })
    await expect(page.locator("[data-checklist-v4='spec']")).toContainText("✅")
    await expect(page.locator("[data-checklist-v4='bind']")).toContainText("✅")

    // ⑦ 清理（afterAll 再兜一次 DELETE；软删 + home reap）
    await deleteTaskRaw(mine!.id)
    createdTaskId = null
  })
})
