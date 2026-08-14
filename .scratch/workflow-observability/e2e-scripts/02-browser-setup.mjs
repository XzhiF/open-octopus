/**
 * Setup script: Creates workspace + execution for browser E2E tests.
 * Does NOT clean up — browser tests will use the data.
 */

import { fetchJSON, healthCheck } from "../../../.claude/skills/e2e-harness/lib/api.mjs"
import { createWorkspace } from "../../../.claude/skills/e2e-harness/lib/workspace.mjs"
import { createExecution, startExecution, pollExecution, createWorkflow } from "../../../.claude/skills/e2e-harness/lib/execution.mjs"
import fs from "node:fs"

const WORKFLOW_REF = "OBS_TEST_observability.yaml"
const WORKFLOW_YAML = `apiVersion: octopus/v1
kind: Workflow
name: OBS_TEST_observability
budget:
  max_tokens: 50000
  max_duration: 300
  max_cost_usd: 1.0
nodes:
  - id: greet
    type: bash
    command: echo "Hello from observability test"
  - id: process
    type: agent
    depends_on: [greet]
    agent: built-in/general-purpose.md
    prompt: "Summarize the number 42 in one sentence."
  - id: fail-test
    type: bash
    depends_on: [process]
    command: "exit 1"
`

const CONTEXT_FILE = "C:/xzf/ai/open-octopus/.scratch/workflow-observability/e2e-data/browser-context.json"

async function main() {
  console.log("=== Browser E2E Setup ===\n")

  const healthy = await healthCheck()
  if (!healthy) { console.error("Server not available"); process.exit(1) }

  const ws = await createWorkspace("obs_browser", "xzf")
  console.log("Workspace:", ws.id, ws.name)

  await createWorkflow(ws.id, WORKFLOW_REF, WORKFLOW_YAML)
  console.log("Workflow created")

  const exec = await createExecution(ws.id, WORKFLOW_REF, `OBS_TEST_browser_${Date.now()}`)
  console.log("Execution:", exec.id)

  await startExecution(ws.id, exec.id)
  console.log("Execution started, polling...")

  const final = await pollExecution(ws.id, exec.id, 120000, 3000)
  console.log("Execution terminal status:", final.status)

  // Get observability data to verify it's available
  const obsResp = await fetchJSON(`/api/workspaces/${ws.id}/executions/${exec.id}/observability`)
  console.log("Observability API status:", obsResp.ok ? "OK" : "FAIL")
  if (obsResp.ok) {
    console.log("  tokens:", JSON.stringify(obsResp.data.tokens))
    console.log("  byNode:", obsResp.data.byNode?.length, "nodes")
    console.log("  errors:", obsResp.data.errors?.length, "entries")
    console.log("  rounds:", JSON.stringify(obsResp.data.rounds))
  }

  // Save context for browser tests
  const context = {
    workspaceId: ws.id,
    workspaceName: ws.name,
    executionId: exec.id,
    workflowRef: WORKFLOW_REF,
    executionStatus: final.status,
    setupAt: new Date().toISOString(),
  }

  fs.mkdirSync("C:/xzf/ai/open-octopus/.scratch/workflow-observability/e2e-data", { recursive: true })
  fs.writeFileSync(CONTEXT_FILE, JSON.stringify(context, null, 2))
  console.log(`\nContext saved to: ${CONTEXT_FILE}`)
  console.log("Ready for browser E2E tests.")
  console.log(`Web URL: http://localhost:3000/workspaces/${ws.id}/executions/${exec.id}/observability`)
}

main().catch(err => { console.error("FATAL:", err); process.exit(1) })
