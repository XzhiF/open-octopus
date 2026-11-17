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

  test("HUD：54px · 唯一导航入口 ← · 指挥官徽 / 舱籍 / SCENE / 读数 / ♪◐✦", async ({ page }) => {
    const audit = attachConsoleAudit(page)
    await gotoCockpit(page, seed!.cabin.id)
    const hud = page.getByTestId("cockpit-hud")
    await expect(hud).toBeVisible()
    const box = await hud.boundingBox()
    expect(Math.round(box!.height)).toBe(54)

    // 唯一导航入口是 ←（其余入口都迁到右栏「更多」）。
    await expect(hud.getByTestId("cockpit-back")).toBeVisible()
    await expect(page.getByTestId("cockpit-ws-open")).toHaveCount(0)
    await expect(page.getByTestId("cockpit-jump")).toHaveCount(0)

    await expect(page.getByTestId("cockpit-player")).toBeVisible()
    await expect(page.getByTestId("cockpit-projects-btn")).toBeVisible()
    await expect(page.getByTestId("cockpit-scene-pill")).toContainText("SCENE")
    await expect(page.getByTestId("cockpit-hud-model")).toBeVisible()
    await expect(page.getByTestId("ck12-rig-tokens")).toBeVisible()
    await expect(page.getByTestId("ck12-rig-context")).toBeVisible()
    await expect(page.getByTestId("cockpit-sound")).toBeVisible()
    await expect(page.getByTestId("cockpit-theme")).toBeVisible()
    await expect(page.getByTestId("cockpit-poses-open")).toBeVisible()

    // 消耗读数点开账本（原底栏 ck12-rig-cost 的入口语义保留）。
    await page.getByTestId("ck12-rig-cost").click()
    await expect(page.getByTestId("cockpit-panel-ledger")).toBeVisible()
    await page.keyboard.press("Escape")
    expect(audit.filtered).toEqual([])
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

  test("通讯台：tab 名称完整 · 底缘状态行 · 底栏焊接 · 右下钟", async ({ page }) => {
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

    // v21 缺陷 3.1：作业 tab 名称不再被压成 0 高。
    const jobTab = page.getByTestId(`cockpit-tab-job:${seed!.taskJob.id}`)
    await expect(jobTab).toBeVisible({ timeout: 20_000 })
    const nameBox = await jobTab.locator(".ck12-ctab-name").boundingBox()
    expect(nameBox!.height).toBeGreaterThanOrEqual(12)

    // 底缘状态行：SCENE / POSE / CTX / MODEL / TUI + 3 枚场景点。
    const footer = page.getByTestId("cockpit-console-footer")
    await expect(footer).toBeVisible()
    await expect(footer).toContainText("SCENE")
    await expect(footer).toContainText("TUI")
    await expect(footer.locator(".ck12-sdot")).toHaveCount(3)
    // 场景点直选：点第三幕，场景图跟到 nebula。
    await page.getByTestId("cockpit-scene-dot-nebula").click()
    await expect(page.locator('[data-testid="cockpit-scene"] [data-scene="in"]'))
      .toHaveAttribute("src", /scene-nebula/, { timeout: 10_000 })

    // 底栏焊接：console 底缘与 composer 条上沿 ≤8px（无黑断层）。
    // 量 bar 而不是内部 slot —— slot 在真 composer portal 挂上之前是居中占位，
    // 位置不代表视觉上的输入行。
    const consoleBox = await win.boundingBox()
    const barBox = await page.getByTestId("cockpit-command-bar").boundingBox()
    expect(barBox!.y - (consoleBox!.y + consoleBox!.height)).toBeLessThanOrEqual(8)

    // 右下钟：right/bottom = 10。
    const clock = page.getByTestId("cockpit-clock")
    await expect(clock).toBeVisible()
    const clockBox = await clock.boundingBox()
    expect(Math.round(VIEWPORT.width - (clockBox!.x + clockBox!.width))).toBe(10)
    expect(Math.round(VIEWPORT.height - (clockBox!.y + clockBox!.height))).toBe(10)

    // 有编队时不显示「舱还是草稿…」横幅（v21 收口）。
    await expect(page.getByTestId("cockpit-status-banner")).toHaveCount(0)
    expect(audit.filtered).toEqual([])
    audit.dispose()
  })
})
