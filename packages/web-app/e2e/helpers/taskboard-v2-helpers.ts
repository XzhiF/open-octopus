// packages/web-app/e2e/helpers/taskboard-v2-helpers.ts
//
// taskboard-modal-v2 票 10 — shared machinery for the five narrow browser flows.
// Complements (never edits) the STABLE task-domain-helpers + the e2e-harness lib.
//
// Boot posture (matt-e2e-test-methodology R1/R6 — no mocks, no seeded lies):
// every flow runs a REAL v4 task through the REAL dispatcher: REST create →
// home batch dirs + bash stub workflow in the task home → PUT v4 spec →
// POST /ready → POST /trigger → the built-in task-lifecycle job claims the root
// row, creates the workspace (git worktree from the fixture bare origin), seeds
// the batch dir down, and the bash node really executes. Flows 1/3/4 park a
// long-sleeping bash node (a genuine 'running' round: pause/takeover refuse
// without a live in-process engine); flows 2/5 let a fast stub round complete
// (a genuine awaiting_review round with a real collect). Zero LLM in flows 1-4;
// flow 2/4's chat turns and flow 5's task-fix round do hit the real provider —
// the honest boundary this file documents per flow.
//
// Environment resolution (one-command re-run, no manual env ritual):
//   OCTOPUS_SERVER_URL / OCTOPUS_DB_PATH win if set; otherwise this repo's own
//   worktree convention is read back: .git file → branch → ~/.octopus/ports/
//   {safe}.json (written by scripts/dev.mjs) → server port; the isolated branch
//   DB name mirrors dev.mjs initBranchDb(`${branch}-${serverPort}`).
//   A HARD guard refuses the user's real ~/.octopus/db/octopus.db — this suite
//   must never read or write it.
//
// Isolation: every created id/name carries E2E_TBV2_ (R7); the org is
// E2E_TBV2_org; git fixture repos + task homes are removed in the sweep. The
// task_phase_acceptances table is append-only (trigger) — rows written here are
// counted and registered in the sweep log, same protocol as 票11/12/14 specs.

import { spawnSync } from "node:child_process"
import { DatabaseSync } from "node:sqlite"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import type { Page } from "@playwright/test"

// ── constants / logging ───────────────────────────────────────────────

export const TBV2_ORG = "E2E_TBV2_org"
export const TBV2_PREFIX = "E2E_TBV2_"

export const log = (msg: string): void => {
  process.stdout.write(`[e2e-tbv2] ${msg}\n`)
}
export const logError = (msg: string): void => {
  process.stderr.write(`[e2e-tbv2] ${msg}\n`)
}

// ── environment resolution ────────────────────────────────────────────

/** worktree repo root = 4 levels up from packages/web-app/e2e/helpers. */
export const TBV2_REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..")

function safeName(s: string): string {
  return s.replace(/\//g, "-").replace(/[^a-zA-Z0-9\-_.]/g, "_")
}

/** Branch of this checkout via .git (file → worktree gitdir → HEAD). */
function currentBranch(): string | null {
  try {
    const gitPath = path.join(TBV2_REPO_ROOT, ".git")
    const stat = fs.statSync(gitPath)
    let headPath: string | null = null
    if (stat.isFile()) {
      const m = fs.readFileSync(gitPath, "utf8").trim().match(/^gitdir:\s*(.+)$/)
      if (m) headPath = path.join(m[1], "HEAD")
    } else if (stat.isDirectory()) {
      headPath = path.join(gitPath, "HEAD")
    }
    if (!headPath) return null
    const ref = fs.readFileSync(headPath, "utf8").trim().match(/ref: refs\/heads\/(.+)/)
    return ref ? ref[1] : null
  } catch {
    return null
  }
}

interface ResolvedEnv {
  serverUrl: string
  dbPath: string
}

let envCache: ResolvedEnv | null = null

export function tbv2Env(): ResolvedEnv {
  if (envCache) return envCache
  let serverUrl = process.env.OCTOPUS_SERVER_URL ?? ""
  let dbPath = process.env.OCTOPUS_DB_PATH ?? ""
  if (!serverUrl || !dbPath) {
    // Read back the worktree convention scripts/dev.mjs wrote.
    const branch = currentBranch()
    const portsFile = branch
      ? path.join(os.homedir(), ".octopus", "ports", `${safeName(branch)}.json`)
      : ""
    let server = 0
    if (portsFile && fs.existsSync(portsFile)) {
      try {
        const j = JSON.parse(fs.readFileSync(portsFile, "utf8")) as { server?: number }
        server = typeof j.server === "number" ? j.server : 0
      } catch { /* fall through to the error below */ }
    }
    if (server > 0) {
      if (!serverUrl) serverUrl = `http://localhost:${server}`
      if (!dbPath) {
        dbPath = path.join(os.homedir(), ".octopus", "db", `octopus-${safeName(`${branch}-${server}`)}.db`)
      }
    }
  }
  if (!serverUrl) {
    throw new Error(
      "tbv2 e2e: server URL unresolved. Start the worktree stack (`pnpm -C <worktree> dev`) " +
        "so ~/.octopus/ports/<branch>.json exists, or export OCTOPUS_SERVER_URL.",
    )
  }
  if (!dbPath) {
    throw new Error(
      "tbv2 e2e: DB path unresolved — export OCTOPUS_DB_PATH (the worktree-isolated branch DB) " +
        "or start the stack via scripts/dev.mjs so the port file + branch DB exist.",
    )
  }
  if (path.basename(dbPath).toLowerCase() === "octopus.db") {
    throw new Error(`tbv2 e2e refuses to run against the user's real dev DB (${dbPath}) — point OCTOPUS_DB_PATH at the branch DB.`)
  }
  if (!fs.existsSync(dbPath)) {
    throw new Error(`tbv2 e2e: DB file not found at ${dbPath}. Is the isolated stack (pnpm dev in the worktree) up?`)
  }
  envCache = { serverUrl, dbPath }
  return envCache
}

export const TBV2_SERVER_URL = (): string => tbv2Env().serverUrl

// ── server availability (R1: real server or FAIL, never silent skip) ──

export async function tbv2ServerAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${tbv2Env().serverUrl}/api/tasks?org=${encodeURIComponent(TBV2_ORG)}`, { signal: AbortSignal.timeout(5000) })
    return res.ok
  } catch {
    return false
  }
}

// ── sqlite (guarded; WAL peers with the server's own connection) ───────

function dbOpen(readOnly: boolean): DatabaseSync {
  // 刀C（票11 流⑦ 撞出）：Node 的 DatabaseSync 拒 `undefined` options
  // （ERR_INVALID_ARG_TYPE: The "options" argument must be an object）—— 写侧要传对象。
  const db = new DatabaseSync(tbv2Env().dbPath, readOnly ? { readOnly: true } : {})
  db.prepare("PRAGMA busy_timeout = 5000").run()
  return db
}

export function tbv2DbRun(sql: string, ...params: unknown[]): void {
  const db = dbOpen(false)
  try {
    db.prepare(sql).run(...(params as never[]))
  } finally {
    db.close()
  }
}

export function tbv2DbAll<T>(sql: string, ...params: unknown[]): T[] {
  const db = dbOpen(true)
  try {
    return db.prepare(sql).all(...(params as never[])) as T[]
  } finally {
    db.close()
  }
}

export function tbv2DbGet<T>(sql: string, ...params: unknown[]): T | undefined {
  const db = dbOpen(true)
  try {
    return db.prepare(sql).get(...(params as never[])) as T | undefined
  } finally {
    db.close()
  }
}

export interface RootExecRow {
  id: string
  status: string
  workflow_ref: string
  workspace_id: string
  task_id: string
  phase_index: number | null
  round_index: number | null
  takeover_at: string | null
  takeover_delivered_at: string | null
  start_commit_id: string | null
  end_commit_id: string | null
}

/** This task's round rows, oldest first. Rounds form a CHAIN: 打回/修复轮 r2 is created
 *  with parent_id = the previous round's row (dispatchPhaseRound), while the first round
 *  is a root ('0') — same predicate + coords the server's own round queries use
 *  (`parent_id='0' OR phase_index IS NOT NULL`). */
export function tbv2RootExecs(taskId: string): RootExecRow[] {
  return tbv2DbAll<RootExecRow>(
    `SELECT id,status,workflow_ref,workspace_id,task_id,phase_index,round_index,takeover_at,takeover_delivered_at,start_commit_id,end_commit_id
       FROM executions WHERE task_id = ? AND (parent_id = '0' OR phase_index IS NOT NULL) ORDER BY created_at ASC, rowid ASC`,
    taskId,
  )
}

export interface NodeRowLite {
  id: string
  node_id: string
  status: string
}

export function tbv2NodeRows(executionId: string): NodeRowLite[] {
  return tbv2DbAll<NodeRowLite>(
    "SELECT id, node_id, status FROM node_executions WHERE execution_id = ? ORDER BY started_at ASC",
    executionId,
  )
}

/** 票06 authoritative intervention SQL (execution-level). */
export function tbv2InterventionEventCount(executionId: string): number {
  const r = tbv2DbGet<{ c: number }>(
    `SELECT COUNT(*) c FROM agent_events ae JOIN node_executions ne ON ae.node_execution_id = ne.id
      WHERE ne.execution_id = ? AND ae.event_type = 'intervention'`,
    executionId,
  )
  return r?.c ?? 0
}

export function tbv2AcceptanceCount(taskId: string): number {
  return tbv2DbGet<{ c: number }>("SELECT COUNT(*) c FROM task_phase_acceptances WHERE task_id = ?", taskId)?.c ?? 0
}

// ── git (real side-effect evidence source) ────────────────────────────

export function gitAt(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" })
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} @${cwd}: ${(r.stderr || "").trim()}`)
  return r.stdout.trim()
}

export function gitHead(dir: string): string {
  return gitAt(["rev-parse", "HEAD"], dir)
}

/** Commits in (start..end] — the round-diff counting authority, measured straight off git. */
export function gitCommitCount(dir: string, start: string, end: string): number {
  const out = gitAt(["rev-list", "--count", `${start}..${end}`], dir)
  return parseInt(out, 10)
}

export function gitLogSubjects(dir: string, range: string | null, n = 50): string[] {
  const args = ["log", `-${n}`, "--pretty=%s"]
  if (range) args.push(range)
  return gitAt(args, dir).split(/\r?\n/).filter(Boolean)
}

// ── REST core (thin, raw — never mocks the server; R1/R3) ─────────────

async function api<T>(method: string, urlPath: string, body?: unknown): Promise<T> {
  const res = await fetch(`${tbv2Env().serverUrl}${urlPath}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${urlPath} → ${res.status}: ${text.slice(0, 400)}`)
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`${method} ${urlPath} → non-JSON body: ${text.slice(0, 200)}`)
  }
}

async function apiRaw(method: string, urlPath: string, body?: unknown): Promise<{ status: number; body: unknown; text: string }> {
  const res = await fetch(`${tbv2Env().serverUrl}${urlPath}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let parsed: unknown = text
  try {
    parsed = JSON.parse(text)
  } catch {
    /* keep text */
  }
  return { status: res.status, body: parsed, text }
}

export interface TaskDtoLite {
  id: string
  name: string
  status: string
  version: number
  workspace_id: string | null
  doer_session_id: string | null
  task_spec: Record<string, unknown>
  derived?: { taskStatus?: string; isV4?: boolean; phaseViews?: TbPhaseViewLite[] }
  [k: string]: unknown
}

export interface TbRoundLite {
  roundIndex: number
  state: string
  decision: string | null
  exec: { id: string; status: string; workflow_ref?: string; [k: string]: unknown }
}
export interface TbPhaseViewLite {
  index: number
  status: string
  currentRound: number | null
  awaitingRound: number | null
  rounds: TbRoundLite[]
}

export const tbv2Api = {
  createTask: (body: Record<string, unknown>) => api<TaskDtoLite>("POST", "/api/tasks", body),
  getTask: (id: string) => api<TaskDtoLite>("GET", `/api/tasks/${id}`),
  updateTask: (id: string, version: number, body: Record<string, unknown>) => api<TaskDtoLite>("PUT", `/api/tasks/${id}`, { ...body, version }),
  readyTask: (id: string) => apiRaw("POST", `/api/tasks/${id}/ready`),
  triggerTask: (id: string) => apiRaw("POST", `/api/tasks/${id}/trigger`, {}),
  pause: (id: string) => apiRaw("POST", `/api/tasks/${id}/pause`),
  resume: (id: string, intervention?: string) => apiRaw("POST", `/api/tasks/${id}/resume`, intervention ? { intervention } : {}),
  takeover: (id: string) => apiRaw("POST", `/api/tasks/${id}/takeover`),
  deliver: (id: string) => apiRaw("POST", `/api/tasks/${id}/takeover/deliver`),
  abort: (id: string) => apiRaw("POST", `/api/tasks/${id}/abort`),
  acceptance: (
    id: string,
    body: { phase_index: number; round_index: number; decision: "accepted" | "rejected"; feedback?: string; reopen_tickets?: string[] },
  ) => apiRaw("POST", `/api/tasks/${id}/acceptance`, body),
  fixRound: (id: string, instruction: string) => apiRaw("POST", `/api/tasks/${id}/fix-round`, { instruction }),
  roundDiff: (id: string, scope?: "round" | "cumulative") =>
    api<Record<string, unknown>>(
      "GET",
      `/api/tasks/${id}/round-diff${scope ? `?scope=${scope}` : ""}`,
    ),
  chatBinding: (id: string) => api<{ task_id: string; session_id: string; workspace_id: string; created: boolean }>("GET", `/api/tasks/${id}/chat`),
  deleteWorkspace: (wsId: string) => apiRaw("DELETE", `/api/workspaces/${wsId}`),
}

// ── wait/poll ─────────────────────────────────────────────────────────

export async function tbv2Until<T>(
  fn: () => T | null | undefined | Promise<T | null | undefined>,
  timeoutMs: number,
  message: string,
  intervalMs = 1000,
): Promise<T> {
  const t0 = Date.now()
  let lastErr = ""
  while (Date.now() - t0 < timeoutMs) {
    try {
      const v = await fn()
      if (v !== null && v !== undefined) return v
    } catch (err: unknown) {
      lastErr = err instanceof Error ? err.message : String(err)
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`tbv2Until timeout(${timeoutMs}ms): ${message}${lastErr ? ` last: ${lastErr}` : ""}`)
}

export const TERMINAL_EXEC = new Set([
  "completed",
  "completed_with_failures",
  "failed",
  "cancelled",
  "aborted",
  "skipped",
  "rejected",
])

// ── fixture: task + home batch dirs + bash stub workflow ──────────────

export interface TbFlowHandles {
  run: string
  taskId: string
  org: string
  projName: string
  batchRel: string
  fixtureRoot: string
  cloneDir: string
  reposIndexBefore: string
  reposIndexPath: string
  /** set once the dispatcher claims + creates the workspace (flow-level lazy reads). */
  wsId: () => string
  wsPath: () => string
  repoWorkDir: () => string
  cleanup: (opts?: { abortTask?: boolean }) => Promise<void>
}

const YMD = (): string => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
}

function dataRoot(): string {
  return process.env.E2E_ARTIFACTS_DIR
    ? path.join(process.env.E2E_ARTIFACTS_DIR, "e2e-data")
    : path.resolve(TBV2_REPO_ROOT, ".scratch/taskboard-modal-v2/e2e-data")
}

export function shotDir(flow: string): string {
  const d = process.env.E2E_ARTIFACTS_DIR
    ? path.join(process.env.E2E_ARTIFACTS_DIR, "e2e-screenshots", flow)
    : path.resolve(TBV2_REPO_ROOT, `.scratch/taskboard-modal-v2/e2e-screenshots/${flow}`)
  fs.mkdirSync(d, { recursive: true })
  return d
}

/**
 * Boot one flow's task: fixture git repo (bare origin + clone registered into
 * the org repos index), v4 task with home batch dirs + a bash-only stub
 * workflow, ready + immediate trigger. `parkSeconds` controls the stub's second
 * node: >0 → the round stays genuinely 'running' that long (flows 1/3/4); 0 →
 * the round completes fast and the task lands awaiting_review (flows 2/5).
 * `extraCommitSeconds` (flow 1 only) → first node churns one commit every N
 * seconds while running, so a genuinely NEW task commit lands mid-round.
 */
export async function tbv2BootFlow(opts: {
  flow: string
  parkSeconds: number
  churnEverySeconds?: number
  churnRounds?: number
}): Promise<TbFlowHandles> {
  const run = `${opts.flow}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  // Per-flow org: the repos index.md is a shared read-modify-write surface — a
  // concurrent sibling restoring ITS snapshot would clobber this flow's entry
  // (ready-gate B1 then 409s 「missing project:…」). One org per flow = zero contention.
  const org = `E2E_TBV2_org_${opts.flow}`
  const projName = `e2e-tbv2-${run}`
  const slug = `e2e-tbv2-${run}`
  const batchRel = `.scratch/${YMD()}/${slug}`
  const fixtureRoot = path.join(dataRoot(), `git-${run}`)
  const bare = path.join(fixtureRoot, `${projName}.git`)
  const cloneDir = path.join(fixtureRoot, projName)

  fs.mkdirSync(fixtureRoot, { recursive: true })
  gitAt(["init", "--bare", "-b", "main", bare], fixtureRoot)
  gitAt(["clone", bare, cloneDir], fixtureRoot)
  gitAt(["config", "user.email", "e2e@tbv2.local"], cloneDir)
  gitAt(["config", "user.name", "E2E TBV2"], cloneDir)
  fs.writeFileSync(path.join(cloneDir, "README.md"), `# ${projName} (e2e tbv2 fixture)\n`)
  gitAt(["add", "-A"], cloneDir)
  gitAt(["-c", "user.name=E2E TBV2", "-c", "user.email=e2e@tbv2.local", "commit", "-m", "seed"], cloneDir)
  gitAt(["push", "origin", "main"], cloneDir)

  // org repos index — the dispatcher resolves project_ids through it (票14 pattern).
  const reposIndexPath = path.join(os.homedir(), ".octopus", "orgs", org, "repos", "index.md")
  const reposIndexBefore = fs.existsSync(reposIndexPath) ? fs.readFileSync(reposIndexPath, "utf-8") : ""
  fs.mkdirSync(path.dirname(reposIndexPath), { recursive: true })
  fs.writeFileSync(reposIndexPath, `${reposIndexBefore}\n### ${projName}\n- local: ${cloneDir} ✓ cloned\n`)

  // task (API-direct keeps org isolation; 票11/12/14 precedent)
  const wfRef = `e2e-tbv2-${opts.flow}`
  const task = await tbv2Api.createTask({
    org,
    name: `${TBV2_PREFIX}票10流${opts.flow}_${run}`,
    task_type: "coding",
    skill_groups: [],
    preset: { org },
    project_ids: [projName],
    task_spec: {
      format: "v4",
      goal: `${TBV2_PREFIX} 票10 E2E flow ${opts.flow}`,
      autoAdvance: false,
      phases: [
        // bindingConfirmed = 历史闸 ⑤ 字段（2026-10-10 已废，ADR-0028）—— server
        // 无视其值，此处保留仅为老 wire 形状样例；新 fixture 无需再写。
        { index: 1, name: "E2E 流", slug, specPath: `${batchRel}/spec.md`, workflowRef: wfRef, inputValues: {}, bindingConfirmed: true },
      ],
      // unit-only 复检门 —— ready gate 的 runbook 逃生面，E2E 永不点复检。
      acceptance_verify: { command: "echo tbv2-e2e-verify", cwd: ".", timeoutS: 30 },
      resources: [],
      authoring_resources: [],
    },
  })
  const homeDir = path.join(os.homedir(), ".octopus", "tasks", task.id)
  if (!fs.existsSync(homeDir)) throw new Error(`v3 create did not materialize home: ${homeDir}`)

  // home batch dir (ready gate + task-fix precheck read this)
  fs.mkdirSync(path.join(homeDir, batchRel, "issues"), { recursive: true })
  fs.writeFileSync(
    path.join(homeDir, batchRel, "spec.md"),
    `# E2E TBV2 spec ${run}\n\n范围：单文件产物。验收方式：git 实物 + UI 观察。\n`,
  )
  fs.writeFileSync(
    path.join(homeDir, batchRel, "issues", "1-ticket.md"),
    `# 票1 e2e stub\n\n## Status\n\nStatus: ready-for-agent\n`,
  )

  // stub workflow in the task home (dispatcher resolves phase workflowRef from home/workflows)
  const churn = (opts.churnEverySeconds ?? 0) > 0
  const churnLines = churn
    ? [
        `for i in $(seq 1 ${opts.churnRounds ?? 8}); do`,
        `  echo "tbv2 churn $i $(date +%s)" > "churn-$i.md"`,
        `  git add -A`,
        `  git -c user.name=E2E_TBV2 -c user.email=e2e@tbv2.local commit -m "tbv2 churn $i" --quiet`,
        `  echo "churn $i done"`,
        `  sleep ${opts.churnEverySeconds}`,
        `done`,
      ]
    : [`  echo "tbv2 round artifact $(date +%s)" > "tbv2-note.md"`, `  git add -A`, `  git -c user.name=E2E_TBV2 -c user.email=e2e@tbv2.local commit -m "tbv2 round commit" --quiet`]
  const wfYaml = [
    "apiVersion: octopus/v1",
    "kind: Workflow",
    `name: ${wfRef}`,
    `description: ${TBV2_PREFIX} 票10 stub —— bash-only；节点先在执行仓落一个 commit 再停驻`,
    "engine: claude",
    "timeout: 1800",
    "execution_mode: serial",
    "nodes:",
    "  - id: tbv2-round",
    "    type: bash",
    `    timeout: ${Math.max(900, opts.parkSeconds + 600)}`,
    "    bash: |",
    "      set -e",
    `      cd "projects/${projName}"`,
    ...churnLines.map((l) => `      ${l}`),
    ...(opts.parkSeconds > 0
      ? [`      echo "tbv2 parked $(date +%s)" > .tbv2-park`, `      sleep ${opts.parkSeconds}`]
      : [`      echo "tbv2 round finished $(date +%s)" > .tbv2-done`]),
    "",
  ].join("\n")
  fs.mkdirSync(path.join(homeDir, "workflows"), { recursive: true })
  fs.writeFileSync(path.join(homeDir, "workflows", `${wfRef}.yaml`), wfYaml)

  // ready gate + immediate trigger (票10 手动点火，v4-task-api-seed-recipe 纪律)
  // 任何启动步失败 → 先回滚本轮已造的现场（task 行/home/index 条目/fixture），再抛 ——
  // 反孤儿纪律：失败的一次 boot 不许在共享 branch DB 里留下尾巴。
  const rollback = (): void => {
    try {
      const db = new DatabaseSync(tbv2Env().dbPath)
      try {
        db.prepare("PRAGMA busy_timeout = 5000").run()
        db.prepare("PRAGMA foreign_keys = OFF").run()
        const execIds = db.prepare("SELECT id FROM executions WHERE task_id = ?").all(task.id) as Array<{ id: string }>
        if (execIds.length) {
          const inList = execIds.map(() => "?").join(",")
          db.prepare(`DELETE FROM agent_events WHERE node_execution_id IN (SELECT id FROM node_executions WHERE execution_id IN (${inList}))`).run(...execIds.map((r) => r.id))
          db.prepare(`DELETE FROM node_executions WHERE execution_id IN (${inList})`).run(...execIds.map((r) => r.id))
          db.prepare(`DELETE FROM executions WHERE id IN (${inList})`).run(...execIds.map((r) => r.id))
        }
        const wsRow = db.prepare("SELECT workspace_id FROM tasks WHERE id = ?").get(task.id) as { workspace_id: string | null } | undefined
        db.prepare("DELETE FROM tasks WHERE id = ?").run(task.id)
        if (wsRow?.workspace_id) db.prepare("DELETE FROM workspaces WHERE id = ?").run(wsRow.workspace_id)
      } finally {
        db.close()
      }
      fs.rmSync(homeDir, { recursive: true, force: true })
      fs.mkdirSync(path.dirname(reposIndexPath), { recursive: true })
      fs.writeFileSync(reposIndexPath, reposIndexBefore)
      fs.rmSync(fixtureRoot, { recursive: true, force: true })
    } catch (err: unknown) {
      logError(`boot rollback failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  try {
    const ready = await tbv2Api.readyTask(task.id)
    if (ready.status !== 200) {
      throw new Error(`ready gate refused (${ready.status}): ${JSON.stringify(ready.body)}`)
    }
    const trig = await tbv2Api.triggerTask(task.id)
    if (trig.status !== 200) {
      throw new Error(`trigger refused (${trig.status}): ${JSON.stringify(trig.body)}`)
    }
  } catch (err) {
    rollback()
    throw err
  }

  let wsId = ""
  let wsPath = ""
  const handles: TbFlowHandles = {
    run,
    taskId: task.id,
    org,
    projName,
    batchRel,
    fixtureRoot,
    cloneDir,
    reposIndexBefore,
    reposIndexPath,
    wsId: () => wsId,
    wsPath: () => wsPath,
    repoWorkDir: () => path.join(wsPath, "projects", projName),
    async cleanup(cleanupOpts = {}) {
      // best-effort teardown, 票14 sweep order: abort live round → DELETE ws API
      // → DB rows → fs → acceptances registered (append-only trigger blocks DELETE).
      let accWritten = 0
      try {
        if (cleanupOpts.abortTask !== false) await tbv2Api.abort(task.id)
      } catch { /* already terminal */ }
      if (wsId) {
        let wsDeletedViaApi = false
        try {
          const r = await tbv2Api.deleteWorkspace(wsId)
          wsDeletedViaApi = r.status >= 200 && r.status < 300
        } catch (err: unknown) {
          logError(`ws delete API failed (${err instanceof Error ? err.message : String(err)}) — falling back to fs+DB`)
        }
        if (!wsDeletedViaApi) {
          // 兜底（票14 sweep 同法）：任务还挂在待验收时 DELETE 可能被闸拒 → 目录+行直清。
          try {
            if (wsPath) fs.rmSync(wsPath, { recursive: true, force: true })
          } catch { /* ignore */ }
          try {
            tbv2DbRun("DELETE FROM workspaces WHERE id = ?", wsId)
          } catch (err: unknown) {
            logError(`ws row delete: ${err instanceof Error ? err.message : String(err)}`)
          }
        } else {
          // API 成功后目录应已清；仍兜一次幂等 rm。
          try {
            if (wsPath && fs.existsSync(wsPath)) fs.rmSync(wsPath, { recursive: true, force: true })
          } catch { /* ignore */ }
        }
      }
      try {
        const execIds = tbv2DbAll<{ id: string }>("SELECT id FROM executions WHERE task_id = ?", task.id).map((r) => r.id)
        const doerSessionId = tbv2DbGet<{ doer_session_id: string | null }>(
          "SELECT doer_session_id FROM tasks WHERE id = ?", task.id,
        )?.doer_session_id
        // 账本残留登记（append-only trigger 挡 DELETE —— 票11/12/14 同纪律）：
        // 删 tasks 行之前先数本 run 写了多少决策行，日志如实报数。
        accWritten = tbv2AcceptanceCount(task.id)
        const db = new DatabaseSync(tbv2Env().dbPath)
        try {
          db.prepare("PRAGMA busy_timeout = 5000").run()
          db.prepare("PRAGMA foreign_keys = OFF").run()
          const run1 = (sql: string, ...p: unknown[]): void => {
            db.prepare(sql).run(...(p as never[]))
          }
          if (execIds.length) {
            const inList = execIds.map(() => "?").join(",")
            run1(`DELETE FROM agent_events WHERE node_execution_id IN (SELECT id FROM node_executions WHERE execution_id IN (${inList}))`, ...execIds)
            run1(`DELETE FROM node_executions WHERE execution_id IN (${inList})`, ...execIds)
            run1(`DELETE FROM node_token_usages WHERE node_execution_id IN (SELECT id FROM node_executions WHERE execution_id IN (${inList}))`, ...execIds)
            run1(`DELETE FROM llm_calls WHERE execution_id IN (${inList})`, ...execIds)
            run1(`DELETE FROM execution_summaries WHERE execution_id IN (${inList})`, ...execIds)
            run1(`DELETE FROM interaction_messages WHERE execution_id IN (${inList})`, ...execIds)
          }
          run1("DELETE FROM executions WHERE task_id = ?", task.id)
          run1("DELETE FROM tasks WHERE id = ?", task.id)
          if (doerSessionId) {
            run1("DELETE FROM chat_messages WHERE session_id = ?", doerSessionId)
            run1("DELETE FROM chat_sessions WHERE id = ?", doerSessionId)
          }
        } finally {
          db.close()
        }
      } catch (err: unknown) {
        logError(`db sweep: ${err instanceof Error ? err.message : String(err)}`)
      }
      try {
        fs.mkdirSync(path.dirname(handles.reposIndexPath), { recursive: true })
        fs.writeFileSync(handles.reposIndexPath, handles.reposIndexBefore)
      } catch { /* ignore */ }
      try {
        fs.rmSync(handles.fixtureRoot, { recursive: true, force: true })
      } catch { /* ignore */ }
      try {
        fs.rmSync(homeDir, { recursive: true, force: true })
      } catch { /* ignore */ }
      log(`[sweep ${opts.flow}] task ${task.id} swept; 本 run 账本写入=${accWritten} 行（task_phase_acceptances append-only，trigger 挡 DELETE，留 scratch DB 内按前缀可查）`)
    },
  }

  // Wait for the claim to land a root row + workspace binding.
  let root: RootExecRow
  try {
    root = await tbv2Until(() => {
      const rows = tbv2RootExecs(task.id)
      return rows.length >= 1 ? rows[0] : null
    }, 150_000, "no root execution row after trigger (built-in lifecycle job claim)")
  } catch (err) {
    rollback()
    throw err
  }
  wsId = root.workspace_id
  wsPath = tbv2DbGet<{ path: string }>("SELECT path FROM workspaces WHERE id = ?", wsId)?.path ?? ""
  if (!wsPath) throw new Error(`workspace row ${wsId} missing/path blank`)
  log(`[${opts.flow}] booted: task=${task.id} exec=${root.id} ws=${wsPath}`)
  return handles
}

// ── 票11 流⑦ seed —— 「待执行三签」UI-only 烟测专用（**不调 trigger，全程零真 provider**）──
//
// 形状 = tbv2BootFlow 的点火前半身，**到此为止**：fixture git 仓 + org repos 索引 +
// v4 直建（挂 source_chat_session_id 草稿会话）+ home 批次目录（spec.md + issues/≥1
// 票，过 ready 闸 ①⑥）+ POST /ready。不 trigger、不等 dispatcher、零执行行 ——
// 任务诚实停在「待执行」（⚡ 待触发），右栏触发钮原样在场但绝不点。
//
// 绑定流 = built-in/budget-test（三 agent 节点 step-1/step-2/step-3，**无必填 inputs**
// → 闸 ③ 天然通过；非 matt-spec-dev → 闸 ④ 不适用）。为什么钉 built-in 域而非
// 任务自建流：◆ 静态预览的两域取数里，home-file 门只放行 `.scratch/**`
// （GET /:id/home-file → resolveHomePath 白名单），任务 workflows/ 域在现读端点
// 拿不到正文 —— 本票是 UI-only 烟测、生产码零改动，故 fixture 走 built-in 侧读通路。
// seed 先 GET /api/workflows/built-in 目录核对该 ref 在场，不在场即响亮失败（不静默换流）。
//
// 草稿期会话（对话回放 + 右栏账台角标的数据面 —— 写侧不经 LLM，读侧全走既有端点）：
//   · POST /api/clones/task-author/sessions 真建会话行（clone_name=task-author，
//     ReadyChatReplay 的 GET /:name/sessions/:id 按 clone_name 校验）；
//   · messages 两行（user + assistant，created_at 相隔 2s → 回放按到达序）；
//   · llm_calls 一行（execution_id NULL 的会话口径账）→ GET /api/sessions/:id/llm-calls
//     totalCalls=1 → ReadyTokenBadge 出账（票10 三态短路的「有账」half）。

export interface TbReadyHandles {
  run: string
  taskId: string
  sessionId: string
  org: string
  projName: string
  batchRel: string
  /** 绑定流 ref（built-in 域）与其 YAML 顶层节点声明序（◆ 预览的行契约）。 */
  wfRef: string
  nodeIds: string[]
  userMarker: string
  aiMarker: string
  cleanup: () => Promise<void>
}

export async function tbv2SeedReadyTask(opts: { flow: string }): Promise<TbReadyHandles> {
  const run = `${opts.flow}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const org = `E2E_TBV2_org_${opts.flow}`
  const projName = `e2e-tbv2-${run}`
  const slug = `e2e-tbv2-${run}`
  const batchRel = `.scratch/${YMD()}/${slug}`
  const wfRef = "built-in/budget-test"
  const nodeIds = ["step-1", "step-2", "step-3"]
  const userMarker = `${TBV2_PREFIX}F7U_${run}`
  const aiMarker = `${TBV2_PREFIX}F7A_${run}`

  // 绑定流在场核对（产品读面目录；缺流 = 机器资源变了，响亮失败不静默换流）
  const catRes = await fetch(`${tbv2Env().serverUrl}/api/workflows/built-in`)
  if (!catRes.ok) throw new Error(`GET /api/workflows/built-in → ${catRes.status}`)
  const catalog = (await catRes.json()) as Array<{ ref?: string }>
  if (!catalog.some((w) => w.ref === wfRef)) {
    throw new Error(`流⑦ fixture 需要绑定流 ${wfRef} 在场（built-in 目录未见 —— 资源库被清过？）`)
  }

  const fixtureRoot = path.join(dataRoot(), `git-${run}`)
  const bare = path.join(fixtureRoot, `${projName}.git`)
  const cloneDir = path.join(fixtureRoot, projName)
  fs.mkdirSync(fixtureRoot, { recursive: true })
  gitAt(["init", "--bare", "-b", "main", bare], fixtureRoot)
  gitAt(["clone", bare, cloneDir], fixtureRoot)
  gitAt(["config", "user.email", "e2e@tbv2.local"], cloneDir)
  gitAt(["config", "user.name", "E2E TBV2"], cloneDir)
  fs.writeFileSync(path.join(cloneDir, "README.md"), `# ${projName} (e2e tbv2 flow7 fixture)\n`)
  gitAt(["add", "-A"], cloneDir)
  gitAt(["-c", "user.name=E2E TBV2", "-c", "user.email=e2e@tbv2.local", "commit", "-m", "seed"], cloneDir)
  gitAt(["push", "origin", "main"], cloneDir)

  // org repos index —— ready 闸 B1（project:<name> 预检）吃这份；逐流 org 防撞（同 boot）。
  const reposIndexPath = path.join(os.homedir(), ".octopus", "orgs", org, "repos", "index.md")
  const reposIndexBefore = fs.existsSync(reposIndexPath) ? fs.readFileSync(reposIndexPath, "utf-8") : ""
  fs.mkdirSync(path.dirname(reposIndexPath), { recursive: true })
  fs.writeFileSync(reposIndexPath, `${reposIndexBefore}\n### ${projName}\n- local: ${cloneDir} ✓ cloned\n`)

  let taskId = ""
  let sessionId = ""
  const homeDirOf = (id: string): string => path.join(os.homedir(), ".octopus", "tasks", id)
  // 反孤儿：seed 任一步失败 → 先清本轮已落的现场（DB 行按 FK 安全序 / fs / 索引快照），再抛。
  const teardown = async (): Promise<void> => {
    try {
      const db = new DatabaseSync(tbv2Env().dbPath)
      try {
        db.prepare("PRAGMA busy_timeout = 5000").run()
        db.prepare("PRAGMA foreign_keys = OFF").run()
        if (taskId) db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId)
        if (sessionId) {
          db.prepare("DELETE FROM llm_calls WHERE session_id = ?").run(sessionId)
          db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId)
          db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId)
        }
      } finally {
        db.close()
      }
    } catch (err: unknown) {
      logError(`flow7 seed teardown(db): ${err instanceof Error ? err.message : String(err)}`)
    }
    try { if (taskId) fs.rmSync(homeDirOf(taskId), { recursive: true, force: true }) } catch { /* ignore */ }
    try { fs.mkdirSync(path.dirname(reposIndexPath), { recursive: true }); fs.writeFileSync(reposIndexPath, reposIndexBefore) } catch { /* ignore */ }
    try { fs.rmSync(fixtureRoot, { recursive: true, force: true }) } catch { /* ignore */ }
  }

  try {
    // 草稿期会话（真端点建行 —— 回放路由校验 clone_name=task-author）
    const sessRes = await fetch(`${tbv2Env().serverUrl}/api/clones/task-author/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Octopus-Org": org },
      body: JSON.stringify({ title: `${TBV2_PREFIX}票11流${opts.flow} 草稿会话 ${run}` }),
    })
    if (!sessRes.ok) throw new Error(`create author session → ${sessRes.status}: ${(await sessRes.text()).slice(0, 300)}`)
    sessionId = ((await sessRes.json()) as { id: string }).id

    // 会话两行（messages 表 = 回放端点 GET /:name/sessions/:id 的同源读面）
    const t0 = Date.now()
    const iso = (ms: number): string => new Date(ms).toISOString()
    tbv2DbRun(
      `INSERT INTO messages (id, session_id, role, content, type, metadata, tool_calls, is_summary, is_compressed, is_edited, source, created_at)
       VALUES (?, ?, 'user', ?, 'text', NULL, NULL, 0, 0, 0, 'main', ?)`,
      `${TBV2_PREFIX}F7m1_${run}`, sessionId, `帮我把「待执行三签烟测」谈成可放行的任务：${userMarker}`, iso(t0),
    )
    tbv2DbRun(
      `INSERT INTO messages (id, session_id, role, content, type, metadata, tool_calls, is_summary, is_compressed, is_edited, source, created_at)
       VALUES (?, ?, 'assistant', ?, 'text', NULL, NULL, 0, 0, 0, 'main', ?)`,
      `${TBV2_PREFIX}F7m2_${run}`, sessionId, `已建草稿并写入批次 spec 与票面。${aiMarker}`, iso(t0 + 2000),
    )

    // 会话口径账一行（execution_id NULL —— 角标读 GET /api/sessions/:id/llm-calls 的原料）
    tbv2DbRun(
      `INSERT INTO llm_calls (id, node_execution_id, execution_id, turn_index, call_index, message_id, model,
         stop_reason, timestamp, duration_ms, ttft_ms, input_tokens, output_tokens, cache_read_tokens,
         cache_creation_tokens, org, workspace_id, workflow_ref, node_id, session_id, instance_id, source_path)
       VALUES (?, NULL, NULL, 1, 1, ?, 'claude-sonnet-4.5', 'end_turn', ?, 1500, NULL, 1200, 260, 8000, 500, ?, NULL, NULL, NULL, ?, NULL, 'clone_chat')`,
      `${TBV2_PREFIX}F7c1_${run}`, `${TBV2_PREFIX}F7m2_${run}`, t0, org, sessionId,
    )

    // v4 直建 + 草稿会话绑定（POST /api/tasks 既有字段；source_chat_session_id 为 FK→sessions）
    const task = await tbv2Api.createTask({
      org,
      name: `${TBV2_PREFIX}票11流${opts.flow}_${run}`,
      task_type: "coding",
      skill_groups: [],
      preset: { org },
      project_ids: [projName],
      source_chat_session_id: sessionId,
      task_spec: {
        format: "v4",
        goal: `${TBV2_PREFIX} 票11 E2E flow ${opts.flow} — 待执行三签 UI-only 烟测（不点火）`,
        autoAdvance: false,
        phases: [
          { index: 1, name: "E2E 流", slug, specPath: `${batchRel}/spec.md`, workflowRef: wfRef, inputValues: {} },
        ],
        // unit-only 复检门 —— ready 闸的 runbook 逃生面（票06 先例），E2E 永不点复检。
        acceptance_verify: { command: "echo tbv2-e2e-verify", cwd: ".", timeoutS: 30 },
        resources: [],
        authoring_resources: [],
      },
    })
    taskId = task.id
    const homeDir = homeDirOf(taskId)
    if (!fs.existsSync(homeDir)) throw new Error(`v4 create did not materialize home: ${homeDir}`)

    // home 批次目录（ready 闸 ① spec 落盘 + ⑥ issues/≥1 票）
    fs.mkdirSync(path.join(homeDir, batchRel, "issues"), { recursive: true })
    fs.writeFileSync(
      path.join(homeDir, batchRel, "spec.md"),
      `# E2E TBV2 spec ${run}\n\n范围：UI-only 三签烟测 —— 本流不 trigger，永不执行绑定流。\n验收方式：控制台三签 UI 观察 + 零执行行对账。\n`,
    )
    fs.writeFileSync(
      path.join(homeDir, batchRel, "issues", "1-ticket.md"),
      `# 票1 e2e stub\n\n## Status\n\nStatus: ready-for-agent\n`,
    )

    const ready = await tbv2Api.readyTask(taskId)
    if (ready.status !== 200) throw new Error(`ready gate refused (${ready.status}): ${JSON.stringify(ready.body)}`)
  } catch (err) {
    await teardown()
    throw err
  }

  log(`[${opts.flow}] ready-seeded: task=${taskId} session=${sessionId} bind=${wfRef}（零 trigger / 零执行行）`)
  return {
    run, taskId, sessionId, org, projName, batchRel, wfRef, nodeIds, userMarker, aiMarker,
    async cleanup() {
      await teardown()
      log(`[sweep ${opts.flow}] task ${taskId} swept（ready 未点火 —— 无 ws/exec 行可清；账本写入=0）`)
    },
  }
}

/** Wait until the round's bash node is genuinely running in-process (pause/takeover precondition).
 *  票11 刀B 加固：过滤 `__` 前缀引擎虚拟节点（__engine_init__ 等）—— 并行负载下 init 的
 *  running 停驻窗口变宽，按 started_at ASC 首命中会采到虚拟节点，令流③的节点对账假挂；
 *  server 的干预落点本来就打在真实工作流节点上（产品行为正确）。 */
export async function tbv2WaitRunningNode(handles: TbFlowHandles, timeoutMs = 90_000): Promise<{ execId: string; nodeId: string }> {
  return tbv2Until(() => {
    const rows = tbv2RootExecs(handles.taskId)
    const live = rows.find((r) => r.status === "running")
    if (!live) return null
    const node = tbv2NodeRows(live.id).find((n) => n.status === "running" && !n.node_id.startsWith("__"))
    return node ? { execId: live.id, nodeId: node.node_id } : null
  }, timeoutMs, "no running node in a live round")
}

/** Wait for the phase's last round to reach a terminal state; returns the row. */
export async function tbv2WaitRoundTerminal(handles: TbFlowHandles, roundIndex: number, timeoutMs = 300_000): Promise<RootExecRow> {
  return tbv2Until(() => {
    const row = tbv2RootExecs(handles.taskId).find((r) => r.round_index === roundIndex)
    return row && TERMINAL_EXEC.has(row.status) ? row : null
  }, timeoutMs, `round ${roundIndex} never reached terminal`)
}

/** The task's derived view (single authority — same DTO the UI renders). phaseViews normalized. */
export async function tbv2Derived(taskId: string): Promise<{ taskStatus?: string; isV4?: boolean; phaseViews: TbPhaseViewLite[] }> {
  const d = await tbv2Api.getTask(taskId)
  if (!d.derived) throw new Error(`GET /tasks/${taskId} carried no derived view (old server?)`)
  return { ...d.derived, phaseViews: d.derived.phaseViews ?? [] }
}

// ── SSE generic collector (server-side truth for state transitions) ───

export class TbSseLog {
  events: Array<{ event: string; data: Record<string, unknown> }> = []
  private controller = new AbortController()
  async start(): Promise<void> {
    const res = await fetch(`${tbv2Env().serverUrl}/api/tasks/events`, {
      headers: { Accept: "text/event-stream" },
      signal: this.controller.signal,
    })
    if (!res.ok || !res.body) throw new Error(`SSE subscribe failed: ${res.status}`)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const blocks = buffer.split("\n\n")
          buffer = blocks.pop() ?? ""
          for (const block of blocks) {
            if (!block.trim()) continue
            let name = "message"
            let data = ""
            for (const line of block.split("\n")) {
              if (line.startsWith("event:")) name = line.slice(6).trim()
              else if (line.startsWith("data:")) data = line.slice(5).trim()
            }
            let parsed: Record<string, unknown> = {}
            try {
              parsed = JSON.parse(data) as Record<string, unknown>
            } catch {
              /* keep */
            }
            this.events.push({ event: name, data: parsed })
          }
        }
      } catch {
        /* abort */
      }
    })()
  }
  stop(): void {
    this.controller.abort()
  }
  count(taskId: string, eventName?: string): number {
    return this.events.filter(
      (e) => e.data.task_id === taskId && (!eventName || e.event === eventName),
    ).length
  }
}

// ── DOM anchors — verified against 票02-09 landed components (task-run-console.tsx /
//    files-tab / chat-tab / nodes-tab / acceptance-surface), NOT the prototype draft.

export const SEL = {
  consoleRoot: () => `[data-run-console]`,
  card: (taskId: string) => `[data-task-column] >> [data-task-id="${taskId}"]`,
  cardInCol: (col: string, taskId: string) => `[data-task-column="${col}"] [data-task-id="${taskId}"]`,
  tab: (key: string) => `[data-console-tab="${key}"]`,
  tabSelected: () => `[data-console-tabs] [data-console-tab][aria-selected="true"]`,
  host: (key: string) => `[data-tab-host="${key}"]`,
  headCommits: () => `[data-head-commits]`,
  statusPill: () => `[data-task-modal-status]`,
  // ≡ 变更 (票03/07)
  filesTab: () => `[data-testid="files-tab"]`,
  statStrip: () => `[data-testid="round-diff-strip"]`,
  stat: (label: string) => `[data-acceptance-stat="${label}"]`,
  fileRows: () => `[data-acceptance-diff-row]`,
  quickEditBadge: () => `[data-testid="quick-edit-badge"]`,
  quickEditChip: () => `[data-testid="quick-edit-chip"]`,
  // 💬 对话 (票07)
  chatForm: () => `[data-chat-form]`,
  chatInput: () => `[data-testid="chat-input"]`,
  chatSend: () => `[data-testid="chat-send"]`,
  chatToolCard: () => `[data-testid="chat-tool-card"]`,
  chatMsgAi: () => `[data-testid="chat-msg-ai"]`,
  // ◆ 节点 (票04)
  nodesTab: () => `[data-testid="nodes-tab"]`,
  nodeRow: (nodeId: string) => `[data-testid="node-row-${nodeId}"]`,
  nodesWfPill: () => `[data-testid="nodes-wf-pill"]`,
  // LIVE 卡 + ⚑ (票06/08)
  liveCard: () => `[data-testid="rail-live-card"]`,
  interventionChip: () => `[data-testid="rail-intervention-chip"]`,
  interventionLog: () => `[data-testid="intervention-log"]`,
  interventionLine: () => `[data-testid="intervention-line"]`,
  // rail 动作（真实 data-*，predecessor draft 里 ask/confirm 两个锚写错过）
  railPause: () => `[data-task-pause]`,
  railResume: () => `[data-task-resume]`,
  railAbort: () => `[data-task-abort]`,
  railAskTakeover: () => `[data-task-ask-takeover]`,
  railDeliver: () => `[data-rail-deliver]`,
  railReassign: () => `[data-rail-reassign]`,
  railAccept: () => `[data-rail-accept]`,
  railReject: () => `[data-rail-reject]`,
  railWs: () => `[data-rail-ws]`, // ⑪真机复点：待验收右栏「🗂 工作空间 · P<ph> 执行视图 ↗」
  // 注入弹框 (票06)
  injectDialog: () => `[data-testid="resume-intervene-dialog"]`,
  injectText: () => `[data-inject-text]`,
  injectConfirm: () => `[data-inject-confirm]`,
  // 三分支弹框 (票08)
  branchDialog: () => `[data-testid="takeover-branch-dialog"]`,
  branchOption: (id: string) => `[data-testid="branch-option-${id}"]`,
  branchGo: () => `[data-testid="branch-go"]`,
  // 走查面（票05/08/09）
  acceptanceModal: () => `[data-acceptance-modal]`,
  rejectOpen: () => `[data-acceptance-reject]`,
  rejectFeedback: () => `[data-reject-panel] [data-reject-feedback]`,
  rejectConfirm: () => `[data-reject-panel] [data-reject-confirm]`,
  takeoverChip: () => `[data-testid="acceptance-takeover-chip"]`,
  // 台账预览弹层 (票09 / ADR-0022)
  ledgerDialog: () => `[data-testid="ledger-dialog"]`,
  ledgerPreviewIntervention: () => `[data-testid="ledger-preview-intervention"]`,
  ledgerPreviewQuickEdit: () => `[data-testid="ledger-preview-quick-edit"]`,
  ledgerPreviewTakeover: () => `[data-testid="ledger-preview-takeover"]`,
  ledgerConfirm: () => `[data-testid="ledger-confirm"]`,
}

/** Deep-link open of the unified console shell (票02 壳; /tasks?task= 深链单源). */
export async function openConsole(page: Page, taskId: string): Promise<void> {
  await page.goto(`/tasks?task=${encodeURIComponent(taskId)}`)
  await page.locator(SEL.consoleRoot()).waitFor({ state: "visible", timeout: 30_000 })
}

export async function activeTabKey(page: Page): Promise<string> {
  const el = page.locator(SEL.tabSelected()).first()
  return (await el.getAttribute("data-console-tab")) ?? ""
}

export async function clickTab(page: Page, key: string): Promise<void> {
  await page.locator(SEL.tab(key)).first().click()
}

/** Wait until the board card for taskId sits in `column`. The board itself takes a
 *  beat to load (list + per-v4 detail fan-out), so: one goto, then POLL the DOM in place;
 *  re-navigate only every ~8s (not every 2s — re-navigation before render resets the
 *  fan-out and the card would never be counted). */
export async function waitCardColumn(page: Page, taskId: string, column: string, timeoutMs = 90_000): Promise<void> {
  const t0 = Date.now()
  let lastNav = 0
  while (Date.now() - t0 < timeoutMs) {
    if (Date.now() - lastNav > 8_000 || lastNav === 0) {
      await page.goto("/tasks")
      lastNav = Date.now()
      // 等看板出现任意卡片（= fetchTasks 完成一轮）再查。
      await page.locator("[data-task-id]").first().waitFor({ state: "attached", timeout: 20_000 }).catch(() => {})
    }
    const count = await page.locator(SEL.cardInCol(column, taskId)).count()
    if (count > 0) return
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error(`card ${taskId} never appeared in column ${column} (${timeoutMs}ms)`)
}
