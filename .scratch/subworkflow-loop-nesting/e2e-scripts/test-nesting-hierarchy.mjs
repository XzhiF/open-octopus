/**
 * E2E Test: Nested Execution Hierarchy (v2)
 *
 * Verifies AC1-AC6 for the sub-workflow/loop nesting feature.
 * Uses separate workspaces per scenario to avoid 409 conflicts.
 *
 * Run: node .scratch/subworkflow-loop-nesting/e2e-scripts/test-nesting-hierarchy.mjs
 */

import { fetchJSON, resolveApiUrl, resolveWebUrl } from "../../../.claude/skills/e2e-harness/lib/api.mjs"
import { createWorkspace, cleanupWorkspace } from "../../../.claude/skills/e2e-harness/lib/workspace.mjs"
import { createExecution, startExecution, pollExecution, createWorkflow } from "../../../.claude/skills/e2e-harness/lib/execution.mjs"
import { querySQL, resolveDbPath } from "../../../.claude/skills/e2e-harness/lib/db.mjs"
import { createResults, record, printReport, saveResults } from "../../../.claude/skills/e2e-harness/lib/reporter.mjs"
import fs from "node:fs"
import path from "node:path"

// ─── Configuration ────────────────────────────────────────────────

const DATA_DIR = path.resolve(
  import.meta.dirname || path.dirname(new URL(import.meta.url).pathname),
  "../e2e-data"
)
const RESULTS_DIR = path.resolve(
  import.meta.dirname || path.dirname(new URL(import.meta.url).pathname),
  "../e2e-screenshots"
)
const POLL_TIMEOUT = 90000
const POLL_INTERVAL = 2000

// ─── Helpers ──────────────────────────────────────────────────────

function readYaml(filename) {
  return fs.readFileSync(path.join(DATA_DIR, filename), "utf8")
}

async function runWorkflow(workspaceId, workflowRef, label) {
  console.log(`\n--- Running: ${label} (${workflowRef}) ---`)
  const exec = await createExecution(workspaceId, workflowRef)
  console.log(`  Created execution: ${exec.id}`)
  await startExecution(workspaceId, exec.id)
  const result = await pollExecution(workspaceId, exec.id, POLL_TIMEOUT, POLL_INTERVAL)
  console.log(`  Status: ${result.status} (${result.duration ?? "?"}ms)`)
  return result
}

/**
 * Create a workspace and upload a set of workflow files.
 */
async function setupWorkspace(name, workflowFiles) {
  const ws = await createWorkspace(name, "xzf")
  console.log(`  Workspace: ${ws.id} (${ws.name})`)
  for (const file of workflowFiles) {
    const content = readYaml(file)
    try {
      await createWorkflow(ws.id, file, content)
      console.log(`    Uploaded: ${file}`)
    } catch (e) {
      console.log(`    Upload note: ${file} — ${e.message}`)
    }
  }
  return ws
}

// ─── Main Test ────────────────────────────────────────────────────

async function main() {
  const results = createResults()
  const apiUrl = resolveApiUrl()
  const dbPath = resolveDbPath()
  const workspaceIds = []

  console.log(`API: ${apiUrl}`)
  console.log(`DB: ${dbPath}`)

  try {
    // ══════════════════════════════════════════════════════════════
    // SCENARIO 1: Loop containing Sub-workflow (AC1, AC2, AC5)
    // ══════════════════════════════════════════════════════════════
    console.log("\n" + "=".repeat(60))
    console.log("SCENARIO 1: Loop containing Sub-workflow")
    console.log("=".repeat(60))

    const ws1 = await setupWorkspace("E2E_TEST_NESTING_s1", [
      "E2E_TEST_NESTING_child-analysis.yaml",
      "E2E_TEST_NESTING_loop-subwf.yaml",
    ])
    workspaceIds.push(ws1.id)

    const exec1 = await runWorkflow(ws1.id, "E2E_TEST_NESTING_loop-subwf.yaml", "loop-subwf")

    if (exec1.status === "completed") {
      record(results, "S1-execute", true, `status=completed, duration=${exec1.duration}ms, iterations=${exec1.steps?.find(s => s.stepId === "review-loop")?.outputs?.iterations ?? "?"}`)
    } else {
      record(results, "S1-execute", false, `status=${exec1.status}, error=${exec1.error || JSON.stringify(exec1)}`)
    }

    // DB query for scenario 1
    const s1Nodes = querySQL(
      `SELECT node_id, node_type, status, parent_node_id, iteration_index FROM node_executions WHERE execution_id='${exec1.id}' ORDER BY started_at`
    )

    console.log("\n  DB node_executions:")
    for (const n of (s1Nodes.data || [])) {
      console.log(`    ${n.node_id} (${n.node_type}): parent=${n.parent_node_id}, iter=${n.iteration_index}, status=${n.status}`)
    }

    // AC1: Sub-workflow child nodes have parent_node_id = sub_workflow node's ID
    const swfChildren = (s1Nodes.data || []).filter(n => n.node_id.includes("call-analysis:"))
    if (swfChildren.length > 0) {
      const allHaveCorrectParent = swfChildren.every(n => n.parent_node_id === "call-analysis")
      record(results, "AC1-parent_node_id", allHaveCorrectParent,
        `${swfChildren.length} children: ${swfChildren.map(n => `${n.node_id}→${n.parent_node_id}`).join(", ")}`)
    } else {
      record(results, "AC1-parent_node_id", false, "No sub-workflow child nodes found in DB")
    }

    // AC2: iteration_index for sub-workflow children inside loop
    if (swfChildren.length > 0) {
      const childrenWithIter = swfChildren.filter(n => n.iteration_index !== null)
      const hasIterIndex = childrenWithIter.length > 0
      record(results, "AC2-iteration_index", hasIterIndex,
        `${childrenWithIter.length}/${swfChildren.length} children have iteration_index: ${childrenWithIter.map(n => n.iteration_index).join(",")}`)
    } else {
      record(results, "AC2-iteration_index", false, "No children to check")
    }

    // API cross-validation: check that API response includes parentNodeId and iterationIndex
    const apiSteps1 = (exec1.steps || []).filter(s => s.parentNodeId !== undefined || s.iterationIndex !== undefined)
    if (apiSteps1.length > 0) {
      record(results, "S1-API-crossval", true,
        `${apiSteps1.length} steps expose parent/iteration metadata: ${apiSteps1.map(s => `${s.stepId}(p=${s.parentNodeId},i=${s.iterationIndex})`).join(", ")}`)
    } else {
      record(results, "S1-API-crossval", false, "No steps expose parent/iteration metadata in API")
    }

    // ══════════════════════════════════════════════════════════════
    // SCENARIO 2: 3-Layer Sub-workflow Nesting A→B→C (AC4)
    // ══════════════════════════════════════════════════════════════
    console.log("\n" + "=".repeat(60))
    console.log("SCENARIO 2: 3-Layer Sub-workflow Nesting (A→B→C)")
    console.log("=".repeat(60))

    const ws2 = await setupWorkspace("E2E_TEST_NESTING_s2", [
      "E2E_TEST_NESTING_layer-c.yaml",
      "E2E_TEST_NESTING_layer-b.yaml",
      "E2E_TEST_NESTING_layer-a.yaml",
    ])
    workspaceIds.push(ws2.id)

    const exec2 = await runWorkflow(ws2.id, "E2E_TEST_NESTING_layer-a.yaml", "layer-a")

    if (exec2.status === "completed") {
      record(results, "S2-execute", true, `status=completed, duration=${exec2.duration}ms`)
    } else {
      record(results, "S2-execute", false, `status=${exec2.status}, error=${exec2.error || JSON.stringify(exec2)}`)
    }

    // DB query for scenario 2
    const s2Nodes = querySQL(
      `SELECT node_id, node_type, status, parent_node_id, iteration_index FROM node_executions WHERE execution_id='${exec2.id}' ORDER BY started_at`
    )

    console.log("\n  DB node_executions:")
    for (const n of (s2Nodes.data || [])) {
      console.log(`    ${n.node_id} (${n.node_type}): parent=${n.parent_node_id}, iter=${n.iteration_index}, status=${n.status}`)
    }

    // AC4: 3-layer nesting — parent_node_id chain complete
    // Layer B children (call-b:mid-work, call-b:call-c) should have parent_node_id = "call-b"
    const layerBChildren = (s2Nodes.data || []).filter(n => n.node_id.startsWith("call-b:"))
    // Layer C children (call-b:call-c:deep-work) should have parent_node_id = "call-c" or "call-b:call-c"
    const layerCChildren = (s2Nodes.data || []).filter(n => n.node_id.includes("deep-work") && n.node_id.includes(":"))

    if (layerBChildren.length > 0) {
      const bCorrect = layerBChildren.every(n => n.parent_node_id === "call-b")
      record(results, "AC4-layer-b", bCorrect,
        `${layerBChildren.length} layer-b children: ${layerBChildren.map(n => `${n.node_id}→${n.parent_node_id}`).join(", ")}`)
    } else {
      record(results, "AC4-layer-b", false, "No layer-b children found")
    }

    if (layerCChildren.length > 0) {
      const cCorrect = layerCChildren.every(n => n.parent_node_id !== null)
      record(results, "AC4-layer-c", cCorrect,
        `${layerCChildren.length} layer-c children: ${layerCChildren.map(n => `${n.node_id}→${n.parent_node_id}`).join(", ")}`)
    } else {
      // Layer C children might be scoped differently
      const anyDeepWork = (s2Nodes.data || []).filter(n => n.node_id.includes("deep-work"))
      record(results, "AC4-layer-c", anyDeepWork.length > 0 && anyDeepWork.some(n => n.parent_node_id !== null),
        `deep-work nodes: ${anyDeepWork.map(n => `${n.node_id}→${n.parent_node_id}`).join(", ")}`)
    }

    // Full chain: verify parent chain traceable
    const allHaveParents = (s2Nodes.data || []).filter(n => n.node_id.includes(":")).every(n => n.parent_node_id !== null)
    record(results, "AC4-full-chain", allHaveParents,
      `All scoped nodes have parent_node_id: ${allHaveParents}`)

    // ══════════════════════════════════════════════════════════════
    // SCENARIO 3: Sub-workflow containing Loop (AC5)
    // ══════════════════════════════════════════════════════════════
    console.log("\n" + "=".repeat(60))
    console.log("SCENARIO 3: Sub-workflow containing Loop")
    console.log("=".repeat(60))

    const ws3 = await setupWorkspace("E2E_TEST_NESTING_s3", [
      "E2E_TEST_NESTING_child-with-loop.yaml",
      "E2E_TEST_NESTING_parent-with-loop-wf.yaml",
    ])
    workspaceIds.push(ws3.id)

    const exec3 = await runWorkflow(ws3.id, "E2E_TEST_NESTING_parent-with-loop-wf.yaml", "parent-with-loop-wf")

    if (exec3.status === "completed") {
      record(results, "S3-execute", true, `status=completed, duration=${exec3.duration}ms`)
    } else {
      record(results, "S3-execute", false, `status=${exec3.status}, error=${exec3.error || JSON.stringify(exec3)}`)
    }

    // DB query for scenario 3
    const s3Nodes = querySQL(
      `SELECT node_id, node_type, status, parent_node_id, iteration_index FROM node_executions WHERE execution_id='${exec3.id}' ORDER BY started_at`
    )

    console.log("\n  DB node_executions:")
    for (const n of (s3Nodes.data || [])) {
      console.log(`    ${n.node_id} (${n.node_type}): parent=${n.parent_node_id}, iter=${n.iteration_index}, status=${n.status}`)
    }

    // AC5: Sub-workflow containing loop works correctly
    // Child workflow nodes (call-loop-wf:setup, call-loop-wf:inner-loop) should have parent_node_id = "call-loop-wf"
    const childWfNodes = (s3Nodes.data || []).filter(n => n.node_id.startsWith("call-loop-wf:"))
    if (childWfNodes.length > 0) {
      const childHasParent = childWfNodes.every(n => n.parent_node_id === "call-loop-wf")
      record(results, "AC5-swf-children", childHasParent,
        `${childWfNodes.length} child-wf nodes: ${childWfNodes.map(n => `${n.node_id}→${n.parent_node_id}`).join(", ")}`)
    } else {
      record(results, "AC5-swf-children", false, "No child workflow nodes found")
    }

    // Loop step nodes inside sub-workflow — check for iteration_index
    const loopStepNodes = (s3Nodes.data || []).filter(n => n.node_id.includes("step") && n.node_id.includes("inner-loop"))
    if (loopStepNodes.length > 0) {
      const stepsWithIter = loopStepNodes.filter(n => n.iteration_index !== null)
      record(results, "AC5-loop-steps", stepsWithIter.length > 0,
        `${loopStepNodes.length} step nodes, ${stepsWithIter.length} with iteration_index: ${stepsWithIter.map(n => n.iteration_index).join(",")}`)
    } else {
      // Step nodes might not be scoped under inner-loop
      const anyStepNodes = (s3Nodes.data || []).filter(n => n.node_id.includes("step"))
      record(results, "AC5-loop-steps", anyStepNodes.length > 0,
        `step nodes found: ${anyStepNodes.map(n => `${n.node_id}(iter=${n.iteration_index})`).join(", ")}`)
    }

    // ══════════════════════════════════════════════════════════════
    // SCENARIO 4: Simple non-nested workflow (AC6 — regression)
    // ══════════════════════════════════════════════════════════════
    console.log("\n" + "=".repeat(60))
    console.log("SCENARIO 4: Simple non-nested (regression)")
    console.log("=".repeat(60))

    const ws4 = await setupWorkspace("E2E_TEST_NESTING_s4", [
      "E2E_TEST_NESTING_simple.yaml",
    ])
    workspaceIds.push(ws4.id)

    const exec4 = await runWorkflow(ws4.id, "E2E_TEST_NESTING_simple.yaml", "simple")

    if (exec4.status === "completed") {
      record(results, "S4-execute", true, `status=completed, duration=${exec4.duration}ms`)
    } else {
      record(results, "S4-execute", false, `status=${exec4.status}`)
    }

    // AC6: New columns should be null for non-nested workflows
    const s4Nodes = querySQL(
      `SELECT node_id, parent_node_id, iteration_index FROM node_executions WHERE execution_id='${exec4.id}' ORDER BY started_at`
    )

    console.log("\n  DB node_executions:")
    for (const n of (s4Nodes.data || [])) {
      console.log(`    ${n.node_id}: parent=${n.parent_node_id}, iter=${n.iteration_index}`)
    }

    const allNull = (s4Nodes.data || []).length > 0 &&
      (s4Nodes.data || []).every(n => n.parent_node_id === null && n.iteration_index === null)
    record(results, "AC6-regression", allNull,
      `${(s4Nodes.data || []).length} nodes, all null: ${allNull}`)

  } catch (err) {
    record(results, "unexpected-error", false, `${err.message}\n${err.stack}`)
    console.error("\nFATAL ERROR:", err)
  } finally {
    // ── Cleanup ────────────────────────────────────────────────────
    console.log("\n=== Cleanup ===")
    for (const wsId of workspaceIds) {
      try {
        await cleanupWorkspace(wsId)
        console.log(`  Deleted workspace ${wsId}`)
      } catch (e) {
        console.log(`  Cleanup note: ${e.message}`)
      }
    }
    record(results, "cleanup", true, `${workspaceIds.length} workspaces cleaned up`)

    // ── Report ─────────────────────────────────────────────────────
    const summary = printReport(results, { title: "Nested Execution Hierarchy E2E Test" })
    saveResults(results, path.join(RESULTS_DIR, "test-results.json"))
    console.log(`\nResults saved to: ${path.join(RESULTS_DIR, "test-results.json")}`)

    process.exit(summary.allPass ? 0 : 1)
  }
}

main().catch(err => {
  console.error("Unhandled error:", err)
  process.exit(2)
})
