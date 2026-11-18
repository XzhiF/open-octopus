// packages/web-app/e2e/tests/cockpit-v20.spec.ts
//
// v20（design 29）真数据 E2E：多作战 tab / 停靠 / grip / 弹出窗 + WINDOWS 条 /
// 决断面板 / SESSION LEDGER / 工作树只读查阅 / 详情文件+调试页签 / 12 姿态帧播放器 /
// DEV 模拟弹层 / 响应式。纪律同 cockpit-global：不发聊天消息（不烧 LLM），
// 播种舱 REST 建、afterAll 删；backend 不在 → 全 skip。

import { expect, test, type Page } from "@playwright/test"
import { execFileSync } from "child_process"
import * as fs from "fs"
import * as path from "path"
import {
  attachConsoleAudit,
  cleanupCabin,
  expectNoHorizontalOverflow,
  gotoCockpit,
  log,
  seedCockpitCabin,
  serverReachable,
  SERVER_URL,
  type SeededCockpit,
} from "../helpers/cockpit-helpers"

const VIEWPORT = { width: 1440, height: 900 }

let seed: SeededCockpit | null = null
let skipReason: string | null = null

test.describe.configure({ mode: "serial" })

async function openComms(page: Page): Promise<void> {
  // v12 自动落点：首拍编队到手会 select 默认 ref（按设计收对话窗）。
  // 等落点定下来再开窗，否则窗刚开就被自动落点收掉（e2e 实测竞态）。
  await expect.poll(async () => {
    const rows = await page.locator('[data-testid^="cockpit-rail-row-"]').count()
    const empty = await page.getByTestId("cockpit-rail-empty").count()
    return rows + empty
  }, { timeout: 20_000 }).toBeGreaterThan(0)
  await page.waitForTimeout(400)
  await page.keyboard.press("Meta+k")
  const win = page.getByTestId("cockpit-chat-window")
  await expect(win).toHaveAttribute("data-open", "true")
  // 默认几何是 rAF 量出来的：等窗真的有尺寸且落定（两拍相同）再量/拖。
  await expect.poll(async () => {
    const a = (await win.boundingBox())?.width ?? 0
    await page.waitForTimeout(220)
    const b = (await win.boundingBox())?.width ?? 0
    return a > 100 && Math.abs(a - b) < 2 ? a : 0
  }, { timeout: 15_000 }).toBeGreaterThan(100)
}

test.describe("全域座舱 v20 · 真数据 E2E", () => {
  test.beforeAll(async () => {
    if (!(await serverReachable())) {
      skipReason = "OCTOPUS backend unreachable (OCTOPUS_SERVER_URL ?? http://localhost:3001)"
      return
    }
    seed = await seedCockpitCabin()
    log(`v20 seed cabin ${seed.cabin.id}`)
  })

  test.beforeEach(async ({ page }) => {
    test.skip(!!skipReason, skipReason ?? "")
    await page.setViewportSize(VIEWPORT)
  })

  test.afterAll(async () => {
    if (!seed) return
    await cleanupCabin(seed.cabin.id)
  })

  test("作战线程：编队 💬 切线程 + ⌥← 回主对话（v21 二轮去 tab 条）", async ({ page }) => {
    const audit = attachConsoleAudit(page)
    await gotoCockpit(page, seed!.cabin.id)
    await openComms(page)
    // v21 二轮：通讯台不再有 tab 条，作战线程从编队行 💬 进。
    await expect(page.getByTestId("cockpit-thread-tabs")).toHaveCount(0)
    await expect(page.getByTestId("cockpit-comms-title")).toHaveText("主对话")
    const talk = page.getByTestId(`cockpit-rail-talk-job:${seed!.taskJob.id}`)
    await expect(talk).toBeVisible({ timeout: 20_000 })
    await talk.click()
    await expect(page.getByTestId("cockpit-comms-title")).not.toHaveText("主对话")
    await page.keyboard.press("Alt+ArrowLeft")
    await expect(page.getByTestId("cockpit-comms-title")).toHaveText("主对话")
    expect(audit.filtered).toEqual([])
    audit.dispose()
  })

  test("停靠 pill + 边缘 grip：收起/展开/拖拽/双击复位", async ({ page }) => {
    const audit = attachConsoleAudit(page)
    await gotoCockpit(page, seed!.cabin.id)
    await openComms(page)
    const win = page.getByTestId("cockpit-chat-window")
    const before = await win.boundingBox()
    await page.getByTestId("cockpit-comms-dock").click()
    await expect(win).toHaveAttribute("data-docked", "true")
    const dock = page.getByTestId("cockpit-con-dock")
    await expect(dock).toBeVisible()
    await dock.click()
    await expect(win).toHaveAttribute("data-docked", "false")
    await page.waitForTimeout(400)

    // 左缘 grip：右缘钉住，宽 -120。
    const grip = win.locator(".ck12-comms-grip-l")
    const gb = await grip.boundingBox()
    await page.mouse.move(gb!.x + 3, gb!.y + 100)
    await page.mouse.down()
    await page.mouse.move(gb!.x + 123, gb!.y + 100, { steps: 6 })
    await page.mouse.up()
    await page.waitForTimeout(300)
    const after = await win.boundingBox()
    expect(Math.abs(after!.width - (before!.width - 120))).toBeLessThan(8)
    expect(Math.abs(after!.x + after!.width - (before!.x + before!.width))).toBeLessThan(4)
    await grip.dblclick()
    // 复位走 rect=null → rAF 重量的异步路径，等落定再量。
    await page.waitForTimeout(600)
    const reset = await win.boundingBox()
    expect(Math.abs(reset!.width - before!.width)).toBeLessThan(8)
    expect(audit.filtered).toEqual([])
    audit.dispose()
  })

  test("弹出窗 + WINDOWS 条：弹出/最小化/chip 恢复/关闭", async ({ page }) => {
    const audit = attachConsoleAudit(page)
    await gotoCockpit(page, seed!.cabin.id)
    await openComms(page)
    const talk = page.getByTestId(`cockpit-rail-talk-job:${seed!.taskJob.id}`)
    await expect(talk).toBeVisible({ timeout: 20_000 })
    await talk.click()
    await page.getByTestId("cockpit-popout").click()
    const win = page.locator(".ck12-cwin").first()
    await expect(win).toBeVisible()
    const bar = page.getByTestId("cockpit-winbar")
    await expect(bar).toBeVisible()
    await expect(page.getByTestId("cockpit-winbar-main")).toBeVisible()
    const winId = await win.getAttribute("data-testid")
    const chip = page.getByTestId(`cockpit-winbar-chip-${winId!.replace("cockpit-win-", "")}`)
    await win.getByRole("button", { name: "最小化到 WINDOWS 条" }).click()
    await expect(win).toBeHidden()
    await expect(chip).toHaveClass(/is-min/)
    await chip.click()
    await expect(win).toBeVisible()
    await win.getByRole("button", { name: "关闭弹出窗" }).click()
    await expect(bar).toHaveCount(0)
    expect(audit.filtered).toEqual([])
    audit.dispose()
  })

  test("决断面板 + SESSION LEDGER：开/空态/四格/Esc", async ({ page }) => {
    const audit = attachConsoleAudit(page)
    await gotoCockpit(page, seed!.cabin.id)
    // v21：决断面板入口从 HUD 的 rail-ops 迁到 inbox 浮层底部的「全部决断 →」。
    await page.getByTestId("cockpit-inbox-chip").click()
    await page.getByRole("button", { name: /全部决断/ }).click()
    const ops = page.getByTestId("cockpit-panel-ops")
    await expect(ops).toBeVisible()
    await expect(page.getByTestId("cockpit-ops-empty")).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(ops).toHaveCount(0)

    // v21 二轮：HUD 读数只读，完整账本从右栏「消耗」进。
    await page.getByTestId("cockpit-menu-usage").click()
    const ledger = page.getByTestId("cockpit-panel-ledger")
    await expect(ledger).toBeVisible()
    await expect(page.getByTestId("cockpit-ledger-top")).toBeVisible()
    await expect(page.getByTestId("cockpit-ledger-cells").locator(".ck12-ledger-cell")).toHaveCount(4)
    await page.keyboard.press("Escape")
    await expect(ledger).toHaveCount(0)

    // v21 四轮：右栏「调试」= 本舱主会话（跟汐音的主 chat），不再落到某条作业。
    await page.getByTestId("cockpit-menu-debug").click()
    const debugPanel = page.getByTestId("cockpit-panel-debug")
    await expect(debugPanel).toBeVisible()
    await expect(debugPanel).toContainText("本舱调试")
    await expect(page.getByTestId("cockpit-main-debug-inspector")).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(debugPanel).toHaveCount(0)

    expect(audit.filtered).toEqual([])
    audit.dispose()
  })

  test("工作树只读查阅：绑项目 → chips → 树 → 预览", async ({ page }) => {
    const audit = attachConsoleAudit(page)
    // 播种舱目录下建一个真 git 仓并绑进舱籍（只读查阅的面）。
    const repoDir = path.join(seed!.dir, "apps", "demo")
    fs.mkdirSync(repoDir, { recursive: true })
    fs.writeFileSync(path.join(repoDir, "readme.md"), "# demo\n")
    const git = (args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repoDir })
    git(["init", "-b", "main"])
    git(["add", "."])
    git(["commit", "-m", "init"])
    const bind = await page.request.post(`${SERVER_URL}/api/cabins/${seed!.cabin.id}/repos`, {
      data: { source: "local", name: "demo", localPath: path.join("apps", "demo") },
    })
    expect(bind.status()).toBe(201)

    await gotoCockpit(page, seed!.cabin.id)
    // v21：文件入口从 HUD 移到右栏「更多 → 文件」。
    await page.getByTestId("cockpit-menu-more").click()
    await page.getByTestId("cockpit-fan-files").click()
    const ws = page.getByTestId("cockpit-panel-ws")
    await expect(ws).toBeVisible()
    await expect(page.getByTestId("cockpit-ws-chip-demo")).toBeVisible({ timeout: 15_000 })
    await expect(ws.getByTestId("cockpit-tree-file-readme.md")).toBeVisible({ timeout: 15_000 })
    await ws.getByTestId("cockpit-tree-file-readme.md").click()
    await expect(ws.locator(".ck12-files-pre")).toContainText("# demo")
    await page.keyboard.press("Escape")
    await expect(ws).toHaveCount(0)
    expect(audit.filtered).toEqual([])
    audit.dispose()
  })

  test("详情文件 + 调试页签：task home 树 / inspect 单行", async ({ page }) => {
    const audit = attachConsoleAudit(page)
    audit.allow404(2)
    await gotoCockpit(page, seed!.cabin.id, { job: seed!.taskJob.id, tab: "files" })
    await expect(page.getByTestId("cockpit-job-files")).toBeVisible({ timeout: 20_000 })
    await page.getByTestId("cockpit-tab-debug").click()
    await expect(page.getByTestId("cockpit-job-debug")).toBeVisible()
    await expect(page.getByTestId("cockpit-dbg-h")).toBeVisible()
    // 统计与过滤同一行（单行 dbg-h 内既有轮数也有过滤 chips）。
    const h = page.getByTestId("cockpit-dbg-h")
    await expect(h).toContainText("轮")
    await expect(h.getByRole("button", { name: /全部/ })).toBeVisible()
    expect(audit.filtered).toEqual([])
    audit.dispose()
  })

  test("12 姿态：图鉴 12 卡 + playPose（v21 静态阶段单帧）", async ({ page }) => {
    const audit = attachConsoleAudit(page)
    await gotoCockpit(page, seed!.cabin.id)
    const sprite = page.getByTestId("cockpit-pose-sprite")
    await expect(sprite).toBeVisible()
    // v21 先静态确认人设：motion sheet 未接，frames=1、立绘走单帧 pose PNG。
    // sheet 补齐后这里会退化成 12 帧，所以两种形态都接受，只断言「不是空图」。
    const frames = Number(await sprite.getAttribute("data-frames"))
    expect(frames).toBeGreaterThanOrEqual(1)
    if (frames > 1) {
      // 帧推进：5 次采样 transform 不全相同（ping-pong 别名防护）。
      const samples = new Set<string>()
      for (let i = 0; i < 5; i += 1) {
        samples.add(await sprite.locator("img").evaluate((el) => el.style.transform))
        await page.waitForTimeout(130)
      }
      expect(samples.size).toBeGreaterThan(1)
    } else {
      await expect(sprite.locator("img")).toHaveAttribute("src", /pose-.+\.png/)
    }

    // v21 二轮：动作图鉴入口在「更多 → 动作」。
    await page.getByTestId("cockpit-menu-more").click()
    await page.getByTestId("cockpit-fan-poses").click()
    const gallery = page.getByTestId("cockpit-poses-gallery")
    await expect(gallery).toBeVisible()
    await expect(gallery.locator(".ck12-pose-card")).toHaveCount(12)
    // v21 新键就位，旧键（happy/worried/salute）不再出现在图鉴。
    await expect(page.getByTestId("cockpit-pose-card-smile")).toBeVisible()
    await expect(page.getByTestId("cockpit-pose-card-concerned")).toBeVisible()
    await expect(page.getByTestId("cockpit-pose-card-ready")).toBeVisible()
    await page.getByTestId("cockpit-pose-card-cheer").click()
    await expect(gallery).toHaveCount(0)
    await expect(sprite).toHaveAttribute("data-pose", "cheer")
    await expect(page.getByTestId("cockpit-pose-fx")).toBeVisible()
    expect(audit.filtered).toEqual([])
    audit.dispose()
  })

  test("DEV 模拟弹层：单条/连发演示简报（?demo=1）", async ({ page }) => {
    const audit = attachConsoleAudit(page)
    await gotoCockpit(page, seed!.cabin.id, { demo: true })
    await page.getByTestId("cockpit-sim-toggle").click()
    await page.getByTestId("cockpit-sim-one").click()
    const brief = page.getByTestId("cockpit-brief")
    await expect(brief).toBeVisible()
    await expect(brief).toHaveAttribute("data-demo", "1")
    await page.getByTestId("cockpit-sim-burst").click()
    await expect(brief).toBeVisible()
    expect(audit.filtered).toEqual([])
    audit.dispose()
  })

  test("响应式 900/390：无横溢 + 停靠 pill 在视口内", async ({ page }) => {
    const audit = attachConsoleAudit(page)
    for (const width of [900, 390]) {
      await page.setViewportSize({ width, height: 844 })
      await gotoCockpit(page, seed!.cabin.id)
      await openComms(page)
      await page.getByTestId("cockpit-comms-dock").click()
      const dock = page.getByTestId("cockpit-con-dock")
      await expect(dock).toBeVisible()
      const box = await dock.boundingBox()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(width)
      await expectNoHorizontalOverflow(page, `${width}px 视口`)
    }
    expect(audit.filtered).toEqual([])
    audit.dispose()
  })
})
