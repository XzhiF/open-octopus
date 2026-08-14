/**
 * E2E Test: Workflow Observability — Quick diagnostic
 * Creates an execution, inspects DB before cleanup
 */

import { fetchJSON, resolveApiUrl, healthCheck } from "../../../.claude/skills/e2e-harness/lib/api.mjs"
import { createWorkspace, cleanupWorkspace } from "../../../.claude/skills/e2e-harness/lib/workspace.mjs"
import { createExecution, startExecution, pollExecution, createWorkflow, getExecution } from "../../../.claude/skills/e2e-harness/lib/execution.mjs"
import { querySQL } from "../../../.claude/skills/e2e-harness/lib/db.mjs"

const WORKFLOW_REF = "OBS_TEST_diag.yaml"
const WORKFLOW_YAML = `apiVersion: octopus/v1
kind: Workflow
name: OBS_TEST_diag
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

async function main() {
  console.log("=== Diagnostic: Observability Data ===\n")

  const ws = await createWorkspace("obs_diag", "xzf")
  console.log("Workspace:", ws.id, ws.name)

  try {
    await createWorkflow(ws.id, WORKFLOW_REF, WORKFLOW_YAML)
    console.log("Workflow created")

    const exec = await createExecution(ws.id, WORKFLOW_REF, `OBS_TEST_diag_${Date.now()}`)
    console.log("Execution created:", exec.id)

    await startExecution(ws.id, exec.id)
    console.log("Execution started")

    const final = await pollExecution(ws.id, exec.id, 120000, 3000)
    console.log("Execution terminal status:", final.status)

    // Inspect node_executions
    console.log("\n--- node_executions ---")
    const neResult = querySQL(
      `SELECT node_id, node_type, status, error, retry_count, iteration_index, parent_node_id, duration, exit_code
       FROM node_executions WHERE execution_id = '${exec.id}' ORDER BY started_at`
    )
    if (neResult.ok) {
      console.log(JSON.stringify(neResult.data, null, 2))
    } else {
      console.log("Query failed:", neResult.error)
    }

    // Inspect llm_calls
    console.log("\n--- llm_calls ---")
    const llmResult = querySQL(
      `SELECT node_id, model, input_tokens, output_tokens, cost_usd, turn_index
       FROM llm_calls WHERE execution_id = '${exec.id}' ORDER BY timestamp`
    )
    if (llmResult.ok) {
      console.log(JSON.stringify(llmResult.data, null, 2))
    }

    // Get observability data
    console.log("\n--- observability API ---")
    const obsResp = await fetchJSON(`/api/workspaces/${ws.id}/executions/${exec.id}/observability`)
    if (obsResp.ok) {
      console.log("tokens:", JSON.stringify(obsResp.data.tokens))
      console.log("byNode count:", obsResp.data.byNode?.length)
      for (const n of obsResp.data.byNode || []) {
        console.log(`  node=${n.nodeId} type=${n.nodeType} input=${n.inputTokens} output=${n.outputTokens} error=${n.error} retry=${n.retryCount}`)
      }
      console.log("errors:", JSON.stringify(obsResp.data.errors))
      console.log("rounds:", JSON.stringify(obsResp.data.rounds))
      console.log("budget:", JSON.stringify(obsResp.data.budget))
    } else {
      console.log("Observability API failed:", obsResp.status, obsResp.text)
    }

    // Get execution detail
    console.log("\n--- execution detail ---")
    const detail = await getExecution(ws.id, exec.id)
    console.log("status:", detail.status)
    console.log("harness_status:", detail.harness_status)

  } finally {
    await cleanupWorkspace(ws.id)
    console.log("\nWorkspace cleaned up")
  }
}

main().catch(console.error)
