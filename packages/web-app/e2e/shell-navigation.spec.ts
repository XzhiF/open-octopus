// 全局三栏外壳（ADR-0034）—
// 左导轨 + 内容 + 右作业坞；对话取代 Dashboard 成为 `/`，今日迁 `/dashboard`。
import { test, expect } from "@playwright/test"

test.describe("全局三栏外壳 · 桌面", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("对话首页 + 左导轨 + 右作业坞；今日迁至 /dashboard", async ({ page }) => {
    await page.goto("/")
    await expect(page.getByRole("heading", { name: "对话", level: 1 })).toBeVisible()
    await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible()
    await expect(page.getByRole("complementary", { name: "作业坞" })).toBeVisible()

    await page.getByRole("link", { name: "今日" }).click()
    await expect(page).toHaveURL(/\/dashboard$/)
    await expect(page.getByRole("heading", { name: "今日", level: 1 })).toBeVisible()
  })

  test("Agent 旧对话入口重定向到对话首页", async ({ page }) => {
    await page.goto("/agent?tab=chat")
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByRole("heading", { name: "对话", level: 1 })).toBeVisible()
    await expect(page.locator("#tab-chat")).toHaveCount(0)
  })

  test("作业坞收起态持久化", async ({ page }) => {
    await page.goto("/")
    await page.getByRole("button", { name: "收起作业坞" }).click()
    await expect(page.getByRole("button", { name: "展开作业坞" })).toBeVisible()
    await page.reload()
    await expect(page.getByRole("button", { name: "展开作业坞" })).toBeVisible()
  })
})

test.describe("全局三栏外壳 · 窄屏", () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test("导轨收进 Sheet 抽屉，作业坞隐藏", async ({ page }) => {
    await page.goto("/")
    await expect(page.getByRole("button", { name: "打开导航" })).toBeVisible()
    await expect(page.getByRole("complementary", { name: "作业坞" })).toBeHidden()

    await page.getByRole("button", { name: "打开导航" }).click()
    const sheetNav = page.getByRole("navigation", { name: "移动端主导航" })
    await expect(sheetNav).toBeVisible()
    await expect(sheetNav.getByRole("link", { name: "设置" })).toHaveAttribute(
      "href",
      "/settings",
    )
  })
})
