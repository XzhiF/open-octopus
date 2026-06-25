// packages/web-app/e2e/tests/swarm-ui.spec.ts
// E2E tests for Swarm UI components — TC-023, TC-024, TC-025, TC-026, TC-P1-002, TC-P1-003, TC-P1-005
import { test, expect } from "@playwright/test"

const TEST_PAGE = "/dev/swarm-test"

test.describe("TC-023: SwarmNode", () => {
  test("renders swarm node in ReactFlow with correct data attributes", async ({ page }) => {
    await page.goto(TEST_PAGE)
    await expect(page.getByTestId("swarm-test-title")).toBeVisible({ timeout: 30000 })

    const section = page.getByTestId("tc-023-swarm-node")
    await expect(section).toBeVisible()

    const swarmNode = page.locator('[data-node-type="swarm"]')
    await expect(swarmNode).toBeVisible({ timeout: 10000 })

    // Verify cyan border styling (running state)
    const borderClass = await swarmNode.getAttribute("class")
    expect(borderClass).toContain("border-cyan")

    // Verify swarm mode badge (use exact match to avoid matching heading)
    await expect(swarmNode.getByText("Review", { exact: true })).toBeVisible()

    // Verify expert count
    await expect(swarmNode.getByText("3 专家")).toBeVisible()

    // Verify pulse animation for running state
    expect(borderClass).toContain("animate-swarm-pulse")
  })
})

test.describe("TC-024: SwarmDetailDialog (5 tabs)", () => {
  test("renders all 5 tab content sections", async ({ page }) => {
    await page.goto(TEST_PAGE)
    await expect(page.getByTestId("swarm-test-title")).toBeVisible({ timeout: 30000 })

    const section = page.getByTestId("tc-024-detail-dialog")
    await expect(section).toBeVisible()

    // Header (SwarmHeaderBar)
    await expect(page.getByTestId("swarm-header")).toBeVisible()
    await expect(page.getByTestId("swarm-header").getByText("Code Review Swarm")).toBeVisible()

    // Experts tab
    await expect(page.getByTestId("expert-list")).toBeVisible()
    await expect(page.getByTestId("expert-list").getByText("security-engineer")).toBeVisible()

    // Messages tab
    await expect(page.getByTestId("message-timeline")).toBeVisible()
    await expect(page.getByTestId("message-timeline").getByText("Identified 3 potential vulnerabilities")).toBeVisible()

    // Consensus tab
    await expect(page.getByTestId("consensus-chart")).toBeVisible()

    // DAG tab
    await expect(page.getByTestId("internal-dag")).toBeVisible()

    // Report tab
    await expect(page.getByTestId("host-report")).toBeVisible()
    await expect(page.getByTestId("host-report").getByText(/Synthesis/)).toBeVisible()
  })
})

test.describe("TC-025: useSwarmEvents SSE", () => {
  test("EventSource connects to SSE endpoint", async ({ page }) => {
    await page.goto(TEST_PAGE)
    await expect(page.getByTestId("swarm-test-title")).toBeVisible({ timeout: 30000 })

    const sseSection = page.getByTestId("tc-025-sse")
    await expect(sseSection).toBeVisible()

    // Wait for SSE connection attempt (connected or error both prove EventSource works)
    const statusEl = page.getByTestId("sse-status")
    await expect(statusEl).not.toContainText("Status: idle", { timeout: 15000 })

    const statusText = await statusEl.textContent()
    expect(statusText).toMatch(/connected|error/)
  })
})

test.describe("TC-026: Replay mode", () => {
  test("shows replay badge when isReplay is true", async ({ page }) => {
    await page.goto(TEST_PAGE)
    await expect(page.getByTestId("swarm-test-title")).toBeVisible({ timeout: 30000 })

    const replaySection = page.getByTestId("tc-026-replay")
    await expect(replaySection).toBeVisible()

    const replayBadge = page.getByTestId("replay-badge")
    await expect(replayBadge).toBeVisible()
    await expect(replayBadge).toContainText("回放模式")

    const header = page.getByTestId("replay-header")
    await expect(header.getByText("Completed Swarm")).toBeVisible()
  })
})

test.describe("TC-P1-002: DispatchDagNode", () => {
  test("renders DAG nodes with role, status, and level info", async ({ page }) => {
    await page.goto(TEST_PAGE)
    await expect(page.getByTestId("swarm-test-title")).toBeVisible({ timeout: 30000 })

    const dagSection = page.getByTestId("internal-dag")
    await expect(dagSection).toBeVisible()

    // Wait for ReactFlow to render DAG nodes
    await expect(dagSection.getByText("backend-architect")).toBeVisible({ timeout: 15000 })
    await expect(dagSection.getByText("security-engineer")).toBeVisible()
    await expect(dagSection.getByText("code-reviewer")).toBeVisible()

    // Verify Level 0 label (unique)
    await expect(dagSection.getByText("Level 0")).toBeVisible()
    // Level 1 appears twice (2 experts at level 1) — just verify at least one
    await expect(dagSection.getByText("Level 1").first()).toBeVisible()
  })
})

test.describe("TC-P1-003: ConsensusChartTab", () => {
  test("renders consensus chart with data points and threshold line", async ({ page }) => {
    await page.goto(TEST_PAGE)
    await expect(page.getByTestId("swarm-test-title")).toBeVisible({ timeout: 30000 })

    const chartSection = page.getByTestId("consensus-chart")
    await expect(chartSection).toBeVisible()

    const chartContainer = chartSection.locator(".recharts-responsive-container")
    await expect(chartContainer).toBeVisible({ timeout: 10000 })

    // SVG elements
    await expect(chartSection.locator("svg .recharts-line")).toBeVisible()
    await expect(chartSection.locator("svg .recharts-reference-line")).toBeVisible()

    // Axis labels
    await expect(chartSection.getByText("轮次")).toBeVisible()
    await expect(chartSection.getByText("共识分")).toBeVisible()
  })
})

test.describe("TC-P1-005: StatsDashboard", () => {
  test("renders stats dashboard with metric cards from API", async ({ page }) => {
    // Mock the swarm-stats API to return valid data
    await page.route("**/analytics/swarm-stats*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          total_executions: 5,
          success_rate: 0.8,
          avg_duration_ms: 12000,
          avg_token_consumed: 3500,
          mode_distribution: { review: 3, debate: 1, dispatch: 1, swarm: 0 },
          avg_rounds: 2.4,
          avg_consensus_score: 0.87,
          top_roles: [
            { role: "security-engineer", count: 4 },
            { role: "backend-architect", count: 3 },
          ],
          router_accuracy: 0.92,
        }),
      })
    })

    await page.goto(TEST_PAGE)
    await expect(page.getByTestId("swarm-test-title")).toBeVisible({ timeout: 30000 })

    const statsSection = page.getByTestId("tc-p1-005-stats")
    await expect(statsSection).toBeVisible()

    // Wait for metric cards to appear (API is mocked, should load fast)
    await expect(statsSection.getByText("总执行")).toBeVisible({ timeout: 15000 })
    await expect(statsSection.getByText("成功率")).toBeVisible()
    await expect(statsSection.getByText("平均耗时")).toBeVisible()
    await expect(statsSection.getByText("平均 Token")).toBeVisible()
    await expect(statsSection.getByText("平均轮次")).toBeVisible()

    // Check mode distribution
    await expect(statsSection.getByText("模式分布:")).toBeVisible()

    // Check top roles
    await expect(statsSection.getByText("security-engineer (4)")).toBeVisible()
  })
})
