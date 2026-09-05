// .scratch/phase-handoff-chaining/e2e-scripts/02-ac2-ui-handoff-hint.mjs
//
// 票05 E2E — AC2：验收弹窗（phase1 待验收态）提示行 N=1 的浏览器截图证据。
// 复用 e2e-harness STABLE 模块（launchBrowser/takeScreenshot/captureConsole/
// closeBrowser）。fixture 与票12/04 playwright 惯例一致：API 直造 v4 双 phase
// + sqlite 直插 phase1 r1 completed 链 → 看板「待验收」列 → 弹窗。
// 数据前缀 E2E_TD_PHASEHANDOFF_，测后清理（账本不写 — 不提交任何决定）。
//
// 产物：$E2E_ARTIFACTS_DIR/e2e-screenshots/AC2-*.png（反假跑 PNG 门禁）。
// 用法: node 02-ac2-ui-handoff-hint.mjs   （server :3001 + web :3000 在跑）

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { launchBrowser, takeScreenshot, captureConsole, closeBrowser } from "../../../.claude/skills/e2e-harness/lib/browser.mjs"

const API = process.env.OCTOPUS_SERVER_URL ?? "http://localhost:3001"
const WEB = process.env.OCTOPUS_WEB_URL ?? "http://localhost:3000"
const ORG = "E2E_TD_org"
const ARTIFACTS =
  process.env.E2E_ARTIFACTS_DIR ?? path.resolve("C:/xzf/ai/open-octopus/.scratch/phase-handoff-chaining")
const DATA = path.join(ARTIFACTS, "e2e-data")
const DB_PATH = path.join(os.homedir(), ".octopus", "db", "octopus.db")
const RUN = `ui-${Date.now()}`

const log = (m) => process.stdout.write(`[ac-ui] ${m}\n`)
const results = []
const record = (ac, pass, detail) => {
  results.push({ ac, pass, detail })
  process.stdout.write(`[ac-ui] ${pass ? "PASS" : "FAIL"} ${ac} — ${detail}\n`)
}
const writeEvidence = (name, obj) => {
  fs.mkdirSync(DATA, { recursive: true })
  fs.writeFileSync(path.join(DATA, name), JSON.stringify(obj, null, 2), "utf-8")
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const NOW_ISO = () => new Date().toISOString()
const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString()

function sql() {
  const db = new DatabaseSync(DB_PATH)
  db.prepare("PRAGMA busy_timeout = 5000").run()
  return db
}
async function api(method, p, body, headers) {
  const res = await fetch(`${API}${p}`, {
    method, headers: { "Content-Type": "application/json", ...(headers ?? {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let data = null; try { data = JSON.parse(text) } catch { /* text */ }
  return { status: res.status, data, text }
}

const created = { taskId: null, wsId: null, schId: null, execId: null, seId: null, home: null }

async function makeAwaitingTask() {
  const name = `E2E_TD_PHASEHANDOFF_${RUN}`
  const t = await api("POST", "/api/tasks", { org: ORG, name, task_type: "coding", skill_groups: [], preset: { org: ORG } })
  if (t.status !== 200 && t.status !== 201) throw new Error(`create ${t.status} ${t.text}`)
  created.taskId = t.data.id
  created.home = path.join(os.homedir(), ".octopus", "tasks", created.taskId)
  const mk = (i) => ({
    index: i, name: `衔接阶段${i}`, slug: `e2e-td-ho-ui-p${i}-${RUN}`,
    specPath: `.scratch/20260906/e2e-td-ho-ui-p${i}-${RUN}/spec.md`,
    workflowRef: "task-dev", inputValues: {},
  })
  const put = await api("PUT", `/api/tasks/${created.taskId}`, {
    task_spec: { format: "v4", goal: "票05 AC2 弹窗提示行", autoAdvance: true, phases: [mk(1), mk(2)], resources: [], authoring_resources: [] },
  }, { "If-Match": String(t.data.version) })
  if (put.status !== 200) throw new Error(`PUT ${put.status} ${put.text}`)
  // sqlite 直插 phase1 r1 completed 链（票12 insertPhaseRoundExec 同形）
  const db = sql()
  const now = NOW_ISO()
  created.wsId = `e2e-td-ho-ui-ws-${RUN}`
  created.schId = `e2e-td-ho-ui-sch-${RUN}`
  created.execId = `e2e-td-ho-ui-exec-${RUN}`
  created.seId = `e2e-td-ho-ui-se-${RUN}`
  db.prepare(
    `INSERT INTO workspaces (id, name, org, status, path, created_at, updated_at, source)
     VALUES (?, ?, ?, 'active', ?, ?, ?, 'user')`,
  ).run(created.wsId, `E2E_TD_PHASEHANDOFF_ws_${RUN}`, ORG, path.join(os.tmpdir(), `e2e-td-ho-ui-${RUN}`), now, now)
  db.prepare(
    `INSERT INTO schedules (id, org, name, enabled, timeout_seconds, created_at, updated_at,
       config, status, origin_type, origin_id, origin_role, workspace_id)
     VALUES (?, ?, ?, 1, 3600, ?, ?, '{}', 'running', 'task', ?, 'primary', ?)`,
  ).run(created.schId, ORG, `E2E_TD_PHASEHANDOFF_sch_${RUN}`, now, now, created.taskId, created.wsId)
  db.prepare(
    `INSERT INTO executions (id, workspace_id, workflow_ref, workflow_name, node_type, org,
       status, phase_index, round_index, created_at, updated_at)
     VALUES (?, ?, 'task-dev', 'e2e-td-ho-ui-round', 'normal', ?, 'completed', 1, 1, ?, ?)`,
  ).run(created.execId, created.wsId, ORG, hoursAgo(1), now)
  db.prepare(
    `INSERT INTO schedule_executions (id, schedule_id, execution_id, status, trigger_type,
       triggered_at, timezone_offset, timezone_iana, duration_ms, workspace_id, created_at, completed_at)
     VALUES (?, ?, ?, 'done', 'manual', ?, '+08:00', 'Asia/Shanghai', 600000, ?, ?, ?)`,
  ).run(created.seId, created.schId, created.execId, hoursAgo(1), created.wsId, now, NOW_ISO())
  db.prepare("UPDATE tasks SET status='running', updated_at=? WHERE id=?").run(now, created.taskId)
  db.close()
  log(`fixture task ${created.taskId} (p1r1 completed → awaiting_review)`)
}

function cleanup() {
  const problems = []
  const db = sql()
  try {
    for (const [tbl, id] of [["schedule_executions", created.seId], ["executions", created.execId], ["schedules", created.schId], ["workspaces", created.wsId], ["tasks", created.taskId]]) {
      if (id) db.prepare(`DELETE FROM ${tbl} WHERE id=?`).run(id)
    }
  } catch (e) { problems.push(e.message) } finally { db.close() }
  if (created.home) { try { fs.rmSync(created.home, { recursive: true, force: true }) } catch (e) { problems.push(e.message) } }
  writeEvidence("AC2-cleanup-problems.json", problems)
  return problems
}

let browser = null
try {
  await makeAwaitingTask()
  // 服务端派生预断言：把「看板没出卡」的原因域先切到 UI 侧（R3 API↔DB 先行）
  let derivedOk = false
  let pvInfo = null
  for (let i = 0; i < 10; i++) {
    const d = await api("GET", `/api/tasks/${created.taskId}`)
    pvInfo = d.data?.derived?.phaseViews?.[0] ?? null
    derivedOk = pvInfo?.status === "awaiting_review" && pvInfo?.awaitingRound === 1
    if (derivedOk) break
    await sleep(2000)
  }
  if (!derivedOk) throw new Error(`derived not awaiting_review: ${JSON.stringify(pvInfo)}`)
  record("AC2-derived-pre", true, `GET /api/tasks/:id derived.phaseViews[0] = awaiting_review(1)（服务端态确认，UI 面另行）`)

  const { browser: b, page } = await launchBrowser({ headless: true })
  browser = b
  const console_ = captureConsole(page)

  // 环境适配（非产品断言）：:3000 next dev 内嵌 data-server-url 为启动时刻的
  // LAN IP（http://172.29.100.7:3001），该接口现已不可达（curl=000）→ 看板
  // 全空。路由把任何 :3001 非 localhost 请求重写到 http://localhost:3001，
  // 保持「真实 server + 真实浏览器 UI」的 R1/R6 口径。
  await page.route((url) => url.port === "3001" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1", async (route) => {
    const target = new URL(route.request().url())
    target.hostname = "localhost"
    try {
      const resp = await route.fetch({ url: target.toString() })
      await route.fulfill({ response: resp })
    } catch {
      await route.abort()
    }
  })

  // Next dev 首编译可能 >20s：warm-up goto（容忍一次超时）再进正式等待
  try { await page.goto(`${WEB}/tasks`, { waitUntil: "domcontentloaded", timeout: 90_000 }) }
  catch { await page.goto(`${WEB}/tasks`, { waitUntil: "domcontentloaded", timeout: 60_000 }) }
  const card = page.locator(`[data-task-column="awaiting_review"] [data-task-id="${created.taskId}"]`)
  await card.waitFor({ state: "visible", timeout: 60_000 })
  await card.locator("[data-task-accept-btn]").click()
  const dialog = page.locator("[data-acceptance-modal]")
  await dialog.waitFor({ state: "visible", timeout: 30_000 })

  const hint = dialog.locator("[data-handoff-hint]")
  await hint.waitFor({ state: "visible", timeout: 30_000 })
  const hintText = (await hint.textContent()) ?? ""
  const shot1 = await takeScreenshot(page, "AC2-handoff-hint-n1.png")
  record("AC2-visible", hintText.includes("共 1 个前序交接") && hintText.includes("将自动进入下一 phase"),
    `提示行文本=「${hintText}」 → ${shot1}`)
  writeEvidence("AC2-hint-text.json", { hintText, screenshot: shot1, taskId: created.taskId })

  // rejected 态（打回面板展开）→ 提示行隐藏（票04 语义交叉复验）
  await dialog.locator("[data-acceptance-reject]").click()
  await sleep(500)
  const hiddenCount = await hint.count()
  const shot2 = await takeScreenshot(page, "AC2-handoff-hint-reject-hidden.png")
  record("AC2-reject-hidden", hiddenCount === 0, `reject 面板展开后 [data-handoff-hint] count=${hiddenCount} → ${shot2}`)
  record("AC2-console", console_.errors.length === 0, `console errors=${console_.errors.length}${console_.errors.length ? ` (${console_.errors.slice(0, 3).join(" | ")})` : ""}`)
} catch (err) {
  record("AC2-HARNESS", false, `脚本异常: ${err instanceof Error ? err.stack?.split("\n")[0] : String(err)}`)
} finally {
  if (browser) await closeBrowser(browser)
  const problems = cleanup()
  const allClear = problems.length === 0
  const db = sql()
  const left = db.prepare("SELECT COUNT(*) c FROM tasks WHERE id=?").get(created.taskId ?? "none").c
  db.close()
  record("AC2-cleanup", allClear && left === 0, `rows 清除=${left === 0}，problems=${JSON.stringify(problems)}`)
}
const failed = results.filter((r) => !r.pass)
writeEvidence("AC2-summary.json", { run: RUN, results, web: WEB })
log(`DONE ${results.length - failed.length}/${results.length} PASS`)
process.exitCode = failed.length === 0 ? 0 : 1
