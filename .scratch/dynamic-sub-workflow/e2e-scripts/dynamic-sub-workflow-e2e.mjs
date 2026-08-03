// E2E test for dynamic_sub_workflow node
// Tests: schema validation, UI rendering (Dynamic badge), file persistence
//
import { chromium } from "playwright"
import { writeFileSync, mkdirSync, existsSync } from "fs"
import { join } from "path"

const API = "http://localhost:3001"
const WEB = "http://localhost:3000"
const SCREENSHOT_DIR = join(import.meta.dirname, "..", "e2e-screenshots")
const WS_NAME = "E2E_TEST_DYNAMIC_dsw"
const WF_NAME = "E2E_TEST_DYNAMIC_parent"
const GENERATED_WF_NAME = "E2E_TEST_DYNAMIC_parent__plan-tasks"

const PARENT_WF_YAML = `apiVersion: octopus/v1
kind: Workflow
name: ${WF_NAME}
nodes:
  - id: prepare
    type: bash
    bash: echo "preparing tickets"
    outputs:
      tickets: "ticket-1,ticket-2,ticket-3"
  - id: plan-tasks
    type: dynamic_sub_workflow
    workflow: ${GENERATED_WF_NAME}
    prompt: |
      Analyze the tickets and plan execution DAG.
    depends_on: [prepare]
`

const GENERATED_DAG_YAML = `apiVersion: octopus/v1
kind: Workflow
name: ${GENERATED_WF_NAME}
nodes:
  - id: task-a
    type: agent
    prompt: "Execute task A: frontend login page"
  - id: task-b
    type: agent
    prompt: "Execute task B: backend auth API"
  - id: task-c
    type: agent
    prompt: "Execute task C: integration testing"
    depends_on: [task-a, task-b]
`

const GENERATED_META = JSON.stringify({
  generated_at: new Date().toISOString(),
  input_hash: "e2e-test-preseeded-hash",
  input_snapshot: { tickets: "ticket-1,ticket-2,ticket-3" },
  validation_rounds: 1,
  execution_status: "pending",
  node_count: 3,
}, null, 2)

const results = []
function record(step, pass, detail) {
  results.push({ step, pass, detail })
  console.log(`${pass ? "PASS" : "FAIL"} | ${step} | ${detail}`)
}

async function main() {
  let workspaceId = ""
  let browser = null

  try {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })

    // ── Step 1: Create workspace ──────────────────────
    console.log("\n=== Step 1: Create workspace ===")
    const wsRes = await fetch(`${API}/api/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: WS_NAME, org: "xzf" }),
    })
    if (!wsRes.ok) {
      // May already exist
      const listRes = await fetch(`${API}/api/workspaces`)
      const list = await listRes.json()
      const existing = list.find(w => w.name === WS_NAME)
      if (existing) {
        workspaceId = existing.id
        record("create-workspace", true, `Already exists: ${workspaceId}`)
      } else {
        record("create-workspace", false, `HTTP ${wsRes.status}`)
        return
      }
    } else {
      const ws = await wsRes.json()
      workspaceId = ws.id
      record("create-workspace", true, `Created: ${workspaceId}`)
    }

    // ── Step 2: Create parent workflow ────────────────
    console.log("\n=== Step 2: Create parent workflow ===")
    const wfRes = await fetch(`${API}/api/workspaces/${workspaceId}/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: WF_NAME, content: PARENT_WF_YAML }),
    })
    record("create-parent-workflow", wfRes.ok, `HTTP ${wfRes.status}`)

    // ── Step 3: Pre-seed generated DAG files ─────────
    console.log("\n=== Step 3: Pre-seed generated DAG ===")
    // Get workspace path
    const wsDetailRes = await fetch(`${API}/api/workspaces/${workspaceId}`)
    const wsDetail = await wsDetailRes.json()
    const wsPath = wsDetail.path || wsDetail.workspacePath
    if (wsPath) {
      const workflowsDir = join(wsPath, "workflows")
      mkdirSync(workflowsDir, { recursive: true })
      writeFileSync(join(workflowsDir, `${GENERATED_WF_NAME}.yaml`), GENERATED_DAG_YAML)
      writeFileSync(join(workflowsDir, `${GENERATED_WF_NAME}.meta.json`), GENERATED_META)
      record("preseed-dag-files", true, `Written to ${workflowsDir}`)
    } else {
      record("preseed-dag-files", false, "Could not get workspace path")
    }

    // ── Step 4: Verify workflow API returns parsed nodes ──
    console.log("\n=== Step 4: Verify workflow API ===")
    const wfGetRes = await fetch(`${API}/api/workspaces/${workspaceId}/workflows/${WF_NAME}`)
    if (wfGetRes.ok) {
      const wfDetail = await wfGetRes.json()
      const nodes = wfDetail.parsed?.nodes || wfDetail.nodes || []
      const dynamicNode = nodes.find(n => n.type === "dynamic_sub_workflow")
      record("api-parse-dynamic-node", !!dynamicNode, `Found: ${dynamicNode?.id || "none"}`)

      // Check generated workflow is also accessible
      const genRes = await fetch(`${API}/api/workspaces/${workspaceId}/workflows/${GENERATED_WF_NAME}`)
      record("api-parse-generated-wf", genRes.ok, `HTTP ${genRes.status}`)
    } else {
      record("api-parse-dynamic-node", false, `HTTP ${wfGetRes.status}`)
    }

    // ── Step 5: UI rendering — Dynamic badge ──────────
    console.log("\n=== Step 5: UI rendering ===")
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })

    // Navigate to workspace detail page (workflows tab)
    await page.goto(`${WEB}/workspaces/${workspaceId}`, { waitUntil: "domcontentloaded", timeout: 30000 })
    await page.waitForTimeout(6000)

    // Try to find and click on workflows section in sidebar/file tree
    const workflowsSection = page.locator("text=workflows").first()
    if (await workflowsSection.isVisible().catch(() => false)) {
      await workflowsSection.click()
      await page.waitForTimeout(2000)
    }

    // Try clicking on the workflow by data attributes or text matching
    const wfItem = page.locator(`[data-testid*="workflow"], text=${WF_NAME}`).first()
    const wfVisible = await wfItem.isVisible().catch(() => false)

    if (wfVisible) {
      await wfItem.click()
      await page.waitForTimeout(3000)
      await page.screenshot({ path: join(SCREENSHOT_DIR, "01-workflow-opened.png") })

      // Check for dynamic_sub_workflow node rendering
      const dynamicBadge = page.locator("text=⚡ Dynamic")
      const hasDynamicBadge = await dynamicBadge.isVisible().catch(() => false)
      record("ui-dynamic-badge", hasDynamicBadge, hasDynamicBadge ? "Badge visible" : "Badge not found")

      const runtimeLabel = page.locator("text=运行时生成")
      const hasRuntimeLabel = await runtimeLabel.isVisible().catch(() => false)
      record("ui-runtime-label", hasRuntimeLabel, hasRuntimeLabel ? "Label visible" : "Label not found")

      await page.screenshot({ path: join(SCREENSHOT_DIR, "02-dynamic-badge.png") })
    } else {
      record("ui-dynamic-badge", false, "Workflow item not found in tree")
      await page.screenshot({ path: join(SCREENSHOT_DIR, "01-workflow-not-found.png") })
    }

    // ── Step 6: Open generated workflow to see child nodes ──
    console.log("\n=== Step 6: Generated workflow child nodes ===")
    const genWfItem = page.locator(`text=${GENERATED_WF_NAME}`).first()
    if (await genWfItem.isVisible().catch(() => false)) {
      await genWfItem.click()
      await page.waitForTimeout(2000)
      await page.screenshot({ path: join(SCREENSHOT_DIR, "03-generated-wf.png") })

      // Check for child node rendering
      const taskA = page.locator("text=task-a").first()
      const hasTaskA = await taskA.isVisible().catch(() => false)
      record("ui-generated-child-nodes", hasTaskA, hasTaskA ? "Child nodes visible" : "Child nodes not found")
    } else {
      record("ui-generated-child-nodes", false, "Generated workflow not found in tree")
    }

    // ── Summary ──────────────────────────────────────
    console.log("\n=== E2E Summary ===")
    const passed = results.filter(r => r.pass).length
    const total = results.length
    console.log(`\n${passed}/${total} checks passed`)
    for (const r of results) {
      console.log(`  ${r.pass ? "✅" : "❌"} ${r.step}: ${r.detail}`)
    }

    if (passed < total) {
      process.exit(1)
    }
  } catch (err) {
    console.error("E2E Error:", err.message)
    if (browser) {
      const page = (await browser.contexts()[0]?.pages()[0]) || (await browser.newPage())
      await page.screenshot({ path: join(SCREENSHOT_DIR, "error.png") })
    }
    process.exit(1)
  } finally {
    if (browser) await browser.close()
  }
}

main()
