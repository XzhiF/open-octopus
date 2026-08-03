/**
 * E2E Harness Recipe — Full Lifecycle
 *
 * A complete, runnable template for end-to-end testing.
 * Copy this file and customize for your feature's E2E test.
 *
 * Run: node recipes/full-lifecycle.mjs
 * Requires: dev server running (pnpm dev), Playwright installed
 *
 * Lifecycle:
 *   1. Health check
 *   2. Create workspace
 *   3. Create workflow(s)
 *   4. Create + start execution
 *   5. Poll until completion
 *   6. Verify results (API + browser)
 *   7. Cleanup
 *   8. Print report
 */

import { createResults, record, printReport, saveResults, exitWithResults } from "../lib/reporter.mjs"
import { healthCheck, resolveApiUrl, resolveWebUrl } from "../lib/api.mjs"
import { createWorkspace, cleanupWorkspace } from "../lib/workspace.mjs"
import { createWorkflow, createExecution, startExecution, pollExecution } from "../lib/execution.mjs"
import { launchBrowser, takeScreenshot, captureConsole, closeBrowser, navigateTo, wait } from "../lib/browser.mjs"
import path from "node:path"

// ─── Configuration ───────────────────────────────────────────────
// Customize these for your feature:

const FEATURE_NAME = "my-feature"
const WORKSPACE_NAME = `E2E_HARNESS_TEST_${FEATURE_NAME}`

const WORKFLOWS = [
  {
    ref: `${FEATURE_NAME}-workflow.yaml`,
    yaml: `apiVersion: octopus/v1
kind: Workflow
name: ${FEATURE_NAME}-workflow
nodes:
  - id: step1
    type: bash
    bash: echo "Step 1: setup"
  - id: step2
    type: bash
    bash: echo "Step 2: process"
    depends_on: [step1]
    outputs:
      result: "success"
`,
  },
]

const SCREENSHOT_DIR = path.join(import.meta.dirname || process.cwd(), "..", "e2e-screenshots")

// ─── Main ────────────────────────────────────────────────────────

const results = createResults()

async function main() {
  let workspaceId = ""
  let browser = null

  try {
    // 1. Health check
    console.log("\n=== 1. Health Check ===")
    const apiUrl = resolveApiUrl()
    const webUrl = resolveWebUrl()

    if (!(await healthCheck())) {
      record(results, "Server health", false, `Cannot reach ${apiUrl}`)
      return
    }
    record(results, "Server health", true, `api=${apiUrl}`)

    // 2. Create workspace
    console.log("\n=== 2. Create Workspace ===")
    const ws = await createWorkspace(WORKSPACE_NAME, "xzf")
    workspaceId = ws.id
    record(results, "Create workspace", true, `id=${ws.id}`)

    // 3. Create workflows
    console.log("\n=== 3. Create Workflows ===")
    for (const wf of WORKFLOWS) {
      await createWorkflow(ws.id, wf.ref, wf.yaml)
      record(results, `Create workflow: ${wf.ref}`, true, "")
    }

    // 4. Create + start execution
    console.log("\n=== 4. Execute Workflow ===")
    const primaryRef = WORKFLOWS[WORKFLOWS.length - 1].ref
    const exec = await createExecution(ws.id, primaryRef, `E2E_HARNESS_TEST_${FEATURE_NAME}_exec`)
    record(results, "Create execution", true, `id=${exec.id}`)

    const started = await startExecution(ws.id, exec.id)
    record(results, "Start execution", started, "")

    // 5. Poll for completion
    console.log("\n=== 5. Poll ===")
    const detail = await pollExecution(ws.id, exec.id, 60000, 2000)
    record(results, "Execution finished", detail.status === "completed", `status=${detail.status}`)

    // 6. Browser verification
    console.log("\n=== 6. Browser Verification ===")
    const launched = await launchBrowser({ headless: true })
    browser = launched.browser
    const page = launched.page
    const consoleCapture = captureConsole(page)

    await navigateTo(page, `${webUrl}/workspaces/${ws.id}`, {
      waitForSelector: `[data-testid="workspace-detail"]`,
      timeout: 20000,
    })
    await wait(3000)

    await takeScreenshot(page, `${FEATURE_NAME}-workspace`, SCREENSHOT_DIR)
    record(results, "Screenshot captured", true, "")

    // Add your feature-specific browser assertions here:
    // e.g., check for specific UI elements, verify data rendering, etc.
    // record(results, "My assertion", condition, "detail")

    // Check console errors
    if (consoleCapture.errors.length > 0) {
      record(results, "Console errors", false, `${consoleCapture.errors.length} errors`)
    } else {
      record(results, "Console clean", true, "")
    }

    // 7. Cleanup
    console.log("\n=== 7. Cleanup ===")
    const deleted = await cleanupWorkspace(ws.id)
    record(results, "Cleanup workspace", deleted, "")

  } catch (err) {
    record(results, "Unexpected error", false, err instanceof Error ? err.message : String(err))
  } finally {
    if (browser) await closeBrowser(browser)
    if (workspaceId) {
      try { await cleanupWorkspace(workspaceId) } catch { /* ignore */ }
    }

    // 8. Report
    console.log("\n=== 8. Report ===")
    saveResults(results, path.join(SCREENSHOT_DIR, `${FEATURE_NAME}-results.json`))
    exitWithResults(results, { title: `${FEATURE_NAME} E2E Test` })
  }
}

main()
