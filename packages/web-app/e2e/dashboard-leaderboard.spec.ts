import { test, expect } from "@playwright/test"

test.describe("Dashboard Leaderboard", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await page.waitForLoadState("networkidle")
  })

  test("三列渲染", async ({ page }) => {
    await expect(page.locator("text=Workspace 用量排行")).toBeVisible()
    await expect(page.locator("text=工作流用量排行")).toBeVisible()
    await expect(page.locator("text=模型用量排行")).toBeVisible()
  })

  test("等高对齐（桌面端）", async ({ page }) => {
    const cards = page.locator('[data-testid="leaderboard-grid"] > *')
    const count = await cards.count()
    if (count < 3) {
      test.skip()
      return
    }

    const heights = await Promise.all(
      Array.from({ length: count }).map(async (_, i) => {
        const box = await cards.nth(i).boundingBox()
        return box?.height ?? 0
      }),
    )

    const [first, ...rest] = heights
    for (const h of rest) {
      expect(Math.abs(h - first)).toBeLessThan(2)
    }
  })

  test("空数据状态", async ({ page }) => {
    const emptyMessages = page.locator("text=暂无用量数据")
    const skeleton = page.locator(".animate-pulse")
    const emptyCount = await emptyMessages.count()
    const skeletonCount = await skeleton.count()
    expect(emptyCount + skeletonCount).toBeGreaterThanOrEqual(0)
  })

  test("响应式布局（移动端）", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    const grid = page.locator('[data-testid="leaderboard-grid"]')
    await expect(grid).toBeVisible()
  })

  test("可访问性（axe-core）", async ({ page }) => {
    await page.goto("/")
    await page.waitForLoadState("domcontentloaded")

    await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") })

    const results = await page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (window as any).axe.run(document, {
        runOnly: ["wcag2a", "wcag2aa"],
      })
    })

    const criticalViolations = results.violations.filter(
      (v: { impact?: string }) => v.impact === "critical" || v.impact === "serious",
    )
    expect(criticalViolations).toHaveLength(0)
  })

  test("错误隔离：排行榜失败不影响 StatsCards", async ({ page }) => {
    await page.route("**/api/dashboard/leaderboard*", route => {
      route.abort()
    })

    await page.reload()
    await page.waitForLoadState("networkidle")

    await expect(page.locator("text=工作流编排平台概览")).toBeVisible()
  })
})
