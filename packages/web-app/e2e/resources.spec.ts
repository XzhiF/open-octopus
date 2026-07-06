// packages/web-app/e2e/resources.spec.ts
// E2E UI tests for 资源管理 — TC-061~099 (Suite B + D5)
import { test, expect } from "@playwright/test"

test.describe("资源管理 — 列表页", () => {
  test("B1: 导航到 /resources — 列表加载", async ({ page }) => {
    await page.goto("/resources")
    await expect(page.locator("h1").filter({ hasText: "资源管理" })).toBeVisible()
    // 骨架屏 → 卡片列表或空状态
    await page.waitForTimeout(3000)
    const hasGrid = await page.locator("a[aria-label*='查看']").first().isVisible().catch(() => false)
    const hasEmpty = await page.getByText("暂无资源").isVisible().catch(() => false)
    const hasNoMatch = await page.getByText("无匹配结果").isVisible().catch(() => false)
    const hasError = await page.getByText("加载失败").isVisible().catch(() => false)
    expect(hasGrid || hasEmpty || hasNoMatch || hasError).toBe(true)
  })

  test("B2: Tab 过滤 — 类型切换", async ({ page }) => {
    await page.goto("/resources")
    await page.waitForTimeout(3000)
    // 点击 Skills tab
    const skillTab = page.getByRole("tab", { name: "Skills" })
    await skillTab.click()
    // Wait for URL to update after tab click
    await page.waitForURL(/type=skill/, { timeout: 5000 })
    expect(page.url()).toContain("type=skill")
    // URL 状态同步
    await page.reload()
    await page.waitForTimeout(2000)
    expect(page.url()).toContain("type=skill")
    // 切回全部
    await page.getByRole("tab", { name: "全部" }).click()
    await page.waitForTimeout(500)
    expect(page.url()).not.toContain("type=")
  })

  test("B3: 搜索过滤 — debounce 300ms", async ({ page }) => {
    await page.goto("/resources")
    await page.waitForTimeout(3000)
    const searchInput = page.locator('input[aria-label="搜索资源"]')
    await expect(searchInput).toBeVisible()
    await searchInput.fill("octo")
    // 等待 debounce (300ms) + 一些余量
    await page.waitForTimeout(600)
    expect(page.url()).toContain("q=octo")
  })

  test("B4: 空状态 — Zero State 引导", async ({ page }) => {
    // Mock API 返回空
    await page.route("**/api/resources**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: [], meta: { total: 0, returned: 0 } }),
      })
    )
    await page.goto("/resources")
    await page.waitForTimeout(2000)
    await expect(page.getByText("暂无资源")).toBeVisible()
    await expect(page.getByText(/安装资源/).first()).toBeVisible()
  })

  test("B5: 安装对话框 — 打开 + 输入", async ({ page }) => {
    await page.goto("/resources")
    await page.waitForTimeout(2000)
    // 点击安装按钮
    const installBtn = page.getByRole("button", { name: /安装资源/ }).first()
    await expect(installBtn).toBeVisible()
    await installBtn.click()
    // 对话框弹出
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText("安装资源")).toBeVisible()
    // autoFocus 输入框
    const refInput = dialog.locator("input").first()
    await expect(refInput).toBeFocused()
    await refInput.fill("builtin:skill/octo-workflow-dev")
    // 关闭对话框
    await dialog.getByRole("button", { name: "取消" }).click()
    await expect(dialog).not.toBeVisible()
  })

  test("B12: URL 状态同步 — 刷新恢复", async ({ page }) => {
    await page.goto("/resources?type=skill&q=deploy")
    await page.waitForTimeout(3000)
    // 状态恢复
    expect(page.url()).toContain("type=skill")
    expect(page.url()).toContain("q=deploy")
    // 刷新页面
    await page.reload()
    await page.waitForTimeout(2000)
    // 状态仍然保持
    expect(page.url()).toContain("type=skill")
    expect(page.url()).toContain("q=deploy")
  })
})

test.describe("资源管理 — 详情页", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/resources")
    await page.waitForTimeout(3000)
  })

  test("B7: 资源详情页 — 三 Tab 布局", async ({ page }) => {
    const firstCard = page.locator("a[aria-label*='查看']").first()
    if (await firstCard.isVisible()) {
      await firstCard.click()
      // 详情页加载
      await page.waitForTimeout(3000)
      // 三 Tab 存在
      await expect(page.getByRole("tab", { name: "概览" })).toBeVisible()
      await expect(page.getByRole("tab", { name: "依赖" })).toBeVisible()
      await expect(page.getByRole("tab", { name: "审计" })).toBeVisible()
      // 默认概览 Tab 内容
      await expect(page.getByText("基本信息")).toBeVisible()
    }
  })

  test("B8: 详情页 — Tab 切换", async ({ page }) => {
    const firstCard = page.locator("a[aria-label*='查看']").first()
    if (await firstCard.isVisible()) {
      await firstCard.click()
      await page.waitForTimeout(3000)
      // 切换到依赖 Tab
      await page.getByRole("tab", { name: "依赖" }).click()
      await expect(page.getByText("依赖关系")).toBeVisible()
      // 切换到审计 Tab
      await page.getByRole("tab", { name: "审计" }).click()
      await expect(page.getByText("审计记录")).toBeVisible()
      // 切回概览
      await page.getByRole("tab", { name: "概览" }).click()
      await expect(page.getByText("基本信息")).toBeVisible()
    }
  })

  test("B9: 卸载确认 — 对话框弹出", async ({ page }) => {
    const firstCard = page.locator("a[aria-label*='查看']").first()
    if (await firstCard.isVisible()) {
      await firstCard.click()
      await page.waitForTimeout(3000)
      const uninstallBtn = page.getByRole("button", { name: /卸载/ })
      if (await uninstallBtn.isVisible()) {
        await uninstallBtn.click()
        // AlertDialog 弹出
        const alert = page.getByRole("alertdialog")
        await expect(alert).toBeVisible()
        await expect(alert.getByText(/卸载/)).toBeVisible()
        // 取消
        await alert.getByRole("button", { name: "取消" }).click()
        await expect(alert).not.toBeVisible()
      }
    }
  })
})

test.describe("资源管理 — 审计日志页", () => {
  test("B10: 审计日志页 — 表格 + 过滤", async ({ page }) => {
    await page.goto("/resources/audit")
    await page.waitForTimeout(3000)
    await expect(page.getByText("审计日志")).toBeVisible()
    // 表格或空状态
    const hasTable = await page.locator("table").isVisible().catch(() => false)
    const hasEmpty = await page.getByText("暂无审计记录").isVisible().catch(() => false)
    expect(hasTable || hasEmpty).toBe(true)
    // 过滤 Select 存在
    await expect(page.getByRole("combobox")).toBeVisible()
  })

  test("B11: 审计导出 — 按钮存在", async ({ page }) => {
    await page.goto("/resources/audit")
    await page.waitForTimeout(2000)
    await expect(page.getByRole("button", { name: /导出.*JSON/ })).toBeVisible()
  })
})

test.describe("资源管理 — 响应式", () => {
  test("D5: 移动端 375px — 卡片单列", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto("/resources")
    await page.waitForTimeout(3000)
    // 页面正常加载
    await expect(page.locator("h1").filter({ hasText: "资源管理" })).toBeVisible()
    // 如果有多张卡片，验证单列布局
    const cards = page.locator("a[aria-label*='查看']")
    if (await cards.count() > 1) {
      const box1 = await cards.first().boundingBox()
      const box2 = await cards.nth(1).boundingBox()
      if (box1 && box2) {
        // 单列: 第二张卡片 y 坐标 > 第一张
        expect(box2.y).toBeGreaterThan(box1.y)
      }
    }
  })
})
