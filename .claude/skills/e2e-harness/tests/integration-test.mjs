/**
 * E2E Harness — Integration Test
 * Full lifecycle: health → workspace → workflow → execution → verify → screenshot → cleanup
 *
 * Run: node tests/integration-test.mjs
 * Requires: dev server running (pnpm dev), Playwright installed
 */

import { createResults, record, printReport, saveResults, exitWithResults } from "../lib/reporter.mjs"
import { healthCheck, resolveApiUrl, resolveWebUrl, fetchJSON } from "../lib/api.mjs"
import { createWorkspace, cleanupWorkspace, getWorkspace, listWorkspaces } from "../lib/workspace.mjs"
import { createWorkflow, createExecution, startExecution, pollExecution } from "../lib/execution.mjs"
import { launchBrowser, takeScreenshot, captureConsole, closeBrowser, navigateTo } from "../lib/browser.mjs"
import path from "node:path"

const results = createResults()

const WORKSPACE_NAME = "E2E_HARNESS_TEST_integration"
const WORKFLOW_REF = "E2E_HARNESS_TEST_simple.yaml"
const WORKFLOW_YAML = `apiVersion: octopus/v1
kind: Workflow
name: E2E_HARNESS_TEST_simple
nodes:
  - id: greet
    type: bash
    bash: echo "Hello from E2E Harness integration test!"
    outputs:
      greeting: "hello-harness"
  - id: process
    type: bash
    bash: echo "Processing complete"
    depends_on: [greet]
    outputs:
      result: "done"
`

const SCREENSHOT_DIR = path.join(import.meta.dirname || process.cwd(), "..", "e2e-screenshots")

async function main() {
  let workspaceId = ""
  let browser = null

  try {
    // ─── Step 1: Health Check ───────────────────────────────────
    console.log("\n--- Step 1: Health Check ---")
    const apiUrl = resolveApiUrl()
    const webUrl = resolveWebUrl()
    record(results, "Resolve URLs", true, `api=${apiUrl}, web=${webUrl}`)

    const healthy = await healthCheck()
    if (!healthy) {
      record(results, "Server health", false, "Server not reachable — abort")
      exitWithResults(results, { title: "Integration Test" })
    }
    record(results, "Server health", true, "API reachable")

    // ─── Step 2: Create Workspace ───────────────────────────────
    console.log("\n--- Step 2: Create Workspace ---")
    const ws = await createWorkspace(WORKSPACE_NAME, "xzf")
    workspaceId = ws.id
    record(results, "Create workspace", !!ws.id, `id=${ws.id}, name=${ws.name}`)

    // Verify workspace exists
    const wsDetail = await getWorkspace(ws.id)
    record(results, "Get workspace", wsDetail.id === ws.id, `name=${wsDetail.name}`)

    // ─── Step 3: Create Workflow ────────────────────────────────
    console.log("\n--- Step 3: Create Workflow ---")
    const wf = await createWorkflow(ws.id, WORKFLOW_REF, WORKFLOW_YAML)
    record(results, "Create workflow", !!wf, `ref=${WORKFLOW_REF}`)

    // ─── Step 4: Create & Start Execution ───────────────────────
    console.log("\n--- Step 4: Execute Workflow ---")
    const exec = await createExecution(ws.id, WORKFLOW_REF, "E2E_HARNESS_TEST_integration_exec")
    record(results, "Create execution", !!exec.id, `id=${exec.id}`)

    const started = await startExecution(ws.id, exec.id)
    record(results, "Start execution", started, "")

    // ─── Step 5: Poll for Completion ────────────────────────────
    console.log("\n--- Step 5: Poll for Completion ---")
    const detail = await pollExecution(ws.id, exec.id, 60000, 2000)
    const completed = detail.status === "completed"
    record(results, "Execution completed", completed, `status=${detail.status}`)

    // ─── Step 6: Verify Results ─────────────────────────────────
    console.log("\n--- Step 6: Verify Results ---")

    // Check that workspace is still accessible
    const wsAfter = await getWorkspace(ws.id)
    record(results, "Workspace still accessible", wsAfter.id === ws.id, "")

    // Check execution detail via API
    const execDetail = await fetchJSON(`/api/workspaces/${ws.id}/executions/${exec.id}`)
    record(results, "Fetch execution detail", execDetail.ok, `status=${execDetail.status}`)

    // ─── Step 7: Browser Screenshot ─────────────────────────────
    console.log("\n--- Step 7: Browser Screenshot ---")
    try {
      const launched = await launchBrowser({ headless: true })
      browser = launched.browser
      const page = launched.page

      const consoleCap = captureConsole(page)

      // Navigate to workspace detail page
      await navigateTo(page, `${webUrl}/workspaces/${ws.id}`, {
        waitForSelector: `[data-testid="workspace-detail"]`,
        timeout: 20000,
      })
      record(results, "Navigate to workspace", true, `url=${webUrl}/workspaces/${ws.id}`)

      // Wait for page to render
      await new Promise((r) => setTimeout(r, 3000))

      // Take screenshot of workspace page
      const ssPath = await takeScreenshot(page, "integration-workspace", SCREENSHOT_DIR)
      record(results, "Screenshot: workspace page", true, `path=${ssPath}`)

      // Check that key elements are present
      const tabBar = page.locator('[data-testid="tab-bar"]')
      const tabBarVisible = await tabBar.isVisible({ timeout: 5000 }).catch(() => false)
      record(results, "Tab bar visible", tabBarVisible, "")

      const wsHeader = page.locator('[data-testid="workspace-header"]')
      const headerVisible = await wsHeader.isVisible({ timeout: 5000 }).catch(() => false)
      record(results, "Workspace header visible", headerVisible, "")

      // Report console errors
      if (consoleCap.errors.length > 0) {
        record(results, "No console errors", false, `${consoleCap.errors.length} errors: ${consoleCap.errors[0]?.slice(0, 80)}`)
      } else {
        record(results, "No console errors", true, "clean")
      }

    } catch (err) {
      record(results, "Browser screenshot", false, err instanceof Error ? err.message : String(err))
    }

    // ─── Step 8: Cleanup ────────────────────────────────────────
    console.log("\n--- Step 8: Cleanup ---")
    const deleted = await cleanupWorkspace(ws.id)
    record(results, "Cleanup workspace", deleted, `deleted=${deleted}`)

    // Verify cleanup
    const wsList = await listWorkspaces()
    const gone = !wsList.some((w) => w.id === ws.id)
    record(results, "Workspace removed", gone, `remaining=${wsList.length}`)

    // ─── Step 9: Report ─────────────────────────────────────────
    console.log("\n--- Step 9: Report ---")
    const reportPath = path.join(SCREENSHOT_DIR, "..", "integration-results.json")
    saveResults(results, reportPath)
    record(results, "Save results", true, `path=${reportPath}`)

  } catch (err) {
    record(results, "Unexpected error", false, err instanceof Error ? err.message : String(err))
  } finally {
    if (browser) await closeBrowser(browser)
    if (workspaceId) {
      try { await cleanupWorkspace(workspaceId) } catch { /* ignore */ }
    }
    exitWithResults(results, { title: "E2E Harness Integration Test" })
  }
}

main()
