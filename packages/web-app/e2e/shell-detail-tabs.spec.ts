import { test, expect } from "@playwright/test"

test.describe("桌面壳 · 常驻详情标签", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("详情开标签、切走保留、点击回归，全程不整页刷新", async ({ page }) => {
    await page.goto("/workspaces")
    await expect(page.getByRole("link", { name: "进入 →" }).first()).toBeVisible({
      timeout: 15_000,
    })
    const boot = await page.evaluate(() => window.__OCTOPUS_BOOT_ID__)

    await page.getByRole("link", { name: "进入 →" }).first().click()
    await expect(page).toHaveURL(/\/workspaces\/[^/]+/)
    const detailUrl = page.url()
    const tabBar = page.getByTestId("detail-tab-bar")
    await expect(tabBar).toBeVisible()
    await expect(tabBar.getByRole("tab")).toHaveCount(1)

    await page.getByRole("link", { name: "知识中心" }).click()
    await expect(page).toHaveURL(/\/knowledge$/)
    await expect(tabBar).toBeVisible()
    await expect(tabBar.getByRole("tab")).toHaveCount(1)

    await tabBar.getByRole("tab").first().click()
    await expect(page).toHaveURL(detailUrl)
    expect(await page.evaluate(() => window.__OCTOPUS_BOOT_ID__)).toBe(boot)
  })

  test("第二个详情形成第二个标签，关闭活动标签回退", async ({ page }) => {
    await page.goto("/workspaces")
    const enterLinks = page.getByRole("link", { name: "进入 →" })
    await expect(enterLinks.first()).toBeVisible({ timeout: 15_000 })

    await enterLinks.first().click()
    await expect(page.getByTestId("detail-tab-bar").getByRole("tab")).toHaveCount(1)
    const firstDetailUrl = page.url()

    await page.getByRole("link", { name: "工作空间", exact: true }).first().click()
    await expect(page).toHaveURL(/\/workspaces$/)
    await expect(enterLinks.nth(1)).toBeVisible({ timeout: 15_000 })
    await enterLinks.nth(1).click()
    await expect(page.getByTestId("detail-tab-bar").getByRole("tab")).toHaveCount(2)

    const tabBar = page.getByTestId("detail-tab-bar")
    await tabBar.getByRole("button", { name: /^关闭 / }).last().click()
    await expect(tabBar.getByRole("tab")).toHaveCount(1)
    await expect(page).toHaveURL(firstDetailUrl)
  })

  test("直接深链详情后刷新，标签恢复且不 404", async ({ page }) => {
    await page.goto("/workspaces")
    const first = page.getByRole("link", { name: "进入 →" }).first()
    await expect(first).toBeVisible({ timeout: 15_000 })
    const href = await first.getAttribute("href")
    expect(href).toMatch(/^\/workspaces\/[^/]+/)

    await page.goto(href!)
    await expect(page.getByTestId("detail-tab-bar")).toBeVisible()
    await page.reload()
    await expect(page.getByTestId("detail-tab-bar")).toBeVisible()
    await expect(page.getByTestId("workspace-detail")).toBeVisible({ timeout: 15_000 })
  })

  test("对话草稿在切视图后保留（对话不卸载）", async ({ page }) => {
    await page.goto("/")
    const composer = page.locator("textarea").first()
    await expect(composer).toBeVisible({ timeout: 15_000 })
    await composer.fill("draft-survives-view-switch")

    await page.getByRole("link", { name: "今日" }).click()
    await expect(page).toHaveURL(/\/dashboard$/)
    await page.getByRole("link", { name: "对话", exact: true }).first().click()
    await expect(page).toHaveURL(/\/$/)
    await expect(page.locator("textarea").first()).toHaveValue("draft-survives-view-switch")
  })
})
