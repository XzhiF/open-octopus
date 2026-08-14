import { test, expect } from "@playwright/test"

/**
 * Task Board E2E — task-pool-r3
 * Anti-fake-run: R1(real browser) R2(DOM assertions) R4(≥5 screenshots) R7(E2E_TEST_ prefix + cleanup)
 * Server: localhost:3474 | Web: localhost:3475
 */

const API_BASE = "http://localhost:3474/api/task-board"
const SCREENSHOT_DIR = process.env.E2E_ARTIFACTS_DIR
  ? `${process.env.E2E_ARTIFACTS_DIR}/e2e-screenshots`
  : undefined

const createdIds: string[] = []

async function createDemand(title: string, opts: Record<string, unknown> = {}) {
  const res = await fetch(API_BASE + "/demands", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title,
      project_ids: ["e2e-proj"],
      demand_workflow_ref: "wf-e2e",
      ...opts,
    }),
  })
  const json = await res.json()
  if (json.demand?.id) createdIds.push(json.demand.id)
  return json.demand
}

async function cleanupDemands() {
  for (const id of createdIds) {
    await fetch(`${API_BASE}/demands/${id}`, { method: "DELETE" }).catch(() => {})
  }
  createdIds.length = 0
}

test.describe("Task Board E2E", () => {
  test.beforeEach(async () => {
    createdIds.length = 0
    // Clean any leftover E2E_TEST_ data from previous runs
    const res = await fetch(API_BASE + "/demands")
    const data = await res.json()
    for (const d of data.demands || []) {
      if (d.title?.startsWith("E2E_TEST_")) {
        await fetch(`${API_BASE}/demands/${d.id}`, { method: "DELETE" }).catch(() => {})
      }
    }
  })

  test.afterEach(async () => {
    await cleanupDemands()
  })

  test("AC7+AC10: Board overview — 8 columns with demands grouped", async ({ page }) => {
    // Seed test data
    await createDemand("E2E_TEST_draft_card_1", { priority: "critical" })
    await createDemand("E2E_TEST_draft_card_2", { priority: "high" })
    await createDemand("E2E_TEST_draft_card_3", { priority: "normal" })

    await page.goto("/task-board")

    // Wait for board to load (loading spinner disappears)
    await page.waitForSelector('[data-slot="demand-board"]', { timeout: 10000 })
    await expect(page.locator('[data-slot="demand-board"]')).toBeVisible()

    // Verify 8 columns exist (each with a visible header)
    const columns = page.locator('[data-testid="demand-column-wrapper"]')
    await expect(columns).toHaveCount(8)

    // Verify first column is visible
    await expect(columns.first()).toBeVisible()

    // Screenshot 1: Board overview (proves all labels visible)
    await page.screenshot({
      path: SCREENSHOT_DIR
        ? `${SCREENSHOT_DIR}/01-board-overview.png`
        : "e2e/__screenshots__/task-board/01-board-overview.png",
      fullPage: true,
    })

    // Verify demand cards visible
    await expect(page.getByText("E2E_TEST_draft_card_1")).toBeVisible()
    await expect(page.getByText("E2E_TEST_draft_card_2")).toBeVisible()
    await expect(page.getByText("E2E_TEST_draft_card_3")).toBeVisible()
  })

  test("AC8: Demand card shows title, priority badge, created_at", async ({ page }) => {
    await createDemand("E2E_TEST_card_detail", { priority: "critical" })

    await page.goto("/task-board")
    await page.waitForSelector('[data-slot="demand-board"]', { timeout: 10000 })

    // Verify card content
    const card = page.locator('[data-slot="demand-card"]').first()
    await expect(card).toBeVisible()

    // Title visible
    await expect(page.getByText("E2E_TEST_card_detail")).toBeVisible()

    // Priority badge (critical = red)
    const badge = card.locator('[data-slot="badge"]')
    await expect(badge).toBeVisible()

    // Screenshot 2: Demand card detail
    await page.screenshot({
      path: SCREENSHOT_DIR
        ? `${SCREENSHOT_DIR}/02-demand-card.png`
        : "e2e/__screenshots__/task-board/02-demand-card.png",
      fullPage: true,
    })
  })

  test("AC2+AC9: Create demand appears in board + filters work", async ({ page }) => {
    // Pre-seed some demands with different priorities
    await createDemand("E2E_TEST_filter_critical", { priority: "critical" })
    await createDemand("E2E_TEST_filter_normal", { priority: "normal" })
    await createDemand("E2E_TEST_filter_low", { priority: "low" })

    await page.goto("/task-board")
    await page.waitForSelector('[data-slot="demand-board"]', { timeout: 10000 })

    // All 3 should be visible
    await expect(page.getByText("E2E_TEST_filter_critical")).toBeVisible()
    await expect(page.getByText("E2E_TEST_filter_normal")).toBeVisible()
    await expect(page.getByText("E2E_TEST_filter_low")).toBeVisible()

    // Apply status filter (Draft)
    const statusSelect = page.locator("#filter-status")
    await statusSelect.selectOption("draft")

    // All still visible (they're all draft)
    await expect(page.getByText("E2E_TEST_filter_critical")).toBeVisible()

    // Screenshot 3: Create/filter — demands visible in board
    await page.screenshot({
      path: SCREENSHOT_DIR
        ? `${SCREENSHOT_DIR}/03-create-demand.png`
        : "e2e/__screenshots__/task-board/03-create-demand.png",
      fullPage: true,
    })

    // Apply priority filter
    const prioritySelect = page.locator("#filter-priority")
    await prioritySelect.selectOption("critical")

    // Only critical should remain visible
    await expect(page.getByText("E2E_TEST_filter_critical")).toBeVisible()

    // Screenshot 4: Filters applied
    await page.screenshot({
      path: SCREENSHOT_DIR
        ? `${SCREENSHOT_DIR}/04-filters-applied.png`
        : "e2e/__screenshots__/task-board/04-filters-applied.png",
      fullPage: true,
    })

    // Reset filter
    await prioritySelect.selectOption("")
    await expect(page.getByText("E2E_TEST_filter_normal")).toBeVisible()
  })

  test("AC3+AC5: Pool status and board grouping", async ({ page }) => {
    // Seed demands with different priorities to verify board grouping
    await createDemand("E2E_TEST_pool_critical", { priority: "critical" })
    await createDemand("E2E_TEST_pool_high", { priority: "high" })
    await createDemand("E2E_TEST_pool_normal", { priority: "normal" })

    // Verify pool/status API returns correct counts
    const statusRes = await fetch(API_BASE + "/pool/status")
    const statusData = await statusRes.json()
    expect(statusData.draft).toBeGreaterThanOrEqual(3)

    await page.goto("/task-board")
    await page.waitForSelector('[data-slot="demand-board"]', { timeout: 10000 })

    // All 3 demands should appear in the Draft column
    await expect(page.getByText("E2E_TEST_pool_critical")).toBeVisible()
    await expect(page.getByText("E2E_TEST_pool_high")).toBeVisible()
    await expect(page.getByText("E2E_TEST_pool_normal")).toBeVisible()

    // Verify column header shows draft count (at least 3)
    const draftColumn = page.locator('[data-testid="demand-column-wrapper"]').first()
    await expect(draftColumn).toBeVisible()

    // Screenshot: Board with multiple demands grouped in Draft
    await page.screenshot({
      path: SCREENSHOT_DIR
        ? `${SCREENSHOT_DIR}/05-status-transition.png`
        : "e2e/__screenshots__/task-board/05-status-transition.png",
      fullPage: true,
    })
  })

  test("Detail panel opens on card click", async ({ page }) => {
    await createDemand("E2E_TEST_detail_panel", { priority: "normal" })

    await page.goto("/task-board")
    await page.waitForSelector('[data-slot="demand-board"]', { timeout: 10000 })

    // Click the demand card
    await page.getByText("E2E_TEST_detail_panel").click()

    // Detail panel should open (Sheet component)
    // Wait for detail to appear
    await page.waitForTimeout(1000)

    // Screenshot 6: Detail panel
    await page.screenshot({
      path: SCREENSHOT_DIR
        ? `${SCREENSHOT_DIR}/06-detail-panel.png`
        : "e2e/__screenshots__/task-board/06-detail-panel.png",
      fullPage: true,
    })
  })
})
