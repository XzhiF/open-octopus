/**
 * E2E Test: Workflow Observability — Integration Tests (v2)
 *
 * Tests the full observability feature:
 * - AC-3: Budget snapshot written to executions table
 * - AC-5: Error timeline mechanism (error classification function)
 * - AC-8: Historical observability data accessible after completion
 * - API Integration: GET /executions/:eid/observability returns correct ObservabilityData
 * - DB Cross-validation: Token aggregation matches DB
 */

import { fetchJSON, resolveApiUrl, healthCheck } from "../../../.claude/skills/e2e-harness/lib/api.mjs"
import { createWorkspace, cleanupWorkspace } from "../../../.claude/skills/e2e-harness/lib/workspace.mjs"
import { createExecution, startExecution, pollExecution, createWorkflow } from "../../../.claude/skills/e2e-harness/lib/execution.mjs"
import { createResults, record, printReport, saveResults, exitWithResults } from "../../../.claude/skills/e2e-harness/lib/reporter.mjs"
import { querySQL, executeSQL } from "../../../.claude/skills/e2e-harness/lib/db.mjs"

const WORKFLOW_REF = "OBS_TEST_observability.yaml"
let WORKSPACE_ID = null

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

let executionId = null

async function main() {
  const results = createResults()

  console.log("=== E2E Test: Workflow Observability (v2) ===\n")

  // Step 1: Health check
  console.log("Step 1: Health check...")
  const healthy = await healthCheck()
  record(results, "Server health check", healthy, healthy ? "Server is running on " + resolveApiUrl() : "Server not reachable")
  if (!healthy) {
    console.log("Server not available. Aborting.")
    exitWithResults(results, { title: "Workflow Observability E2E v2" })
  }

  // Step 1.5: Create workspace
  console.log("\nStep 1.5: Creating test workspace...")
  try {
    const ws = await createWorkspace("obs_v2", "xzf")
    WORKSPACE_ID = ws.id
    record(results, "Create test workspace", true, `id=${WORKSPACE_ID}, name=${ws.name}`)
  } catch (err) {
    record(results, "Create test workspace", false, err.message)
    exitWithResults(results, { title: "Workflow Observability E2E v2" })
  }

  // Step 2: Create workflow
  console.log("\nStep 2: Creating test workflow...")
  try {
    await createWorkflow(WORKSPACE_ID, WORKFLOW_REF, WORKFLOW_YAML)
    record(results, "Create workflow with budget", true, `ref=${WORKFLOW_REF}`)
  } catch (err) {
    record(results, "Create workflow with budget", false, err.message)
  }

  // Step 3: Create and start execution
  console.log("\nStep 3: Creating and starting execution...")
  try {
    const exec = await createExecution(WORKSPACE_ID, WORKFLOW_REF, `OBS_TEST_exec_${Date.now()}`)
    executionId = exec.id
    record(results, "Create execution", true, `executionId=${executionId}`)

    const started = await startExecution(WORKSPACE_ID, executionId)
    record(results, "Start execution", started, started ? "Execution started" : "Failed to start")
  } catch (err) {
    record(results, "Create/start execution", false, err.message)
  }

  // Step 4: Poll until terminal status
  if (executionId) {
    console.log("\nStep 4: Polling execution (max 120s)...")
    const finalExec = await pollExecution(WORKSPACE_ID, executionId, 120000, 3000)
    const terminal = ["completed", "failed", "error", "cancelled", "budget_exceeded"].includes(finalExec.status)
    record(results, "Execution reaches terminal status", terminal, `status=${finalExec.status}`)
  }

  // Step 5: Verify budget_snapshot in DB (AC-3)
  console.log("\nStep 5: AC-3 — Budget snapshot verification...")
  if (executionId) {
    const dbResult = querySQL(
      `SELECT budget_snapshot, status, started_at, completed_at FROM executions WHERE id = '${executionId}'`
    )
    if (dbResult.ok && dbResult.data.length > 0) {
      const row = dbResult.data[0]
      const hasSnapshot = row.budget_snapshot !== null && row.budget_snapshot !== ""
      record(results, "AC-3: budget_snapshot written to DB", hasSnapshot,
        hasSnapshot ? `snapshot=${row.budget_snapshot}` : "budget_snapshot is NULL")

      if (hasSnapshot) {
        try {
          const snapshot = JSON.parse(row.budget_snapshot)
          const hasMaxTokens = snapshot.max_tokens === 50000
          const hasMaxDuration = snapshot.max_duration === 300
          const hasMaxCost = snapshot.max_cost_usd === 1.0
          record(results, "AC-3: snapshot max_tokens=50000", hasMaxTokens, `actual=${snapshot.max_tokens}`)
          record(results, "AC-3: snapshot max_duration=300", hasMaxDuration, `actual=${snapshot.max_duration}`)
          record(results, "AC-3: snapshot max_cost_usd=1.0", hasMaxCost, `actual=${snapshot.max_cost_usd}`)
        } catch (e) {
          record(results, "AC-3: budget_snapshot JSON parseable", false, e.message)
        }
      }
    } else {
      record(results, "AC-3: DB query for budget_snapshot", false, dbResult.error || "no data")
    }
  }

  // Step 6: Verify observability API (AC-5, AC-8)
  console.log("\nStep 6: Observability API verification...")
  if (executionId) {
    const obsResp = await fetchJSON(`/api/workspaces/${WORKSPACE_ID}/executions/${executionId}/observability`)
    record(results, "GET /observability returns 200", obsResp.ok, `status=${obsResp.status}`)

    if (obsResp.ok && obsResp.data) {
      const obs = obsResp.data

      // AC-8: Historical data accessible
      record(results, "AC-8: executionId matches", obs.executionId === executionId, `api=${obs.executionId}`)
      record(results, "AC-8: status present", !!obs.status, `status=${obs.status}`)

      // Token summary
      const hasTokens = obs.tokens && typeof obs.tokens.totalInput === "number"
      record(results, "API: tokens.totalInput is number", hasTokens, `value=${obs.tokens?.totalInput}`)
      record(results, "API: tokens.totalOutput is number", typeof obs.tokens?.totalOutput === "number", `value=${obs.tokens?.totalOutput}`)
      record(results, "API: tokens.totalCostUsd is number", typeof obs.tokens?.totalCostUsd === "number", `value=${obs.tokens?.totalCostUsd}`)
      record(results, "API: tokens.totalCostUsd > 0", obs.tokens?.totalCostUsd > 0, `cost=${obs.tokens?.totalCostUsd}`)

      // ByNode breakdown
      const hasByNode = Array.isArray(obs.byNode) && obs.byNode.length >= 3
      record(results, "API: byNode has >= 3 entries", hasByNode, `count=${obs.byNode?.length}`)

      if (obs.byNode) {
        const agentNode = obs.byNode.find(n => n.nodeId === "process")
        record(results, "API: agent node 'process' in byNode", !!agentNode,
          agentNode ? `input=${agentNode.inputTokens}, output=${agentNode.outputTokens}` : "not found")

        if (agentNode) {
          record(results, "API: agent node has tokens > 0", agentNode.inputTokens + agentNode.outputTokens > 0,
            `total=${agentNode.inputTokens + agentNode.outputTokens}`)
          record(results, "API: agent node has llmTurns > 0", agentNode.llmTurns > 0, `llmTurns=${agentNode.llmTurns}`)
        }

        const failNode = obs.byNode.find(n => n.nodeId === "fail-test")
        record(results, "API: fail-test node in byNode", !!failNode,
          failNode ? `status=${failNode.error}, retryCount=${failNode.retryCount}` : "not found")
        if (failNode) {
          record(results, "API: fail-test retryCount > 0", failNode.retryCount > 0, `retryCount=${failNode.retryCount}`)
        }
      }

      // ByModel breakdown
      const hasByModel = Array.isArray(obs.byModel) && obs.byModel.length > 0
      record(results, "API: byModel has entries", hasByModel, `count=${obs.byModel?.length}`)

      // TimeSeries
      const hasTimeSeries = Array.isArray(obs.timeSeries) && obs.timeSeries.length > 0
      record(results, "API: timeSeries has entries", hasTimeSeries, `count=${obs.timeSeries?.length}`)

      // Budget section
      const hasBudget = obs.budget !== undefined && obs.budget !== null
      record(results, "API: budget section present", hasBudget)

      if (obs.budget) {
        record(results, "API: budget.snapshot not null", obs.budget.snapshot !== null,
          `snapshot=${JSON.stringify(obs.budget.snapshot)?.substring(0, 80)}`)

        if (obs.budget.snapshot) {
          record(results, "API: snapshot.max_tokens=50000", obs.budget.snapshot.max_tokens === 50000,
            `actual=${obs.budget.snapshot.max_tokens}`)
        }

        const progress = obs.budget.progress
        record(results, "API: budget.progress present", !!progress,
          progress ? `tokens%=${progress.tokensPercent}, duration%=${progress.durationPercent}, cost%=${progress.costPercent}` : "missing")

        if (progress) {
          record(results, "API: tokensPercent > 0", progress.tokensPercent > 0, `value=${progress.tokensPercent}`)
          record(results, "API: durationPercent > 0", progress.durationPercent > 0, `value=${progress.durationPercent}`)
          record(results, "API: costPercent > 0", progress.costPercent > 0, `value=${progress.costPercent}`)
        }
      }

      // AC-5: Error timeline
      record(results, "AC-5: errors is array", Array.isArray(obs.errors), `count=${obs.errors?.length}`)

      // Rounds section
      const hasRounds = obs.rounds && typeof obs.rounds === "object"
      record(results, "API: rounds present", hasRounds,
        hasRounds ? `llm=${obs.rounds.totalLlmTurns}, retries=${obs.rounds.totalRetries}` : "missing")

      if (obs.rounds) {
        record(results, "API: totalLlmTurns > 0", obs.rounds.totalLlmTurns > 0, `value=${obs.rounds.totalLlmTurns}`)
        record(results, "API: totalRetries > 0 (fail-test retried)", obs.rounds.totalRetries > 0, `value=${obs.rounds.totalRetries}`)
      }

      // DB Cross-validation
      console.log("\nStep 6b: Cross-validation...")
      const tokenDbResult = querySQL(
        `SELECT COALESCE(SUM(input_tokens), 0) as total_input, COALESCE(SUM(output_tokens), 0) as total_output, COALESCE(SUM(cost_usd), 0) as total_cost FROM llm_calls WHERE execution_id = '${executionId}'`
      )
      if (tokenDbResult.ok && tokenDbResult.data.length > 0) {
        const dbInput = tokenDbResult.data[0].total_input
        const dbOutput = tokenDbResult.data[0].total_output
        const dbCost = tokenDbResult.data[0].total_cost
        const apiInput = obs.tokens.totalInput
        const apiOutput = obs.tokens.totalOutput
        const apiCost = obs.tokens.totalCostUsd

        const inputMatch = dbInput === apiInput
        const outputMatch = dbOutput === apiOutput
        const costMatch = Math.abs(dbCost - apiCost) < 0.0001

        record(results, "R3: API totalInput == DB SUM(input_tokens)", inputMatch,
          `API=${apiInput}, DB=${dbInput}`)
        record(results, "R3: API totalOutput == DB SUM(output_tokens)", outputMatch,
          `API=${apiOutput}, DB=${dbOutput}`)
        record(results, "R3: API totalCostUsd ≈ DB SUM(cost_usd)", costMatch,
          `API=${apiCost}, DB=${dbCost}`)
      } else {
        record(results, "R3: DB token query", false, tokenDbResult.error || "no data")
      }

      // Cross-validate byNode count with node_executions
      const nodeCountResult = querySQL(
        `SELECT COUNT(DISTINCT node_id) as cnt FROM node_executions WHERE execution_id = '${executionId}'`
      )
      if (nodeCountResult.ok && nodeCountResult.data.length > 0) {
        const dbNodeCount = nodeCountResult.data[0].cnt
        const apiNodeCount = obs.byNode?.length ?? 0
        record(results, "R3: API byNode count == DB distinct node count",
          dbNodeCount === apiNodeCount,
          `API=${apiNodeCount}, DB=${dbNodeCount}`)
      }
    } else {
      record(results, "API: observability response valid", false, `status=${obsResp.status}, text=${obsResp.text?.substring(0, 200)}`)
    }
  }

  // Step 7: Error classification function test (AC-5 indirect)
  console.log("\nStep 7: Verifying error-related data in DB...")
  if (executionId) {
    const nodeStatusResult = querySQL(
      `SELECT node_id, node_type, status, error, retry_count, exit_code FROM node_executions WHERE execution_id = '${executionId}'`
    )
    if (nodeStatusResult.ok) {
      const failNode = nodeStatusResult.data.find(r => r.node_id === "fail-test")
      record(results, "DB: fail-test node found", !!failNode,
        failNode ? `status=${failNode.status}, retry=${failNode.retry_count}` : "not found")

      if (failNode) {
        record(results, "DB: fail-test status=failed", failNode.status === "failed", `actual=${failNode.status}`)
        record(results, "DB: fail-test retry_count >= 1", failNode.retry_count >= 1, `actual=${failNode.retry_count}`)
        // Note: error field may be null due to engine callback flow (onError called after onNodeEnd for retried nodes)
        // This is a known data persistence gap, not a test failure
        if (failNode.error === null) {
          record(results, "BUG-FINDING: fail-test error column is NULL", false,
            "Error message not persisted for retried bash nodes — engine callback flow gap")
        }
      }
    }
  }

  // Cleanup
  console.log("\nCleanup...")
  if (WORKSPACE_ID) {
    const cleaned = await cleanupWorkspace(WORKSPACE_ID)
    record(results, "Cleanup workspace", cleaned, `id=${WORKSPACE_ID}`)
  }

  // Save results
  const resultsPath = saveResults(results, "C:/xzf/ai/open-octopus/.scratch/workflow-observability/e2e-data/integration-results-v2.json")
  console.log(`\nResults saved to: ${resultsPath}`)

  if (executionId && WORKSPACE_ID) {
    const fs = await import("node:fs")
    fs.writeFileSync(
      "C:/xzf/ai/open-octopus/.scratch/workflow-observability/e2e-data/execution-context.json",
      JSON.stringify({ workspaceId: WORKSPACE_ID, executionId, workflowRef: WORKFLOW_REF }, null, 2)
    )
  }

  exitWithResults(results, { title: "Workflow Observability — Integration Tests v2" })
}

main().catch((err) => {
  console.error("FATAL:", err)
  process.exit(1)
})
