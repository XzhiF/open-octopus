#!/usr/bin/env node
// Feedback loop: run test-process-conflict, check harness delegation result
// Usage: node .scratch/debug-harness-delegation.mjs

import { fetchJSON, resolveApiUrl } from "../.claude/skills/e2e-harness/lib/api.mjs"

const WS_ID = "f399edcd-ec4e-4530-90c9-9ba5ae4df544"
const WORKFLOW_NAME = "test-process-conflict"
const API = resolveApiUrl()

// ── Helpers ──

async function clearData() {
  // Get all executions
  const execs = await fetchJSON(`${API}/api/workspaces/${WS_ID}/executions/tree`)
  if (execs.ok && Array.isArray(execs.data)) {
    for (const e of execs.data) {
      // No delete API — we'll just check the latest execution
    }
  }
}

async function createExecution() {
  // Get root execution ID first
  const tree = await fetchJSON(`${API}/api/workspaces/${WS_ID}/executions/tree`)
  let parentId = null
  if (tree.ok && tree.data?.nodes?.length > 0) {
    const root = tree.data.nodes.find((n) => n.parent_id === "0")
    if (root) parentId = root.id
  }

  const body = { workflow_ref: WORKFLOW_NAME + ".yaml" }
  if (parentId) body.parent_id = parentId

  const res = await fetchJSON(`${API}/api/workspaces/${WS_ID}/executions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    console.error("❌ Create execution failed:", res.status, res.text)
    process.exit(1)
  }
  return res.data
}

async function startExecution(execId) {
  const res = await fetchJSON(`${API}/api/workspaces/${WS_ID}/executions/${execId}/start`, {
    method: "POST",
  })
  if (!res.ok) {
    console.error("❌ Start execution failed:", res.status, res.text)
    process.exit(1)
  }
  return res.data
}

async function pollExecution(execId, maxWaitMs = 60000) {
  const start = Date.now()
  while (Date.now() - start < maxWaitMs) {
    const res = await fetchJSON(`${API}/api/workspaces/${WS_ID}/executions/${execId}`)
    if (!res.ok) {
      console.error("❌ Poll failed:", res.status)
      return null
    }
    const status = res.data?.status
    if (["completed", "failed", "cancelled", "blocked"].includes(status)) {
      return res.data
    }
    console.log(`  ⏳ status=${status}, waiting...`)
    await new Promise((r) => setTimeout(r, 3000))
  }
  console.error("❌ Timeout waiting for execution")
  return null
}

async function getHarnessEvents(execId) {
  const res = await fetchJSON(`${API}/api/workspaces/${WS_ID}/harness/events/${execId}`)
  if (!res.ok) return []
  return res.data?.events ?? []
}

// ── Main ──

console.log("🔧 Creating execution:", WORKFLOW_NAME)
const exec = await createExecution()
const execId = exec.id
console.log("  Created:", execId)

console.log("🚀 Starting execution...")
await startExecution(execId)
console.log("  Started")

console.log("⏳ Polling for completion (max 60s)...")
const result = await pollExecution(execId)
if (!result) {
  console.log("FAIL: execution did not complete")
  process.exit(1)
}
console.log(`  Execution finished: status=${result.status}, harness_status=${result.harness_status}`)

// Wait extra time for async delegation to complete
console.log("\n⏳ Waiting 60s for async delegation...")
await new Promise((r) => setTimeout(r, 60000))

console.log("\n📋 Harness events:")
const events = await getHarnessEvents(execId)
if (events.length === 0) {
  console.log("  (no events)")
}
for (const e of events) {
  const resultPreview = e.result_json ? JSON.stringify(JSON.parse(e.result_json)).slice(0, 200) : "(no result)"
  console.log(`  [${e.event_type}] node=${e.node_id} ts=${e.timestamp}`)
  console.log(`    result: ${resultPreview}`)
}

// ── Verdict ──
const delegationEvents = events.filter((e) => e.event_type === "delegation")
console.log("\n" + "=".repeat(60))

if (delegationEvents.length === 0) {
  console.log("🔴 FAIL: No delegation event found — Harness Agent was never called")
  process.exit(1)
}

const delegation = delegationEvents[0]
const delegationResult = delegation.result_json ? JSON.parse(delegation.result_json) : null

if (!delegationResult) {
  console.log("🔴 FAIL: Delegation event has no result_json")
  process.exit(1)
}

if (delegationResult.success === true) {
  console.log(`🟢 PASS: Delegation succeeded`)
  console.log(`  decision: ${delegationResult.decision}`)
  console.log(`  reasoning: ${delegationResult.reasoning}`)
  if (delegationResult.blockReason) console.log(`  blockReason: ${delegationResult.blockReason}`)
  if (delegationResult.harnessHint) console.log(`  harnessHint: ${delegationResult.harnessHint}`)
  if (delegationResult.continueSubsequent !== undefined) console.log(`  continueSubsequent: ${delegationResult.continueSubsequent}`)
  process.exit(0)
} else {
  console.log(`🔴 FAIL: Delegation failed`)
  console.log(`  decision: ${delegationResult.decision}`)
  console.log(`  reasoning: ${delegationResult.reasoning}`)
  process.exit(1)
}
