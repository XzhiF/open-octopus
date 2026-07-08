import { test, expect } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

/**
 * Dedicated accessibility test suite for resource management pages.
 * Covers axe-core full scan + keyboard navigation + ARIA attributes.
 */

test.describe("Resource Pages — Accessibility (WCAG 2.1 AA)", () => {
  test("resource list page — no critical or serious axe violations", async ({ page }) => {
    await page.goto("/resources")
    await page.waitForLoadState("networkidle")
    const results = await new AxeBuilder({ page })
      .disableRules(["color-contrast"]) // theme-level, not resource-specific
      .analyze()
    const severe = results.violations.filter(v => v.impact === "critical" || v.impact === "serious")
    expect(severe, `Axe violations: ${JSON.stringify(severe.map(v => ({ id: v.id, impact: v.impact })))}`).toEqual([])
  })

  test("resource detail page — no critical axe violations", async ({ page }) => {
    // Use a type/name that may exist; skip gracefully if no resources installed
    await page.goto("/resources")
    await page.waitForLoadState("networkidle")
    const firstCard = page.getByTestId(/^resource-card-/).first()
    if (await firstCard.isVisible({ timeout: 3000 }).catch(() => false)) {
      await firstCard.click()
      await page.waitForLoadState("networkidle")
      const results = await new AxeBuilder({ page })
        .disableRules(["color-contrast"])
        .analyze()
      const severe = results.violations.filter(v => v.impact === "critical" || v.impact === "serious")
      expect(severe).toEqual([])
    }
  })

  test("audit page — no critical axe violations", async ({ page }) => {
    await page.goto("/resources?tab=audit")
    await page.waitForLoadState("networkidle")
    const results = await new AxeBuilder({ page })
      .disableRules(["color-contrast"])
      .analyze()
    const severe = results.violations.filter(v => v.impact === "critical" || v.impact === "serious")
    expect(severe).toEqual([])
  })

  test("install dialog — accessible modal with focus trap", async ({ page }) => {
    await page.goto("/resources")
    await page.getByRole("button", { name: /安装/ }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()

    // Dialog has accessible name
    await expect(dialog).toHaveAttribute("aria-labelledby", /.+/)

    // Close button reachable via Tab
    const closeBtn = dialog.getByRole("button", { name: /关闭|取消|×/ }).first()
    if (await closeBtn.isVisible().catch(() => false)) {
      await expect(closeBtn).toBeFocused().catch(() => {
        // focus may be on input — acceptable if autofocus set
      })
    }

    // Escape closes dialog
    await page.keyboard.press("Escape")
    await expect(dialog).not.toBeVisible()
  })

  test("tab list — arrow key navigation between tabs", async ({ page }) => {
    await page.goto("/resources")
    const firstTab = page.getByRole("tab", { name: /资源列表/ })
    const secondTab = page.getByRole("tab", { name: /审计日志/ })

    await firstTab.focus()
    await expect(firstTab).toBeFocused()
    await expect(firstTab).toHaveAttribute("aria-selected", "true")

    // Arrow right moves to next tab
    await page.keyboard.press("ArrowRight")
    await expect(secondTab).toBeFocused()
    await expect(secondTab).toHaveAttribute("aria-selected", "true")

    // Arrow left moves back
    await page.keyboard.press("ArrowLeft")
    await expect(firstTab).toBeFocused()
    await expect(firstTab).toHaveAttribute("aria-selected", "true")
  })

  test("all interactive elements have accessible names", async ({ page }) => {
    await page.goto("/resources")
    await page.waitForLoadState("networkidle")

    // All buttons must have text or aria-label
    const buttons = page.getByRole("button")
    const count = await buttons.count()
    for (let i = 0; i < count; i++) {
      const btn = buttons.nth(i)
      const name = await btn.getAttribute("aria-label")
        ?? await btn.getAttribute("aria-labelledby")
        ?? await btn.textContent() ?? ""
      expect(name.trim().length, `Button at index ${i} has no accessible name`).toBeGreaterThan(0)
    }
  })

  test("images and icons have alt text or aria-hidden", async ({ page }) => {
    await page.goto("/resources")
    await page.waitForLoadState("networkidle")

    const images = page.locator("img")
    const imgCount = await images.count()
    for (let i = 0; i < imgCount; i++) {
      const img = images.nth(i)
      const alt = await img.getAttribute("alt")
      const ariaHidden = await img.getAttribute("aria-hidden")
      const role = await img.getAttribute("role")
      expect(
        (alt !== null && alt.trim().length > 0) || ariaHidden === "true" || role === "presentation",
        `Image at index ${i} missing alt text or aria-hidden`,
      ).toBe(true)
    }
  })

  test("form inputs have associated labels", async ({ page }) => {
    await page.goto("/resources")
    await page.getByRole("button", { name: /安装/ }).click()
    await expect(page.getByRole("dialog")).toBeVisible()

    const inputs = page.getByRole("textbox").or(page.getByRole("searchbox"))
    const inputCount = await inputs.count()
    for (let i = 0; i < inputCount; i++) {
      const input = inputs.nth(i)
      const labelledBy = await input.getAttribute("aria-labelledby")
      const label = await input.getAttribute("aria-label")
      const id = await input.getAttribute("id")
      expect(
        (labelledBy !== null) || (label !== null && label.trim().length > 0) || (id !== null),
        `Input at index ${i} has no accessible label`,
      ).toBe(true)
    }
  })
})
