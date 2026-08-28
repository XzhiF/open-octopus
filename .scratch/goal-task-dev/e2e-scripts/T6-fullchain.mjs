#!/usr/bin/env node
/**
 * T6 — FULL-CHAIN REAL RUN (ticket-07 handoff item 5).
 * Kanban draft → bind built-in/task-dev (real inputs incl. max_turns fuse=15) → ready
 * → scheduler claims → REAL unattended execution in a THROWAWAY git repo
 * (/tmp/gtd-e2e-repo, init+1 commit, NO REMOTE — ship must hit local fallback, never push).
 * Asserts: develop completed via real /goal loop (JSONL end status), ship node commits
 * locally (hello.txt committed on worktree branch), ship-report.md in artifacts dir.
 * Cross-validation: API ↔ DB ↔ git ↔ filesystem. Full cleanup + restore in finally.
 */
import { execSync } from "child_process"
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "fs"
import os from "os"
import path from "path"
import { createResults, record, exitWithResults } from "../../../.claude/skills/e2e-harness/lib/reporter.mjs"
import { launchBrowser, takeScreenshot, closeBrowser } from "../../../.claude/skills/e2e-harness/lib/browser.mjs"
import { resolveApiUrl, resolveWebUrl } from "../../../.claude/skills/e2e-harness/lib/api.mjs"
import { querySQL } from "../../../.claude/skills/e2e-harness/lib/db.mjs"

const API = resolveApiUrl()
const WEB = resolveWebUrl()
const results = createResults()
const ok = (name, cond, detail) => {
  record(results, name, !!cond, detail)
  console.log(`${cond ? "PASS" : "FAIL"} [${name}] ${detail ?? ""}`.slice(0, 300))
}
const sh = (cmd, cwd) => execSync(cmd, { cwd, encoding: "utf8", timeout: 30000 })
async function api(p, opts = {}) {
  const r = await fetch(`${API}${p}`, { headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) }, ...opts })
  return { status: r.status, data: await r.json().catch(() => null) }
}

const REPO = "/tmp/gtd-e2e-repo"
const ORG = "default"
const IDX = path.join(os.homedir(), ".octopus", "orgs", ORG, "repos", "index.md")
const IDX_EXISTED = existsSync(IDX)
const IDX_BACKUP = IDX_EXISTED ? readFileSync(IDX, "utf8") : null
const GOAL = "在工作区中 git 仓库 projects/gtd-e2e-repo 的根目录创建文件 hello.txt，其内容（去除首尾空白后）必须恰好为 GTD_E2E_OK。不要执行 git commit 或 push（提交由后续 ship 节点负责）。"
const AC = "仓库 projects/gtd-e2e-repo 的工作树根目录存在文件 hello.txt，且去除首尾空白后内容恰好等于 GTD_E2E_OK"

let taskId = null
let wsPaths = []
try {
  // ── 0. throwaway repo inside /tmp ONLY (never touch real repos; no remote) ──
  rmSync(REPO, { recursive: true, force: true })
  mkdirSync(REPO, { recursive: true })
  sh("git init -b main", REPO)
  writeFileSync(path.join(REPO, "README.md"), "throwaway repo for goal-task-dev E2E — never push\n")
  sh("git add README.md && git -c commit.gpgsign=false commit --no-verify -q -m 'chore: seed'", REPO)
  ok("SETUP repo has exactly 1 seed commit", sh("git rev-list --count HEAD", REPO).trim() === "1")
  ok("SETUP repo has NO remote (safety precondition)", sh("git remote -v", REPO).trim() === "")

  // ── 1. register repo in org index.md ──
  mkdirSync(path.dirname(IDX), { recursive: true })
  writeFileSync(IDX, `# GitRepo Index\n\n> goal-task-dev E2E temporary fixture (removed on cleanup).\n\n### gtd-e2e-repo\n- git: none\n- branch: main\n- local: ${REPO}\n`)
  ok("SETUP repos index.md written", existsSync(IDX))

  // ── 2. create draft → bind → ready(=confirm enqueue) ──
  const created = await api("/api/tasks", { method: "POST", body: JSON.stringify({ org: ORG, name: "E2E_TEST_GTD_fullchain", task_type: "coding", skill_groups: [] }) })
  taskId = created.data?.id
  ok("CHAIN draft created", created.status === 201 && !!taskId, `id=${taskId}`)
  const putR = await api(`/api/tasks/${taskId}`, {
    method: "PUT", headers: { "If-Match": String(created.data.version) },
    body: JSON.stringify({
      workflow_ref: "built-in/task-dev",
      project_ids: ["gtd-e2e-repo"],
      task_spec: { goal: GOAL, ac: [AC], goal_confirmed: true, ac_confirmed: [AC], task_type: "coding", skill_groups: [], input_values: { goal: "${goal}", ac: "${ac}", max_turns: "15" } },
    }),
  })
  ok("CHAIN PUT bind ok", putR.status === 200 && putR.data?.workflow_ref === "built-in/task-dev", `status=${putR.status}`)
  const readyR = await api(`/api/tasks/${taskId}/ready`, { method: "POST" })
  ok("CHAIN ready(200) — enqueued", readyR.status === 200 && readyR.data?.status === "ready", `status=${readyR.status}`)
  const sq = querySQL(`SELECT id, status FROM schedules WHERE origin_id='${taskId}'`)
  ok("CHAIN schedule queued", sq.data?.length === 1 && sq.data[0].status === "queued", `sched=${sq.data?.[0]?.id}`)

  // ── 3. wait for scheduler claim + real unattended execution ──
  console.log("Waiting for scheduler tick + real task-dev execution (up to 15 min)...")
  const t0 = Date.now()
  let taskStatus = null, execInfo = null, done = false
  while (Date.now() - t0 < 900_000 && !done) {
    taskStatus = querySQL(`SELECT status FROM tasks WHERE id='${taskId}'`).data?.[0]?.status ?? null
    const es = querySQL(`SELECT se.execution_id, s.status AS sched_status, e.status AS exec_status, e.var_pool, w.path AS ws_path
      FROM schedules s
      LEFT JOIN schedule_executions se ON se.schedule_id=s.id
      LEFT JOIN executions e ON e.id=se.execution_id
      LEFT JOIN workspaces w ON w.id=e.workspace_id
      WHERE s.origin_id='${taskId}' ORDER BY se.triggered_at DESC LIMIT 1`)
    if (es.data?.[0]?.execution_id) execInfo = es.data[0]
    if (taskStatus && ["completed", "failed", "aborted"].includes(taskStatus)) done = true
    else await new Promise(r => setTimeout(r, 5000))
  }
  ok("EXEC terminal reached", done, `task=${taskStatus} after ${((Date.now() - t0) / 1000).toFixed(0)}s exec=${execInfo?.exec_status}`)
  const schedFinal = querySQL(`SELECT status FROM schedules WHERE origin_id='${taskId}'`).data?.[0]?.status
  ok("EXEC task completed + schedule done", taskStatus === "completed" && schedFinal === "done", `task=${taskStatus} sched=${schedFinal}`)

  // ── 4. node-level evidence from execution JSONL ──
  const wsDir = execInfo?.ws_path
  const execId = execInfo?.execution_id
  let devStatus = null, shipStatus = null
  if (wsDir && execId) {
    const logDir = path.join(wsDir, "logs", execId)
    const readEnd = (node) => {
      const f = path.join(logDir, `${node}.jsonl`)
      if (!existsSync(f)) return null
      let s = null
      for (const line of readFileSync(f, "utf8").split("\n")) {
        try { const e = JSON.parse(line); if (e.event === "end") s = e.status } catch {}
      }
      return s
    }
    devStatus = readEnd("develop")
    shipStatus = readEnd("ship")
  }
  ok("EXEC develop node completed (JSONL end=completed)", devStatus === "completed", `develop=${devStatus}`)
  ok("EXEC ship node completed (JSONL end=completed)", shipStatus === "completed", `ship=${shipStatus}`)
  const devLog = wsDir && execId ? path.join(wsDir, "logs", execId, "develop.jsonl") : null
  ok("EXEC develop transcript contains the goal condition", !!devLog && existsSync(devLog) && readFileSync(devLog, "utf8").includes("GTD_E2E_OK"), devLog)

  // ── 5. git evidence — ship committed locally on worktree branch ──
  const commits = Number(sh("git rev-list --all --count", REPO).trim())
  ok("GIT new commit(s) beyond seed exist", commits >= 2, `total=${commits}`)
  let committedBranch = null
  for (const ref of sh("git for-each-ref --format='%(refname:short)' refs/heads", REPO).trim().split("\n")) {
    try { if (sh(`git show ${ref}:hello.txt`, REPO).trim() === "GTD_E2E_OK") { committedBranch = ref; break } } catch {}
  }
  ok("GIT hello.txt committed with exact GTD_E2E_OK content", committedBranch !== null, `branch=${committedBranch}`)
  const commitMsg = committedBranch ? sh(`git log -1 --format='%s' ${committedBranch}`, REPO).trim() : ""
  ok("GIT commit message conventional-ish (feat/fix/chore)", /^(feat|fix|chore|refactor|test|docs)!?:/i.test(commitMsg), commitMsg)
  ok("SAFETY still no remote after run (never pushed)", sh("git remote -v", REPO).trim() === "")

  // worktree live file
  const wtHello = wsDir ? path.join(wsDir, "projects", "gtd-e2e-repo", "hello.txt") : null
  ok("FILE hello.txt exists in execution worktree (trimmed==GTD_E2E_OK)", !!wtHello && existsSync(wtHello) && readFileSync(wtHello, "utf8").trim() === "GTD_E2E_OK", wtHello)

  // ── 6. ship-report.md in task artifacts dir ──
  const artDir = path.join(os.homedir(), ".octopus", "tasks", taskId, "artifacts")
  const report = path.join(artDir, "ship-report.md")
  ok("FILE ship-report.md exists in artifacts dir", existsSync(report), report)
  if (existsSync(report)) {
    const rc = readFileSync(report, "utf8")
    ok("FILE ship-report.md content references AC/file", /GTD_E2E_OK|hello\.txt/i.test(rc), rc.slice(0, 150).replace(/\n/g, " ⏎ "))
  }
  const artApi = await api(`/api/tasks/${taskId}/artifacts`)
  ok("API artifacts endpoint reachable (200)", artApi.status === 200, `status=${artApi.status} n=${Array.isArray(artApi.data) ? artApi.data.length : "?"}`)

  // ── 7. ship_status var rode through var_pool → local fallback ──
  let vpStr = execInfo?.var_pool ?? ""
  ok("DB var_pool ship_status indicates local fallback", /local/.test(vpStr), (vpStr.match(/ship_status[^,}"]*"?[^,}"]*/)?.[0] ?? vpStr.slice(0, 120)))

  // ── 8. best-effort UI screenshot of completed task ──
  try {
    const { browser, page } = await launchBrowser()
    await page.goto(`${WEB}/tasks`, { waitUntil: "domcontentloaded", timeout: 30000 })
    const card = page.locator(`[data-task-card][data-task-id="${taskId}"]`).first()
    await card.waitFor({ state: "visible", timeout: 20000 })
    await card.click()
    await page.waitForTimeout(2500)
    const p = await takeScreenshot(page, "04-fullchain-completed-board")
    ok("SHOT-4 fullchain completed board view", p.endsWith(".png"), p)
    await closeBrowser(browser)
  } catch (e) {
    ok("SHOT-4 fullchain completed board view (best-effort)", false, String(e?.message ?? e).slice(0, 150))
  }
} catch (err) {
  ok("T6 unexpected error", false, String(err?.message ?? err))
} finally {
  // ── cleanup: workspaces+worktrees, repo, task home, index.md, DB rows ──
  try {
    const rows = querySQL(`SELECT w.id AS wid, w.path AS wpath FROM schedules s
      JOIN schedule_executions se ON se.schedule_id=s.id
      JOIN executions e ON e.id=se.execution_id
      JOIN workspaces w ON w.id=e.workspace_id WHERE s.origin_id='${taskId ?? ""}'`)
    wsPaths = rows.data.map(r => r.wpath)
    querySQL(`DELETE FROM executions WHERE id IN (SELECT execution_id FROM schedule_executions WHERE schedule_id IN (SELECT id FROM schedules WHERE origin_id='${taskId ?? ""}'))`)
    querySQL(`DELETE FROM schedule_executions WHERE schedule_id IN (SELECT id FROM schedules WHERE origin_id='${taskId ?? ""}')`)
    querySQL(`DELETE FROM schedule_workspaces WHERE schedule_id IN (SELECT id FROM schedules WHERE origin_id='${taskId ?? ""}')`)
    const widList = rows.data.map(r => `'${r.wid}'`).join(",")
    if (widList) querySQL(`DELETE FROM workspaces WHERE id IN (${widList})`)
    querySQL(`DELETE FROM schedules WHERE origin_id='${taskId ?? ""}'`)
    querySQL(`DELETE FROM tasks WHERE id='${taskId ?? ""}'`)
    const chk = querySQL(`SELECT (SELECT COUNT(*) FROM tasks WHERE id='${taskId ?? ""}') AS t, (SELECT COUNT(*) FROM schedules WHERE origin_id='${taskId ?? ""}') AS s, (SELECT COUNT(*) FROM executions WHERE id IN (SELECT execution_id FROM schedule_executions WHERE schedule_id='${taskId ?? ""}')) AS e`)
    ok("CLEANUP DB rows deleted (task/sched/exec/ws)", Number(chk.data?.[0]?.t) === 0 && Number(chk.data?.[0]?.s) === 0, JSON.stringify(chk.data?.[0]))
    for (const p of wsPaths) { try { rmSync(p, { recursive: true, force: true }) } catch {} }
    try { sh("git worktree prune", REPO) } catch {}
    rmSync(REPO, { recursive: true, force: true })
    if (taskId) rmSync(path.join(os.homedir(), ".octopus", "tasks", taskId), { recursive: true, force: true })
    if (IDX_EXISTED) writeFileSync(IDX, IDX_BACKUP)
    else rmSync(IDX, { force: true })
    ok("CLEANUP repo+workspace dirs+index.md restored", !existsSync(REPO) && !existsSync(IDX), `REPO=${existsSync(REPO)} IDX=${existsSync(IDX)}`)
  } catch (e) {
    ok("CLEANUP", false, String(e?.message ?? e))
  }
}

exitWithResults(results, { title: "T6 FULL-CHAIN REAL RUN — kanban→task-dev→ship (throwaway repo)" })
