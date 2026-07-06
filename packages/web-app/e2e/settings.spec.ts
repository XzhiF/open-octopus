import { test, expect } from "@playwright/test"

test.describe("Settings 页面", () => {
  test("Header 设置按钮导航到 Settings 页面", async ({ page }) => {
    await page.goto("/")
    // 点击 Header 的设置图标按钮
    await page.locator('a[href="/settings"]').first().click()
    await expect(page).toHaveURL(/\/settings/)
    // 验证页面标题
    await expect(page.getByText("日志分析").first()).toBeVisible()
  })

  test("Settings 页面显示左侧 Sidebar", async ({ page }) => {
    await page.goto("/settings")
    await expect(page.getByText("日志分析").first()).toBeVisible()
  })

  test("Tab 切换更新 URL", async ({ page }) => {
    await page.goto("/settings")

    // 点击失败分析 Tab
    await page.getByRole("tab", { name: "失败分析" }).click()
    await expect(page).toHaveURL(/tab=failures/)

    // 点击异常检测 Tab
    await page.getByRole("tab", { name: "异常检测" }).click()
    await expect(page).toHaveURL(/tab=anomalies/)

    // 点击成本分析 Tab
    await page.getByRole("tab", { name: "成本分析" }).click()
    await expect(page).toHaveURL(/tab=cost/)

    // 切回概览
    await page.getByRole("tab", { name: "概览" }).click()
    await expect(page).toHaveURL(/tab=overview/)
  })

  test("Tab 状态在刷新后保持", async ({ page }) => {
    await page.goto("/settings?tab=failures")
    // 刷新页面
    await page.reload()
    // 验证仍在失败分析 Tab
    await expect(page.getByRole("tab", { name: "失败分析" })).toHaveAttribute("data-state", "active")
  })

  test("概览 Tab 显示健康摘要或空状态", async ({ page }) => {
    await page.goto("/settings")
    // 等待加载完成（骨架屏消失）
    await page.waitForTimeout(2000)
    // 应该显示统计卡、空状态提示或错误信息（三者之一即可）
    const hasStats = await page.getByText("总执行").isVisible().catch(() => false)
    const hasEmpty = await page.getByText("暂无执行数据").isVisible().catch(() => false)
    const hasError = await page.getByText("加载分析数据失败").isVisible().catch(() => false)
    expect(hasStats || hasEmpty || hasError).toBe(true)
  })

  test("各 Tab 空状态正确显示", async ({ page }) => {
    await page.goto("/settings")
    await page.waitForTimeout(2000)

    // 失败分析 Tab 空状态
    await page.getByRole("tab", { name: "失败分析" }).click()
    await page.waitForTimeout(1000)
    const hasFailureEmpty = await page.getByText(/没有失败记录/).isVisible().catch(() => false)
    const hasFailureData = await page.getByText("节点脆弱度排行").isVisible().catch(() => false)
    expect(hasFailureEmpty || hasFailureData).toBe(true)

    // 异常检测 Tab
    await page.getByRole("tab", { name: "异常检测" }).click()
    await page.waitForTimeout(1000)
    const hasAnomalyEmpty = await page.getByText(/未发现异常/).isVisible().catch(() => false)
    const hasAnomalyData = await page.getByText("耗时异常").isVisible().catch(() => false)
    expect(hasAnomalyEmpty || hasAnomalyData).toBe(true)

    // 成本分析 Tab
    await page.getByRole("tab", { name: "成本分析" }).click()
    await page.waitForTimeout(1000)
    const hasCostEmpty = await page.getByText(/暂无成本数据/).isVisible().catch(() => false)
    const hasCostData = await page.getByText("成本趋势").isVisible().catch(() => false)
    expect(hasCostEmpty || hasCostData).toBe(true)
  })

  test("Header 导航栏设置链接可点击（bonus）", async ({ page }) => {
    await page.goto("/")
    const settingsLink = page.locator('a[href="/settings"]')
    await expect(settingsLink.first()).toBeVisible()
    await settingsLink.first().click()
    await expect(page).toHaveURL(/\/settings/)
  })
})
