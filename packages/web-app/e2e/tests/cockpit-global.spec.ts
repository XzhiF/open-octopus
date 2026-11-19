// packages/web-app/e2e/tests/cockpit-global.spec.ts
//
// Step 10 — real-data E2E for the global cockpit (cockpit-v12).
//
// Scope notes (plans/cabin-cockpit-v12.md §Step 10):
//   - ONLY this spec is expected to run green. The rest of the e2e suite has
//     historical red (e2e/tests/auth.spec.ts targets /login, which this SPA
//     does not have) and is intentionally out of scope.
//   - The backend must already be listening on OCTOPUS_SERVER_URL ?? :3001;
//     when it is not, every test skips (serverReachable()).
//   - A throwaway cabin is seeded over REST in beforeAll and deleted in
//     afterAll. Cleanup failure is loud (throws), never silent.
//   - We deliberately do NOT send a chat message: that would call the real LLM
//     and write into a real session. Chat delivery/queue/stop behaviour is
//     covered by the existing unit tests; here we only prove the composer is
//     mounted in the bottom bar and survives closing the floating window.

import { expect, test, type Page } from "@playwright/test"
import {
  attachConsoleAudit,
  cleanupCabin,
  cockpitUrl,
  expectNoHorizontalOverflow,
  firstFocusableButton,
  gotoCockpit,
  listCabinsViaApi,
  log,
  seedCockpitCabin,
  serverReachable,
  tempScreenshotPath,
  type SeededCockpit,
} from "../helpers/cockpit-helpers"

const VIEWPORT = { width: 1440, height: 900 }

let seed: SeededCockpit | null = null
let skipReason: string | null = null
let cabinIdsBefore: string[] = []

test.describe.configure({ mode: "serial" })

test.describe("全局座舱 · 真数据 E2E", () => {
  test.beforeAll(async () => {
    if (!(await serverReachable())) {
      skipReason = "OCTOPUS backend unreachable (OCTOPUS_SERVER_URL ?? http://localhost:3001)"
      return
    }
    cabinIdsBefore = (await listCabinsViaApi()).map((c) => c.id)
    log(`cabins before seed: ${cabinIdsBefore.length}`)
    seed = await seedCockpitCabin()
  })

  test.beforeEach(async ({ page }) => {
    test.skip(!!skipReason, skipReason ?? "")
    await page.setViewportSize(VIEWPORT)
  })

  test.afterAll(async () => {
    if (!seed) return
    const seededId = seed.cabin.id
    await cleanupCabin(seededId)
    // Prove the cascade happened at the API surface (not just "DELETE returned 200").
    const after = await listCabinsViaApi()
    expect(after.some((c) => c.id === seededId), `seeded cabin ${seededId} still listed`).toBe(false)
    seed = null
  })

  test("两套界面互不干扰：classic 编队行仍开详情窗，「⛶ 全域」才进入全域", async ({ page }) => {
    const audit = attachConsoleAudit(page)
    const cabinId = seed!.cabin.id
    const job = seed!.workflowJob

    await page.goto(`/cabin/${cabinId}`)
    // The classic fleet only renders once the cabin main session is resolved.
    await expect(page.getByTestId("cabin-fleet")).toBeVisible({ timeout: 30_000 })

    // ── classic 的既有行为不变：点编队行 = 就地开作业详情窗 ─────────────
    await page.getByTestId(`cabin-fleet-row-${job.id}`).click()
    await expect(
      page.getByTestId("cabin-window").filter({ has: page.getByTestId("cabin-job-detail") }),
    ).toBeVisible({ timeout: 15_000 })
    await expect(page).toHaveURL(new RegExp(`/cabin/${cabinId}(\\?|$)`))
    await page.getByTestId("cabin-win-close-job").click()
    await expect(page.getByTestId("cabin-job-detail")).toBeHidden({ timeout: 10_000 })

    // ── 唯一的切换按钮 → 全域（v21 三轮：首载不自动选面，停在舰桥）─────
    await page.getByTestId("cabin-enter-cockpit").click()
    await expect(page).toHaveURL(new RegExp(`/cabin/${cabinId}/cockpit`), { timeout: 30_000 })
    await expect(page.getByTestId("cockpit-shell")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("cockpit-face")).toHaveCount(0)

    // 点编队行才开作战详情（并写 ?job=）。
    await page.getByTestId(`cockpit-rail-row-job:${job.id}`).click()
    await page.waitForURL(
      (url) => ["job", "task", "attn"].some((key) => !!url.searchParams.get(key)),
      { timeout: 30_000 },
    )
    await expect(page.getByTestId("cockpit-job-header")).toBeVisible({ timeout: 30_000 })

    // ── 返回：回到进入前的 classic 路径，编队仍在 ──────────────────────
    await page.getByTestId("cockpit-back").click()
    await expect(page).toHaveURL(new RegExp(`/cabin/${cabinId}(\\?|$)`), { timeout: 30_000 })
    await expect(page.getByTestId("cabin-fleet")).toBeVisible({ timeout: 30_000 })

    expect(audit.filtered, `console errors: ${JSON.stringify(audit.raw, null, 2)}`).toEqual([])
    audit.dispose()
  })

  test("深链 ?job=… 直接落在该作业，返回回入口舱", async ({ page }) => {
    const audit = attachConsoleAudit(page)
    const cabinId = seed!.cabin.id
    const job = seed!.workflowJob

    await gotoCockpit(page, cabinId, { job: job.id })
    const title = page.getByTestId("cockpit-job-header").locator(".ck12-dh-pt b")
    await expect(title).toContainText(job.title, { timeout: 30_000 })
    await expect(page.getByTestId("cockpit-rail-row-job:" + job.id)).toHaveAttribute(
      "aria-selected",
      "true",
    )

    await page.getByTestId("cockpit-back").click()
    await expect(page).toHaveURL(new RegExp(`/cabin/${cabinId}(\\?|$)`), { timeout: 30_000 })

    expect(audit.filtered, `console errors: ${JSON.stringify(audit.raw, null, 2)}`).toEqual([])
    audit.dispose()
  })

  test("无效深链 ?job=not-a-real-job → 收面并清掉参数（不自动弹另一条）", async ({ page }) => {
    const audit = attachConsoleAudit(page)
    const cabinId = seed!.cabin.id

    // The bogus id legitimately 404s before CockpitUrlSync rewrites the URL.
    audit.allow404(3)
    await page.goto(`/cabin/${cabinId}/cockpit?job=not-a-real-job`)
    await expect(page.getByTestId("cockpit-shell")).toBeVisible({ timeout: 30_000 })

    await page.waitForURL(
      (url) => !url.searchParams.get("job"),
      { timeout: 30_000 },
    )
    // v21 三轮：详情是点击编队行才开的模态 dossier；无效深链只收面，不弹别的作业。
    await expect(page.getByTestId("cockpit-face")).toHaveCount(0)

    expect(audit.filtered, `console errors: ${JSON.stringify(audit.raw, null, 2)}`).toEqual([])
    audit.dispose()
  })

  test("五页签逐个打开：pane 存在且文案非空", async ({ page }) => {
    const audit = attachConsoleAudit(page)
    await gotoCockpit(page, seed!.cabin.id, { job: seed!.workflowJob.id })
    await expect(page.getByTestId("cockpit-tab-overview")).toBeVisible({ timeout: 30_000 })

    const panes = [
      { tab: "overview", pane: "cabin-job-overview" },
      { tab: "relay", pane: "cabin-job-relay" },
      { tab: "run", pane: "cabin-job-run" },
      { tab: "changes", pane: "cabin-job-changes" },
      { tab: "accept", pane: "cabin-job-accept" },
    ] as const

    for (const { tab, pane } of panes) {
      await page.getByTestId(`cockpit-tab-${tab}`).click()
      const locator = page.getByTestId(pane)
      await expect(locator, `${tab} pane missing`).toBeVisible({ timeout: 15_000 })
      const length = await locator.evaluate((el) => (el.textContent ?? "").trim().length)
      expect(length, `${tab} pane rendered empty text`).toBeGreaterThan(0)
      await expect(page.getByTestId(`cockpit-tab-${tab}`)).toHaveAttribute("aria-selected", "true")
    }

    // URL keeps the selected job and records the active tab.
    await expect(page).toHaveURL(/[?&]job=/, { timeout: 10_000 })
    await expect(page).toHaveURL(/[?&]tab=accept/, { timeout: 10_000 })

    expect(audit.filtered, `console errors: ${JSON.stringify(audit.raw, null, 2)}`).toEqual([])
    audit.dispose()
  })

  test("浮窗：默认展开 / 输入框在台内 / ✕ 停靠成 pill / 拖拽", async ({ page }) => {
    const audit = attachConsoleAudit(page)
    await gotoCockpit(page, seed!.cabin.id, { job: seed!.workflowJob.id })

    // Bridge telemetry only becomes ready once the real ChatPane mounts.
    // v21 二轮起没有 CockpitBridge 节点：真 ChatPane 挂上 = composer 落进槽。
    await expect(page.getByTestId("cockpit-composer-slot").locator("textarea")).toHaveCount(1, {
      timeout: 30_000,
    })

    const win = page.getByTestId("cockpit-chat-window")
    // v21 三轮：通讯台默认展开（原型 console 常驻），输入框在台内（原型 .con-in）。
    await expect(win).toHaveAttribute("data-open", "true")
    const composer = page.getByTestId("cockpit-composer-slot")
    await expect(composer.locator("textarea")).toHaveCount(1)
    const wb = await win.boundingBox()
    const cb = await composer.boundingBox()
    expect(wb && cb, "window/composer has no box").toBeTruthy()
    expect(cb!.x, "composer not inside window (left)").toBeGreaterThanOrEqual(wb!.x)
    expect(cb!.y + cb!.height, "composer not inside window (bottom)").toBeLessThanOrEqual(wb!.y + wb!.height + 1)

    // 深链带的作战详情 dossier 会盖住通讯台（原型 .pscrim 模态）：先收它再拖。
    await page.keyboard.press("Escape")
    await expect(page.getByTestId("cockpit-face")).toHaveCount(0, { timeout: 10_000 })

    // ── 拖到左栏上方（rail 默认 300px）────────────────────────────────
    await expect
      .poll(async () => (await win.boundingBox())?.width ?? 0, {
        message: "chat window never got its default geometry",
      })
      .toBeGreaterThan(300)
    await page.waitForTimeout(300)
    const header = win.locator("header.ck12-comms-head")
    const hb = await header.boundingBox()
    expect(hb, "chat window header has no box").not.toBeNull()
    await page.mouse.move(hb!.x + hb!.width / 2, hb!.y + hb!.height / 2)
    await page.mouse.down()
    await page.mouse.move(40, 220, { steps: 12 })
    await page.mouse.up()
    await expect
      .poll(async () => (await win.boundingBox())?.x ?? Number.POSITIVE_INFINITY, {
        message: "chat window did not move to the left rail",
      })
      .toBeLessThan(60)

    // ── ✕ 停靠：整台收起成 pill；点 pill 再展开（原型 #conDock）────────
    await page.getByTestId("cockpit-comms-close").click()
    await expect(win).toHaveAttribute("data-docked", "true")
    const dock = page.getByTestId("cockpit-con-dock")
    await expect(dock).toBeVisible()
    await dock.click()
    await expect(win).toHaveAttribute("data-docked", "false")
    await expect(win).toHaveAttribute("data-open", "true")

    expect(audit.filtered, `console errors: ${JSON.stringify(audit.raw, null, 2)}`).toEqual([])
    audit.dispose()
  })

  test("关闭按钮审计：聊天浮窗 / 作业面 的第一个可聚焦按钮在左且是关闭", async ({ page }) => {
    const audit = attachConsoleAudit(page)
    await gotoCockpit(page, seed!.cabin.id, { job: seed!.workflowJob.id })
    // v21 二轮起没有 CockpitBridge 节点：真 ChatPane 挂上 = composer 落进槽。
    await expect(page.getByTestId("cockpit-composer-slot").locator("textarea")).toHaveCount(1, {
      timeout: 30_000,
    })

    // 1) 聊天浮窗
    await page.getByTestId("cockpit-composer-slot").locator("textarea").focus()
    const chatWin = page.getByTestId("cockpit-chat-window")
    await expect(chatWin).toHaveAttribute("data-open", "true")
    const chatFirst = await firstFocusableButton(chatWin)
    expect(chatFirst, "chat window has no focusable button").not.toBeNull()
    expect(chatFirst!.ariaLabel).toBe("收起通讯台")
    expect(chatFirst!.x, "chat close button is not on the left").toBeLessThan(chatFirst!.centerX)

    // 2) 作业面（详情 dossier 覆盖在通讯台上，Esc 先收它）
    const jobHeader = page.getByTestId("cockpit-job-header")
    const jobFirst = await firstFocusableButton(jobHeader)
    expect(jobFirst, "job header has no focusable button").not.toBeNull()
    expect(jobFirst!.testId).toBe("cockpit-job-close")
    expect(jobFirst!.x, "job close button is not on the left").toBeLessThan(jobFirst!.centerX)
    await page.keyboard.press("Escape")
    await expect(page.getByTestId("cockpit-face")).toBeHidden({ timeout: 10_000 })

    // v21 二轮起 HUD 只剩三枚只读读数：上下文 / 在场 / 模型 popover 的触发入口
    // 已退役（明细在通讯台头部 MODEL / CTX / TOKEN 下拉），关闭钮左置由
    // components/cockpit/__tests__/close-left-audit.test.tsx 单测覆盖。
    await expect(page.getByTestId("ck12-rig-context")).toBeVisible()
    const ctxTag = await page.getByTestId("ck12-rig-context").evaluate((el) => el.tagName)
    expect(ctxTag).toBe("SPAN")

    expect(audit.filtered, `console errors: ${JSON.stringify(audit.raw, null, 2)}`).toEqual([])
    audit.dispose()
  })

  test("换色：更多 → 设置 → 主题色后 body 上的 --ck-a 变化", async ({ page }) => {
    const audit = attachConsoleAudit(page)
    await gotoCockpit(page, seed!.cabin.id)

    const readAccent = () =>
      page.evaluate(() => getComputedStyle(document.body).getPropertyValue("--ck-a").trim())

    const before = await readAccent()
    expect(before, "--ck-a is not set on body").toBeTruthy()

    await page.getByTestId("cockpit-menu-more").click()
    await page.getByTestId("cockpit-fan-settings").click()
    await expect(page.getByTestId("cockpit-settings")).toBeVisible({ timeout: 10_000 })
    await page.getByTestId("cockpit-theme-crimson").click()
    await expect.poll(readAccent, { message: "--ck-a did not change after 主题色" }).not.toBe(before)
    await page.getByTestId("cockpit-settings-close").click()

    expect(audit.filtered, `console errors: ${JSON.stringify(audit.raw, null, 2)}`).toEqual([])
    audit.dispose()
  })

  test("演示到达：⌁ → 简报左置 ✕、10s 消失、四边流光出现", async ({ page }) => {
    const audit = attachConsoleAudit(page)
    await gotoCockpit(page, seed!.cabin.id, { job: seed!.workflowJob.id, demo: true })

    // 深链带的详情 dossier 是模态（原型 .pscrim）：先收面再点演示按钮。
    await page.keyboard.press("Escape")
    await expect(page.getByTestId("cockpit-face")).toHaveCount(0, { timeout: 10_000 })

    const trigger = page.getByTestId("cockpit-demo-arrival")
    await expect(trigger).toBeVisible({ timeout: 15_000 })
    await trigger.click()

    const brief = page.getByTestId("cockpit-brief")
    await expect(brief).toBeVisible({ timeout: 10_000 })
    // v21 二轮：简报只保留一枚左置 ✕（其余仍是整卡点开 + 10s 自动消失）。
    await expect(brief.locator("button")).toHaveCount(1)
    await expect(brief.locator("button").first()).toHaveAttribute("aria-label", "关闭简报")
    await expect(brief).toContainText("演示")

    // Edge glow + centrefold pulse are nonce-driven; the element must exist and
    // have replayed at least once.
    const edge = page.getByTestId("cockpit-edgefx")
    await expect(edge).toHaveCount(1)
    await expect
      .poll(async () => Number(await edge.getAttribute("data-nonce")))
      .toBeGreaterThan(0)

    // 10s auto-dismiss.
    await expect(brief).toHaveCount(0, { timeout: 15_000 })

    expect(audit.filtered, `console errors: ${JSON.stringify(audit.raw, null, 2)}`).toEqual([])
    audit.dispose()
  })

  test("响应式 1440 / 1280 / 1024 / 900：无横向溢出（1440 截图存临时目录）", async ({ page }) => {
    const audit = attachConsoleAudit(page)
    for (const width of [1440, 1280, 1024, 900]) {
      await page.setViewportSize({ width, height: 900 })
      await gotoCockpit(page, seed!.cabin.id, { job: seed!.workflowJob.id })
      await expect(page.getByTestId("cockpit-face")).toBeVisible({ timeout: 30_000 })
      // Let layout settle (rail becomes a drawer at ≤1120, chat geometry re-clamps).
      await page.waitForTimeout(400)
      await expectNoHorizontalOverflow(page, `cockpit @ ${width}px`)
      if (width === 1440) {
        const shot = tempScreenshotPath("cockpit-1440.png")
        await page.screenshot({ path: shot })
        log(`1440 screenshot: ${shot}`)
      }
    }
    expect(audit.filtered, `console errors: ${JSON.stringify(audit.raw, null, 2)}`).toEqual([])
    audit.dispose()
  })

  test("性能：离开座舱后星野不再申请动画帧", async ({ page }) => {
    const audit = attachConsoleAudit(page)
    // Count rAF invocations from before the app boots. CockpitStarfield is the
    // only continuous rAF loop in the app; one-shot rAF calls elsewhere are a
    // handful per navigation and are ignored by the threshold below.
    await page.addInitScript(() => {
      const w = window as unknown as { __ckRafCount?: number }
      w.__ckRafCount = 0
      const original = window.requestAnimationFrame.bind(window)
      window.requestAnimationFrame = (cb: FrameRequestCallback) =>
        original((time) => {
          w.__ckRafCount = (w.__ckRafCount ?? 0) + 1
          return cb(time)
        })
    })

    await gotoCockpit(page, seed!.cabin.id, { job: seed!.workflowJob.id })
    await page.waitForTimeout(600)
    const inStart = await page.evaluate(() => (window as unknown as { __ckRafCount: number }).__ckRafCount)
    await page.waitForTimeout(1000)
    const inEnd = await page.evaluate(() => (window as unknown as { __ckRafCount: number }).__ckRafCount)
    const inFlight = inEnd - inStart
    // Headless Chromium can throttle rAF to ~15 fps; any steady stream proves
    // the canvas loop is alive while the cockpit is mounted.
    expect(inFlight, "starfield did not run while mounted").toBeGreaterThan(5)

    await page.getByTestId("cockpit-back").click()
    await expect(page.getByTestId("cockpit-shell")).toHaveCount(0, { timeout: 20_000 })
    // Let unmount-time one-shots and route transitions drain.
    await page.waitForTimeout(600)
    const outStart = await page.evaluate(() => (window as unknown as { __ckRafCount: number }).__ckRafCount)
    await page.waitForTimeout(1000)
    const outEnd = await page.evaluate(() => (window as unknown as { __ckRafCount: number }).__ckRafCount)

    expect(
      outEnd - outStart,
      `rAF kept running after leaving the cockpit (${outEnd - outStart} frames/s)`,
    ).toBeLessThanOrEqual(2)

    expect(audit.filtered, `console errors: ${JSON.stringify(audit.raw, null, 2)}`).toEqual([])
    audit.dispose()
  })

  test("reduced motion：不挂载舱壁流光", async ({ browser }) => {
    const context = await browser.newContext({
      reducedMotion: "reduce",
      viewport: VIEWPORT,
    })
    const page = await context.newPage()
    const audit = attachConsoleAudit(page)
    try {
      await gotoCockpit(page, seed!.cabin.id, { job: seed!.workflowJob.id, demo: true })
      // 深链带的详情 dossier 是模态（原型 .pscrim）：先收面再点演示按钮。
      await page.keyboard.press("Escape")
      await expect(page.getByTestId("cockpit-face")).toHaveCount(0, { timeout: 10_000 })
      const trigger = page.getByTestId("cockpit-demo-arrival")
      await expect(trigger).toBeVisible({ timeout: 15_000 })
      await trigger.click()
      await expect(page.getByTestId("cockpit-brief")).toBeVisible({ timeout: 10_000 })
      // CockpitEffects returns null under prefers-reduced-motion.
      await expect(page.locator(".ck12-edgefx")).toHaveCount(0)
      await expect(page.getByTestId("cockpit-fx")).toHaveCount(0)
      expect(audit.filtered, `console errors: ${JSON.stringify(audit.raw, null, 2)}`).toEqual([])
    } finally {
      audit.dispose()
      await context.close()
    }
  })
})
