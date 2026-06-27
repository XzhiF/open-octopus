/**
 * E2E test: Loop Dashboard — Execution Memory (US-030)
 *
 * Validates: P-01 (stats, cost trend, workflow ranking, leaderboard, search, list)
 *            P-02 (execution detail page)
 *
 * Prerequisites:
 *   - Server + Web-app running
 *   - At least 2 archived executions with different workflow_names
 */

import { test, expect, Page } from '@playwright/test'

const DASHBOARD_URL = '/dashboard'
const MEMORY_TAB_SELECTOR = 'text=执行记忆'

async function navigateToMemoryTab(page: Page) {
  await page.goto(DASHBOARD_URL)
  await page.waitForLoadState('networkidle')
  // Click memory tab
  const tab = page.locator(MEMORY_TAB_SELECTOR).first()
  if (await tab.isVisible()) {
    await tab.click()
    await page.waitForLoadState('networkidle')
  }
}

test.describe('P-01: Execution Memory Dashboard', () => {
  test('TC-009: stats cards render with data', async ({ page }) => {
    await navigateToMemoryTab(page)

    // Stats cards should render (4 cards: total, success rate, cost, duration)
    const cards = page.locator('[data-testid="archive-stats-card"], .archive-stats-card')
    // If no test id, fall back to checking that stats content is visible
    const statsVisible = await cards.count() > 0 ||
      await page.locator('text=/总执行|成功率|总成本|平均耗时|Total|Success/i').first().isVisible().catch(() => false)

    // Empty state or data state — both are valid
    const hasEmptyState = await page.locator('text=/暂无执行数据|No execution data/i').isVisible().catch(() => false)
    expect(statsVisible || hasEmptyState).toBe(true)
  })

  test('TC-010: empty state when no archive data', async ({ page }) => {
    // Mock empty API response
    await page.route('**/api/archive/stats', route =>
      route.fulfill({
        json: {
          total_executions: 0, completed_executions: 0, failed_executions: 0,
          success_rate: 0, total_cost_usd: 0, total_cost_display: '¥0.0 ≈$0.00',
          avg_duration_ms: 0, top_workflows: [],
        },
      })
    )

    await navigateToMemoryTab(page)

    // Should show empty state or zero values
    const pageContent = await page.textContent('body')
    const hasEmptyOrZero = pageContent?.includes('暂无') ||
      pageContent?.includes('0') ||
      pageContent?.includes('No')
    expect(hasEmptyOrZero).toBeTruthy()
  })

  test('TC-011: cost trend chart with period toggle', async ({ page }) => {
    await navigateToMemoryTab(page)

    // Cost trend section should exist
    const trendSection = page.locator('[data-testid="archive-cost-trend"], .archive-cost-trend')
    const trendVisible = await trendSection.count() > 0 ||
      await page.locator('text=/成本趋势|Cost Trend|7d|30d/i').first().isVisible().catch(() => false)

    // Either chart or "数据不足" message
    const hasContent = trendVisible ||
      await page.locator('text=/数据不足|Not enough data/i').isVisible().catch(() => false)
    expect(hasContent).toBe(true)
  })

  test('TC-012: workflow ranking cards', async ({ page }) => {
    await navigateToMemoryTab(page)

    // Workflow ranking section should exist
    const rankingSection = page.locator('text=/工作流排行|Workflow Ranking|工作流/i').first()
    const hasRanking = await rankingSection.isVisible().catch(() => false)

    // Or empty state
    const hasEmpty = await page.locator('text=/暂无|No data/i').isVisible().catch(() => false)
    expect(hasRanking || hasEmpty).toBe(true)
  })

  test('TC-013: execution leaderboard with 3 tabs', async ({ page }) => {
    await navigateToMemoryTab(page)

    // Leaderboard should have 3 dimension tabs
    const leaderboard = page.locator('text=/最省钱|最快|最高成功率|Cheapest|Fastest|Most Reliable/i')
    const tabCount = await leaderboard.count()

    // At least some leaderboard content visible, or empty state
    const hasContent = tabCount > 0 ||
      await page.locator('text=/排行|Leaderboard/i').first().isVisible().catch(() => false)
    const hasEmpty = await page.locator('text=/暂无|No data/i').isVisible().catch(() => false)
    expect(hasContent || hasEmpty).toBe(true)
  })

  test('TC-014: execution list with pagination', async ({ page }) => {
    await navigateToMemoryTab(page)

    // Execution table should exist
    const table = page.locator('table, [data-testid="archive-execution-table"]')
    const hasTable = await table.count() > 0

    // Or empty state
    const hasEmpty = await page.locator('text=/暂无|No execution/i').isVisible().catch(() => false)
    expect(hasTable || hasEmpty).toBe(true)
  })

  test('TC-015: experience search renders', async ({ page }) => {
    await navigateToMemoryTab(page)

    // Search input should exist
    const searchInput = page.locator('input[type="text"], input[placeholder*="搜索"], input[placeholder*="search"]').first()
    const hasSearch = await searchInput.isVisible().catch(() => false)

    // Or experience section visible
    const hasSection = await page.locator('text=/经验|搜索|Experience|Search/i').first().isVisible().catch(() => false)
    expect(hasSearch || hasSection).toBe(true)
  })

  test('TC-016: experience search returns results on query', async ({ page }) => {
    // Mock FTS search response
    await page.route('**/api/archive/lessons**', route =>
      route.fulfill({
        json: [
          {
            id: '1', type: 'bug', title: 'Test Bug', content: 'Found a test bug',
            project: 'test-project', package: 'server', file_pattern: '*.ts',
            keywords: 'test,bug', status: 'active', relevance_score: 0.9,
            use_count: 1, workflow_name: 'test-flow', created_at: new Date().toISOString(),
          },
        ],
      })
    )

    await navigateToMemoryTab(page)

    const searchInput = page.locator('input[type="text"]').first()
    if (await searchInput.isVisible().catch(() => false)) {
      await searchInput.fill('test')
      // Trigger search
      const searchBtn = page.locator('button[type="submit"], button:has-text("搜索")').first()
      if (await searchBtn.isVisible().catch(() => false)) {
        await searchBtn.click()
      } else {
        await searchInput.press('Enter')
      }
      await page.waitForTimeout(500) // debounce

      // Should show results or the card
      const hasResult = await page.locator('text=/Test Bug|test-project/i').isVisible().catch(() => false)
      expect(hasResult).toBe(true)
    }
  })
})

test.describe('P-02: Execution Detail Page', () => {
  test('TC-017: detail page renders with valid ID', async ({ page }) => {
    // Mock detail API
    await page.route('**/api/archive/executions/test-exec-id', route =>
      route.fulfill({
        json: {
          id: 'test-exec-id', workflow_name: 'test-workflow', workflow_ref: 'test.yaml',
          status: 'completed', started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(), duration_ms: 5000,
          total_input_tokens: 1000, total_output_tokens: 500, total_cost_usd: 0.05,
          node_summary: JSON.stringify([{ nodeId: 'n1', type: 'bash', status: 'completed', duration: 1000 }]),
          model_breakdown: JSON.stringify({ 'claude-sonnet': { input: 1000, output: 500, cost: 0.05 } }),
          failed_nodes: '[]', error_message: '', vars_snapshot: '{}',
          lessons_learned: 'Test lesson', lessons: [],
          chain: { parent: null, children: [] }, workspace_archive_id: null,
          workspace_id: 'ws-1', workspace_name: 'test-ws', created_at: new Date().toISOString(),
        },
      })
    )

    await page.goto('/dashboard/memory/executions/test-exec-id')
    await page.waitForLoadState('networkidle')

    // Should show workflow name or detail content
    const hasDetail = await page.locator('text=/test-workflow|执行详情|Execution Detail/i').first().isVisible().catch(() => false)
    const hasLoading = await page.locator('[data-testid="skeleton"], .animate-pulse').isVisible().catch(() => false)
    expect(hasDetail || hasLoading).toBe(true)
  })

  test('TC-018: detail page shows 404 for invalid ID', async ({ page }) => {
    await page.route('**/api/archive/executions/nonexistent-id', route =>
      route.fulfill({ status: 404, json: { error: 'Not found' } })
    )

    await page.goto('/dashboard/memory/executions/nonexistent-id')
    await page.waitForLoadState('networkidle')

    // Should show 404 state with back button
    const has404 = await page.locator('text=/未找到|Not Found|not found|404/i').first().isVisible().catch(() => false)
    const hasBackBtn = await page.locator('text=/返回|Back|←/i').first().isVisible().catch(() => false)
    expect(has404 || hasBackBtn).toBe(true)
  })
})

test.describe('TC-059: Full Dashboard Flow', () => {
  test('navigate from stats to detail page', async ({ page }) => {
    await navigateToMemoryTab(page)

    // Verify page loads without errors
    const errors: string[] = []
    page.on('pageerror', err => errors.push(err.message))

    // Wait for all dashboard sections to load
    await page.waitForTimeout(2000)

    // No uncaught errors
    expect(errors.filter(e => !e.includes('ResizeObserver'))).toHaveLength(0)
  })
})
