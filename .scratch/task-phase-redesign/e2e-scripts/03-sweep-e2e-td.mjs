// .scratch/task-phase-redesign/e2e-scripts/03-sweep-e2e-td.mjs
// 票14 残留清扫：删除 ~/.octopus/db 里 E2E_TD_* 前缀的 tasks/executions/schedules/
// workspaces 行 + 对应 home/ws/fs。task_phase_acceptances 有 append-only trigger
// 挡 DELETE —— 本脚本尽力删（FK off + 绕 trigger 不可行时跳过并登记孤儿行数）。
// 用法: node 03-sweep-e2e-td.mjs
import { DatabaseSync } from "node:sqlite"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const DB = path.join(os.homedir(), ".octopus", "db", "octopus.db")
const db = new DatabaseSync(DB)
db.prepare("PRAGMA busy_timeout = 5000").run()
db.prepare("PRAGMA foreign_keys = OFF").run()
const run = (s, ...p) => { try { db.prepare(s).run(...p) } catch (e) { console.log(`skip [${s.slice(0, 40)}…]: ${e.message}`) } }

// 收集本 org 下 lifecycle/ws fixture 的 execution ids（含打标 + task:E2E_TD ws）
const execs = db.prepare(`SELECT id FROM executions
  WHERE phase_index IS NOT NULL
     OR workspace_id IN (SELECT id FROM workspaces WHERE org='E2E_TD_org' AND name LIKE 'task:E2E_TD%')`).all().map((r) => r.id)
for (const e of execs) {
  run("DELETE FROM agent_events WHERE node_execution_id IN (SELECT id FROM node_executions WHERE execution_id=?)", e)
  run("DELETE FROM node_token_usages WHERE node_execution_id IN (SELECT id FROM node_executions WHERE execution_id=?)", e)
}
if (execs.length) {
  const ph = execs.map(() => "?").join(",")
  run(`DELETE FROM node_executions WHERE execution_id IN (${ph})`, ...execs)
  run(`DELETE FROM llm_calls WHERE execution_id IN (${ph})`, ...execs)
  run(`DELETE FROM execution_summaries WHERE execution_id IN (${ph})`, ...execs)
  run(`DELETE FROM interaction_messages WHERE execution_id IN (${ph})`, ...execs)
}
run(`DELETE FROM executions WHERE phase_index IS NOT NULL
     OR workspace_id IN (SELECT id FROM workspaces WHERE org='E2E_TD_org' AND name LIKE 'task:E2E_TD%')`)

const tids = db.prepare(`SELECT id FROM tasks WHERE name LIKE 'E2E_TD_%' OR org='E2E_TD_org'`).all().map((r) => r.id)
if (tids.length) {
  const ph = tids.map(() => "?").join(",")
  run(`DELETE FROM schedule_executions WHERE schedule_id IN (SELECT id FROM schedules WHERE origin_id IN (${ph}))`, ...tids)
  run(`DELETE FROM schedule_workspaces WHERE schedule_id IN (SELECT id FROM schedules WHERE origin_id IN (${ph}))`, ...tids)
  run(`DELETE FROM schedules WHERE origin_id IN (${ph})`, ...tids)
}
// E2E_TD 相关 workspaces（task 名前缀 + 直造 e2e-td-acc-ws/e2e-td-ws）
run(`DELETE FROM workspaces WHERE (org='E2E_TD_org' AND name LIKE 'task:E2E_TD%') OR name LIKE 'E2E_TD_%' OR name LIKE 'e2e-td-%'`)
// home 目录（先删前记录 id 以便 fs 清理）
const homes = tids.map((t) => path.join(os.homedir(), ".octopus", "tasks", t))
if (tids.length) { const ph = tids.map(() => "?").join(","); run(`DELETE FROM tasks WHERE id IN (${ph})`, ...tids) }
// task_phase_acceptances：trigger 保护，尽力删（会 RAISE）→ 统计孤儿登记
let accBefore = 0, accGone = 0
try { accBefore = db.prepare("SELECT COUNT(*) c FROM task_phase_acceptances").get().c } catch { /* */ }
if (tids.length) {
  const ph = tids.map(() => "?").join(",")
  try { accGone = db.prepare(`DELETE FROM task_phase_acceptances WHERE task_id IN (${ph})`).run(...tids).changes } catch (e) { console.log(`acceptances trigger 拦截（预期）：${e.message}`) }
}
let accAfter = 0
try { accAfter = db.prepare("SELECT COUNT(*) c FROM task_phase_acceptances").get().c } catch { /* */ }
console.log(`task_phase_acceptances: before=${accBefore} deleted=${accGone} after=${accAfter}（trigger 保护，孤儿登记）`)

// 关联 chat sessions（UI 直造 task 的 source_chat_session_id）
try {
  const sids = db.prepare(`SELECT DISTINCT source_chat_session_id s FROM tasks WHERE source_chat_session_id IS NOT NULL`).all().map((r) => r.s)
  void sids // 已随 tasks 删除；sessions 保留（org 隔离），不清用户数据
} catch { /* */ }

db.close()

// fs
for (const h of homes) { if (fs.existsSync(h)) fs.rmSync(h, { recursive: true, force: true }) }
const wsRoot = path.join(os.homedir(), ".octopus", "orgs", "E2E_TD_org", "workspaces")
let wsN = 0
if (fs.existsSync(wsRoot)) for (const d of fs.readdirSync(wsRoot)) if (/E2E_TD|lcmtk|smoke|^e2e-td/.test(d)) { fs.rmSync(path.join(wsRoot, d), { recursive: true, force: true }); wsN++ }
const ed = "/Users/xzf/Projects/ai/XzhiF/open-octopus/.scratch/task-phase-redesign/e2e-data"
let edN = 0
if (fs.existsSync(ed)) for (const d of fs.readdirSync(ed)) {
  if (d.startsWith("lifecycle-evidence")) continue // 保留 R4 证据 json
  const p = path.join(ed, d)
  if (/^git-lc|^smoke|^lc/.test(d) || fs.statSync(p).isDirectory()) { fs.rmSync(p, { recursive: true, force: true }); edN++ }
}
// repos index 去 E2E_TD lifecycle 条目
const IDX = path.join(os.homedir(), ".octopus", "orgs", "E2E_TD_org", "repos", "index.md")
if (fs.existsSync(IDX)) {
  const lines = fs.readFileSync(IDX, "utf-8").split("\n")
  const out = []
  let skip = false
  for (const ln of lines) {
    if (/^### /.test(ln)) { skip = /lcmtk|smoke|e2e-td-lc|pA$|pB$/.test(ln) }
    if (!skip) out.push(ln)
  }
  fs.writeFileSync(IDX, out.join("\n").replace(/\n{3,}/g, "\n\n"))
}
console.log(`fs: homes=${homes.length} wsDirs=${wsN} e2eData=${edN} indexCleaned`)

// 残留核对
const chk = new DatabaseSync(DB)
const left = {
  tasks: chk.prepare("SELECT COUNT(*) c FROM tasks WHERE name LIKE 'E2E_TD_%'").get().c,
  execTagged: chk.prepare("SELECT COUNT(*) c FROM executions WHERE phase_index IS NOT NULL").get().c,
  ws: chk.prepare("SELECT COUNT(*) c FROM workspaces WHERE org='E2E_TD_org' AND name LIKE 'task:E2E_TD%'").get().c,
  sched: chk.prepare("SELECT COUNT(*) c FROM schedules WHERE origin_type='task' AND origin_id IN (SELECT id FROM tasks WHERE name LIKE 'E2E_TD_%')").get().c,
}
chk.close()
console.log("residual:", JSON.stringify(left))
