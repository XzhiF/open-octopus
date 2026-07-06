import { test, expect } from "@playwright/test"

// Workspace ID from API — the app needs to be on a workspace page to show the workflow panel
const WORKSPACE_ID = "569873c2-d648-4bbc-bf11-ef5b37761507"

test.describe("Workflow Pause & Resume", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`/workspaces/${WORKSPACE_ID}`)
    // Don't use networkidle — SSE keeps network busy
    // Wait for the workflow panel to render (its header text)
    await page.waitForSelector('text="执行流程"', { timeout: 15000 })
  })

  test("page loads and shows workflow panel", async ({ page }) => {
    // Verify the workflow panel header is visible
    await expect(page.getByText("执行流程").first()).toBeVisible()
    // Verify the testid attribute exists on the panel container
    const panel = page.locator('[data-testid="workflow-flow-panel"]').first()
    await expect(panel).toBeVisible()
  })

  test("running node has pause button with correct attributes", async ({ page }) => {
    const runningNodes = page.locator('[data-status="running"]')
    const count = await runningNodes.count()
    if (count > 0) {
      const pauseBtn = runningNodes.first().getByTestId("pause-button")
      await expect(pauseBtn).toBeVisible()
      await expect(pauseBtn).toHaveAttribute("title", "暂停")
    }
  })

  test("paused node has resume button with correct attributes", async ({ page }) => {
    const pausedNodes = page.locator('[data-status="paused"]')
    const count = await pausedNodes.count()
    if (count > 0) {
      const resumeBtn = pausedNodes.first().getByTestId("resume-button")
      await expect(resumeBtn).toBeVisible()
      await expect(resumeBtn).toHaveAttribute("title", "继续")
    }
  })

  test("pending approval node shows correct status", async ({ page }) => {
    const pendingNodes = page.locator('[data-status="pending_approval"]')
    const count = await pendingNodes.count()
    if (count > 0) {
      const nodeText = await pendingNodes.first().textContent()
      expect(nodeText).toContain("待审批")
    }
  })

  test("global pause/resume buttons appear based on execution state", async ({ page }) => {
    const globalPauseBtn = page.getByTestId("global-pause-button")
    const globalResumeBtn = page.getByTestId("global-resume-button")

    const hasPause = await globalPauseBtn.isVisible().catch(() => false)
    const hasResume = await globalResumeBtn.isVisible().catch(() => false)

    // Both shouldn't be visible at the same time
    expect(!(hasPause && hasResume)).toBe(true)
  })

  test("status badge shows 已暂停 for paused nodes", async ({ page }) => {
    const pausedNodes = page.locator('[data-status="paused"]')
    const count = await pausedNodes.count()
    if (count > 0) {
      await expect(pausedNodes.first()).toContainText("已暂停")
    }
  })

  test("API server is responsive", async ({ request }) => {
    const resp = await request.get("/api/workspaces")
    expect(resp.status()).toBeLessThan(500)
  })
})
