/**
 * Self-test for execution.mjs
 * Run: node lib/execution.self-test.mjs
 * Requires: dev server running
 */

import { createResults, record, exitWithResults } from "./reporter.mjs"
import { healthCheck } from "./api.mjs"
import { createWorkspace, cleanupWorkspace } from "./workspace.mjs"
import {
  createWorkflow,
  createExecution,
  startExecution,
  pollExecution,
  getExecution,
} from "./execution.mjs"

const results = createResults()

const SIMPLE_WF = `apiVersion: octopus/v1
kind: Workflow
name: E2E_HARNESS_TEST_simple
nodes:
  - id: hello
    type: bash
    bash: echo "hello from harness self-test"
    outputs:
      greeting: "hello"
`

async function main() {
  const healthy = await healthCheck()
  if (!healthy) {
    record(results, "Server health check", false, "Server not reachable — start with `pnpm dev`")
    exitWithResults(results, { title: "execution.mjs self-test" })
  }

  let workspaceId = ""

  try {
    // Setup: create workspace + workflow
    const ws = await createWorkspace("exec_selftest", "xzf")
    workspaceId = ws.id
    record(results, "Setup: create workspace", true, `id=${ws.id}`)

    await createWorkflow(ws.id, "E2E_HARNESS_TEST_simple.yaml", SIMPLE_WF)
    record(results, "Setup: create workflow", true, "ref=E2E_HARNESS_TEST_simple.yaml")

    // Test 1: Create execution
    const exec = await createExecution(ws.id, "E2E_HARNESS_TEST_simple.yaml", "E2E_HARNESS_TEST_selftest")
    record(results, "createExecution", !!exec.id, `id=${exec.id}`)

    // Test 2: Start execution
    const started = await startExecution(ws.id, exec.id)
    record(results, "startExecution", started, "")

    // Test 3: Poll execution
    const detail = await pollExecution(ws.id, exec.id, 30000, 2000)
    const terminalOk = ["completed", "failed", "error"].includes(detail.status)
    record(results, "pollExecution reaches terminal", terminalOk, `status=${detail.status}`)

    // Test 4: getExecution
    const fetched = await getExecution(ws.id, exec.id)
    record(results, "getExecution", fetched.id === exec.id, `status=${fetched.status}`)

  } catch (err) {
    record(results, "Unexpected error", false, err instanceof Error ? err.message : String(err))
  } finally {
    if (workspaceId) {
      try { await cleanupWorkspace(workspaceId) } catch { /* ignore */ }
    }
    exitWithResults(results, { title: "execution.mjs self-test" })
  }
}

main()
