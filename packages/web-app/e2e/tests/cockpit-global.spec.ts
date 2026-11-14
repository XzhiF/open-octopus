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

    // ── 唯一的切换按钮 → 全域（不带 ref：由默认选中规则落一条真行）─────
    await page.getByTestId("cabin-enter-cockpit").click()
    await expect(page).toHaveURL(new RegExp(`/cabin/${cabinId}/cockpit`), { timeout: 30_000 })
    await expect(page.getByTestId("cockpit-shell")).toBeVisible({ timeout: 30_000 })
    await page.waitForURL(
      (url) => ["job", "task", "attn"].some((key) => !!url.searchParams.get(key)),
      { timeout: 30_000 },
    )
    await expect(page.getByTestId("cockpit-job-header")).toBeVisible({ timeout: 30_000 })

    // ── 返回：回到进入前的 classic 路径，编队仍在 ──────────────────────
    await page.getByRole("button", { name: "← 返回作战舱" }).click()
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
    const title = page.getByTestId("cockpit-job-header").locator("h2")
    await expect(title).toHaveText(job.title, { timeout: 30_000 })
    await expect(page.getByTestId("cockpit-rail-row-job:" + job.id)).toHaveAttribute(
      "aria-selected",
      "true",
    )

    await page.getByRole("button", { name: "← 返回作战舱" }).click()
    await expect(page).toHaveURL(new RegExp(`/cabin/${cabinId}(\\?|$)`), { timeout: 30_000 })

    expect(audit.filtered, `console errors: ${JSON.stringify(audit.raw, null, 2)}`).toEqual([])
    audit.dispose()
  })

  test("无效深链 ?job=not-a-real-job 会被改写成有效 job", async ({ page }) => {
    const audit = attachConsoleAudit(page)
    const cabinId = seed!.cabin.id

    // The bogus id legitimately 404s before CockpitUrlSync rewrites the URL.
    audit.allow404(3)
    await page.goto(`/cabin/${cabinId}/cockpit?job=not-a-real-job`)
    await expect(page.getByTestId("cockpit-shell")).toBeVisible({ timeout: 30_000 })

    await page.waitForURL(
      (url) => url.searchParams.get("job") !== "not-a-real-job",
      { timeout: 30_000 },
    )
    const url = new URL(page.url())
    const selected =
      url.searchParams.get("job") ??
      url.searchParams.get("task") ??
      url.searchParams.get("attn")
    expect(selected, `URL was not rewritten to a valid ref: ${page.url()}`).toBeTruthy()

    // The rewritten ref must be one of the rows the fleet actually rendered.
    const kind = url.searchParams.get("job")
      ? "job"
      : url.searchParams.get("task")
        ? "task"
        : "attn"
    await expect(
      page.getByTestId(`cockpit-rail-row-${kind}:${selected}`),
      `rewritten ref ${kind}:${selected} is not in the fleet`,
    ).toHaveCount(1)

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

  test("浮窗：聚焦输入框开窗 / ✕ 后底栏仍有输入框 / 拖·收·锁·透明度", async ({ page }) => {
    const audit = attachConsoleAudit(page)
    await gotoCockpit(page, seed!.cabin.id, { job: seed!.workflowJob.id })

    // Bridge telemetry only becomes ready once the real ChatPane mounts.
    await expect(page.getByTestId("cockpit-bridge")).toHaveAttribute("data-chat", "ready", {
      timeout: 30_000,
    })

    const win = page.getByTestId("cockpit-chat-window")
    const commandBar = page.getByTestId("cockpit-command-bar")
    await expect(win).toHaveAttribute("data-open", "false")
    await expect(commandBar.locator("textarea")).toHaveCount(1)

    // ── 聚焦底栏输入框 → 浮窗 open ─────────────────────────────────────
    await commandBar.locator("textarea").focus()
    await expect(win).toHaveAttribute("data-open", "true", { timeout: 10_000 })
    await expect(win).toBeVisible()

    // ── 拖到左栏上方（rail 默认 300px）────────────────────────────────
    // The window computes its default rect in a rAF after opening; dragging
    // before that lands on a null rect and is intentionally ignored.
    await expect
      .poll(async () => (await win.boundingBox())?.width ?? 0, {
        message: "chat window never got its default geometry",
      })
      .toBeGreaterThan(300)
    // Let the post-open layout rAF run. It reads rectRef at frame time; a drag
    // that races it can be clamped back to the pre-drag rect (CockpitChatWindow
    // schedules the recompute on the open transition).
    await page.waitForTimeout(300)
    const header = win.locator("header.ck12-comms-head")
    const before = await win.boundingBox()
    expect(before, "chat window has no box after opening").not.toBeNull()
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
    const dragged = await win.boundingBox()
    expect(dragged!.x, "drag should overlap the 300px fleet rail").toBeLessThan(310)

    // ── ✕ 收起：底栏输入框仍在（composer portal 不受隐藏祖先影响）──────
    await page.getByRole("button", { name: "关闭对话窗" }).click()
    await expect(win).toHaveAttribute("data-open", "false")
    await expect(commandBar.locator("textarea")).toHaveCount(1)

    // 再聚焦 → 重新展开
    await commandBar.locator("textarea").focus()
    await expect(win).toHaveAttribute("data-open", "true", { timeout: 10_000 })

    // ── — 收成 47px ───────────────────────────────────────────────────
    await page.getByRole("button", { name: "收起对话窗" }).click()
    await expect(win).toHaveAttribute("data-mini", "true")
    await expect.poll(async () => (await win.boundingBox())?.height ?? 0).toBeCloseTo(47, 0)
    await page.getByRole("button", { name: "展开对话窗" }).click()
    await expect(win).toHaveAttribute("data-mini", "false")

    // ── 📌 锁定后拖不动 ───────────────────────────────────────────────
    await page.getByRole("button", { name: "锁定位置" }).click()
    await expect(page.getByRole("button", { name: "锁定位置" })).toHaveAttribute("aria-pressed", "true")
    const pinnedLeft = (await win.boundingBox())!.x
    const hb2 = await header.boundingBox()
    await page.mouse.move(hb2!.x + hb2!.width / 2, hb2!.y + hb2!.height / 2)
    await page.mouse.down()
    await page.mouse.move(hb2!.x + hb2!.width / 2 + 180, hb2!.y + hb2!.height / 2 + 120, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(250)
    expect((await win.boundingBox())!.x, "pinned window moved").toBeCloseTo(pinnedLeft, 0)
    await page.getByRole("button", { name: "锁定位置" }).click()

    // ── ◍ 五档循环 94 → 82 → 70 → 55 → 100 → 94 ──────────────────────
    const alphaButton = page.getByRole("button", { name: "调整不透明度" })
    const readAlpha = async () => {
      const text = (await alphaButton.textContent()) ?? ""
      return Number.parseInt(text.replace(/[^\d]/g, ""), 10)
    }
    const first = await readAlpha()
    const seen = [first]
    for (let i = 0; i < 5; i += 1) {
      await alphaButton.click()
      seen.push(await readAlpha())
    }
    expect(new Set(seen.slice(0, 5)).size, `alpha did not cycle: ${seen.join(",")}`).toBe(5)
    expect(seen[5], `alpha did not wrap to the first step: ${seen.join(",")}`).toBe(first)

    expect(audit.filtered, `console errors: ${JSON.stringify(audit.raw, null, 2)}`).toEqual([])
    audit.dispose()
  })

  test("关闭按钮审计：聊天浮窗 / 作业面 / 上下文 / 在场 的第一个可聚焦按钮在左且是关闭", async ({ page }) => {
    const audit = attachConsoleAudit(page)
    await gotoCockpit(page, seed!.cabin.id, { job: seed!.workflowJob.id })
    await expect(page.getByTestId("cockpit-bridge")).toHaveAttribute("data-chat", "ready", {
      timeout: 30_000,
    })

    // 1) 聊天浮窗
    await page.getByTestId("cockpit-command-bar").locator("textarea").focus()
    const chatWin = page.getByTestId("cockpit-chat-window")
    await expect(chatWin).toHaveAttribute("data-open", "true")
    const chatFirst = await firstFocusableButton(chatWin)
    expect(chatFirst, "chat window has no focusable button").not.toBeNull()
    expect(chatFirst!.ariaLabel).toBe("关闭对话窗")
    expect(chatFirst!.x, "chat close button is not on the left").toBeLessThan(chatFirst!.centerX)

    // 2) 作业面
    const jobHeader = page.getByTestId("cockpit-job-header")
    const jobFirst = await firstFocusableButton(jobHeader)
    expect(jobFirst, "job header has no focusable button").not.toBeNull()
    expect(jobFirst!.testId).toBe("cockpit-job-close")
    expect(jobFirst!.x, "job close button is not on the left").toBeLessThan(jobFirst!.centerX)

    // 3) 上下文 popover
    await page.getByTestId("ck12-rig-context").click()
    const contextPop = page.getByTestId("ck12-rig-context-pop")
    await expect(contextPop).toBeVisible({ timeout: 10_000 })
    const contextFirst = await firstFocusableButton(contextPop)
    expect(contextFirst, "context popover has no focusable button").not.toBeNull()
    expect(contextFirst!.testId).toBe("ck12-rig-context-close")
    expect(contextFirst!.x, "context close button is not on the left").toBeLessThan(contextFirst!.centerX)
    await page.getByTestId("ck12-rig-context-close").click()
    await expect(contextPop).toBeHidden({ timeout: 10_000 })

    // 4) 在场 popover
    await page.getByTestId("ck12-rig-presence").click()
    const presencePop = page.getByTestId("ck12-rig-presence-pop")
    await expect(presencePop).toBeVisible({ timeout: 10_000 })
    const presenceFirst = await firstFocusableButton(presencePop)
    expect(presenceFirst, "presence popover has no focusable button").not.toBeNull()
    expect(presenceFirst!.testId).toBe("ck12-rig-presence-close")
    expect(presenceFirst!.x, "presence close button is not on the left").toBeLessThan(presenceFirst!.centerX)
    await page.getByTestId("ck12-rig-presence-close").click()
    await expect(presencePop).toBeHidden({ timeout: 10_000 })

    // The model popover is a known boundary: it reuses ComposerModelPopover,
    // which has no close button (click-outside / Esc closes it). Assert the
    // trigger exists so the boundary is visible in this spec, not assumed.
    await expect(page.getByTestId("ck12-rig-model").locator("button").first()).toBeVisible()

    expect(audit.filtered, `console errors: ${JSON.stringify(audit.raw, null, 2)}`).toEqual([])
    audit.dispose()
  })

  test("换色：◐ 换色后 body 上的 --ck-a 变化", async ({ page }) => {
    const audit = attachConsoleAudit(page)
    await gotoCockpit(page, seed!.cabin.id, { job: seed!.workflowJob.id })

    const readAccent = () =>
      page.evaluate(() => getComputedStyle(document.body).getPropertyValue("--ck-a").trim())

    const before = await readAccent()
    expect(before, "--ck-a is not set on body").toBeTruthy()

    await page.getByRole("button", { name: /换色/ }).click()
    await expect.poll(readAccent, { message: "--ck-a did not change after 换色" }).not.toBe(before)

    expect(audit.filtered, `console errors: ${JSON.stringify(audit.raw, null, 2)}`).toEqual([])
    audit.dispose()
  })

  test("演示到达：⌁ → 简报 0 按钮、10s 消失、四边流光出现", async ({ page }) => {
    const audit = attachConsoleAudit(page)
    await gotoCockpit(page, seed!.cabin.id, { job: seed!.workflowJob.id, demo: true })

    const trigger = page.getByTestId("cockpit-demo-arrival")
    await expect(trigger).toBeVisible({ timeout: 15_000 })
    await trigger.click()

    const brief = page.getByTestId("cockpit-brief")
    await expect(brief).toBeVisible({ timeout: 10_000 })
    // Hard requirement: the brief carries no buttons at all (auto-dismiss only).
    await expect(brief.locator("button")).toHaveCount(0)
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

    await page.getByRole("button", { name: "← 返回作战舱" }).click()
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
