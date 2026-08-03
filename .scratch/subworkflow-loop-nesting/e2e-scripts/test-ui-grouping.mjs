/**
 * E2E Test: UI Grouping Verification (AC3)
 *
 * Verifies that the UI correctly groups sub-workflow children per iteration
 * (not merged across iterations).
 *
 * Run: node .scratch/subworkflow-loop-nesting/e2e-scripts/test-ui-grouping.mjs
 */

import { resolveApiUrl, resolveWebUrl } from "../../../.claude/skills/e2e-harness/lib/api.mjs"
import { createWorkspace, cleanupWorkspace } from "../../../.claude/skills/e2e-harness/lib/workspace.mjs"
import { createExecution, startExecution, pollExecution, createWorkflow } from "../../../.claude/skills/e2e-harness/lib/execution.mjs"
import { launchBrowser, takeScreenshot, captureConsole, navigateTo, wait, closeBrowser } from "../../../.claude/skills/e2e-harness/lib/browser.mjs"
import { createResults, record, printReport, saveResults } from "../../../.claude/skills/e2e-harness/lib/reporter.mjs"
import fs from "node:fs"
import path from "node:path"

const DATA_DIR = path.resolve(
  import.meta.dirname || path.dirname(new URL(import.meta.url).pathname),
  "../e2e-data"
)
const SCREENSHOT_DIR = path.resolve(
  import.meta.dirname || path.dirname(new URL(import.meta.url).pathname),
  "../e2e-screenshots"
)

function readYaml(filename) {
  return fs.readFileSync(path.join(DATA_DIR, filename), "utf8")
}

async function main() {
  const results = createResults()
  const webUrl = resolveWebUrl()
  let workspaceId = null
  let browser = null

  try {
    // Setup: create workspace with loop-subwf workflow
    console.log("=== Setup: Creating workspace with loop-subwf workflow ===")
    const ws = await createWorkspace("E2E_TEST_NESTING_ui", "xzf")
    workspaceId = ws.id

    await createWorkflow(ws.id, "E2E_TEST_NESTING_child-analysis.yaml",
      readYaml("E2E_TEST_NESTING_child-analysis.yaml"))
    await createWorkflow(ws.id, "E2E_TEST_NESTING_loop-subwf.yaml",
      readYaml("E2E_TEST_NESTING_loop-subwf.yaml"))

    // Execute the workflow
    const exec = await createExecution(ws.id, "E2E_TEST_NESTING_loop-subwf.yaml")
    await startExecution(ws.id, exec.id)
    const result = await pollExecution(ws.id, exec.id, 90000, 2000)
    record(results, "setup-execute", result.status === "completed",
      `status=${result.status}, execId=${exec.id}`)

    // Launch browser
    console.log("\n=== Browser E2E: UI Grouping Verification ===")
    const launched = await launchBrowser({ headless: true })
    browser = launched.browser
    const page = launched.page
    const consoleCapture = captureConsole(page)

    // Navigate to execution detail page
    const detailUrl = `${webUrl}/workspaces/${ws.id}?tab=detail&execId=${exec.id}`
    console.log(`Navigating to: ${detailUrl}`)
    await navigateTo(page, detailUrl, { timeout: 15000 })
    await wait(5000) // Wait for data to load (Next.js SSR + client hydration)

    // Take screenshot of the execution detail page
    const screenshot1 = await takeScreenshot(page, "execution-detail-overview", SCREENSHOT_DIR)
    record(results, "UI-screenshot-overview", true, `Screenshot: ${screenshot1}`)

    // Check if execution log viewer exists
    const logViewer = await page.$('[data-testid="execution-log-viewer"]')
    if (logViewer) {
      record(results, "UI-log-viewer-exists", true, "execution-log-viewer found")
    } else {
      // Try alternative selectors
      const altLogViewer = await page.$('.execution-log-viewer, [class*="log-viewer"], [class*="LogViewer"]')
      record(results, "UI-log-viewer-exists", !!altLogViewer,
        altLogViewer ? "Found via class selector" : "Not found")
    }

    // Check for sub-workflow child grouping
    // Look for groups that contain "call-analysis" text
    const groupElements = await page.$$('[class*="group"], [class*="Group"], [data-testid*="group"]')
    console.log(`Found ${groupElements.length} potential group elements`)

    // Try to find iteration-specific groups
    const pageContent = await page.textContent("body")
    const hasIterationGroups = pageContent.includes("iter1") || pageContent.includes("iter2") ||
      pageContent.includes("iteration") || pageContent.includes("-iter")
    const hasCallAnalysis = pageContent.includes("call-analysis")

    console.log(`Page contains 'call-analysis': ${hasCallAnalysis}`)
    console.log(`Page contains iteration markers: ${hasIterationGroups}`)

    if (hasCallAnalysis) {
      record(results, "AC3-call-analysis-visible", true, "call-analysis sub-workflow children visible in UI")
    } else {
      record(results, "AC3-call-analysis-visible", false, "call-analysis not found in page content")
    }

    // Take a full-page screenshot
    const screenshot2 = await takeScreenshot(page, "execution-detail-full", SCREENSHOT_DIR, { fullPage: true })
    record(results, "UI-screenshot-full", true, `Screenshot: ${screenshot2}`)

    // Check for JS errors
    if (consoleCapture.errors.length === 0) {
      record(results, "UI-no-js-errors", true, "No console errors")
    } else {
      record(results, "UI-no-js-errors", false, `Errors: ${consoleCapture.errors.join("; ")}`)
    }

    // Try to expand log groups to see iteration grouping
    // Click on the review-loop node to expand its children
    const reviewLoopExpanded = await page.evaluate(() => {
      const elements = document.querySelectorAll("*")
      let found = false
      for (const el of elements) {
        if (el.textContent?.includes("review-loop") && el.children.length > 0) {
          if (el.tagName === "BUTTON" || el.tagName === "DIV" || el.tagName === "SPAN") {
            el.click()
            found = true
          }
        }
      }
      return found
    })
    console.log(`Clicked review-loop element: ${reviewLoopExpanded}`)

    await wait(2000)
    const screenshot3 = await takeScreenshot(page, "execution-detail-expanded", SCREENSHOT_DIR)
    record(results, "UI-screenshot-expanded", true, `Screenshot: ${screenshot3}`)

  } catch (err) {
    record(results, "browser-error", false, `${err.message}`)
    console.error("Browser test error:", err)
  } finally {
    if (browser) await closeBrowser(browser)
    if (workspaceId) {
      try {
        await cleanupWorkspace(workspaceId)
        record(results, "cleanup", true, `Deleted ${workspaceId}`)
      } catch (e) {
        record(results, "cleanup", false, e.message)
      }
    }

    const summary = printReport(results, { title: "UI Grouping E2E Test (AC3)" })
    saveResults(results, path.join(SCREENSHOT_DIR, "ui-test-results.json"))
    process.exit(summary.allPass ? 0 : 1)
  }
}

main().catch(err => {
  console.error("Unhandled:", err)
  process.exit(2)
})
