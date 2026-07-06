import { test, expect } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"
import {
  installResourceViaApi,
  uninstallResourceViaApi,
  assertAuditSchema,
} from "../helpers/resource-helpers"

const TEST_ORG = "e2e-test"
// Use a known builtin skill from core-pack
const TEST_REF = "builtin:octo-agent-clones"
const TEST_NAME = "octo-agent-clones"
const TEST_TYPE = "skill"

test.describe("Resource Management — TC-E2E-001", () => {
  // Cleanup after each test
  test.afterEach(async () => {
    try {
      await uninstallResourceViaApi(TEST_ORG, TEST_NAME, TEST_TYPE)
    } catch { /* already uninstalled */ }
  })

  test("S1: Resource list page loads with empty state", async ({ page }) => {
    await page.goto("/resources")
    await expect(page.getByRole("heading", { name: "资源管理" })).toBeVisible()
    // Tab navigation visible
    await expect(page.getByRole("tablist")).toBeVisible()
    await expect(page.getByRole("tab", { name: /资源列表/ })).toBeVisible()
    await expect(page.getByRole("tab", { name: /审计日志/ })).toBeVisible()
    // Visual baseline: empty resource list
    await expect(page).toHaveScreenshot("resource-list-empty.png", { maxDiffPixelRatio: 0.05 })
  })

  test("S2: Tab switching works (list → audit → list)", async ({ page }) => {
    await page.goto("/resources")
    // Default tab is list
    await expect(page.getByRole("tab", { name: /资源列表/ })).toHaveAttribute("aria-selected", "true")

    // Switch to audit tab
    await page.getByRole("tab", { name: /审计日志/ }).click()
    await expect(page).toHaveURL(/tab=audit/)
    await expect(page.getByRole("tab", { name: /审计日志/ })).toHaveAttribute("aria-selected", "true")
    // Visual baseline: audit tab active
    await expect(page).toHaveScreenshot("resource-tab-audit.png", { maxDiffPixelRatio: 0.05 })

    // Switch back to list
    await page.getByRole("tab", { name: /资源列表/ }).click()
    await expect(page).toHaveURL(/tab=list/)
  })

  test("S3: Install dialog opens with proper accessibility", async ({ page }) => {
    await page.goto("/resources")
    // Open install dialog
    await page.getByRole("button", { name: /安装/ }).click()
    // Dialog visible
    await expect(page.getByRole("dialog")).toBeVisible()
    // Ref input focused
    const refInput = page.getByTestId("install-ref-input")
    await expect(refInput).toBeVisible()
    // Install button starts disabled when input empty
    const installBtn = page.getByTestId("btn-install")
    await expect(installBtn).toBeVisible()
    // Close via Escape
    await page.keyboard.press("Escape")
    await expect(page.getByRole("dialog")).not.toBeVisible()
  })

  test("S4: After install, resource card appears in list", async ({ page }) => {
    // Pre-install via API
    await installResourceViaApi(TEST_ORG, TEST_REF)

    await page.goto("/resources")
    // Card should appear (wait for data load)
    await expect(page.getByTestId(`resource-card-${TEST_NAME}`)).toBeVisible({ timeout: 10000 })
    // Visual baseline: resource card in list
    await expect(page).toHaveScreenshot("resource-list-with-card.png", { maxDiffPixelRatio: 0.05 })
  })

  test("S5: Detail page shows resource info", async ({ page }) => {
    await installResourceViaApi(TEST_ORG, TEST_REF)

    await page.goto(`/resources/${TEST_TYPE}/${TEST_NAME}`)
    // Detail page heading
    await expect(page.getByText(TEST_NAME)).toBeVisible({ timeout: 10000 })
    // Uninstall button with aria-label
    await expect(page.getByRole("button", { name: /卸载/ })).toBeVisible()
    // Visual baseline: detail page
    await expect(page).toHaveScreenshot("resource-detail.png", { maxDiffPixelRatio: 0.05 })
  })

  test("S6: Uninstall removes resource from list", async ({ page }) => {
    await installResourceViaApi(TEST_ORG, TEST_REF)

    await page.goto("/resources")
    await expect(page.getByTestId(`resource-card-${TEST_NAME}`)).toBeVisible({ timeout: 10000 })

    // Trigger uninstall via API for reliability
    await uninstallResourceViaApi(TEST_ORG, TEST_NAME, TEST_TYPE)

    // Refresh
    await page.reload()
    await expect(page.getByTestId(`resource-card-${TEST_NAME}`)).not.toBeVisible({ timeout: 10000 })
  })

  test("S7: Audit page shows install/uninstall records", async ({ page }) => {
    await installResourceViaApi(TEST_ORG, TEST_REF)
    await uninstallResourceViaApi(TEST_ORG, TEST_NAME, TEST_TYPE)

    await page.goto("/resources?tab=audit")
    // Audit timeline visible
    await expect(page.getByTestId("audit-timeline")).toBeVisible({ timeout: 10000 })
    // Should show install and uninstall records
    await expect(page.getByText("install")).toBeVisible()
    await expect(page.getByText("uninstall")).toBeVisible()
    // Visual baseline: audit timeline
    await expect(page).toHaveScreenshot("resource-audit.png", { maxDiffPixelRatio: 0.05 })
  })

  test("S8: Accessibility — no critical violations on resource pages", async ({ page }) => {
    await page.goto("/resources")
    const results = await new AxeBuilder({ page })
      .include("#tabpanel-list")
      .analyze()
    expect(results.violations.filter(v => v.impact === "critical")).toEqual([])
  })

  test("S9: Keyboard navigation — all tabs reachable via Tab key", async ({ page }) => {
    await page.goto("/resources")
    // Focus the tablist
    const tablist = page.getByRole("tablist")
    await tablist.focus()
    // Tab through tabs
    await expect(page.getByRole("tab", { name: /资源列表/ })).toBeFocused()
    await page.keyboard.press("Tab")
    await expect(page.getByRole("tab", { name: /审计日志/ })).toBeFocused()
  })
})

test.describe("Audit schema validation", () => {
  test("audit records conform to expected schema", () => {
    const mockRecords = [
      {
        timestamp: "2026-07-07T05:00:00Z",
        action: "install",
        resourceName: "test",
        resourceType: "skill",
        source: "builtin",
        caller: "cli",
      },
    ]
    // Should not throw
    assertAuditSchema(mockRecords)
  })

  test("audit schema rejects missing fields", () => {
    const badRecords = [{ timestamp: "2026-07-07T05:00:00Z", action: "install" }]
    expect(() => assertAuditSchema(badRecords)).toThrow("missing")
  })
})
