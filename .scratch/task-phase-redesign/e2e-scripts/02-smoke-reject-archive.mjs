// .scratch/task-phase-redesign/e2e-scripts/02-smoke-reject-archive.mjs
//
// 主故事全序列彩排（API+fs，无浏览器）：
// v4 双 phase（双 project git fixture）→ 入队 → trigger → r1 终态 → home spec
// 编辑 → UI 等价打回（POST acceptance rejected）→ round2 同 ws（seed 反映新
// spec + fix-feedback-r1.md）→ r2 accepted → auto advance phase2 → 终态 →
// accepted（末）→ archiving（ADR 顺延 / 术语 append / 冲突进报告 / commit+push
// 双 project）→ done。

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { DatabaseSync } from "node:sqlite"

const API = process.env.OCTOPUS_SERVER_URL ?? "http://localhost:3001"
const ORG = "E2E_TD_org"
const DATA_DIR = "/Users/xzf/Projects/ai/XzhiF/open-octopus/.scratch/task-phase-redesign/e2e-data"
const RUN = `smoke2-${Date.now()}`
const DB_PATH = path.join(os.homedir(), ".octopus", "db", "octopus.db")
const YMD = (() => { const d = new Date(); const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` })()

const log = (m) => process.stdout.write(`[smoke2] ${m}\n`)
const fail = (m) => { process.stderr.write(`[smoke2] FAIL: ${m}\n`); throw new Error(m) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function sql() { const db = new DatabaseSync(DB_PATH); db.prepare("PRAGMA busy_timeout = 5000").run(); return db }
function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" })
  if (r.status !== 0) fail(`git ${args.join(" ")}: ${r.stderr}`)
  return r.stdout.trim()
}
async function api(method, p, body, headers) {
  const res = await fetch(`${API}${p}`, { method, headers: { "Content-Type": "application/json", ...(headers ?? {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  const text = await res.text()
  let data = null; try { data = JSON.parse(text) } catch { /* */ }
  return { status: res.status, data, text }
}
async function pollExecution(pred, timeoutMs, msg) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const db = sql()
    const rows = db.prepare("SELECT id,status,phase_index,round_index,workspace_id FROM executions WHERE phase_index IS NOT NULL ORDER BY created_at ASC").all()
    db.close()
    const hit = pred(rows)
    if (hit) return hit
    await sleep(1500)
  }
  return fail(`timeout: ${msg}`)
}
const TERM = ["completed", "failed", "error", "cancelled", "completed_with_failures"]

// ── git fixtures ──
const FIX = path.join(DATA_DIR, RUN)
fs.mkdirSync(FIX, { recursive: true })
function makeFixtureRepo(name, { ctx }) {
  const bare = path.join(FIX, `${name}.git`)
  const clone = path.join(FIX, name)
  git(["init", "--bare", "-b", "main", bare])
  git(["clone", bare, clone])
  git(["config", "user.email", "e2e@test.local"], clone)
  git(["config", "user.name", "E2E TD"], clone)
  fs.mkdirSync(path.join(clone, "docs", "adr"), { recursive: true })
  for (const n of [1, 2, 3]) fs.writeFileSync(path.join(clone, "docs", "adr", `000${n}-pre.md`), `# ADR 000${n}\n\n预置 ${n}\n`)
  if (ctx) fs.writeFileSync(path.join(clone, "CONTEXT.md"), "# Context\n\n## 术语表\n\n| Term | Definition |\n|------|-----------|\n| **Widget** | 仓库既有定义（旧义） |\n")
  fs.writeFileSync(path.join(clone, "README.md"), `# ${name}\n`)
  git(["add", "-A"], clone); git(["commit", "-m", "seed"], clone); git(["push", "origin", "main"], clone)
  return { bare, clone }
}
const repoA = makeFixtureRepo(`${RUN}-projA`, { ctx: true })
const repoB = makeFixtureRepo(`${RUN}-projB`, { ctx: false })
if (fs.existsSync(path.join(repoB.clone, "CONTEXT.md"))) { fs.rmSync(path.join(repoB.clone, "CONTEXT.md")); git(["add","-A"],repoB.clone); git(["commit","-m","rm"],repoB.clone); git(["push","origin","main"],repoB.clone) }
const IDX = path.join(os.homedir(), ".octopus", "orgs", ORG, "repos", "index.md")
const idxBefore = fs.readFileSync(IDX, "utf-8")
const projA = `${RUN}-pA`, projB = `${RUN}-pB`
fs.writeFileSync(IDX, idxBefore + `\n### ${projA}\n- local: ${repoA.clone} ✓ cloned\n\n### ${projB}\n- local: ${repoB.clone} ✓ cloned\n`)
log("fixtures ready")

let taskId = null
function cleanup() {
  const db = sql()
  try {
    const execs = db.prepare("SELECT id FROM executions WHERE workspace_id IN (SELECT id FROM workspaces WHERE name LIKE ?)").all(`task:%${RUN}%`).map(r => r.id)
    for (const e of execs) {
      db.prepare("DELETE FROM agent_events WHERE node_execution_id IN (SELECT id FROM node_executions WHERE execution_id=?)").run(e)
      db.prepare("DELETE FROM node_token_usages WHERE node_execution_id IN (SELECT id FROM node_executions WHERE execution_id=?)").run(e)
      db.prepare("DELETE FROM node_executions WHERE execution_id=?").run(e)
    }
    db.prepare("DELETE FROM llm_calls WHERE execution_id IN (SELECT id FROM executions WHERE workspace_id IN (SELECT id FROM workspaces WHERE name LIKE ?))").run(`task:%${RUN}%`)
    db.prepare("DELETE FROM executions WHERE workspace_id IN (SELECT id FROM workspaces WHERE name LIKE ?)").run(`task:%${RUN}%`)
    if (taskId) {
      db.prepare("DELETE FROM schedule_executions WHERE schedule_id IN (SELECT id FROM schedules WHERE origin_id=?)").run(taskId)
      db.prepare("DELETE FROM schedule_workspaces WHERE schedule_id IN (SELECT id FROM schedules WHERE origin_id=?)").run(taskId)
      db.prepare("DELETE FROM schedules WHERE origin_id=?").run(taskId)
      db.prepare("DELETE FROM tasks WHERE id=?").run(taskId)
    }
  } catch (e) { log(`cleanup db: ${e.message}`) }
  db.close()
  try { fs.writeFileSync(IDX, idxBefore) } catch { /* */ }
  fs.rmSync(FIX, { recursive: true, force: true })
  const wsRoot = path.join(os.homedir(), ".octopus", "orgs", ORG, "workspaces")
  if (fs.existsSync(wsRoot)) for (const d of fs.readdirSync(wsRoot)) if (d.includes(RUN)) fs.rmSync(path.join(wsRoot, d), { recursive: true, force: true })
  if (taskId) fs.rmSync(path.join(os.homedir(), ".octopus", "tasks", taskId), { recursive: true, force: true })
}

try {
// ── v4 dual-phase task ──
const t = await api("POST", "/api/tasks", { org: ORG, name: `E2E_TD_${RUN}`, task_type: "coding", skill_groups: [], preset: { org: ORG } })
taskId = t.data.id
const HOME = path.join(os.homedir(), ".octopus", "tasks", taskId)
const slug1 = `${RUN}-p1`, slug2 = `${RUN}-p2`
const batch1 = `.scratch/${YMD}/${slug1}`, batch2 = `.scratch/${YMD}/${slug2}`
for (const [b, n] of [[batch1, "一"], [batch2, "二"]]) {
  fs.mkdirSync(path.join(HOME, b, "issues"), { recursive: true })
  fs.writeFileSync(path.join(HOME, b, "spec.md"), `# phase${n} spec\n\nE2E_TD 彩排\n`)
  fs.writeFileSync(path.join(HOME, b, "issues", "1-ticket.md"), `# 票1\n\nStatus: ready-for-agent\n`)
}
fs.mkdirSync(path.join(HOME, "workflows"), { recursive: true })
fs.writeFileSync(path.join(HOME, "workflows", "e2e-td-smoke.yaml"),
  `apiVersion: octopus/v1\nkind: Workflow\nname: e2e-td-smoke\ninputs:\n  batch_dir:\n    description: "batch dir"\n    required: true\nnodes:\n  - id: stub\n    type: bash\n    timeout: 60\n    bash: |\n      set -e\n      echo "E2E_TD_DONE $(date +%s)" > "$vars.batch_dir/exec-report.md"\n`)
// home 归档面输入
fs.mkdirSync(path.join(HOME, "docs", "adr", projA), { recursive: true })
fs.writeFileSync(path.join(HOME, "docs", "adr", projA, "0001-pick-db.md"), `# ADR 选库\n\n选 sqlite。\n`)
fs.mkdirSync(path.join(HOME, "docs", "adr", projB), { recursive: true })
fs.writeFileSync(path.join(HOME, "docs", "adr", projB, "0001-add-cache.md"), `# ADR 加缓存\n\nredis。\n`)
fs.writeFileSync(path.join(HOME, "context-notes.md"),
  `# E2E_TD 术语笔记\n\n## ${projA}\n- **Gizmo** — E2E_TD projA 新词\n- **Widget** — E2E_TD 冲突新定义\n\n## ${projB}\n- **Sprocket** — E2E_TD projB 新词\n`)
const put = await api("PUT", `/api/tasks/${taskId}`, {
  task_spec: { format: "v4", goal: `E2E_TD 彩排 ${RUN}`, autoAdvance: true,
    phases: [
      { index: 1, name: "阶段一", slug: slug1, specPath: `${batch1}/spec.md`, workflowRef: "e2e-td-smoke", inputValues: { batch_dir: batch1 } },
      { index: 2, name: "阶段二", slug: slug2, specPath: `${batch2}/spec.md`, workflowRef: "e2e-td-smoke", inputValues: { batch_dir: batch2 } },
    ], resources: [], authoring_resources: [] },
  project_ids: [projA, projB],
}, { "If-Match": String(t.data.version) })
if (put.status !== 200) fail(`PUT ${put.status} ${put.text}`)
const rdy = await api("POST", `/api/tasks/${taskId}/ready`)
if (rdy.status !== 200) fail(`ready ${rdy.status} ${rdy.text}`)
const trig = await api("POST", `/api/tasks/${taskId}/trigger`)
if (trig.status !== 200) fail(`trigger ${trig.status} ${trig.text}`)
log("enqueued + triggered")

// ── r1 terminal ──
const r1 = await pollExecution((rows) => rows.find((e) => e.phase_index === 1 && e.round_index === 1 && TERM.includes(e.status)), 180_000, "r1 terminal")
if (r1.status !== "completed") fail(`r1 status ${r1.status}`)
log(`r1 done ${r1.id.slice(0, 8)} ws=${r1.workspace_id.slice(0, 8)}`)
// derived awaiting_review
let d = await api("GET", `/api/tasks/${taskId}`)
if (!d.data.derived || !d.data.derived.phaseViews) fail(`no derived: ${d.text.slice(0, 200)}`)
let pv = d.data.derived.phaseViews[0]
if (pv.status !== "awaiting_review" || pv.awaitingRound !== 1) fail(`phase1 derived=${pv.status} round=${pv.awaitingRound}`)
log("derived awaiting_review(1,1) ✓")

// ── home spec 编辑 → 打回 round2 ──
const specAbs = path.join(HOME, batch1, "spec.md")
fs.writeFileSync(specAbs, fs.readFileSync(specAbs, "utf-8") + "\nE2E_TD_SPEC_R2_EDIT\n")
const rej = await api("POST", `/api/tasks/${taskId}/acceptance`, { phase_index: 1, round_index: 1, decision: "rejected", feedback: "E2E_TD 路由没接上，请修复" })
if (rej.status !== 200) fail(`reject ${rej.status} ${rej.text}`)
log(`rejected ok dispatch=(${rej.data.dispatch?.phase_index},${rej.data.dispatch?.round_index}) ws=${rej.data.dispatch?.workspace_id?.slice(0,8)} same=${rej.data.dispatch?.workspace_id === r1.workspace_id}`)
if (rej.data.dispatch?.workspace_id !== r1.workspace_id) fail("round2 on DIFFERENT ws — 复用失败")
// fix-feedback + seed 断言（同 ws）
const ffHome = path.join(HOME, batch1, "fix-feedback-r1.md")
if (!fs.existsSync(ffHome)) fail("fix-feedback-r1.md missing in home")
const db = sql(); const wrow = db.prepare("SELECT path FROM workspaces WHERE id=?").get(r1.workspace_id); db.close()
const WSP = wrow.path
if (!fs.existsSync(path.join(WSP, batch1, "fix-feedback-r1.md"))) fail("fix-feedback not seeded to ws")
const wsSpec = fs.readFileSync(path.join(WSP, batch1, "spec.md"), "utf-8")
if (!wsSpec.includes("E2E_TD_SPEC_R2_EDIT")) fail("round2 seed did not reflect home spec edit")
const wsCount = sql().prepare("SELECT COUNT(*) c FROM workspaces WHERE org=? AND name LIKE ?").get(ORG, `task:%${RUN}%`).c
if (wsCount !== 1) fail(`ws count ${wsCount} != 1`)
log("seed-override + fix-feedback + ws-reuse ✓")

const r2 = await pollExecution((rows) => rows.find((e) => e.phase_index === 1 && e.round_index === 2 && TERM.includes(e.status)), 180_000, "r2 terminal")
if (r2.status !== "completed") fail(`r2 ${r2.status}`)
d = await api("GET", `/api/tasks/${taskId}`)
pv = d.data.derived.phaseViews[0]
if (pv.status !== "awaiting_review" || pv.awaitingRound !== 2) fail(`phase1 after r2: ${pv.status}/${pv.awaitingRound}`)
log("r2 awaiting_review ✓")

// ── accepted → auto phase2 ──
const acc = await api("POST", `/api/tasks/${taskId}/acceptance`, { phase_index: 1, round_index: 2, decision: "accepted" })
if (acc.status !== 200 || acc.data.next_action !== "dispatched") fail(`accept1 ${acc.status} ${acc.data?.next_action} ${acc.text}`)
if (acc.data.dispatch?.phase_index !== 2) fail("auto advance did not dispatch phase2")
log("auto_advance → phase2 dispatched")
const p2 = await pollExecution((rows) => rows.find((e) => e.phase_index === 2 && e.round_index === 1 && TERM.includes(e.status)), 180_000, "p2r1 terminal")
if (p2.status !== "completed") fail(`p2 ${p2.status}`)
d = await api("GET", `/api/tasks/${taskId}`)
pv = d.data.derived.phaseViews[1]
if (pv.status !== "awaiting_review") fail(`phase2 derived ${pv.status}`)
if (p2.workspace_id !== r1.workspace_id) fail("phase2 on different ws!")
log("phase2 awaiting_review on SAME ws ✓")

// ── 末 accepted → archiving → done ──
const acc2 = await api("POST", `/api/tasks/${taskId}/acceptance`, { phase_index: 2, round_index: 1, decision: "accepted" })
if (acc2.status !== 200 || acc2.data.next_action !== "archiving") fail(`final accept ${acc2.status} ${acc2.data?.next_action} ${acc2.text}`)
let fin = null
const t1 = Date.now()
while (Date.now() - t1 < 90_000) {
  const dd = sql()
  fin = dd.prepare("SELECT status, completed_at FROM tasks WHERE id=?").get(taskId)
  dd.close()
  if (fin.status === "done") break
  await sleep(1500)
}
log(`final status=${fin.status} completed_at=${fin.completed_at}`)
if (fin.status !== "done") fail("not done after archiving")

// ── git 归档证据 ──
function assertWt(projName, bare, expectAdr, termNew, oldDefLine) {
  const wt = path.join(WSP, "projects", projName)
  const adrs = fs.readdirSync(path.join(wt, "docs", "adr")).filter((f) => /^\d{4}-.*\.md$/.test(f)).sort()
  const synced = adrs.filter((f) => fs.readFileSync(path.join(wt, "docs", "adr", f), "utf-8").includes("Synced from task"))
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], wt)
  const head = git(["log", "-1", "--pretty=%s"], wt)
  const bareBranch = git(["ls-remote", bare, branch], FIX)
  const ctx = fs.readFileSync(path.join(wt, "CONTEXT.md"), "utf-8")
  log(`${projName}: adrs=[${adrs.join(",")}] synced=[${synced.join(",")}] HEAD="${head}" pushed=${!!bareBranch}`)
  if (!synced.some((f) => f === expectAdr)) fail(`${projName} missing ${expectAdr}`)
  if (!/^chore\(archive\): .+ syncback \d{8}$/.test(head)) fail(`${projName} HEAD not archive commit: ${head}`)
  if (!bareBranch) fail(`${projName} archive branch not in bare`)
  if (!ctx.includes(termNew)) fail(`${projName} CONTEXT.md missing term ${termNew}`)
  if (oldDefLine && !ctx.includes(oldDefLine)) fail(`${projName} existing term line was touched`)
  return { ctx, synced }
}
const a = assertWt(projA, repoA.bare, "0004-pick-db.md", "Gizmo", "仓库既有定义（旧义）")
assertWt(projB, repoB.bare, "0004-add-cache.md", "Sprocket", null)
if (!a.ctx.includes("Gizmo") ) fail("no Gizmo")
if (a.ctx.includes("E2E_TD 冲突新定义")) fail("conflicting Widget definition was WRITTEN (must be conflict-only)")
const report = path.join(HOME, "archive", "report.md")
if (!fs.existsSync(report)) fail("archive report.md missing")
const repTxt = fs.readFileSync(report, "utf-8")
if (!repTxt.includes("Widget")) fail("report.md missing conflict term Widget")
const state = JSON.parse(fs.readFileSync(path.join(HOME, "archive", "state.json"), "utf-8"))
log(`state.json projects: ${Object.entries(state.projects).map(([k, v]) => `${k}=${v.status}`).join(", ")}`)
log("SMOKE2 PASS ✔ full reject/archive story works")
} finally { cleanup() }
