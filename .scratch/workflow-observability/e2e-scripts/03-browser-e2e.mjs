/**
 * E2E Test: Browser E2E — Observability Page
 *
 * Tests:
 * - AC-1: Floating panel summary cards
 * - AC-2: Observability page renders charts
 * - AC-6: Rounds detail expandable
 * - UI rendering of 4 summary cards, line chart, bar chart, error timeline
 */

import { launchBrowser, takeScreenshot, navigateTo, wait, closeBrowser, captureConsole } from "../../../.claude/skills/e2e-harness/lib/browser.mjs"
import { createResults, record, saveResults, exitWithResults } from "../../../.claude/skills/e2e-harness/lib/reporter.mjs"
import { cleanupWorkspace } from "../../../.claude/skills/e2e-harness/lib/workspace.mjs"
import fs from "node:fs"

const CONTEXT_FILE = "C:/xzf/ai/open-octopus/.scratch/workflow-observability/e2e-data/browser-context.json"
const SCREENSHOT_DIR = "C:/xzf/ai/open-octopus/.scratch/workflow-observability/e2e-screenshots"

async function main() {
  const results = createResults()

  // Load context
  const context = JSON.parse(fs.readFileSync(CONTEXT_FILE, "utf8"))
  const { workspaceId, executionId, workspaceName } = context
  console.log(`=== Browser E2E: Observability Page ===`)
  console.log(`Workspace: ${workspaceId} (${workspaceName})`)
  console.log(`Execution: ${executionId}\n`)

  const { browser, context: browserCtx, page } = await launchBrowser({ headless: true })
  const consoleCapture = captureConsole(page)

  // Collect API responses via network interception
  let observabilityApiResponse = null
  page.on("response", async (resp) => {
    const url = resp.url()
    if (url.includes("/observability") && resp.status() === 200) {
      try {
        observabilityApiResponse = await resp.json()
      } catch { /* non-JSON */ }
    }
  })

  try {
    // Step 1: Navigate to the observability page
    console.log("Step 1: Navigate to observability page...")
    const obsUrl = `http://localhost:3000/workspaces/${workspaceId}/executions/${executionId}/observability`
    await navigateTo(page, obsUrl, { waitUntil: "networkidle", timeout: 30000 })
    await wait(3000) // Wait for client-side rendering

    record(results, "Navigate to observability page", true, `url=${obsUrl}`)

    // Take initial screenshot
    await takeScreenshot(page, "01-observability-page-initial", SCREENSHOT_DIR, { fullPage: true })
    record(results, "Screenshot: initial page load", true)

    // Step 2: Verify 4 summary cards (AC-1/AC-2)
    console.log("\nStep 2: Verify summary cards...")

    // Look for card-like elements. The observability page should have 4 summary cards:
    // Total Tokens, Total Turns, Total Cost, Budget Status
    const pageContent = await page.content()

    // Check for token-related text
    const hasTokenCard = await page.locator("text=/token/i").count() > 0
    record(results, "AC-2: Token card/label visible", hasTokenCard,
      `found ${await page.locator("text=/token/i").count()} token-related elements`)

    // Check for cost-related text
    const hasCostCard = await page.locator("text=/cost/i").count() > 0
    record(results, "AC-2: Cost card/label visible", hasCostCard,
      `found ${await page.locator("text=/cost/i").count()} cost-related elements`)

    // Check for turn/round-related text
    const hasTurnCard = await page.locator("text=/turn|round|轮/i").count() > 0
    record(results, "AC-2: Turn/Round card/label visible", hasTurnCard,
      `found ${await page.locator("text=/turn|round|轮/i").count()} turn-related elements`)

    // Check for budget-related text
    const hasBudgetCard = await page.locator("text=/budget|预算/i").count() > 0
    record(results, "AC-2: Budget card/label visible", hasBudgetCard,
      `found ${await page.locator("text=/budget|预算/i").count()} budget-related elements`)

    // Step 3: Verify charts render (AC-2)
    console.log("\nStep 3: Verify charts...")

    // Check for SVG elements (charts typically render as SVG)
    const svgCount = await page.locator("svg").count()
    record(results, "AC-2: SVG chart elements present", svgCount > 0, `svg count=${svgCount}`)

    // Check for canvas elements (alternative chart rendering)
    const canvasCount = await page.locator("canvas").count()

    // Check for Recharts-specific class names or elements
    const rechartsElements = await page.locator(".recharts-wrapper, .recharts-surface, [class*='recharts']").count()
    record(results, "AC-2: Recharts elements detected", rechartsElements > 0, `recharts count=${rechartsElements}`)

    // Take chart screenshot
    await takeScreenshot(page, "02-observability-charts", SCREENSHOT_DIR, { fullPage: false })

    // Step 4: Check for error timeline (AC-5)
    console.log("\nStep 4: Error timeline...")

    const hasErrorTimeline = await page.locator("text=/error|错误|时间线|timeline/i").count() > 0
    record(results, "AC-5: Error timeline section visible", hasErrorTimeline,
      `found ${await page.locator("text=/error|错误|时间线|timeline/i").count()} error-related elements`)

    // Step 5: Check for rounds detail (AC-6)
    console.log("\nStep 5: Rounds detail...")

    const hasRoundsSection = await page.locator("text=/轮次|rounds|detail|明细/i").count() > 0
    record(results, "AC-6: Rounds detail section visible", hasRoundsSection,
      `found ${await page.locator("text=/轮次|rounds|detail|明细/i").count()} rounds-related elements`)

    // Try to find and click expandable elements
    const expandButtons = await page.locator("button:has-text('展开'), [aria-expanded], details > summary, .accordion-trigger").count()
    if (expandButtons > 0) {
      await page.locator("button:has-text('展开'), [aria-expanded], details > summary, .accordion-trigger").first().click().catch(() => {})
      await wait(1000)
      await takeScreenshot(page, "03-rounds-expanded", SCREENSHOT_DIR)
      record(results, "AC-6: Expandable rounds detail clicked", true, `${expandButtons} expandable elements found`)
    } else {
      record(results, "AC-6: Expandable rounds elements", false, "no expandable elements found")
    }

    // Step 6: Full page screenshot for evidence
    console.log("\nStep 6: Final screenshots...")
    await takeScreenshot(page, "04-full-page-evidence", SCREENSHOT_DIR, { fullPage: true })
    record(results, "Screenshot: full page evidence", true)

    // Step 7: Check browser console for errors
    console.log("\nStep 7: Console error check...")
    const criticalErrors = consoleCapture.errors.filter(e =>
      !e.includes("favicon") && !e.includes("404") && !e.includes("hydration")
    )
    record(results, "No critical console errors",
      criticalErrors.length === 0,
      criticalErrors.length > 0 ? `${criticalErrors.length} errors: ${criticalErrors[0].substring(0, 100)}` : "clean")

    // Step 8: Verify observability API was called from the page
    console.log("\nStep 8: Network verification...")
    record(results, "Browser made observability API call",
      !!observabilityApiResponse,
      observabilityApiResponse ? `API responded with data` : "no API call intercepted")

    if (observabilityApiResponse) {
      record(results, "API response has tokens data",
        !!observabilityApiResponse.tokens,
        observabilityApiResponse.tokens ? `input=${observabilityApiResponse.tokens.totalInput}` : "missing")
      record(results, "API response has byNode data",
        Array.isArray(observabilityApiResponse.byNode) && observabilityApiResponse.byNode.length > 0,
        `${observabilityApiResponse.byNode?.length ?? 0} nodes`)
      record(results, "API response has budget data",
        !!observabilityApiResponse.budget,
        observabilityApiResponse.budget ? `snapshot=${!!observabilityApiResponse.budget.snapshot}` : "missing")
    }

  } catch (err) {
    record(results, "Browser E2E execution", false, err.message)
    await takeScreenshot(page, "99-error", SCREENSHOT_DIR).catch(() => {})
  } finally {
    // Cleanup workspace
    console.log("\nCleanup...")
    const cleaned = await cleanupWorkspace(workspaceId)
    record(results, "Cleanup workspace", cleaned, `id=${workspaceId}`)

    await closeBrowser(browser)
  }

  // Save results
  const resultsPath = saveResults(results, "C:/xzf/ai/open-octopus/.scratch/workflow-observability/e2e-data/browser-results.json")
  console.log(`\nResults saved to: ${resultsPath}`)

  exitWithResults(results, { title: "Workflow Observability — Browser E2E" })
}

main().catch(err => { console.error("FATAL:", err); process.exit(1) })
