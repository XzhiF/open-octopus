// .scratch/task-phase-redesign/e2e-scripts/04-smoke-ws-delete-500.mjs
// 复现：v4 任务走到 done 后 DELETE /api/workspaces/:id → 500 根因定位。
// 复用 02-smoke 的最小链：1-phase + 1 project fixture → trigger → terminal →
// accept(末, 即 archiving→done) → API DELETE ws → 打印响应体。

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { DatabaseSync } from "node:sqlite"

const API = process.env.OCTOPUS_SERVER_URL ?? "http://localhost:3001"
const ORG = "E2E_TD_org"
const DATA_DIR = "/Users/xzf/Projects/ai/XzhiF/open-octopus/.scratch/task-phase-redesign/e2e-data"
const RUN = `wsdel-${Date.now()}`
const DB_PATH = path.join(os.homedir(), ".octopus", "db", "octopus.db")
const log = (m) => process.stdout.write(`[wsdel] ${m}\n`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function sql() { const db = new DatabaseSync(DB_PATH); db.prepare("PRAGMA busy_timeout = 5000").run(); return db }
function git(args, cwd) { const r = spawnSync("git", args, { cwd, encoding: "utf-8" }); if (r.status !== 0) throw new Error(`git ${args}: ${r.stderr}`); return r.stdout.trim() }
async function api(method, p, body, headers) {
  const res = await fetch(`${API}${p}`, { method, headers: { "Content-Type": "application/json", ...(headers ?? {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  const text = await res.text(); let data = null; try { data = JSON.parse(text) } catch { /* */ }
  return { status: res.status, data, text }
}

const FIX = path.join(DATA_DIR, RUN)
fs.mkdirSync(FIX, { recursive: true })
const bare = path.join(FIX, "p.git"), clone = path.join(FIX, "p")
git(["init", "--bare", "-b", "main", bare], FIX)
git(["clone", bare, clone], FIX)
git(["config", "user.email", "e@t.local"], clone); git(["config", "user.name", "E"], clone)
fs.writeFileSync(path.join(clone, "README.md"), "x\n")
git(["add", "-A"], clone); git(["commit", "-m", "s"], clone); git(["push", "origin", "main"], clone)
const PROJ = `${RUN}-p`
const IDX = path.join(os.homedir(), ".octopus", "orgs", ORG, "repos", "index.md")
const idxBefore = fs.readFileSync(IDX, "utf-8")
fs.writeFileSync(IDX, `${idxBefore}\n### ${PROJ}\n- local: ${clone} ✓ cloned\n`)
let taskId = null
try {
  const t = await api("POST", "/api/tasks", { org: ORG, name: `E2E_TD_${RUN}`, task_type: "coding", skill_groups: [], preset: { org: ORG } })
  taskId = t.data.id
  const HOME = path.join(os.homedir(), ".octopus", "tasks", taskId)
  const rel = `.scratch/20260903/${RUN}`
  fs.mkdirSync(path.join(HOME, rel), { recursive: true })
  fs.writeFileSync(path.join(HOME, rel, "spec.md"), "# spec\n")
  fs.mkdirSync(path.join(HOME, "workflows"), { recursive: true })
  fs.writeFileSync(path.join(HOME, "workflows", "e2e-td-wsdel.yaml"), `apiVersion: octopus/v1\nkind: Workflow\nname: e2e-td-wsdel\ninputs:\n  batch_dir:\n    description: "b"\n    required: true\nnodes:\n  - id: b\n    type: bash\n    timeout: 30\n    bash: echo x > "$vars.batch_dir/out.md"\n`)
  const put = await api("PUT", `/api/tasks/${taskId}`, { task_spec: { format: "v4", goal: "E2E_TD wsdel", autoAdvance: true, phases: [{ index: 1, name: "一", slug: RUN, specPath: `${rel}/spec.md`, workflowRef: "e2e-td-wsdel", inputValues: { batch_dir: rel } }], resources: [], authoring_resources: [] }, project_ids: [PROJ] }, { "If-Match": String(t.data.version) })
  if (put.status !== 200) throw new Error(`put ${put.status} ${put.text}`)
  const rdy = await api("POST", `/api/tasks/${taskId}/ready`)
  log(`ready → ${rdy.status} ${rdy.text.slice(0, 200)}`)
  if (rdy.status !== 200) throw new Error(`ready failed ${rdy.status}`)
  const trg = await api("POST", `/api/tasks/${taskId}/trigger`)
  log(`trigger → ${trg.status} ${trg.text.slice(0, 200)}`)
  if (trg.status !== 200) throw new Error(`trigger failed ${trg.status}`)
  let exec = null
  for (let i = 0; i < 90; i++) {
    const db = sql(); exec = db.prepare(`SELECT e.id, e.status, e.workspace_id FROM executions e WHERE e.phase_index IS NOT NULL AND e.id IN (SELECT se.execution_id FROM schedule_executions se JOIN schedules s ON s.id=se.schedule_id WHERE s.origin_id=?)`).get(taskId); db.close()
    if (exec && ["completed", "failed"].includes(exec.status)) break
    await sleep(2000)
  }
  if (!exec || exec.status !== "completed") {
    const db = sql()
    const scheds = db.prepare("SELECT * FROM schedules WHERE origin_id=?").all(taskId)
    const sexecs = db.prepare("SELECT * FROM schedule_executions WHERE schedule_id IN (SELECT id FROM schedules WHERE origin_id=?)").all(taskId)
    const allExecs = db.prepare("SELECT id,status,phase_index,workspace_id FROM executions WHERE workspace_id IN (SELECT id FROM workspaces WHERE name LIKE ?)").all(`%${RUN}%`)
    log(`diagnostics scheds=${JSON.stringify(scheds.map((s) => ({ id: s.id, status: s.status, ws: s.workspace_id })))} sched_execs=${JSON.stringify(sexecs.map((s) => ({ st: s.status, err: s.error_summary, ws: s.workspace_id })))} execs=${JSON.stringify(allExecs)}`)
    db.close()
    throw new Error(`exec ${exec?.status ?? "none"}`)
  }
  const wsId = exec.workspace_id
  const acc = await api("POST", `/api/tasks/${taskId}/acceptance`, { phase_index: 1, round_index: 1, decision: "accepted" })
  log(`accept → ${acc.status} ${acc.data?.next_action}`)
  let status = ""
  for (let i = 0; i < 40; i++) { const db = sql(); status = db.prepare("SELECT status FROM tasks WHERE id=?").get(taskId).status; db.close(); if (status === "done") break; await sleep(1500) }
  log(`task done=${status === "done"}`)
  // —— 复现点 ——
  const del = await api("DELETE", `/api/workspaces/${wsId}`)
  log(`DELETE /api/workspaces/${wsId} → ${del.status} ${del.text.slice(0, 500)}`)
  // DB 侧引用核对（若 500，找出还引用 ws 的行）
  const db = sql()
  const refs = {
    executions: db.prepare("SELECT COUNT(*) c FROM executions WHERE workspace_id=?").get(wsId).c,
    schedules_by_ws: db.prepare("SELECT COUNT(*) c FROM schedules WHERE workspace_id=?").get(wsId).c,
    sched_ws: db.prepare("SELECT COUNT(*) c FROM schedule_workspaces WHERE workspace_id=?").get(wsId).c,
    schedule_execs_ws: db.prepare("SELECT COUNT(*) c FROM schedule_executions WHERE workspace_id=?").get(wsId).c,
    opt_sugg: db.prepare("SELECT COUNT(*) c FROM optimization_suggestions WHERE workspace_id=?").get(wsId).c,
    task_workspace_id: db.prepare("SELECT workspace_id FROM tasks WHERE id=?").get(taskId).workspace_id,
  }
  db.close()
  log(`post-500 refs: ${JSON.stringify(refs)}`)
  // 若删失败，手动走一遍 cascade 看哪步炸（外键 ON 的独立连接）。
  // FK-ON 下 schedule_executions.execution_id → executions(NO ACTION) 会先炸在
  // 「DELETE FROM executions」—— 即 cascadeDeleteByWorkspace 的 schedules 子查询
  // 以 schedules.workspace_id 为键，而 task 信封行该列为 NULL（绑定存于
  // schedule_workspaces + tasks.workspace_id），故桥表行未被清，executions 删不动。
  const db2 = new DatabaseSync(DB_PATH)
  db2.prepare("PRAGMA foreign_keys = ON").run()
  const stmts = [
    ["chat-data", "DELETE FROM chat_messages WHERE session_id IN (SELECT id FROM chat_sessions WHERE workspace_id=?)"],
    ["opt", "DELETE FROM optimization_suggestions WHERE workspace_id = ?"],
    ["pipeline", "DELETE FROM pipeline_state WHERE workspace_id = ?"],
    ["sched_exec(by schedules.ws)", "DELETE FROM schedule_executions WHERE schedule_id IN (SELECT id FROM schedules WHERE workspace_id = ?)"],
    ["sched_ws(by schedules.ws)", "DELETE FROM schedule_workspaces WHERE schedule_id IN (SELECT id FROM schedules WHERE workspace_id = ?)"],
    ["executions(FK block?)", "DELETE FROM executions WHERE workspace_id = ?"],
    ["del_ws", "DELETE FROM workspaces WHERE id = ?"],
  ]
  for (const [name, s] of stmts) {
    try { const c = db2.prepare(s).run(wsId).changes; log(`  manual ${name}: ok (${c})`) } catch (e) { log(`  manual ${name}: ${e.message}`) }
  }
  db2.close()
} finally {
  fs.writeFileSync(IDX, idxBefore)
  fs.rmSync(FIX, { recursive: true, force: true })
  if (taskId) {
    const db = new DatabaseSync(DB_PATH)
    db.prepare("PRAGMA foreign_keys=OFF").run()
    const run = (s, ...p) => { try { db.prepare(s).run(...p) } catch { /* */ } }
    const execIds = db.prepare(`SELECT e.id FROM executions e WHERE e.workspace_id IN (SELECT id FROM workspaces WHERE name LIKE ?)`).all(`%${RUN}%`).map((r) => r.id)
    for (const e of execIds) { run("DELETE FROM agent_events WHERE node_execution_id IN (SELECT id FROM node_executions WHERE execution_id=?)", e); run("DELETE FROM node_executions WHERE execution_id=?", e) }
    run("DELETE FROM executions WHERE workspace_id IN (SELECT id FROM workspaces WHERE name LIKE ?)", `%${RUN}%`)
    if (taskId) {
      run("DELETE FROM schedule_executions WHERE schedule_id IN (SELECT id FROM schedules WHERE origin_id=?)", taskId)
      run("DELETE FROM schedule_workspaces WHERE schedule_id IN (SELECT id FROM schedules WHERE origin_id=?)", taskId)
      run("DELETE FROM schedules WHERE origin_id=?", taskId)
      run("DELETE FROM task_phase_acceptances WHERE task_id=?", taskId)
      run("DELETE FROM tasks WHERE id=?", taskId)
    }
    run("DELETE FROM workspaces WHERE name LIKE ?", `%${RUN}%`)
    db.close()
    fs.rmSync(path.join(os.homedir(), ".octopus", "tasks", taskId), { recursive: true, force: true })
    const wsRoot = path.join(os.homedir(), ".octopus", "orgs", ORG, "workspaces")
    if (fs.existsSync(wsRoot)) for (const d of fs.readdirSync(wsRoot)) if (d.includes(RUN)) fs.rmSync(path.join(wsRoot, d), { recursive: true, force: true })
  }
  log("cleanup done")
}
