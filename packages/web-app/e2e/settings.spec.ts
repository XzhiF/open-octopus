import { test, expect } from "@playwright/test"
import { openApp } from "./helpers/desktop"

test.describe("Settings 页面", () => {
  test("Octopus 菜单设置入口导航到 Settings 窗口", async ({ page }) => {
    await page.goto("/")
    await openApp(page, "设置")
    await expect(page).toHaveURL(/\/settings/)
    await expect(page.locator('[data-window-id="settings"]')).toBeVisible()
    // 日志分析已下线，设置里只剩外观。
    await expect(page.getByTestId("appearance-panel")).toBeVisible({ timeout: 15_000 })
  })

  test("Settings 页面显示左侧 Sidebar", async ({ page }) => {
    await page.goto("/settings")
    await expect(page.getByRole("button", { name: "外观" })).toBeVisible()
  })
})