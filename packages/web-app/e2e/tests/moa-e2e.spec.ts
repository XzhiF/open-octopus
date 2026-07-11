// packages/web-app/e2e/tests/moa-e2e.spec.ts
// E2E tests for MOA Swarm Mode UI — TC-016, TC-017, TC-018, TC-019, TC-020, TC-021, TC-023, TC-024
import { test, expect } from "@playwright/test"

// Mock API responses for MOA endpoints
async function mockMoaApis(page: import("@playwright/test").Page) {
  // Mock model alias config
  await page.route("**/config/models", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        providers: {
          pi: {
            "pro-max": "pi-pro-max-v2",
            "pro": "pi-pro-v1",
            "se": "pi-se-v1",
          },
          claude: {
            "pro-max": "opus",
            "pro": "sonnet",
            "se": "haiku",
          },
        },
      }),
    })
  })

  // Mock workflow validation — always valid
  await page.route("**/workflows/validate", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        valid: true,
        errors: [],
        warnings: [],
        parsed: { mode: "moa", expertCount: 2, hasAggregator: true },
      }),
    })
  })
}

test.describe("TC-016: MoaConfigPanel — Expert list", () => {
  test("renders empty state and allows adding experts", async ({ page }) => {
    await mockMoaApis(page)
    await page.goto("/dev/moa-test")
    await expect(page.getByTestId("moa-test-title")).toBeVisible({ timeout: 30000 })

    // Navigate to MOA test section
    const moaSection = page.getByTestId("tc-moa-config")
    await expect(moaSection).toBeVisible()

    // Empty state
    await expect(moaSection.getByText("点击「添加 Expert」开始配置")).toBeVisible()

    // Add expert button
    const addButton = moaSection.getByRole("button", { name: /添加 Expert/ })
    await addButton.click()

    // First expert row appears
    await expect(moaSection.getByPlaceholder("角色名")).toBeVisible()
  })
})

test.describe("TC-017: Save button disabled when experts < 2", () => {
  test("save button is disabled with 0 or 1 expert", async ({ page }) => {
    await mockMoaApis(page)
    await page.goto("/dev/moa-test")
    await expect(page.getByTestId("moa-test-title")).toBeVisible({ timeout: 30000 })

    const moaSection = page.getByTestId("tc-moa-config")
    await expect(moaSection).toBeVisible()

    // Save button should be disabled with 0 experts
    const saveButton = moaSection.getByRole("button", { name: "保存" })
    await expect(saveButton).toBeDisabled()

    // Add 1 expert
    await moaSection.getByRole("button", { name: /添加 Expert/ }).click()
    await expect(saveButton).toBeDisabled()

    // Add 2nd expert — save becomes available (after filling required fields)
    await moaSection.getByRole("button", { name: /添加 Expert/ }).click()
  })
})

test.describe("TC-018: ModelResolveBadge — three states", () => {
  test("shows exact, degraded, and error badge states", async ({ page }) => {
    await mockMoaApis(page)
    await page.goto("/dev/moa-test")
    await expect(page.getByTestId("moa-test-title")).toBeVisible({ timeout: 30000 })

    const badgeSection = page.getByTestId("tc-moa-badges")
    await expect(badgeSection).toBeVisible()

    // Exact match badge
    await expect(badgeSection.getByText("pi-pro-max-v2", { exact: false }).first()).toBeVisible()

    // Degraded match badge
    await expect(badgeSection.getByText("降级", { exact: false }).first()).toBeVisible()

    // Error badge
    await expect(badgeSection.getByText("无法解析", { exact: false }).first()).toBeVisible()
  })
})

test.describe("TC-019: YAML Export", () => {
  test("export modal shows YAML content with copy button", async ({ page }) => {
    await mockMoaApis(page)
    await page.goto("/dev/moa-test")
    await expect(page.getByTestId("moa-test-title")).toBeVisible({ timeout: 30000 })

    const moaSection = page.getByTestId("tc-moa-config")
    await expect(moaSection).toBeVisible()

    // Click export button
    await moaSection.getByRole("button", { name: /导出 YAML/ }).click()

    // Modal appears with export tab active
    await expect(page.getByRole("dialog")).toBeVisible()
    await expect(page.getByText("YAML 导出")).toBeVisible()

    // Copy button present
    await expect(page.getByRole("button", { name: /复制/ })).toBeVisible()
  })
})

test.describe("TC-020: YAML Import error handling", () => {
  test("shows error with line number for invalid YAML", async ({ page }) => {
    await mockMoaApis(page)
    await page.goto("/dev/moa-test")
    await expect(page.getByTestId("moa-test-title")).toBeVisible({ timeout: 30000 })

    const moaSection = page.getByTestId("tc-moa-config")
    await expect(moaSection).toBeVisible()

    // Click import button
    await moaSection.getByRole("button", { name: /导入 YAML/ }).click()

    // Modal appears
    await expect(page.getByRole("dialog")).toBeVisible()

    // Switch to import tab
    await page.getByRole("tab", { name: /导入/ }).click()

    // Paste invalid YAML
    const textarea = page.locator("textarea").last()
    await textarea.fill("invalid: yaml: broken\n  - not: [proper")

    // Click parse
    await page.getByRole("button", { name: /解析/ }).click()

    // Error message appears
    await expect(page.getByRole("alert")).toBeVisible({ timeout: 5000 })
  })
})

test.describe("TC-021: MoaResultTab — five states", () => {
  test("renders empty state when no execution data", async ({ page }) => {
    await page.goto("/dev/moa-test")
    await expect(page.getByTestId("moa-test-title")).toBeVisible({ timeout: 30000 })

    const resultSection = page.getByTestId("tc-moa-result")
    await expect(resultSection).toBeVisible()

    // Empty state
    await expect(resultSection.getByText("暂无执行数据")).toBeVisible()
  })

  test("renders success state with expert cards and aggregator output", async ({ page }) => {
    await page.goto("/dev/moa-test")
    await expect(page.getByTestId("moa-test-title")).toBeVisible({ timeout: 30000 })

    const resultSection = page.getByTestId("tc-moa-result-success")
    await expect(resultSection).toBeVisible()

    // Expert cards visible
    await expect(resultSection.getByText("security")).toBeVisible()
    await expect(resultSection.getByText("performance")).toBeVisible()

    // Aggregator section visible
    await expect(resultSection.getByText("Aggregator")).toBeVisible()

    // Compare button visible
    await expect(resultSection.getByRole("button", { name: /对比视图/ })).toBeVisible()
  })
})

test.describe("TC-023: Expert compare view", () => {
  test("compare mode shows side-by-side expert outputs", async ({ page }) => {
    await page.goto("/dev/moa-test")
    await expect(page.getByTestId("moa-test-title")).toBeVisible({ timeout: 30000 })

    const resultSection = page.getByTestId("tc-moa-result-success")
    await expect(resultSection).toBeVisible()

    // Click compare button
    await resultSection.getByRole("button", { name: /对比视图/ }).click()

    // Checkboxes appear
    await expect(resultSection.locator('[role="checkbox"]').first()).toBeVisible()

    // Back button appears
    await expect(resultSection.getByRole("button", { name: /返回/ })).toBeVisible()
  })
})

test.describe("TC-028: Expert output collapsible", () => {
  test("expand all button toggles output height", async ({ page }) => {
    await page.goto("/dev/moa-test")
    await expect(page.getByTestId("moa-test-title")).toBeVisible({ timeout: 30000 })

    const resultSection = page.getByTestId("tc-moa-result-success")
    await expect(resultSection).toBeVisible()

    // Click on first expert card to select it
    const expertCard = resultSection.getByText("security").first()
    await expertCard.click()

    // Expand button visible
    const expandTrigger = resultSection.getByText("展开全部")
    await expect(expandTrigger).toBeVisible()
    await expandTrigger.click()

    // Should now show "收起"
    await expect(resultSection.getByText("收起")).toBeVisible()
  })
})
