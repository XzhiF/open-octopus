/**
 * E2E Harness Recipe — Interception Audit
 *
 * Tests all 5 harness interception layers with real workflow execution.
 *
 * Run: node .claude/skills/e2e-harness/recipes/harness-intercept-audit.mjs
 * Requires: dev server running (pnpm dev)
 *
 * Test matrix:
 *   T1: Static scan — bash node with kill $OCTOPUS_HOST_PID → blocked
 *   T2: Agent tool interception — agent kill command → denied by canUseTool
 *   T3: Timeout cascade + agent_takeover → all nodes overridden to completed
 *   T4: Server survival — host process alive after all tests
 *
 * Reference: .claude/skills/e2e-harness/patterns/harness-intercept.md
 */

import { createResults, record, exitWithResults } from "../lib/reporter.mjs"
import { healthCheck, fetchJSON, resolveApiUrl } from "../lib/api.mjs"
import { createWorkspace, cleanupWorkspace } from "../lib/workspace.mjs"
import { createWorkflow, createExecution, startExecution, pollExecution } from "../lib/execution.mjs"

// ─── Configuration ───────────────────────────────────────────────

const WORKSPACE_NAME = "E2E_HARNESS_TEST_intercept_audit"
const API_URL = resolveApiUrl()

// T1: Static scan — process_conflict detector
const WF_STATIC_SCAN = `apiVersion: octopus/v1
kind: Workflow
name: intercept-t1-static-scan
timeout: 30
nodes:
  - id: safe-bash
    type: bash
    bash: echo "Safe node, host PID=$OCTOPUS_HOST_PID"
  - id: dangerous-bash
    type: bash
    depends_on: [safe-bash]
    bash: |
      echo "This should NOT execute"
      kill -9 $OCTOPUS_HOST_PID
    timeout: 10
`

// T2: Agent tool interception — canUseTool denies kill command
const WF_AGENT_TOOL = `apiVersion: octopus/v1
kind: Workflow
name: intercept-t2-agent-tool
timeout: 60
nodes:
  - id: agent-kill-host
    type: agent
    prompt: |
      Execute this bash command exactly:
      kill -0 $OCTOPUS_HOST_PID && echo "alive" || echo "dead"
      Then try: kill -9 $OCTOPUS_HOST_PID
      Report what happened with both commands.
    timeout: 60
`

// T3: Timeout cascade + agent_takeover override
const WF_TAKEOVER = `apiVersion: octopus/v1
kind: Workflow
name: intercept-t3-takeover
timeout: 60
nodes:
  - id: cascade-1
    type: bash
    timeout: 2
    bash: |
      echo "Cascade 1: simulating long task..."
      sleep 30
  - id: cascade-2
    type: bash
    depends_on: [cascade-1]
    timeout: 2
    bash: |
      echo "Cascade 2"
      sleep 30
  - id: cascade-3
    type: bash
    depends_on: [cascade-2]
    timeout: 2
    bash: |
      echo "Cascade 3"
      sleep 30
  - id: takeover-result
    type: bash
    depends_on: [cascade-3]
    bash: echo "Takeover report: all cascades handled by harness agent"
`

// ─── Helpers ─────────────────────────────────────────────────────

async function getHarnessEvents(wsId, execId) {
  const { data } = await fetchJSON(`${API_URL}/api/workspaces/${wsId}/harness/events/${execId}`)
  return data?.events ?? []
}

async function getNodeStates(wsId, execId) {
  const { data } = await fetchJSON(`${API_URL}/api/workspaces/${wsId}/executions/${execId}/state`)
  return data?.nodes ?? {}
}

async function runWorkflow(wsId, yaml, ref, expectedStatus, maxWaitMs = 120_000) {
  await createWorkflow(wsId, ref, yaml)
  const exec = await createExecution(wsId, ref)
  await startExecution(wsId, exec.id)
  const result = await pollExecution(wsId, exec.id, maxWaitMs, 3_000)
  return { execId: exec.id, result }
}

// ─── Main ────────────────────────────────────────────────────────

const results = createResults()

async function main() {
  let wsId = ""

  try {
    // Health check
    console.log("\n=== Health Check ===")
    if (!(await healthCheck())) {
      record(results, "server-health", false, `Cannot reach ${API_URL}`)
      return
    }
    record(results, "server-health", true, `api=${API_URL}`)
    const serverPid = (await fetchJSON(`${API_URL}/api/actuator/health`))
      .data?.components?.server?.details?.pid
    record(results, "server-pid", !!serverPid, `PID=${serverPid}`)

    // Create workspace
    console.log("\n=== Create Workspace ===")
    const ws = await createWorkspace(WORKSPACE_NAME, "xzf")
    wsId = ws.id
    record(results, "workspace-created", !!ws.id, `id=${ws.id}`)

    // ─── T1: Static Scan ───────────────────────────────────────
    console.log("\n=== T1: Static Scan (ProcessConflictDetector) ===")
    const t1 = await runWorkflow(wsId, WF_STATIC_SCAN, "intercept-t1-static-scan.yaml")
    const t1Status = t1.result.status
    record(results, "T1-execution-terminal", ["completed","failed"].includes(t1Status), `status=${t1Status}`)

    const t1Events = await getHarnessEvents(wsId, t1.execId)
    const t1Diagnoses = t1Events.filter(e => e.event_type === "diagnosis")
    const t1Delegations = t1Events.filter(e => e.event_type === "delegation")
    record(results, "T1-diagnosis-fired", t1Diagnoses.length > 0, `count=${t1Diagnoses.length}`)
    record(results, "T1-delegation-returned", t1Delegations.length > 0, `count=${t1Delegations.length}`)

    if (t1Delegations.length > 0) {
      const lastDel = JSON.parse(t1Delegations.at(-1).result_json ?? "{}")
      record(results, "T1-decision=block_node", lastDel.decision === "block_node", `decision=${lastDel.decision}`)
    }

    const t1Nodes = await getNodeStates(wsId, t1.execId)
    record(results, "T1-dangerous-bash-skipped",
      t1Nodes["dangerous-bash"]?.status === "skipped" || t1Nodes["dangerous-bash"]?.status === "failed",
      `status=${t1Nodes["dangerous-bash"]?.status}`)

    // Verify server survived T1
    record(results, "T1-server-alive", await healthCheck(), "")

    // Delete execution to make room for next
    await fetchJSON(`${API_URL}/api/workspaces/${wsId}/executions/${t1.execId}`, { method: "DELETE" })

    // ─── T2: Agent Tool Interception ───────────────────────────
    console.log("\n=== T2: Agent Tool Interception (canUseTool) ===")
    const t2 = await runWorkflow(wsId, WF_AGENT_TOOL, "intercept-t2-agent-tool.yaml", "completed", 90_000)
    record(results, "T2-execution-terminal", ["completed","failed"].includes(t2.result.status), `status=${t2.result.status}`)

    const t2Events = await getHarnessEvents(wsId, t2.execId)
    const t2ToolIntercepts = t2Events.filter(e =>
      e.event_type === "diagnosis" && e.detector === "tool_interceptor")
    record(results, "T2-tool-interceptor-fired", t2ToolIntercepts.length > 0, `count=${t2ToolIntercepts.length}`)

    const t2Nodes = await getNodeStates(wsId, t2.execId)
    const agentOutput = t2Nodes["agent-kill-host"]?.lastOutput ?? ""
    const agentBlocked = agentOutput.toLowerCase().includes("block") ||
      agentOutput.toLowerCase().includes("intercept") ||
      agentOutput.toLowerCase().includes("denied")
    record(results, "T2-agent-reports-blocked", agentBlocked, `output=${agentOutput.slice(0, 150)}`)

    // Critical: verify server survived kill attempt
    const t2Alive = await healthCheck()
    record(results, "T2-server-alive-after-kill", t2Alive, "")

    await fetchJSON(`${API_URL}/api/workspaces/${wsId}/executions/${t2.execId}`, { method: "DELETE" })

    // ─── T3: Timeout Cascade + Agent Takeover ──────────────────
    console.log("\n=== T3: Timeout Cascade + Agent Takeover ===")
    const t3 = await runWorkflow(wsId, WF_TAKEOVER, "intercept-t3-takeover.yaml", "completed", 180_000)
    record(results, "T3-execution-terminal", ["completed","failed"].includes(t3.result.status), `status=${t3.result.status}`)

    const t3Events = await getHarnessEvents(wsId, t3.execId)
    const t3Takeovers = t3Events.filter(e => {
      if (e.event_type !== "delegation") return false
      try { return JSON.parse(e.result_json)?.decision === "agent_takeover" }
      catch { return false }
    })
    record(results, "T3-agent-takeover-fired", t3Takeovers.length > 0, `count=${t3Takeovers.length}`)

    const t3Nodes = await getNodeStates(wsId, t3.execId)
    const cascadeCompleted = ["cascade-1","cascade-2","cascade-3"].every(
      id => t3Nodes[id]?.status === "completed")
    record(results, "T3-cascade-nodes-completed", cascadeCompleted,
      `c1=${t3Nodes["cascade-1"]?.status} c2=${t3Nodes["cascade-2"]?.status} c3=${t3Nodes["cascade-3"]?.status}`)

    const takeoverRan = t3Nodes["takeover-result"]?.status === "completed"
    record(results, "T3-takeover-result-ran", takeoverRan, `status=${t3Nodes["takeover-result"]?.status}`)

    // ─── T4: Server Survival (final check) ─────────────────────
    console.log("\n=== T4: Server Survival ===")
    const finalAlive = await healthCheck()
    record(results, "T4-server-alive-final", finalAlive, "")
    if (finalAlive) {
      const finalPid = (await fetchJSON(`${API_URL}/api/actuator/health`))
        .data?.components?.server?.details?.pid
      record(results, "T4-same-pid", finalPid === serverPid, `PID=${finalPid} (was ${serverPid})`)
    }

    // Cleanup
    console.log("\n=== Cleanup ===")
    await cleanupWorkspace(wsId)
    record(results, "cleanup-done", true, "")

  } catch (err) {
    record(results, "unexpected-error", false, err instanceof Error ? err.message : String(err))
  } finally {
    if (wsId) {
      try { await cleanupWorkspace(wsId) } catch { /* ignore */ }
    }
    exitWithResults(results, { title: "Harness Interception Audit" })
  }
}

main()
