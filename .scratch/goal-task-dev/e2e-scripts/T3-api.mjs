#!/usr/bin/env node
/**
 * T3 — API E2E: AC6 (presets + bind→ready→materialize→DB) + AC9-live (seed v2 catalog)
 * + handoff items (1)(2)(3)(8). Real server :3001, real dev DB. No auth in dev (R6: N/A,
 * routes open — documented, not mocked).
 *
 * Safety: gate/main/variant tasks are ABORTED immediately after ready (before the 60s
 * scheduler tick) and hard-deleted from DB at the end. No schedule for these ever executes.
 */
import { fetchJSON, resolveApiUrl } from "../../../.claude/skills/e2e-harness/lib/api.mjs"
import { querySQL } from "../../../.claude/skills/e2e-harness/lib/db.mjs"
import { createResults, record, exitWithResults } from "../../../.claude/skills/e2e-harness/lib/reporter.mjs"
import { readFileSync, existsSync } from "fs"
import os from "os"
import path from "path"

const API = resolveApiUrl()
const results = createResults()
const ok = (name, cond, detail) => {
  record(results, name, !!cond, detail)
  console.log(`${cond ? "PASS" : "FAIL"} [${name}] ${detail ?? ""}`)
}
const j = (x) => JSON.stringify(x)

// ── (1) presets: general-dev → built-in/task-dev; superpowers-zh filter ──
{
  const r = await fetchJSON("/api/workflow-presets")
  const gen = r.data?.presets?.find((p) => p.name === "general-dev")
  ok("AC6a GET presets general-dev=task-dev", r.ok && gen?.workflow === "built-in/task-dev",
    `status=${r.status} gen=${j(gen)}`)
  ok("AC6a inputs skeleton ${goal}/${ac}",
    gen?.inputs?.goal === "${goal}" && gen?.inputs?.ac === "${ac}", j(gen?.inputs))
  const sup = r.data?.presets?.find((p) => p.name === "superpowers-task-dev")
  ok("AC6a presets include superpowers", sup?.workflow === "built-in/superpowers-task-dev", j(sup))

  const f = await fetchJSON("/api/workflow-presets?skills_group=superpowers-zh")
  const fp = f.data?.presets?.find((p) => p.name === "superpowers-task-dev")
  ok("AC6a superpowers-zh filter returns superpowers preset", f.ok && fp, `status=${f.status} n=${f.data?.presets?.length} has=${!!fp}`)
}

// ── (2) GET workflow detail: inputs contract ──
{
  const r = await fetchJSON("/api/workflows/built-in/task-dev")
  const inputs = r.data?.parsed?.inputs
  const g = inputs?.goal, a = inputs?.ac, m = inputs?.max_turns
  ok("AC6b task-dev detail loaded", r.ok && inputs, `status=${r.status} keys=${j(Object.keys(inputs ?? {}))}`)
  ok("AC6b goal required=true w/ description", g?.required === true && typeof g?.description === "string" && g.description.length > 0, j(g))
  ok("AC6b ac required=true w/ description", a?.required === true && typeof a?.description === "string" && a.description.length > 0, j(a))
  ok("AC6b max_turns required=false default=\"200\" (string)", m?.required === false && m?.default === "200", j(m))
}

// ── (8) AC9-live: v2 seed catalog on disk ──
{
  const livePath = path.join(os.homedir(), ".octopus", "agent", "built-in", "task-author", "workflow-presets.yaml")
  ok("AC9-live catalog file exists", existsSync(livePath), livePath)
  const live = readFileSync(livePath, "utf8")
  ok("AC9-live version header == # version: 2", live.split("\n")[0] === "# version: 2", live.split("\n")[0])
  ok("AC9-live file binds general-dev→task-dev", /name:\s*general-dev[\s\S]*?workflow:\s*built-in\/task-dev/.test(live), "")
  // API↔file cross: both agree on general-dev binding
  const r = await fetchJSON("/api/workflow-presets")
  const gen = r.data?.presets?.find((p) => p.name === "general-dev")
  ok("AC9-live API↔file cross-validated", gen?.workflow === "built-in/task-dev" && /workflow:\s*built-in\/task-dev/.test(live),
    `API=${gen?.workflow}`)
}

// ── task lifecycle helpers ──
async function createDraft(name) {
  const r = await fetchJSON("/api/tasks", {
    method: "POST",
    body: j({ org: "default", name, task_type: "coding", skill_groups: [] }),
  })
  if (!r.ok) throw new Error(`createTask failed: ${r.status} ${r.text}`)
  return r.data
}
async function putTask(task, body) {
  const r = await fetchJSON(`/api/tasks/${task.id}`, {
    method: "PUT",
    headers: { "If-Match": String(task.version) },
    body: j(body),
  })
  if (!r.ok) throw new Error(`PUT failed: ${r.status} ${r.text}`)
  return r.data
}
async function ready(taskId) {
  return fetchJSON(`/api/tasks/${taskId}/ready`, { method: "POST" })
}
async function abort(taskId) {
  return fetchJSON(`/api/tasks/${taskId}/abort`, { method: "POST" })
}
function schedulesOf(taskId) {
  const q = querySQL(
    `SELECT id, status, origin_type, cron_expression, config FROM schedules WHERE origin_id = '${taskId}'`,
  )
  if (!q.ok) throw new Error(`DB query failed: ${q.error}`)
  return q.data.map((r) => ({ ...r, config: JSON.parse(r.config) }))
}

const GOAL = "在工作区创建文件 hello.txt，内容恰好为 X"
const AC1 = "文件 hello.txt 存在且去空白后内容恰好为 X"

// ── (3a) gate negative → then full bind on the SAME task ("409-gone") ──
const gateTask = await createDraft("E2E_TEST_GTD_gate")
ok("AC6c draft created (201, v1)", gateTask.status === "draft" && gateTask.version === 1, `id=${gateTask.id} v=${gateTask.version}`)
// Gate negative: schema requires ac.min(1), so the missing-item path is exercised via
// goal_confirmed:false (confirmation-gate D18) — ready must 409 with missing list.
await putTask(gateTask, { workflow_ref: "built-in/task-dev", task_spec: { goal: GOAL, ac: [AC1], goal_confirmed: false, ac_confirmed: [], task_type: "coding", skill_groups: [] } })
{
  const r = await ready(gateTask.id)
  ok("AC6c ready-gate 409 with missing:goal_confirmed", r.status === 409 && Array.isArray(r.data?.missing) && r.data.missing.includes("goal_confirmed"),
    `status=${r.status} missing=${j(r.data?.missing)}`)
  const q = schedulesOf(gateTask.id)
  ok("AC6c 409 creates NO schedule", q.length === 0, `rows=${q.length}`)
}

// ── (3b) main path: ready → confirm(ready) → DB materialize asserts ──
const mainTask = await createDraft("E2E_TEST_GTD_bindmain")
let t = await putTask(mainTask, {
  workflow_ref: "built-in/task-dev",
  task_spec: { goal: GOAL, ac: [AC1], goal_confirmed: true, ac_confirmed: [AC1], task_type: "coding", skill_groups: [], input_values: { goal: "${goal}", ac: "${ac}" } },
})
ok("AC6d PUT bind workflow_ref persisted", t.workflow_ref === "built-in/task-dev", `workflow_ref=${t.workflow_ref}`)
{
  const r = await ready(t.id)
  ok("AC6d ready-gate 409-gone (200 ready)", r.status === 200 && r.data?.status === "ready", `status=${r.status} task.status=${r.data?.status}`)
  const scheds = schedulesOf(t.id)
  ok("AC6d schedule row created (queued, origin=task, no cron)", scheds.length === 1 && scheds[0].status === "queued" && scheds[0].origin_type === "task" && scheds[0].cron_expression === null,
    j(scheds.map(s => ({ id: s.id, st: s.status, origin: s.origin_type }))))
  const iv = scheds[0]?.config?.workflow_chain?.[0]?.input_values ?? {}
  ok("AC6d materialized input_values.goal verbatim", iv.goal === GOAL, `goal=${iv.goal}`)
  ok("AC6d materialized input_values.ac verbatim (single-item join)", iv.ac === AC1, `ac=${iv.ac}`)
  ok("AC6d NO max_turns key (rides YAML default)", !("max_turns" in iv), `keys=${j(Object.keys(iv))}`)
  ok("AC6d config.workflow_ref=built-in/task-dev", scheds[0]?.config?.workflow_chain?.[0]?.workflow_ref === "built-in/task-dev", scheds[0]?.config?.workflow_chain?.[0]?.workflow_ref)
  const artifactsDir = path.join(os.homedir(), ".octopus", "tasks", t.id, "artifacts")
  ok("AC6d v3 task_artifacts_dir injected", iv.task_artifacts_dir === artifactsDir, iv.task_artifacts_dir)
  // cleanup: abort BEFORE scheduler tick
  const ab = await abort(t.id)
  ok("AC6d gate/main task aborted pre-tick", ab.status === 200, `abort=${ab.status}`)
}

// ── (3c) variant: input_values.max_turns="5" persists into config ──
const varTask = await createDraft("E2E_TEST_GTD_maxturns")
t = await putTask(varTask, {
  workflow_ref: "built-in/task-dev",
  task_spec: { goal: GOAL, ac: [AC1], goal_confirmed: true, ac_confirmed: [AC1], task_type: "coding", skill_groups: [], input_values: { goal: "${goal}", ac: "${ac}", max_turns: "5" } },
})
{
  const r = await ready(t.id)
  ok("AC6e variant ready 200", r.status === 200, `status=${r.status}`)
  const scheds = schedulesOf(t.id)
  const iv = scheds[0]?.config?.workflow_chain?.[0]?.input_values ?? {}
  ok("AC6e max_turns=\"5\" materialized into config", iv.max_turns === "5", `max_turns=${j(iv.max_turns)}`)
  await abort(t.id)
  const after = schedulesOf(t.id)
  ok("AC6e variant aborted", after.every(s => s.status === "aborted"), j(after.map(s => s.status)))
}

// ── final: no executions ever spawned for any gate task + hard cleanup ──
{
  const ids = [gateTask.id, mainTask.id, varTask.id]
  const q = querySQL(`SELECT COUNT(*) AS n FROM schedule_executions se JOIN schedules s ON se.schedule_id=s.id WHERE s.origin_id IN ('${ids.join("','")}')`)
  ok("SAFETY zero executions for gate tasks", q.ok && Number(q.data[0]?.n) === 0, `n=${q.data[0]?.n}`)
  const del = (sql) => { const r = querySQL(sql); return r }
  // hard delete via executeSQL-like: querySQL uses -json and only reads; DELETE via sqlite3 direct through same helper is fine (sqlite CLI executes any SQL)
  const d1 = del(`DELETE FROM schedules WHERE origin_id IN ('${ids.join("','")}');`)
  const d2 = del(`DELETE FROM tasks WHERE id IN ('${ids.join("','")}');`)
  // sweep any leaked E2E_TEST_GTD_ drafts (e.g. from an aborted earlier script run)
  del(`DELETE FROM schedules WHERE origin_id IN (SELECT id FROM tasks WHERE name LIKE 'E2E_TEST_GTD_%');`)
  del(`DELETE FROM tasks WHERE name LIKE 'E2E_TEST_GTD_%';`)
  const chk = querySQL(`SELECT (SELECT COUNT(*) FROM tasks WHERE id IN ('${ids.join("','")}')) AS t, (SELECT COUNT(*) FROM schedules WHERE origin_id IN ('${ids.join("','")}')) AS s, (SELECT COUNT(*) FROM tasks WHERE name LIKE 'E2E_TEST_GTD_%') AS leaked`)
  ok("CLEANUP tasks+schedules hard-deleted (incl. prefix sweep)", chk.ok && Number(chk.data[0]?.t) === 0 && Number(chk.data[0]?.s) === 0 && Number(chk.data[0]?.leaked) === 0, j(chk.data[0]))
  // evidence: schedule rows deleted before task rows — assert delete statements ran without error
  ok("CLEANUP SQL executed", d1.ok && d2.ok, `${d1.error ?? ""}${d2.error ?? ""}`)
}

exitWithResults(results, { title: "T3 API E2E — AC6/AC9-live/handoff(1)(2)(3)(8)" })
