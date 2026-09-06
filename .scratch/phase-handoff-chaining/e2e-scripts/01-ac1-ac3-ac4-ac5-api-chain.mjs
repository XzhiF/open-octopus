// .scratch/phase-handoff-chaining/e2e-scripts/01-ac1-ac3-ac4-ac5-api-chain.mjs
//
// 票05 E2E — AC1/AC3/AC4/AC5：prev_handoff_paths 注入的部署态四方交叉
// （API ↔ DB envelope ↔ home fs ↔ 执行运行时回写），零真 LLM（bash stub 流，
// 票14 smoke-chain 同法）。
//
// 主剧本（Task A, AC1+AC3）：
//   v4 双 phase 任务 → phase1 批次预置 handoff.md（模拟 ship+collect 已完成）
//   → ready → trigger（首建 ws + bash stub 真执行 r1）→ r1 completed 待验收
//   → AC3: GET home-file?list=1 含 handoff.md
//   → POST acceptance(phase1,r1,accepted) → 200 next_action=dispatched
//   → AC1: DB envelope chain[0].input_values.prev_handoff_paths ===
//     phase1 handoff.md home 绝对路径 ∧ fs existsSync ∧ 内容=预置字节
//   → phase2 r1 终态 → collect 回流 home 的 runtime-prev-handoff.txt
//     内容 === 注入路径（运行时送达证明）。
// 反例剧本（Task B, AC4）：phase1 无 handoff.md → accept 200（不 500）且
//   chain[0].input_values 不含 prev_handoff_paths 键（静默降级）。
// AC5：全清（任务/信封/执行/ws 行 + home/ws 目录）+ health 200 全程。
//
// 用法: node 01-ac1-ac3-ac4-ac5-api-chain.mjs   （server :3001 在跑）
// 证据: <artifacts>/e2e-data/  前缀 AC1*/AC3*/AC4*/AC5*。

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { DatabaseSync } from "node:sqlite"

const API = process.env.OCTOPUS_SERVER_URL ?? "http://localhost:3001"
const ORG = "E2E_TD_org"
const ARTIFACTS =
  process.env.E2E_ARTIFACTS_DIR ??
  path.join("C:", "xzf", "ai", "open-octopus", ".scratch", "phase-handoff-chaining")
const DATA = path.join(ARTIFACTS, "e2e-data")
const DB_PATH = process.env.OCTOPUS_DB_PATH ?? path.join(os.homedir(), ".octopus", "db", "octopus.db")
const RUN = `ho-${Date.now()}`
const YMD = (() => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
})()
const TERM = ["completed", "failed", "error", "cancelled", "completed_with_failures"]
const HANDOFF_MARKER = "E2E_TD_PHASEHANDOFF_HANDOFF_V1"
const CHAIN_KEY = "prev_handoff_paths"

const log = (m) => process.stdout.write(`[ac-chain] ${m}\n`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const record = (ac, pass, detail) => {
  results.push({ ac, pass, detail })
  process.stdout.write(`[ac-chain] ${pass ? "PASS" : "FAIL"} ${ac} — ${detail}\n`)
}
const writeEvidence = (name, obj) => {
  fs.mkdirSync(DATA, { recursive: true })
  const p = path.join(DATA, name)
  fs.writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj, null, 2), "utf-8")
  return p
}

function sql() {
  const db = new DatabaseSync(DB_PATH)
  db.prepare("PRAGMA busy_timeout = 5000").run()
  return db
}

async function api(method, p, body, headers) {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let data = null
  try { data = JSON.parse(text) } catch { /* keep text */ }
  return { status: res.status, data, text }
}

function envelopeOf(taskId) {
  const db = sql()
  try {
    const row = db
      .prepare("SELECT id, config, status, updated_at FROM schedules WHERE origin_type='task' AND origin_id=? AND origin_role='primary'")
      .get(taskId)
    if (!row) return null
    const cfg = JSON.parse(row.config)
    return { scheduleId: row.id, status: row.status, config: cfg }
  } finally { db.close() }
}

async function waitTaggedExec(taskId, phase, round, timeoutMs) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const db = sql()
    const row = db
      .prepare(
        `SELECT e.id, e.status, e.workspace_id, e.created_at
           FROM executions e
           JOIN schedule_executions se ON se.execution_id = e.id
           JOIN schedules s ON s.id = se.schedule_id
          WHERE s.origin_type='task' AND s.origin_id=? AND e.phase_index=? AND e.round_index=?
          ORDER BY e.created_at DESC LIMIT 1`,
      )
      .get(taskId, phase, round)
    db.close()
    if (row && TERM.includes(row.status)) return row
    await sleep(3000)
  }
  return null
}

// ── git fixture + org index.md 条目（票14 smoke-chain 同法）：v4 首建 ws 的
//    projects 由 materialize 自 project_ids 生成且 source_path 为空 ⇒ 必须能
//    经 ~/.octopus/orgs/{org}/repos/index.md 解析到本地 git 仓库（E-claim 探针
//    实证：缺条目时 claim→「repo 'default' not found in index.md」，首执行
//    永无 executions 行）。测毕恢复 index.md + 删 fixture。
function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" })
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`)
  return r.stdout.trim()
}
const FIX = path.join(DATA, RUN)
const PROJ = `e2e-td-ho-${RUN}`
const IDX = path.join(os.homedir(), ".octopus", "orgs", ORG, "repos", "index.md")
let idxBefore = null
function makeGitFixture() {
  fs.mkdirSync(DATA, { recursive: true })
  const bare = path.join(FIX, `${PROJ}.git`)
  const clone = path.join(FIX, PROJ)
  git(["init", "--bare", "-b", "main", bare])
  git(["clone", bare, clone])
  git(["config", "user.email", "e2e@test.local"], clone)
  git(["config", "user.name", "E2E TD"], clone)
  fs.writeFileSync(path.join(clone, "README.md"), `# ${PROJ}\n`)
  git(["add", "-A"], clone); git(["commit", "-m", "seed"], clone); git(["push", "origin", "main"], clone)
  idxBefore = fs.existsSync(IDX) ? fs.readFileSync(IDX, "utf-8") : ""
  fs.mkdirSync(path.dirname(IDX), { recursive: true })
  fs.writeFileSync(IDX, `${idxBefore}${idxBefore && !idxBefore.endsWith("\n") ? "\n" : ""}\n### ${PROJ}\n- local: ${clone} ✓ cloned\n`)
  log(`git fixture ${PROJ} @ ${clone}`)
}
function restoreGitFixture() {
  const problems = []
  try { if (idxBefore !== null) fs.writeFileSync(IDX, idxBefore) } catch (e) { problems.push(`index.md: ${e.message}`) }
  try { fs.rmSync(FIX, { recursive: true, force: true }) } catch (e) { problems.push(`rm fix: ${e.message}`) }
  return problems
}

// ── 任务构造 ────────────────────────────────────────────────────────────
const state = [] // {taskId, home, wsPath, slug1, slug2, batch1Rel, batch2Rel, handoffAbs}

function stubWorkflowYaml() {
  // 单一 stub 流绑两 phase：把 $inputs.prev_handoff_paths 原样落
  // {batch}/runtime-prev-handoff.txt（collect 回流 home = 运行时送达证据）。
  return [
    "apiVersion: octopus/v1",
    "kind: Workflow",
    "name: e2e-td-ho",
    "inputs:",
    "  batch_dir:",
    '    description: "批次目录（ws 同构相对位）"',
    "    required: true",
    "  prev_handoff_paths:",
    '    description: "已 accepted 前序 handoff.md 绝对路径（server 内置注入键）"',
    "    required: false",
    "nodes:",
    "  - id: probe",
    "    type: bash",
    "    timeout: 60",
    "    bash: |",
    "      set -e",
    "      PH='$inputs.prev_handoff_paths'",
    '      printf \'%s\' "$PH" > "$inputs.batch_dir/runtime-prev-handoff.txt"',
    '      echo "E2E_TD_HO_DONE $(date +%s)" > "$inputs.batch_dir/exec-report.md"',
    "",
  ].join("\n")
}

function handoffBody(taskId, batch1Abs) {
  return [
    `# handoff · 阶段一 (r1) — ${HANDOFF_MARKER}`,
    "",
    `- task: ${taskId}`,
    "- phase: 1 · round: 1 · PR: E2E_TD-fake-pr",
    `- batch: ${batch1Abs}`,
    "",
    "## Protected Decisions",
    `- ${HANDOFF_MARKER}：prev_handoff_paths 走 server 内置注入键（K3），信封不动。`,
    "",
    "## Confirmed Interfaces",
    "- packages/server/src/services/tasks/tasks-service.ts::collectPrevHandoffPaths（给路径不给描述）",
    "",
    "## Gap Targets",
    "- 真 LLM 深验 SKIP（成本口径），由本 E2E 的编程式交叉 + simulate mock 覆盖。",
    "",
  ].join("\n")
}

async function makeTask(variant, { withHandoff }) {
  const name = `E2E_TD_PHASEHANDOFF_${variant}_${RUN}`
  const t = await api("POST", "/api/tasks", {
    org: ORG, name, task_type: "coding", skill_groups: [], preset: { org: ORG },
  })
  if (t.status !== 201 && t.status !== 200) throw new Error(`create ${t.status} ${t.text}`)
  const taskId = t.data.id
  const home = path.join(os.homedir(), ".octopus", "tasks", taskId)
  if (!fs.existsSync(home)) throw new Error(`home missing at ${home}`)
  const slug1 = `e2e-td-ho-p1-${RUN}`
  const slug2 = `e2e-td-ho-p2-${RUN}`
  const batch1Rel = `.scratch/${YMD}/${slug1}`
  const batch2Rel = `.scratch/${YMD}/${slug2}`
  const batch1Abs = path.join(home, ".scratch", YMD, slug1)
  const batch2Abs = path.join(home, ".scratch", YMD, slug2)
  fs.mkdirSync(path.join(batch1Abs, "issues"), { recursive: true })
  fs.mkdirSync(path.join(batch2Abs, "issues"), { recursive: true })
  fs.writeFileSync(path.join(batch1Abs, "spec.md"), `# 阶段一 spec\n\n${name}\n`)
  fs.writeFileSync(path.join(batch1Abs, "issues", "01-one.md"), `# 票1\n\nStatus: ready-for-agent\n`)
  fs.writeFileSync(path.join(batch2Abs, "spec.md"), `# 阶段二 spec\n\n${name}\n`)
  fs.writeFileSync(path.join(batch2Abs, "issues", "01-two.md"), `# 票2\n\nStatus: ready-for-agent\n`)
  const handoffAbs = path.join(batch1Abs, "handoff.md")
  if (withHandoff) fs.writeFileSync(handoffAbs, handoffBody(taskId, batch1Abs), "utf-8")
  fs.mkdirSync(path.join(home, "workflows"), { recursive: true })
  fs.writeFileSync(path.join(home, "workflows", "e2e-td-ho.yaml"), stubWorkflowYaml(), "utf-8")
  const put = await api("PUT", `/api/tasks/${taskId}`, {
    task_spec: {
      format: "v4", goal: name, autoAdvance: true,
      phases: [
        { index: 1, name: "阶段一", slug: slug1, specPath: `${batch1Rel}/spec.md`, workflowRef: "e2e-td-ho", inputValues: { batch_dir: "${phase.batch_rel}" } },
        { index: 2, name: "阶段二", slug: slug2, specPath: `${batch2Rel}/spec.md`, workflowRef: "e2e-td-ho", inputValues: { batch_dir: "${phase.batch_rel}" } },
      ],
      resources: [], authoring_resources: [],
    },
    project_ids: [PROJ],
  }, { "If-Match": String(t.data.version) })
  if (put.status !== 200) throw new Error(`PUT ${put.status} ${put.text}`)
  const rdy = await api("POST", `/api/tasks/${taskId}/ready`)
  if (rdy.status !== 200) throw new Error(`ready ${rdy.status} ${rdy.text}`)
  const trig = await api("POST", `/api/tasks/${taskId}/trigger`)
  if (trig.status !== 200) throw new Error(`trigger ${trig.status} ${trig.text}`)
  const entry = { taskId, home, slug1, slug2, batch1Rel, batch2Rel, batch1Abs, batch2Abs, handoffAbs, wsPath: null }
  state.push(entry)
  log(`${variant}: task ${taskId} enqueued+triggered`)
  return entry
}

// ── 清理（AC5）──────────────────────────────────────────────────────────
function cleanupTask(entry) {
  const problems = []
  const db = sql()
  try {
    const wsRow = db.prepare("SELECT w.id, w.path FROM workspaces w JOIN tasks t ON t.workspace_id = w.id WHERE t.id=?").get(entry.taskId)
    const execs = db
      .prepare(
        `SELECT DISTINCT e.id FROM executions e
          WHERE e.id IN (SELECT se.execution_id FROM schedule_executions se
                           JOIN schedules s ON s.id = se.schedule_id
                          WHERE s.origin_type='task' AND s.origin_id=?)
             OR e.workspace_id = ?`,
      )
      .all(entry.taskId, wsRow?.id ?? "__none__")
      .map((r) => r.id)
    for (const e of execs) {
      db.prepare("DELETE FROM agent_events WHERE node_execution_id IN (SELECT id FROM node_executions WHERE execution_id=?)").run(e)
      db.prepare("DELETE FROM node_token_usages WHERE node_execution_id IN (SELECT id FROM node_executions WHERE execution_id=?)").run(e)
      db.prepare("DELETE FROM interaction_messages WHERE execution_id=?").run(e)
      db.prepare("DELETE FROM node_edges WHERE execution_id=?").run(e)
      db.prepare("DELETE FROM execution_summaries WHERE execution_id=?").run(e)
      db.prepare("DELETE FROM node_executions WHERE execution_id=?").run(e)
      db.prepare("DELETE FROM llm_calls WHERE execution_id=?").run(e)
    }
    db.prepare("DELETE FROM schedule_executions WHERE schedule_id IN (SELECT id FROM schedules WHERE origin_type='task' AND origin_id=?)").run(entry.taskId)
    db.prepare("DELETE FROM schedule_workspaces WHERE schedule_id IN (SELECT id FROM schedules WHERE origin_type='task' AND origin_id=?)").run(entry.taskId)
    if (execs.length) {
      const ph = execs.map(() => "?").join(",")
      db.prepare(`DELETE FROM executions WHERE id IN (${ph})`).run(...execs)
    }
    entry.execIds = [...execs]
    db.prepare("DELETE FROM schedules WHERE origin_type='task' AND origin_id=?").run(entry.taskId)
    if (wsRow) {
      entry.wsPath = entry.wsPath ?? wsRow.path ?? null
      entry.wsId = wsRow.id
      db.prepare("DELETE FROM optimization_suggestions WHERE workspace_id=?").run(wsRow.id)
      db.prepare("DELETE FROM pipeline_state WHERE workspace_id=?").run(wsRow.id)
      db.prepare("DELETE FROM workspaces WHERE id=?").run(wsRow.id)
    }
    db.prepare("DELETE FROM tasks WHERE id=?").run(entry.taskId)
  } catch (e) {
    problems.push(`db: ${e.message}`)
  } finally { db.close() }
  try { fs.rmSync(entry.home, { recursive: true, force: true }) } catch (e) { problems.push(`rm home: ${e.message}`) }
  if (entry.wsPath) { try { fs.rmSync(entry.wsPath, { recursive: true, force: true }) } catch (e) { problems.push(`rm ws: ${e.message}`) } }
  return problems
}

function verifyGone(entry) {
  const db = sql()
  try {
    const c = (sqlStr, ...p) => db.prepare(sqlStr).get(...p).c
    const left = {
      tasks: c("SELECT COUNT(*) c FROM tasks WHERE id=?", entry.taskId),
      schedules: c("SELECT COUNT(*) c FROM schedules WHERE origin_type='task' AND origin_id=?", entry.taskId),
      executions: (entry.execIds ?? []).length
        ? c(`SELECT COUNT(*) c FROM executions WHERE id IN (${entry.execIds.map(() => "?").join(",")}) OR workspace_id = ?`, ...entry.execIds, entry.wsId ?? "__none__")
        : c("SELECT COUNT(*) c FROM executions WHERE workspace_id = ?", entry.wsId ?? "__none__"),
      homeExists: fs.existsSync(entry.home),
      wsExists: entry.wsPath ? fs.existsSync(entry.wsPath) : false,
    }
    return left
  } finally { db.close() }
}

// ── 主流程 ──────────────────────────────────────────────────────────────
let health0 = await api("GET", "/api/actuator/health")
log(`health(start): ${health0.status}`)

const A = { ok: false }
const B = { ok: false }
try {
  makeGitFixture()
  // ═══ Task A — AC1 + AC3 ═══
  const ta = await makeTask("HAPPY", { withHandoff: true })
  const e1 = await waitTaggedExec(ta.taskId, 1, 1, 240_000)
  if (!e1) throw new Error("phase1 r1 never reached terminal")
  if (e1.status !== "completed") throw new Error(`phase1 r1 status=${e1.status} (stub exec failed)`)
  log(`HAPPY p1r1 completed exec=${e1.id} ws=${e1.workspace_id}`)
  const dbRow = sql()
  const wsPath = dbRow.prepare("SELECT path FROM workspaces WHERE id=?").get(e1.workspace_id)?.path
  dbRow.close()
  ta.wsPath = wsPath ?? null

  // derived 待验收（accept 前置态，API 面）
  const d0 = await api("GET", `/api/tasks/${ta.taskId}`)
  const pv0 = d0.data?.derived?.phaseViews?.[0]
  record("PRE-awaiting", d0.status === 200 && pv0?.status === "awaiting_review" && pv0?.awaitingRound === 1,
    `GET /api/tasks → derived.phaseViews[0] = ${JSON.stringify({ status: pv0?.status, awaitingRound: pv0?.awaitingRound })}`)

  // AC3: home-file LIST 含预置 handoff.md（批次清单可见性）
  const list = await api("GET", `/api/tasks/${ta.taskId}/home-file?path=${encodeURIComponent(ta.batch1Rel)}&list=1`)
  const files = list.data?.files ?? []
  const hit = files.find((f) => f.path.endsWith(`${ta.slug1}/handoff.md`))
  writeEvidence("AC3-home-file-list.json", { request: `${ta.batch1Rel}&list=1`, status: list.status, files })
  record("AC3", list.status === 200 && !!hit,
    hit ? `LIST 返回含 ${hit.path} (bytes=${hit.bytes}) — fs↔API 一致` : `LIST 未含 handoff.md：${JSON.stringify(files.map((f) => f.path))}`)

  // AC1: accept → dispatched(phase2) → envelope chain 注入断言
  const acc = await api("POST", `/api/tasks/${ta.taskId}/acceptance`, { phase_index: 1, round_index: 1, decision: "accepted" })
  writeEvidence("AC1-acceptance-response.json", { status: acc.status, body: acc.data ?? acc.text })
  const dispOk = acc.status === 200 && acc.data?.next_action === "dispatched" && acc.data?.dispatch?.phase_index === 2 && acc.data?.dispatch?.round_index === 1
  const envAfter = envelopeOf(ta.taskId)
  const step0 = envAfter?.config?.workflow_chain?.[0]
  const injected = step0?.input_values?.[CHAIN_KEY]
  const expected = ta.handoffAbs
  writeEvidence("AC1-envelope-after-accept.json", {
    schedule_id: envAfter?.scheduleId,
    workflow_ref: step0?.workflow_ref,
    input_values: step0?.input_values,
    expected_prev_handoff_paths: expected,
    actual_prev_handoff_paths: injected ?? null,
    has_key: !!step0?.input_values && CHAIN_KEY in step0.input_values,
  })
  const existsOnFs = typeof injected === "string" && fs.existsSync(injected)
  const fsBytesEq = existsOnFs && fs.readFileSync(injected, "utf-8") === fs.readFileSync(expected, "utf-8")
  const chainEq = injected === expected
  record("AC1", dispOk && chainEq && existsOnFs && fsBytesEq,
    `next_action=${acc.data?.next_action} dispatch.p${acc.data?.dispatch?.phase_index}r${acc.data?.dispatch?.round_index} | chain 注入键 ${chainEq ? "===phase1 handoff 绝对路径" : `≠ 期望: actual=${JSON.stringify(injected)}`} | existsSync=${existsOnFs} | 字节一致=${fsBytesEq}`)

  // 账本行（DB 面）
  const ledg = sql()
  const led = ledg.prepare("SELECT phase_index, round_index, decision FROM task_phase_acceptances WHERE task_id=? ORDER BY decided_at").all(ta.taskId)
  ledg.close()
  writeEvidence("AC1-db-ledger-rows.txt", JSON.stringify(led, null, 2))
  record("AC1-ledger", led.length === 1 && led[0].decision === "accepted" && led[0].phase_index === 1 && led[0].round_index === 1,
    `task_phase_acceptances(task) rows=${JSON.stringify(led)}`)

  // 运行时送达：phase2 r1 终态 → collect 把 runtime-prev-handoff.txt 回流 home
  const e2 = await waitTaggedExec(ta.taskId, 2, 1, 240_000)
  if (!e2) throw new Error("phase2 r1 never reached terminal")
  if (e2.status !== "completed") throw new Error(`phase2 r1 status=${e2.status}`)
  const runtimeFile = path.join(ta.batch2Abs, "runtime-prev-handoff.txt")
  const runtimeExists = fs.existsSync(runtimeFile)
  const runtimeVal = runtimeExists ? fs.readFileSync(runtimeFile, "utf-8").trim() : null
  writeEvidence("AC1-runtime-delivery.json", {
    phase2_exec: { id: e2.id, status: e2.status, same_ws: e2.workspace_id === e1.workspace_id },
    runtime_file: runtimeFile, runtime_exists: runtimeExists,
    runtime_value: runtimeVal, equals_injected_path: runtimeVal === expected,
  })
  record("AC1-runtime", runtimeExists && runtimeVal === expected && e2.workspace_id === e1.workspace_id,
    `执行侧(经 seed→start→collect 环)收到 prev_handoff_paths=${JSON.stringify(runtimeVal)}；phase2 同 ws 复用=${e2.workspace_id === e1.workspace_id}`)

  // 终态后 envelope chain 仍持键（持久化，非运行期幻象）
  const envFinal = envelopeOf(ta.taskId)
  const still = envFinal?.config?.workflow_chain?.[0]?.input_values?.[CHAIN_KEY]
  record("AC1-persisted", still === expected, `终态后 chain[0].input_values.${CHAIN_KEY}=${JSON.stringify(still)}`)
  A.ok = true

  // ═══ Task B — AC4 反例（无 handoff.md → 键不注入、不 500）═══
  const tb = await makeTask("NOHANDOFF", { withHandoff: false })
  const be1 = await waitTaggedExec(tb.taskId, 1, 1, 240_000)
  if (!be1 || be1.status !== "completed") throw new Error(`NOHANDOFF p1r1 terminal=${be1?.status ?? "timeout"}`)
  const bNeg = await api("GET", `/api/tasks/${tb.taskId}/home-file?path=${encodeURIComponent(tb.batch1Rel)}&list=1`)
  const bFiles = bNeg.data?.files ?? []
  record("AC4-prelist-neg", bNeg.status === 200 && !bFiles.some((f) => f.path.endsWith("handoff.md")),
    `反例批次 LIST=${JSON.stringify(bFiles.map((f) => f.path))}（无 handoff.md，对照组成立）`)
  const bacc = await api("POST", `/api/tasks/${tb.taskId}/acceptance`, { phase_index: 1, round_index: 1, decision: "accepted" })
  const benv = envelopeOf(tb.taskId)
  const bstep0 = benv?.config?.workflow_chain?.[0]
  const bHas = !!bstep0?.input_values && CHAIN_KEY in bstep0.input_values
  writeEvidence("AC4-response-and-chain.json", {
    accept_status: bacc.status, next_action: bacc.data?.next_action,
    dispatch: bacc.data?.dispatch ?? null,
    chain_input_values: bstep0?.input_values ?? null,
    [`${CHAIN_KEY}_present`]: bHas,
  })
  record("AC4", bacc.status === 200 && bacc.data?.next_action === "dispatched" && bHas === false,
    `accept HTTP=${bacc.status}（不 500）next_action=${bacc.data?.next_action}，chain[0].input_values 含 ${CHAIN_KEY} 键=${bHas}（期望 false，静默降级）`)
  const be2 = await waitTaggedExec(tb.taskId, 2, 1, 240_000)
  const bRuntimeFile = path.join(tb.batch2Abs, "runtime-prev-handoff.txt")
  const bRuntime = fs.existsSync(bRuntimeFile) ? fs.readFileSync(bRuntimeFile, "utf-8").trim() : null
  writeEvidence("AC4-runtime-degrade.json", {
    phase2_exec: be2 ? { id: be2.id, status: be2.status } : null,
    runtime_value: bRuntime, contains_phase1_path: !!bRuntime && bRuntime.includes(tb.handoffAbs),
  })
  record("AC4-runtime", (be2?.status === "completed") && !(bRuntime && bRuntime.includes(tb.handoffAbs)),
    `无 handoff 时 phase2 仍正常跑完(${be2?.status})，运行时值未含任何 phase1 路径（值=${JSON.stringify(bRuntime)}）`)
  B.ok = true
} catch (err) {
  record("HARNESS", false, `脚本异常: ${err instanceof Error ? err.message : String(err)}`)
}

// ═══ AC5 清理 + 复核 + health ═══
let cleanupProblems = []
let goneAll = true
for (const entry of state) {
  cleanupProblems.push(...cleanupTask(entry))
  const left = verifyGone(entry)
  writeEvidence(`AC5-postclean-${entry.taskId.slice(0, 8)}.json`, { left, cleanupProblems })
  if (left.tasks !== 0 || left.schedules !== 0 || left.homeExists || left.wsExists) goneAll = false
}
cleanupProblems.push(...restoreGitFixture())
const health1 = await api("GET", "/api/actuator/health")
record("AC5", cleanupProblems.length === 0 && goneAll && health0.status === 200 && health1.status === 200,
  `rows/dirs 全清=${goneAll}，清理报错=${JSON.stringify(cleanupProblems)}，health ${health0.status}→${health1.status}（task_phase_acceptances 账本行按 append-only 惯例保留）`)

writeEvidence("01-run-summary.json", { run: RUN, ymd: YMD, results, health: { start: health0.status, end: health1.status } })
const failed = results.filter((r) => !r.pass)
log(`DONE ${results.length - failed.length}/${results.length} PASS`)
process.exitCode = failed.length === 0 ? 0 : 1
