// packages/web-app/e2e/tests/moa-error-paths.spec.ts
// E2E error path tests for MOA UI — TC-015, TC-017, TC-018, TC-020, TC-022
import { test, expect } from "@playwright/test"

async function mockMoaApis(page: import("@playwright/test").Page) {
  await page.route("**/config/models", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        providers: {
          pi: { "pro-max": "pi-pro-max-v2", "pro": "pi-pro-v1", "se": "pi-se-v1" },
        },
      }),
    })
  })

  await page.route("**/workflows/validate", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        valid: false,
        errors: [{ path: ["experts"], message: "requires at least 2 experts", code: "custom" }],
        warnings: [],
      }),
    })
  })
}

test.describe("TC-017: Submit disabled with insufficient experts", () => {
  test("save button stays disabled when only 1 expert configured", async ({ page }) => {
    await mockMoaApis(page)
    await page.goto("/dev/moa-test")
    await expect(page.getByTestId("moa-test-title")).toBeVisible({ timeout: 30000 })

    const moaSection = page.getByTestId("tc-moa-config")
    await expect(moaSection).toBeVisible()

    // Add 1 expert
    await moaSection.getByRole("button", { name: /添加 Expert/ }).click()

    // Validation message
    await expect(moaSection.getByText("MOA 模式至少需要 2 个 Expert")).toBeVisible()

    // Save disabled
    await expect(moaSection.getByRole("button", { name: "保存" })).toBeDisabled()
  })
})

test.describe("TC-018: Model degraded warning", () => {
  test("degraded model shows orange badge", async ({ page }) => {
    await mockMoaApis(page)
    await page.goto("/dev/moa-test")
    await expect(page.getByTestId("moa-test-title")).toBeVisible({ timeout: 30000 })

    const badgeSection = page.getByTestId("tc-moa-badges")
    await expect(badgeSection).toBeVisible()

    // Degraded badge has the warning icon
    const degradedBadge = badgeSection.getByText("降级", { exact: false }).first()
    await expect(degradedBadge).toBeVisible()
  })
})

test.describe("TC-022: Expert failed card", () => {
  test("failed expert shown with error state in result tab", async ({ page }) => {
    await page.goto("/dev/moa-test")
    await expect(page.getByTestId("moa-test-title")).toBeVisible({ timeout: 30000 })

    const resultSection = page.getByTestId("tc-moa-result-partial")
    await expect(resultSection).toBeVisible()

    // Failed expert badge visible
    await expect(resultSection.getByText("失败").first()).toBeVisible()

    // Successful experts still shown
    await expect(resultSection.getByText("security")).toBeVisible()
  })
})

test.describe("TC-015: All experts failed — AlertBanner", () => {
  test("shows error alert when all experts fail", async ({ page }) => {
    await page.goto("/dev/moa-test")
    await expect(page.getByTestId("moa-test-title")).toBeVisible({ timeout: 30000 })

    const resultSection = page.getByTestId("tc-moa-result-all-failed")
    await expect(resultSection).toBeVisible()

    // Alert banner visible
    await expect(resultSection.getByText("所有 Expert 执行失败")).toBeVisible()

    // Retry button present
    await expect(resultSection.getByRole("button", { name: /重试/ })).toBeVisible()
  })
})

test.describe("TC-020: YAML import syntax error with line number", () => {
  test("shows line number in error for malformed YAML", async ({ page }) => {
    await mockMoaApis(page)
    await page.goto("/dev/moa-test")
    await expect(page.getByTestId("moa-test-title")).toBeVisible({ timeout: 30000 })

    const moaSection = page.getByTestId("tc-moa-config")

    // Open import modal
    await moaSection.getByRole("button", { name: /导入 YAML/ }).click()
    await expect(page.getByRole("dialog")).toBeVisible()

    // Switch to import tab
    await page.getByRole("tab", { name: /导入/ }).click()

    // Enter invalid YAML
    const textarea = page.locator("textarea").last()
    await textarea.fill("mode: moa\nexperts:\n  - role: [invalid")

    // Parse
    await page.getByRole("button", { name: /解析/ }).click()

    // Error shown
    const alert = page.getByRole("alert")
    await expect(alert).toBeVisible({ timeout: 5000 })
  })
})
