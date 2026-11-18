// packages/web-app/e2e/tests/cockpit-v21-fidelity.spec.ts
//
// v21 高保真验收（design 31 / 32）：HUD 结构、舱景切换、tab 名称盒、
// 通讯台底缘状态行、底栏焊接、右下钟、草稿 banner 收口。
// 纪律同 cockpit-v20：不发聊天消息（不烧 LLM），播种舱 REST 建、afterAll 删；
// backend 不在 → 全 skip。

import { expect, test } from "@playwright/test"
import {
  attachConsoleAudit,
  cleanupCabin,
  gotoCockpit,
  log,
  seedCockpitCabin,
  serverReachable,
  type SeededCockpit,
} from "../helpers/cockpit-helpers"

const VIEWPORT = { width: 1600, height: 900 }

let seed: SeededCockpit | null = null
let skipReason: string | null = null

test.describe.configure({ mode: "serial" })

test.describe("全域座舱 v21 · 高保真", () => {
  test.beforeAll(async () => {
    if (!(await serverReachable())) {
      skipReason = "OCTOPUS backend unreachable (OCTOPUS_SERVER_URL ?? http://localhost:3001)"
      return
    }
    seed = await seedCockpitCabin()
    log(`v21 seed cabin ${seed.cabin.id}`)
  })

  test.beforeEach(async ({ page }) => {
    test.skip(!!skipReason, skipReason ?? "")
    await page.setViewportSize(VIEWPORT)
  })

  test.afterAll(async () => {
    if (!seed) return
    await cleanupCabin(seed.cabin.id)
  })

  test("HUD：54px · 经典模式返回钮 · 舱籍 / SCENE / 读数 / ♪◐✦", async ({ page }) => {
    const audit = attachConsoleAudit(page)
    await gotoCockpit(page, seed!.cabin.id)
    const hud = page.getByTestId("cockpit-hud")
    await expect(hud).toBeVisible()
    const box = await hud.boundingBox()
    expect(Math.round(box!.height)).toBe(54)

    // 唯一导航入口 = 「← 经典模式」（其余入口都迁到右栏「更多」）；指挥官徽已删。
    await expect(hud.getByTestId("cockpit-back")).toBeVisible()
    await expect(hud.getByTestId("cockpit-back")).toContainText("经典模式")
    await expect(page.getByTestId("cockpit-player")).toHaveCount(0)
    await expect(page.getByTestId("cockpit-ws-open")).toHaveCount(0)
    await expect(page.getByTestId("cockpit-jump")).toHaveCount(0)

    await expect(page.getByTestId("cockpit-projects-btn")).toBeVisible()
    await expect(page.getByTestId("cockpit-scene-pill")).toContainText("SCENE")

    // v21 二轮：右上只剩三枚只读读数（模型切换 / ♪◐✦ / 时间横条全部撤除）。
    await expect(page.getByTestId("ck12-rig-tokens")).toBeVisible()
    await expect(page.getByTestId("ck12-rig-context")).toBeVisible()
    await expect(page.getByTestId("ck12-rig-cost")).toBeVisible()
    await expect(page.getByTestId("cockpit-hud-model")).toHaveCount(0)
    await expect(page.getByTestId("cockpit-sound")).toHaveCount(0)
    await expect(page.getByTestId("cockpit-theme")).toHaveCount(0)
    await expect(page.getByTestId("cockpit-poses-open")).toHaveCount(0)
    await expect(page.getByTestId("cockpit-clock")).toHaveCount(0)

    // 三枚读数只读：点消耗不再弹账本（完整账走右栏「消耗」）。
    await page.getByTestId("ck12-rig-cost").click()
    await expect(page.getByTestId("cockpit-panel-ledger")).toHaveCount(0)
    expect(audit.filtered, `console: ${JSON.stringify(audit.raw)}`).toEqual([])
    audit.dispose()
  })

  test("舱景：首屏 1 张桥景 · SCENE pill 逐幕切换", async ({ page }) => {
    const audit = attachConsoleAudit(page)
    await gotoCockpit(page, seed!.cabin.id)
    const img = page.locator('[data-testid="cockpit-scene"] [data-scene="in"]')
    await expect(img).toHaveAttribute("src", /scene-bridge/)

    await page.getByTestId("cockpit-scene-pill").click()
    await expect(img).toHaveAttribute("src", /scene-cruise/, { timeout: 10_000 })

    await page.getByTestId("cockpit-scene-pill").click()
    await expect(img).toHaveAttribute("src", /scene-nebula/, { timeout: 10_000 })
    expect(audit.filtered).toEqual([])
    audit.dispose()
  })

  test("通讯台：头部遥测 · 轮次下拉 · 底栏焊接 · 无 tab/状态行/时钟", async ({ page }) => {
    const audit = attachConsoleAudit(page)
    await gotoCockpit(page, seed!.cabin.id)

    // 开通讯台（落点确定后，同 v20 openComms）。
    await expect.poll(async () => {
      const rows = await page.locator('[data-testid^="cockpit-rail-row-"]').count()
      const empty = await page.getByTestId("cockpit-rail-empty").count()
      return rows + empty
    }, { timeout: 20_000 }).toBeGreaterThan(0)
    await page.waitForTimeout(400)
    await page.keyboard.press("Meta+k")
    const win = page.getByTestId("cockpit-chat-window")
    await expect(win).toHaveAttribute("data-open", "true")
    await expect.poll(async () => {
      const a = (await win.boundingBox())?.width ?? 0
      await page.waitForTimeout(220)
      const b = (await win.boundingBox())?.width ?? 0
      return a > 100 && Math.abs(a - b) < 2 ? a : 0
    }, { timeout: 15_000 }).toBeGreaterThan(100)

    // v21 二轮：头部遥测 MODEL / CTX / TOKEN（对齐 classic 的上下文与账本弹层来源）。
    await expect(page.getByTestId("cockpit-comms-title")).toHaveText("主对话")
    await expect(page.getByTestId("cockpit-con-model")).toContainText("MODEL")
    await expect(page.getByTestId("cockpit-con-ctx")).toContainText("CTX")
    await expect(page.getByTestId("cockpit-con-token")).toContainText("TOKEN")

    // 多 tab 条 / 底缘状态行 / 右下钟全部退役。
    await expect(page.getByTestId("cockpit-thread-tabs")).toHaveCount(0)
    await expect(page.getByTestId("cockpit-console-footer")).toHaveCount(0)
    await expect(page.getByTestId("cockpit-clock")).toHaveCount(0)

    // MODEL 下拉：以芯片为中心向下展开、夹在台内；Esc 收起。
    await page.getByTestId("cockpit-con-model").click()
    const drop = page.getByTestId("cockpit-con-drop-model")
    await expect(drop).toBeVisible()
    const dropBox = await drop.boundingBox()
    const winBox = await win.boundingBox()
    expect(dropBox!.x).toBeGreaterThanOrEqual(winBox!.x - 1)
    expect(dropBox!.x + dropBox!.width).toBeLessThanOrEqual(winBox!.x + winBox!.width + 1)
    expect(dropBox!.y).toBeGreaterThanOrEqual(winBox!.y + 30)
    await page.keyboard.press("Escape")
    await expect(drop).toHaveCount(0)
    await expect(win).toHaveAttribute("data-open", "true")

    // v21 三轮：输入行回到通讯台内部（原型 .con-in），不再是屏幕底栏。
    const consoleBox = await win.boundingBox()
    const barBox = await page.getByTestId("cockpit-composer-slot").boundingBox()
    expect(barBox!.y).toBeGreaterThanOrEqual(consoleBox!.y)
    expect(barBox!.y + barBox!.height).toBeLessThanOrEqual(consoleBox!.y + consoleBox!.height + 1)

    // 有编队时不显示「舱还是草稿…」横幅（v21 收口）。
    await expect(page.getByTestId("cockpit-status-banner")).toHaveCount(0)
    expect(audit.filtered).toEqual([])
    audit.dispose()
  })

  test("详情 dossier：居中 760 · 8 页签在正文里 · ⛶ 全屏 / 还原 · 右下缩放柄", async ({ page }) => {
    const audit = attachConsoleAudit(page)
    await gotoCockpit(page, seed!.cabin.id)
    await expect.poll(async () => page.locator('[data-testid^="cockpit-rail-row-"]').count(), {
      timeout: 20_000,
    }).toBeGreaterThan(0)

    // 点编队行 = 原型「点一条 → 开玻璃 dossier」。
    await page.locator('[data-testid^="cockpit-rail-row-"]').first().click()
    const face = page.getByTestId("cockpit-face")
    await expect(face).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId("cockpit-face-scrim")).toBeVisible()
    // 入场动画（原型 pin：translateY 12 → 0）在无头页里会被限速 —— 等它归零再量。
    await expect.poll(async () => Math.round((await face.boundingBox())!.y), {
      timeout: 15_000,
    }).toBe(58)

    // 原型 .panel：居中 760，top 58 / bottom 30（1600×900 → 420 / 58 / 760 / 812）。
    const box = await face.boundingBox()
    expect(Math.round(box!.width)).toBe(760)
    expect(Math.round(box!.x)).toBe(420)
    expect(Math.round(box!.y)).toBe(58)
    expect(Math.round(box!.height)).toBe(812)

    // 页签在滚动正文（原型 .pb）里：八个（概览…调试 · 项目）。
    await expect(face.locator(".ck12-face-body .ck12-dtabs")).toHaveCount(1)
    await expect(face.locator(".ck12-dtab")).toHaveCount(8)
    await expect(page.getByTestId("cockpit-tab-project")).toBeVisible()

    // 右上只有 ✕ + ⛶（原型 .ph）：项目签 / 中止 / 谈 / 决断 / 调试 / 去处理都撤。
    await expect(face.locator(".ck12-dh button")).toHaveCount(2)

    // 窗口化：右下缩放柄 + ⛶ 全屏（原型 5 / 52 / vw-10 / vh-58），再点还原。
    await expect(page.getByTestId("cockpit-dossier-grip")).toBeVisible()
    await page.getByTestId("cockpit-dossier-max").click()
    await expect(face).toHaveAttribute("data-maximized", "1")
    const maxed = await face.boundingBox()
    expect(Math.round(maxed!.x)).toBe(5)
    expect(Math.round(maxed!.y)).toBe(52)
    expect(Math.round(maxed!.width)).toBe(1590)
    expect(Math.round(maxed!.height)).toBe(842)

    await page.getByTestId("cockpit-dossier-max").click()
    await expect(face).not.toHaveAttribute("data-maximized", "1")
    const restored = await face.boundingBox()
    expect(Math.round(restored!.x)).toBe(420)
    expect(Math.round(restored!.width)).toBe(760)

    await page.keyboard.press("Escape")
    await expect(face).toHaveCount(0)
    expect(audit.filtered).toEqual([])
    audit.dispose()
  })
})
