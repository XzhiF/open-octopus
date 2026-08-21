// Isolate backend vs frontend for the assist adoption failure.
// Flow: create session+task → trigger assist → seed aggregator output → GET run.
// If GET returns parsed output, backend is fine and the bug is the viewer's
// SSE-only refresh (no re-fetch after a DB-side seed).
import fs from "fs"
import path from "path"
import os from "os"
import { createRequire } from "module"
const require = createRequire(import.meta.url)

const SERVER = "http://localhost:3001"
const ORG = "E2E_TD_debug_org"
const now = () => new Date().toISOString()

function seedRunOutput(runId, synthesis, status = "completed") {
  const dbPath = path.join(os.homedir(), ".octopus", "db", "octopus.db")
  const { DatabaseSync } = require("node:sqlite")
  const db = new DatabaseSync(dbPath)
  try {
    const ts = now()
    db.prepare("UPDATE executions SET status = ?, updated_at = ? WHERE id = ?").run(status, ts, runId)
    const upd = db.prepare("SELECT changes() AS c").get()
    db.prepare("DELETE FROM node_executions WHERE execution_id = ? AND node_id = 'panel'").run(runId)
    const neId = `${runId}-panel-debug`
    db.prepare(`INSERT INTO node_executions (id, execution_id, node_id, node_type, status, started_at, completed_at, duration, exit_code, error, vars_snapshot, outputs, session_id, parent_node_id, iteration_index) VALUES (?, ?, 'panel', 'swarm', 'completed', ?, ?, 10, 0, NULL, NULL, ?, NULL, NULL, NULL)`).run(neId, runId, ts, ts, JSON.stringify({ synthesis }))
    return { execUpdateChanges: upd.c }
  } finally {
    db.close()
  }
}

function inspectRun(runId) {
  const dbPath = path.join(os.homedir(), ".octopus", "db", "octopus.db")
  const { DatabaseSync } = require("node:sqlite")
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const exec = db.prepare("SELECT id, status, workspace_id, substr(pipeline_config,1,200) as pc FROM executions WHERE id = ?").get(runId)
    const nodes = db.prepare("SELECT id, node_id, status, substr(outputs,1,200) as outs FROM node_executions WHERE execution_id = ?").all(runId)
    return { exec, nodes }
  } finally {
    db.close()
  }
}

async function jfetch(url, opts) {
  const res = await fetch(url, opts)
  const text = await res.text()
  let body
  try { body = JSON.parse(text) } catch { body = text }
  return { status: res.status, body }
}

async function main() {
  // 1. Create session
  const sess = await jfetch(`${SERVER}/api/clones/task-author/sessions`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
    body: JSON.stringify({ title: "E2E_TD_debug_assist" }),
  })
  console.log("[1] session:", sess.status, JSON.stringify(sess.body).slice(0, 120))
  const sessionId = sess.body.id

  // 2. Create task bound to session
  const task = await jfetch(`${SERVER}/api/tasks`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ org: ORG, name: "E2E_TD_debug_assist_task", source_chat_session_id: sessionId, task_type: "coding", skill_groups: ["default"] }),
  })
  console.log("[2] task:", task.status, task.body.id)
  const taskId = task.body.id

  // 3. Seed goal/ac
  await jfetch(`${SERVER}/api/tasks/${taskId}/spec-field`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ field: "goal", value: "E2E_TD debug goal" }) })
  await jfetch(`${SERVER}/api/tasks/${taskId}/spec-field`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ field: "ac", value: ["E2E_TD debug ac"] }) })

  // 4. Trigger assist
  const trig = await jfetch(`${SERVER}/api/tasks/${taskId}/assist-workflows`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ template: "moa-requirements-review" }),
  })
  console.log("[4] trigger:", trig.status, JSON.stringify(trig.body).slice(0, 160))
  const runId = trig.body.run_id
  if (!runId) { console.log("NO run_id — abort"); return { taskId } }

  // 5. Wait for start() to settle (engine fire-and-forget may error in dev)
  await new Promise(r => setTimeout(r, 2500))

  // 6. Inspect BEFORE seed
  const before = inspectRun(runId)
  console.log("[6] BEFORE seed: exec=", JSON.stringify(before.exec), "nodes=", before.nodes.length)
  for (const n of before.nodes) console.log("    node:", n.node_id, n.status, (n.outs || "").slice(0, 80))

  // 7. GET run BEFORE seed (what viewer would see on initial fetch)
  const getBefore = await jfetch(`${SERVER}/api/tasks/${taskId}/assist-workflows/${runId}`)
  console.log("[7] GET before seed:", getBefore.status, "status=", getBefore.body.status, "hasOutput=", !!getBefore.body.output, "parseError=", getBefore.body.output_parse_error)

  // 8. Seed aggregator output
  const synthesis = JSON.stringify({ ac_candidates: ["E2E_TD adopted ac from MoA"], suggestions: ["E2E_TD async event bus"], risks: ["E2E_TD rate limit"] })
  const seed = seedRunOutput(runId, synthesis)
  console.log("[8] seed: execUpdateChanges=", seed.execUpdateChanges)

  // 9. Inspect AFTER seed
  const after = inspectRun(runId)
  console.log("[9] AFTER seed: exec=", JSON.stringify(after.exec), "nodes=", after.nodes.length)
  for (const n of after.nodes) console.log("    node:", n.node_id, n.status, (n.outs || "").slice(0, 80))

  // 10. GET run AFTER seed (what viewer would see if it re-fetched)
  const getAfter = await jfetch(`${SERVER}/api/tasks/${taskId}/assist-workflows/${runId}`)
  console.log("[10] GET after seed:", getAfter.status, "status=", getAfter.body.status, "hasOutput=", !!getAfter.body.output)
  if (getAfter.body.output) console.log("    output:", JSON.stringify(getAfter.body.output))
  if (getAfter.body.output_raw) console.log("    output_raw:", getAfter.body.output_raw.slice(0, 80), "parse_error=", getAfter.body.output_parse_error)

  // 11. cleanup
  await jfetch(`${SERVER}/api/tasks/${taskId}`, { method: "DELETE" })
  console.log("[11] cleanup: task deleted")

  return { taskId, runId, getAfterHasOutput: !!getAfter.body.output }
}

main().then((r) => {
  console.log("\n=== VERDICT ===")
  console.log("Backend GET returns parsed output after seed:", r.getAfterHasOutput)
  console.log(r.getAfterHasOutput
    ? "→ BACKEND OK. Bug is the viewer (SSE-only, no re-fetch after DB-side seed)."
    : "→ BACKEND BROKEN. Seed/GET route does not surface the output.")
}).catch(e => console.error("ERR", e))
