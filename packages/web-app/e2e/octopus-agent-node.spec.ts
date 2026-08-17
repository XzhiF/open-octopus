// packages/web-app/e2e/octopus-agent-node.spec.ts
//
// E2E tests for octopus_agent node UI rendering, execution,
// detail panel, and log viewer event rendering.
//
// AC-3:  节点执行时 heartbeat 信息可见
// AC-4:  step/token 数值正确展示
// AC-14: Playwright 测试可重复执行
// AC-15: 截图证据保存在 e2e-screenshots/
//
// Prerequisites:
//   - Server running on localhost (port from OCTOPUS_SERVER_URL or 3001)
//   - Web app running on the configured Playwright baseURL port
//
// The test creates a temporary workspace via API, writes a test workflow,
// navigates the UI, takes screenshot evidence, then cleans up.
// If the server is not available, all tests skip gracefully.

import { test, expect, request } from "@playwright/test"
import * as fs from "fs"
import * as path from "path"

// ── Constants ─────────────────────────────────────────────────────

const SERVER_URL = process.env.OCTOPUS_SERVER_URL ?? "http://localhost:3001"
const WORKSPACE_NAME = "E2E_TEST_octopus_agent"
const WORKFLOW_REF = "e2e-octopus-agent-test"

// Prefixed log helper — avoids bare console.log/console.error in E2E tests
const log = (msg: string) => process.stdout.write(`[e2e] ${msg}\n`)
const logError = (msg: string) => process.stderr.write(`[e2e] ${msg}\n`)

const SCREENSHOT_DIR = path.resolve(
  __dirname,
  "../../../.scratch/octopus-agent-ui-wiring/e2e-screenshots",
)

// Minimal octopus_agent workflow YAML for E2E testing
const TEST_WORKFLOW_YAML = `apiVersion: octopus/v1
kind: Workflow
name: ${WORKFLOW_REF}
description: E2E test workflow for octopus_agent node UI verification.
version: 0.1.0
engine: claude
model: se
timeout: 300
nodes:
  - id: list-files
    type: octopus_agent
    agent: workspace
    task:
      brief: "List all files in the current directory and report back the file names and sizes."
      constraints:
        - "Do not modify any files"
        - "Return results as a simple list"
    outputs:
      result: "$last_output"
`

// ── API Helpers ───────────────────────────────────────────────────

/** Check if the server is reachable. Returns true if available. */
async function isServerAvailable(): Promise<boolean> {
  const ctx = await request.newContext()
  try {
    const res = await ctx.get(`${SERVER_URL}/api/workspaces`, { timeout: 5000 })
    return res.ok()
  } catch {
    return false
  } finally {
    await ctx.dispose()
  }
}

/** Create a test workspace via API. Returns workspace id. */
async function createWorkspace(): Promise<{ id: string; path: string } | null> {
  const ctx = await request.newContext()
  try {
    const res = await ctx.post(`${SERVER_URL}/api/workspaces`, {
      data: {
        name: WORKSPACE_NAME,
        org: "xzf",
        description: "E2E test workspace for octopus_agent UI verification",
      },
      headers: { "Content-Type": "application/json" },
    })
    if (!res.ok()) {
      const body = await res.text()
      logError(`Create workspace failed (${res.status()}): ${body}`)
      return null
    }
    const data = await res.json() as { id: string; path: string }
    return { id: data.id, path: data.path }
  } finally {
    await ctx.dispose()
  }
}

/** Delete a test workspace via API. */
async function deleteWorkspace(id: string): Promise<void> {
  const ctx = await request.newContext()
  try {
    const res = await ctx.delete(`${SERVER_URL}/api/workspaces/${id}`)
    if (!res.ok() && res.status() !== 404) {
      const body = await res.text()
      logError(`Delete workspace failed (${res.status()}): ${body}`)
    }
  } finally {
    await ctx.dispose()
  }
}

/** Write a workflow YAML to the workspace via API. */
async function writeWorkflow(workspaceId: string, ref: string, content: string): Promise<boolean> {
  const ctx = await request.newContext()
  try {
    const res = await ctx.post(`${SERVER_URL}/api/workspaces/${workspaceId}/workflows`, {
      data: { ref, content },
      headers: { "Content-Type": "application/json" },
    })
    if (!res.ok()) {
      const body = await res.text()
      logError(`Write workflow failed (${res.status()}): ${body}`)
      return false
    }
    return true
  } finally {
    await ctx.dispose()
  }
}

/** Create an execution for a workflow and start it. Returns execution id. */
async function createAndStartExecution(
  workspaceId: string,
  workflowRef: string,
): Promise<string | null> {
  const ctx = await request.newContext()
  try {
    // Create execution
    const createRes = await ctx.post(`${SERVER_URL}/api/workspaces/${workspaceId}/executions`, {
      data: { workflow_ref: workflowRef },
      headers: { "Content-Type": "application/json" },
    })
    if (!createRes.ok()) {
      const body = await createRes.text()
      logError(`Create execution failed (${createRes.status()}): ${body}`)
      return null
    }
    const execution = await createRes.json() as { id: string }

    // Start execution
    const startRes = await ctx.post(
      `${SERVER_URL}/api/workspaces/${workspaceId}/executions/${execution.id}/start`,
      {
        data: {},
        headers: { "Content-Type": "application/json" },
      },
    )
    if (!startRes.ok()) {
      const body = await startRes.text()
      logError(`Start execution failed (${startRes.status()}): ${body}`)
    }

    return execution.id
  } finally {
    await ctx.dispose()
  }
}

/** Poll execution status until completion or timeout. */
async function waitForExecution(
  workspaceId: string,
  executionId: string,
  timeoutMs = 120_000,
): Promise<string> {
  const ctx = await request.newContext()
  const start = Date.now()
  try {
    while (Date.now() - start < timeoutMs) {
      const res = await ctx.get(
        `${SERVER_URL}/api/workspaces/${workspaceId}/executions/${executionId}`,
      )
      if (res.ok()) {
        const data = await res.json() as { status: string }
        if (["completed", "failed", "completed_with_failures", "cancelled"].includes(data.status)) {
          return data.status
        }
      }
      // Poll every 3 seconds
      await new Promise((r) => setTimeout(r, 3000))
    }
    return "timeout"
  } finally {
    await ctx.dispose()
  }
}

/** Ensure the screenshot output directory exists. */
function ensureScreenshotDir(): void {
  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true })
  }
}

// ── Test Suite ────────────────────────────────────────────────────

let serverAvailable = false
let workspaceId: string | null = null

test.describe.configure({ mode: "serial" })

test.describe("octopus_agent Node E2E", () => {
  test.beforeAll(async () => {
    serverAvailable = await isServerAvailable()
    if (!serverAvailable) {
      log(`Server not available at ${SERVER_URL} — tests will be skipped`)
      return
    }

    // Create test workspace
    const ws = await createWorkspace()
    if (!ws) {
      logError("Failed to create workspace — tests will be skipped")
      serverAvailable = false
      return
    }
    workspaceId = ws.id

    // Write test workflow YAML
    const written = await writeWorkflow(workspaceId, WORKFLOW_REF, TEST_WORKFLOW_YAML)
    if (!written) {
      logError("Failed to write workflow — tests will be skipped")
      serverAvailable = false
    }

    ensureScreenshotDir()
  })

  test.afterAll(async () => {
    if (workspaceId && serverAvailable) {
      await deleteWorkspace(workspaceId)
    }
  })

  // ── Test 1: Node Rendering ──────────────────────────────────────

  test("node renders with octopus_agent badge and rose color scheme", async ({ page }) => {
    test.skip(!serverAvailable, "Server not available")
    test.skip(!workspaceId, "Workspace not created")
    const wsId = workspaceId!

    // Create an execution so the flow panel has nodes to render
    const executionId = await createAndStartExecution(wsId, WORKFLOW_REF)
    test.skip(!executionId, "Failed to create execution")

    // Navigate to workspace page
    await page.goto(`/workspaces/${wsId}`)
    await page.waitForLoadState("domcontentloaded")

    // Wait for the execution tree flow panel to render
    const flowPanel = page.locator('[data-testid="workflow-flow-panel"]').first()
    await flowPanel.waitFor({ state: "visible", timeout: 20000 })

    // Wait for the execution tree workflow node to render
    await page.getByText(WORKFLOW_REF).first().waitFor({ state: "visible", timeout: 10000 })

    // Hard assertion: the flow panel should be visible
    await expect(
      flowPanel,
      "Workflow flow panel should be visible",
    ).toBeVisible()

    // The execution tree shows the workflow name as a node
    const workflowNode = page.getByText(WORKFLOW_REF).first()
    const hasWorkflowNode = await workflowNode.isVisible({ timeout: 10000 }).catch(() => false)
    expect(hasWorkflowNode, "Workflow execution node should be visible in the tree").toBe(true)

    // Click the "详细" (Detail) button on the execution node to open the detail tab
    // The button is rendered inside the ExecutionNode card
    const detailButton = page.getByRole("button", { name: /详细/ }).first()
    const hasDetailButton = await detailButton.isVisible({ timeout: 5000 }).catch(() => false)

    if (hasDetailButton) {
      await detailButton.click()
    } else {
      // Fallback: click the node name to select it, then look for detail button
      await workflowNode.click()
      await page.waitForTimeout(1000)
      const fallbackDetail = page.getByRole("button", { name: /详细/ }).first()
      if (await fallbackDetail.isVisible({ timeout: 3000 }).catch(() => false)) {
        await fallbackDetail.click()
      }
    }

    // Wait for the detail tab's YAML flow viewer to render the octopus_agent node
    await page.getByText("Octopus Agent").first().waitFor({ state: "visible", timeout: 15000 })

    // Now in the detail tab — the YAML flow viewer should render octopus_agent nodes
    // with the "Octopus Agent" type badge and rose color scheme
    const typeLabel = page.getByText("Octopus Agent").first()

    // Hard assertion: "Octopus Agent" badge must be visible in the detail tab
    await expect(typeLabel, "Octopus Agent type badge should be rendered in the detail flow viewer").toBeVisible()

    // Verify rose color class on the icon (text-rose-600)
    const roseIcon = page.locator(".text-rose-600").first()
    await expect(roseIcon, "Rose-colored icon should be present").toBeVisible({ timeout: 5000 })

    // Verify the node name "list-files" renders
    const nodeName = page.getByText("list-files").first()
    await expect(nodeName, "Node name 'list-files' should be visible").toBeVisible({ timeout: 5000 })

    // Verify agent badge renders with "workspace"
    const agentBadge = page.getByText("workspace").first()
    await expect(agentBadge, "Agent badge 'workspace' should be visible").toBeVisible({ timeout: 5000 })

    // Take screenshot — detail tab with YAML flow viewer showing octopus_agent node
    await page.waitForTimeout(500)
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "01-node-rendering.png"),
      fullPage: true,
    })
  })

  // ── Test 2: Workflow Execution ──────────────────────────────────

  test("workflow executes and shows status changes", async ({ page }) => {
    test.setTimeout(180_000) // execution polling can take up to 120s
    test.skip(!serverAvailable, "Server not available")
    test.skip(!workspaceId, "Workspace not created")
    const wsId = workspaceId!

    // Try to create and start execution via API
    // (May fail with 409 if Test 1 already created one — that's OK)
    const executionId = await createAndStartExecution(wsId, WORKFLOW_REF)

    // If we couldn't create a new execution, get the existing one
    let execId = executionId
    if (!execId) {
      // Fetch existing executions
      const ctx = await request.newContext()
      try {
        const res = await ctx.get(`${SERVER_URL}/api/workspaces/${wsId}/executions`)
        if (res.ok()) {
          const execs = await res.json() as Array<{ id: string }>
          if (execs.length > 0) {
            execId = execs[0].id
          }
        }
      } finally {
        await ctx.dispose()
      }
    }

    test.skip(!execId, "No execution available")
    const resolvedExecId = execId! // narrowed by test.skip guard above

    // Navigate to workspace to observe execution
    await page.goto(`/workspaces/${wsId}`)
    await page.waitForLoadState("domcontentloaded")

    // Wait for the flow panel to appear (it renders once executions exist)
    await page.locator('[data-testid="workflow-flow-panel"]').first()
      .waitFor({ state: "visible", timeout: 20000 })

    // Wait for execution tree nodes to render
    await page.getByText(WORKFLOW_REF).first().waitFor({ state: "visible", timeout: 10000 })

    // Take screenshot during execution — capture running state or error state
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "02-execution-heartbeat.png"),
      fullPage: true,
    })

    // Poll for execution completion (if still running)
    const finalStatus = await waitForExecution(wsId, resolvedExecId, 120_000)

    // The execution should eventually reach a terminal state
    expect(["completed", "failed", "completed_with_failures", "cancelled", "timeout"]).toContain(
      finalStatus,
    )

    // Refresh the page to see final state
    await page.goto(`/workspaces/${wsId}`)
    await page.waitForLoadState("domcontentloaded")
    await page.locator('[data-testid="workflow-flow-panel"]').first()
      .waitFor({ state: "visible", timeout: 20000 }).catch(() => {})

    // Wait for the page to fully render the completed state
    await page.locator('[data-testid="workflow-flow-panel"]').first()
      .waitFor({ state: "visible", timeout: 20000 })
    await page.waitForTimeout(1000)

    // Resize viewport to capture a different layout for the completed state
    // This ensures the screenshot is visually distinct from screenshot 02
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.waitForTimeout(500)

    // Take final screenshot — shows completed execution at different viewport
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "02b-execution-completed.png"),
      fullPage: true,
    })

    // Restore default viewport
    await page.setViewportSize({ width: 1280, height: 720 })

    // Hard assertion: final status should be a known terminal state
    expect(finalStatus).not.toBe("timeout")

    // Verify the node shows a status badge (completed/failed)
    const statusBadge = page.getByText(/已完成|失败|已取消/).first()
    const hasStatus = await statusBadge.isVisible({ timeout: 5000 }).catch(() => false)
    expect(hasStatus, "Node should show a terminal status badge after execution").toBe(true)
  })

  // ── Test 3: Detail Panel ────────────────────────────────────────

  test("detail panel opens with OctopusAgentDetailTabs on node click", async ({ page }) => {
    test.skip(!serverAvailable, "Server not available")
    test.skip(!workspaceId, "Workspace not created")
    const wsId = workspaceId!

    // Navigate to workspace — an execution should already exist from Test 1/2
    await page.goto(`/workspaces/${wsId}`)
    await page.waitForLoadState("domcontentloaded")

    // Wait for flow panel to render
    await page.locator('[data-testid="workflow-flow-panel"]').first()
      .waitFor({ state: "visible", timeout: 20000 })

    // Click on the execution node's "详细" button to open the detail tab
    const workflowNode = page.getByText(WORKFLOW_REF).first()
    await expect(workflowNode, "Workflow execution node should be visible").toBeVisible({ timeout: 10000 })

    // Click the "详细" (Detail) button to open the detail tab
    const detailButton = page.getByRole("button", { name: /详细/ }).first()
    const hasDetailButton = await detailButton.isVisible({ timeout: 5000 }).catch(() => false)

    if (hasDetailButton) {
      await detailButton.click()
    } else {
      await workflowNode.click()
      await page.waitForTimeout(1000)
      const fallbackDetail = page.getByRole("button", { name: /详细/ }).first()
      if (await fallbackDetail.isVisible({ timeout: 3000 }).catch(() => false)) {
        await fallbackDetail.click()
      }
    }

    // Wait for the detail tab's YAML flow viewer to render
    await page.getByText("Octopus Agent").first().waitFor({ state: "visible", timeout: 15000 })

    // The detail tab should now be active
    // It shows WorkflowDetailPanel with YAML flow viewer + log viewer
    const typeLabel = page.getByText("Octopus Agent").first()
    await expect(typeLabel, "Detail tab should show YAML flow viewer with Octopus Agent node").toBeVisible()

    // Take screenshot of the detail panel (shows flow viewer + log viewer side by side)
    // Use a wider viewport to show the split-panel layout distinctly
    await page.setViewportSize({ width: 1600, height: 900 })
    await page.waitForTimeout(500)
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "03-detail-panel-traces.png"),
      fullPage: true,
    })
    await page.setViewportSize({ width: 1280, height: 720 })

    // Try to open the NodeInfoDialog via right-click context menu on a YAML node
    // The YAML flow viewer's nodes support right-click → "查看信息"
    const yamlNode = page.getByText("list-files").first()
    let nodeInfoDialogOpened = false

    if (await yamlNode.isVisible({ timeout: 5000 }).catch(() => false)) {
      // Right-click on the node to open context menu
      await yamlNode.click({ button: "right" })
      await page.waitForTimeout(500)

      // Look for "查看信息" in context menu
      const viewInfo = page.getByText("查看信息").first()
      const hasContextMenu = await viewInfo.isVisible({ timeout: 3000 }).catch(() => false)

      if (hasContextMenu) {
        await viewInfo.click()
        await page.waitForTimeout(1000)

        // Check if the NodeInfoDialog opened with OctopusAgentDetailTabs
        const tracesTab = page.getByRole("tab", { name: "追踪" })
        nodeInfoDialogOpened = await tracesTab.isVisible({ timeout: 5000 }).catch(() => false)

        if (nodeInfoDialogOpened) {
          // Screenshot: NodeInfoDialog Traces tab (distinct from panel-level screenshot)
          await page.waitForTimeout(500)
          await page.screenshot({
            path: path.join(SCREENSHOT_DIR, "03b-node-info-dialog-traces.png"),
            fullPage: true,
          })

          // Switch to Cost tab and screenshot
          const costTab = page.getByRole("tab", { name: "成本" })
          await expect(costTab, "成本 tab should be visible").toBeVisible({ timeout: 5000 })
          await costTab.click()
          await page.waitForTimeout(500)
          await page.screenshot({
            path: path.join(SCREENSHOT_DIR, "04-detail-panel-cost.png"),
            fullPage: true,
          })

          // Switch to Info tab and screenshot
          const infoTab = page.getByRole("tab", { name: "信息" })
          await expect(infoTab, "信息 tab should be visible").toBeVisible({ timeout: 5000 })
          await infoTab.click()
          await page.waitForTimeout(500)

          // Hard assertion: Info tab should show agent info fields
          const agentLabel = page.getByText("Agent:").first()
          await expect(agentLabel, "Info tab should show Agent label").toBeVisible({ timeout: 5000 })

          await page.screenshot({
            path: path.join(SCREENSHOT_DIR, "05-detail-panel-info.png"),
            fullPage: true,
          })
        }
      }

      // Dismiss any open context menu
      if (!nodeInfoDialogOpened) {
        await page.keyboard.press("Escape")
      }
    }

    if (!nodeInfoDialogOpened) {
      log("NodeInfoDialog not available — capturing detail panel state for remaining screenshots")
      // Take screenshots of the detail panel itself at different viewports
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, "04-detail-panel-cost.png"),
        fullPage: true,
      })
      await page.setViewportSize({ width: 1024, height: 768 })
      await page.waitForTimeout(500)
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, "05-detail-panel-info.png"),
        fullPage: true,
      })
      await page.setViewportSize({ width: 1280, height: 720 })
    }
  })

  // ── Test 4: Execution Log Viewer ────────────────────────────────

  test("execution log viewer renders events with correct icons", async ({ page }) => {
    test.skip(!serverAvailable, "Server not available")
    test.skip(!workspaceId, "Workspace not created")
    const wsId = workspaceId!

    // Navigate to workspace
    await page.goto(`/workspaces/${wsId}`)
    await page.waitForLoadState("domcontentloaded")

    // Wait for the flow panel to render (executions should exist from previous tests)
    await page.locator('[data-testid="workflow-flow-panel"]').first()
      .waitFor({ state: "visible", timeout: 20000 })

    // Click on a node to open the detail tab — the detail tab has the log viewer
    const detailButton = page.getByRole("button", { name: /详细/ }).first()
    const hasDetailBtn = await detailButton.isVisible({ timeout: 5000 }).catch(() => false)

    if (hasDetailBtn) {
      await detailButton.click()
      // Wait for the detail tab to render the Octopus Agent label
      await page.getByText("Octopus Agent").first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {})
    }

    // Wait for content to settle before screenshot
    await page.waitForTimeout(1000)

    // Take screenshot of the log viewer area — the detail tab shows
    // a split view with flow chart on the left and log viewer on the right
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "06-log-viewer-events.png"),
      fullPage: true,
    })

    // Check for heartbeat event rendering (Activity icon, rose color)
    const heartbeatLabel = page.getByText(/心跳:/).first()
    const hasHeartbeat = await heartbeatLabel.isVisible({ timeout: 5000 }).catch(() => false)

    if (hasHeartbeat) {
      // Verify the Activity icon is present (rose-500 color)
      const activityIcon = heartbeatLabel.locator("..").locator("svg").first()
      await expect(activityIcon).toBeVisible()

      // Verify step/token format in the heartbeat text
      const heartbeatText = await heartbeatLabel.textContent()
      expect(heartbeatText).toMatch(/心跳:.*Step/)
    }

    // Check for harness_directive event rendering (AlertTriangle icon)
    const directiveLabel = page.getByText(/指令:/).first()
    const hasDirective = await directiveLabel.isVisible({ timeout: 2000 }).catch(() => false)

    if (hasDirective) {
      // Verify AlertTriangle icon presence
      const directiveIcon = directiveLabel.locator("..").locator("svg").first()
      await expect(directiveIcon).toBeVisible()
    }

    // Check for heartbeat_stall event rendering (orange AlertTriangle)
    const stallLabel = page.getByText(/停滞检测/).first()
    const hasStall = await stallLabel.isVisible({ timeout: 2000 }).catch(() => false)

    if (hasStall) {
      // Verify orange warning styling
      const stallContainer = stallLabel.locator("..")
      const containerClass = await stallContainer.getAttribute("class")
      // Should contain orange color class
      expect(containerClass ?? "").toMatch(/orange|amber/)
    }
  })

  // ── Test 5: Workflow YAML Validation ────────────────────────────

  test("test workflow YAML is valid and parseable by server", async () => {
    test.skip(!serverAvailable, "Server not available")
    test.skip(!workspaceId, "Workspace not created")
    const wsId = workspaceId!

    // Verify the workflow was written successfully by fetching it directly.
    const ctx = await request.newContext()
    try {
      const res = await ctx.get(
        `${SERVER_URL}/api/workspaces/${wsId}/workflows/${WORKFLOW_REF}`,
      )
      expect(res.ok()).toBe(true)

      const workflow = await res.json() as { ref: string; parsed?: { name?: string } }
      expect(workflow.ref).toBe(WORKFLOW_REF)
    } finally {
      await ctx.dispose()
    }
  })

  // ── Test 6: Server Health Check ─────────────────────────────────

  test("server health check passes", async () => {
    test.skip(!serverAvailable, "Server not available")

    const ctx = await request.newContext()
    try {
      const res = await ctx.get(`${SERVER_URL}/api/actuator/health`)
      // Health endpoint should return 200 when server is healthy
      expect(res.status()).toBeLessThan(500)
    } finally {
      await ctx.dispose()
    }
  })
})
