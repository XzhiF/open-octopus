// 知识中心 · 只读知识库 E2E（2026-11-03）。
// 真 server(3001)+web(3000) 真数据。策展人抽屉 / FINDING 收件箱 / 引用药丸已移除：
// wiki 的写入与冲突裁决回到主对话，本页面只读浏览、检索与阅读。
// 钉三件事：①阅读史栈可用；②左树拖宽记忆；③真实目录/页渲染/INDEX/原料库读面。
import { test, expect } from "@playwright/test"

const W = 1440
const H = 900

test.use({ viewport: { width: W, height: H } })

test.describe("知识中心 · 只读知识库", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/knowledge")
    await page.waitForSelector('[data-testid="kc-tree-ready"]', { timeout: 15000 })
  })

  test("负断言：没有策展人抽屉 / FINDING 收件箱 / 写入入口", async ({ page }) => {
    await expect(page.getByTestId("kc-drawer-toggle")).toHaveCount(0)
    await expect(page.getByTestId("kc-curator-drawer")).toHaveCount(0)
    await expect(page.getByTestId("kc-cite-pill")).toHaveCount(0)
    await expect(page.getByTestId("kc-finding-inbox")).toHaveCount(0)
    await expect(page.getByText("问策展人")).toHaveCount(0)
    await expect(page.getByRole("button", { name: /采纳|忽略|落 wiki|重试编译/ })).toHaveCount(0)
  })

  test("阅读史栈导航：页头 ←/→ 与浏览器前进/后退共栈（替代浏览器导航，跳链可快速返回）", async ({ page }) => {
    // 史栈 [空(0), index(1), log(2)]：初始空态，← disabled
    await expect(page.getByTestId("kc-nav-back")).toBeDisabled()
    await expect(page.getByTestId("kc-empty-state")).toBeVisible()
    await page.getByTestId("kc-select-index").click()
    await expect(page.getByTestId("kc-index-view")).toBeVisible()
    await page.getByTestId("kc-select-log").click()
    await expect(page.getByTestId("kc-log-view")).toBeVisible()
    await expect(page.getByTestId("kc-nav-back")).toBeEnabled()
    await expect(page.getByTestId("kc-nav-forward")).toBeDisabled()

    // 页头 ←：log → index（history.go(-1) → popstate 唯一提交点）
    await page.getByTestId("kc-nav-back").click()
    await expect(page.getByTestId("kc-index-view")).toBeVisible()

    // 浏览器 back：index → 空态（证明与页头箭头同一个浏览器历史栈）
    await page.goBack()
    await expect(page.getByTestId("kc-empty-state")).toBeVisible()
    await expect(page.getByTestId("kc-nav-back")).toBeDisabled()

    // 浏览器 forward ×2 → 空态→index→log；页头 → 此时仍 disabled（栈尾），← 可点
    await page.goForward()
    await expect(page.getByTestId("kc-index-view")).toBeVisible()
    await page.goForward()
    await expect(page.getByTestId("kc-log-view")).toBeVisible()
    await expect(page.getByTestId("kc-nav-forward")).toBeDisabled()

    // 新导航截断前向分支：回 index 后点树打开 LOG 之外的页，史栈尾替换
    await page.getByTestId("kc-nav-back").click() // log → index
    await page.getByTestId("kc-nav-back").click() // index → 空态
    await expect(page.getByTestId("kc-empty-state")).toBeVisible()
    await page.getByTestId("kc-select-index").click() // push 截断：栈=[空, index]
    await expect(page.getByTestId("kc-nav-forward")).toBeDisabled()
  })

  test("左树拖宽：把手骑分界线，拖拽即时改宽且刷新后记忆（视图态 localStorage）", async ({ page }) => {
    const aside = page.getByTestId("kc-tree-pane")
    const before = (await aside.boundingBox())!
    const hb = (await page.getByTestId("kc-tree-resize").boundingBox())!
    // 把手中心应压在树/正文分界线上（±2px）
    expect(Math.abs(hb.x + hb.width / 2 - (before.x + before.width))).toBeLessThan(2)

    await page.mouse.move(hb.x + hb.width / 2, hb.y + 200)
    await page.mouse.down()
    await page.mouse.move(hb.x + hb.width / 2 + 150, hb.y + 200, { steps: 6 })
    await page.mouse.up()
    const after = (await aside.boundingBox())!
    expect(after.width).toBeGreaterThan(before.width + 100)

    await page.reload()
    await page.waitForSelector('[data-testid="kc-tree-ready"]', { timeout: 15000 })
    const reloaded = (await aside.boundingBox())!
    expect(Math.abs(reloaded.width - after.width)).toBeLessThan(2)
  })

  test("真实目录树（改版 20261016）：根层直呈 .octopus/knowledge 结构，SCHEMA.md 开 DocView", async ({ page }) => {
    const root = page.getByTestId("kc-tree-ready")
    // 根层 = 盘上实况（目录先行）；user_preference/.git 被 /fs 端点排除
    await expect(root.locator('[data-kc-fs-path="_archive"]')).toBeVisible()
    await expect(root.locator('[data-kc-fs-path="raw"]')).toBeVisible()
    await expect(root.locator('[data-kc-fs-path="SCHEMA.md"]')).toBeVisible()
    await expect(root.locator('[data-kc-fs-path="wiki"]')).toBeVisible()
    // System 三入口收进树：INDEX/LOG 文件叶 + raw 目录行（智能展开默认可见）
    await expect(root.locator('[data-kc-fs-path="wiki/INDEX.md"]')).toBeVisible()
    await expect(root.locator('[data-kc-fs-path="wiki/LOG.md"]')).toBeVisible()
    // 活页目录自动展开（叶直接可见），归档 _retired 默认收起
    await expect(root.locator('[data-kc-fs-path^="wiki/concepts/"]').first()).toBeVisible()
    await expect(root.locator('[data-kc-fs-path^="wiki/_retired/"]')).toHaveCount(0)
    // SCHEMA.md → fs/file 只读视图
    await root.locator('[data-kc-fs-path="SCHEMA.md"]').click()
    await expect(page.getByTestId("kc-doc-view")).toBeVisible({ timeout: 10000 })
    await expect(page.getByTestId("kc-doc-view")).toContainText("SCHEMA.md")
  })

  test("树导航 → 页渲染 → 右栏三件套在场（目录/反链/实效账）", async ({ page }) => {
    // 活页叶（entryMap 全路径精确配命中）直接可点——不硬编码页名，取 concepts 首叶
    const firstLeaf = page.getByTestId("kc-tree-ready").locator('[data-kc-fs-path^="wiki/concepts/"]').first()
    await firstLeaf.click()
    await expect(page.getByTestId("kc-page-title")).toBeVisible({ timeout: 10000 })
    await expect(page.getByTestId("kc-crumb")).toBeVisible()
    // 1440px 视口 = xl 断点，右栏应现
    await expect(page.getByTestId("kc-rail")).toBeVisible()
    await expect(page.getByTestId("kc-rail").locator("text=本页目录")).toBeVisible()
    await expect(page.getByTestId("kc-rail").locator("text=反向链接")).toBeVisible()
  })

  test("INDEX 总览与原料库两特殊视图真读（tree.index + /api/knowledge/raw）", async ({ page }) => {
    await page.getByTestId("kc-select-index").click()
    await expect(page.getByTestId("kc-index-view")).toBeVisible()

    await page.getByTestId("kc-select-rawlib").click()
    const lib = page.getByTestId("kc-raw-lib")
    await expect(lib).toBeVisible()
    // 真库 raw 非空（本机 global wiki 已投喂多时）；行点开通只读原文
    const rows = page.getByTestId("kc-raw-row")
    await expect(rows.first()).toBeVisible({ timeout: 10000 })
    await rows.first().click()
    await expect(page.getByTestId("kc-raw-view")).toBeVisible()
  })

  test("负断言：user_preference 概念全消失（无必读组/无入口/无文案）", async ({ page }) => {
    await expect(page.locator("text=user_preference")).toHaveCount(0)
    await expect(page.locator("text=必读")).toHaveCount(0)
    // 双模式钮已删
    await expect(page.locator('button:has-text("对话模式")')).toHaveCount(0)
    await expect(page.locator('button:has-text("浏览模式")')).toHaveCount(0)
  })
})
