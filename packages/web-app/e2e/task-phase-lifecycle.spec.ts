// packages/web-app/e2e/task-phase-lifecycle.spec.ts
//
// task-phase-redesign 票 14 — 主故事全链穿线（AC1-AC5）。
//
// 一条真实链路（真实 server:3001 + 真实 SQLite + 真实 fs + 真实 git fixture，
// 零 mock、零 skip；agent 执行节点用 bash-stub 工作流模拟 —— 票 14 stub 原则，
// 活体 LLM 不在 E2E 域）：
//   新建 coding 任务（API 直造 v4 fixture，票 11/12 同法）→ 拆分/绑定经 UI 反映
//   → [入队]（v4 gate 四行清单，真点击）→ 触发 phase1（真点击，真调度 claim →
//   ws 首建 + git worktree + seed 下行 + bash 执行）→ 终态 collect 上行 + SSE →
//   待验收三栏（真弹窗）→ 打回带反馈（真 POST：账本 rejected + fix-feedback-r1.md
//   + round2 同 worktree 开跑 + seed 反映 home 新 spec）→ 通过（auto_advance →
//   phase2 自动开跑）→ 末通过 → archiving（git fixture 双 project：ADR 顺延 /
//   术语 append / 冲突只报不写 / 归档 commit push）→ done。
//   全程 AC2 交叉真相：UI 角标 == GET /:id derived == DB 账本/executions == fs。
//
// 组织隔离：task 经 API createTask(org=E2E_TD_org) 直造（票 11/12 先例 —— UI 的
// TemplatePicker 默认 orgs[0]=真实 org，E2E 不得把 workspace/git worktree 落进
// 用户真实 org）；「新建」UI 路径本身已由票 11 AC1 覆盖。R6（登录取 token）在本
// 项目为空操作：server 无 auth 中间件（/api/tasks 无鉴权，全库 e2e 先例一致）。
//
// 运行：
//   export E2E_ARTIFACTS_DIR=<repo>/.scratch/task-phase-redesign
//   cd packages/web-app && npx playwright test e2e/task-phase-lifecycle.spec.ts --trace on
// 前置：server 已起（:3001）；web 未起时 playwright.config webServer 自动拉起
// （注意：⏳ 徽标用例在票 11 spec，本 spec 不依赖 NEXT_PUBLIC_PHASE_BUDGET_MS）。
//
// 残留登记（afterAll 打印）：task_phase_acceptances 受 append-only trigger 保护
// 无法 DELETE —— 本 spec 写入 3 行（(1,1)rejected/(1,2)accepted/(2,1)accepted），
// 与票 11/12 的 E2E_TD_acc_* 一并归清扫脚本按 task 前缀登记。

import { test, expect } from "@playwright/test"
import { DatabaseSync } from "node:sqlite"
import { spawnSync } from "node:child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  SERVER_URL,
  TASK_E2E_ORG,
  log,
  logError,
  isServerAvailable,
  createTask,
  updateTask,
  getTask,
  resolveDbPath,
  type TaskDTO,
} from "./helpers/task-domain-helpers"

// ── 常量 / 运行态 ──────────────────────────────────────────────────────

const RUN = `lc${Date.now().toString(36)}`
const TASK_NAME = `E2E_TD_主故事穿线_${RUN}`
const PROJ_A = `e2e-td-lc-${RUN}-pA`
const PROJ_B = `e2e-td-lc-${RUN}-pB`
const YMD = (() => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
})()
const SLUG1 = `e2e-td-lc-${RUN}-p1`
const SLUG2 = `e2e-td-lc-${RUN}-p2`
const BATCH1 = `.scratch/${YMD}/${SLUG1}`
const BATCH2 = `.scratch/${YMD}/${SLUG2}`
const GOAL = `E2E_TD 主故事穿线 ${RUN}`

const DATA_DIR = process.env.E2E_ARTIFACTS_DIR
  ? path.join(process.env.E2E_ARTIFACTS_DIR, "e2e-data")
  : path.resolve(__dirname, "../../../.scratch/task-phase-redesign/e2e-data")
const SHOT_DIR = process.env.E2E_ARTIFACTS_DIR
  ? path.join(process.env.E2E_ARTIFACTS_DIR, "e2e-screenshots", "lifecycle")
  : path.resolve(__dirname, "../e2e-screenshots/lifecycle")
const REPOS_INDEX = path.join(os.homedir(), ".octopus", "orgs", TASK_E2E_ORG, "repos", "index.md")
const FIX_ROOT = path.join(DATA_DIR, `git-${RUN}`)

let serverAvailable = false
let taskId = ""
let taskVersion = 0
let boundWsId = ""
let envelopeScheduleId = ""
let reposIndexBefore = ""

interface AcceptanceResp {
  status: number
  body: {
    task: { status: string; derived: TaskDerived }
    next_action: string
    acceptance_id: string
    dispatch?: { schedule_id: string; execution_id: string; workspace_id: string; phase_index: number; round_index: number }
    error?: string
  } | null
}
interface TaskDerived {
  taskStatus: string
  isV4: boolean
  phaseViews: Array<{
    index: number; name: string; slug: string; workflowRef: string; status: string
    currentRound: number | null; acceptedRound: number | null; awaitingRound: number | null
    rounds: Array<{ roundIndex: number; state: string; decision: string | null }>
  }>
}

function shot(name: string): string {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  return path.join(SHOT_DIR, name)
}
const HOME_DIR = (): string => path.join(os.homedir(), ".octopus", "tasks", taskId)
const NOW_ISO = (): string => new Date().toISOString()

// ── sqlite（读写，票 11 先例）─────────────────────────────────────────
function dbOpen(): DatabaseSync {
  const db = new DatabaseSync(resolveDbPath())
  db.prepare("PRAGMA busy_timeout = 5000").run()
  return db
}
function dbRun(sql: string, ...params: unknown[]): void {
  const db = dbOpen()
  try { db.prepare(sql).run(...(params as never[])) } finally { db.close() }
}
function dbAll<T>(sql: string, ...params: unknown[]): T[] {
  const db = dbOpen()
  try { return db.prepare(sql).all(...(params as never[])) as T[] } finally { db.close() }
}
function dbGet<T>(sql: string, ...params: unknown[]): T | undefined {
  const db = dbOpen()
  try { return db.prepare(sql).get(...(params as never[])) as T | undefined } finally { db.close() }
}

interface ExecRow { id: string; status: string; phase_index: number | null; round_index: number | null; workspace_id: string }
const TERM = new Set(["completed", "failed", "error", "cancelled", "completed_with_failures"])

/** Poll a predicate until truthy or deadline. */
async function until<T>(fn: () => T | null | Promise<T | null>, timeoutMs: number, msg: string): Promise<T> {
  const t0 = Date.now()
  let lastErr = ""
  while (Date.now() - t0 < timeoutMs) {
    try {
      const v = await fn()
      if (v) return v
    } catch (err: unknown) {
      lastErr = err instanceof Error ? err.message : String(err)
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(`timeout(${timeoutMs}ms): ${msg}${lastErr ? ` last: ${lastErr}` : ""}`)
}

/** 本任务打标执行（经 schedules origin 域 — derive 同口径）。 */
function taskRoundExecs(): ExecRow[] {
  return dbAll<ExecRow>(
    `SELECT e.id, e.status, e.phase_index, e.round_index, e.workspace_id FROM executions e
      WHERE e.phase_index IS NOT NULL AND e.id IN (
        SELECT se.execution_id FROM schedule_executions se
          JOIN schedules s ON s.id = se.schedule_id
         WHERE s.origin_type='task' AND s.origin_id = ? AND se.execution_id IS NOT NULL)
      ORDER BY e.created_at ASC`,
    taskId,
  )
}
function roundTerminal(phaseIdx: number, roundIdx: number): ExecRow | undefined {
  return taskRoundExecs().find((e) => e.phase_index === phaseIdx && e.round_index === roundIdx && TERM.has(e.status))
}

// ── SSE 收集（全部事件名通用）─────────────────────────────────────────
class SseLog {
  events: Array<{ event: string; data: Record<string, unknown> }> = []
  private controller = new AbortController()
  async start(): Promise<void> {
    const res = await fetch(`${SERVER_URL}/api/tasks/events`, {
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
              else if (line.startsWith("data:")) data += line.slice(5).trim()
            }
            let parsed: Record<string, unknown> = {}
            try { parsed = JSON.parse(data) as Record<string, unknown> } catch { /* keep */ }
            this.events.push({ event: name, data: parsed })
          }
        }
      } catch { /* abort */ }
    })()
  }
  stop(): void { this.controller.abort() }
  count(name: string, pred: (d: Record<string, unknown>) => boolean = () => true): number {
    return this.events.filter((e) => e.event === name && pred(e.data)).length
  }
}
const sse = new SseLog()

// ── git fixture（双 project：bare origin + 主 clone 种子）──────────────
function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" })
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} @${cwd}: ${r.stderr?.trim()}`)
  return r.stdout.trim()
}
function makeFixtureRepo(name: string, opts: { context: boolean }): { bare: string; clone: string } {
  const bare = path.join(FIX_ROOT, `${name}.git`)
  const clone = path.join(FIX_ROOT, name)
  fs.mkdirSync(path.dirname(clone), { recursive: true })
  git(["init", "--bare", "-b", "main", bare], DATA_DIR)
  git(["clone", bare, clone], DATA_DIR)
  git(["config", "user.email", "e2e@lc.local"], clone)
  git(["config", "user.name", "E2E TD LC"], clone)
  fs.mkdirSync(path.join(clone, "docs", "adr"), { recursive: true })
  for (const n of [1, 2, 3]) {
    fs.writeFileSync(path.join(clone, "docs", "adr", `000${n}-pre.md`), `# ADR 000${n}\n\n预置 ${n}\n`)
  }
  if (opts.context) {
    fs.writeFileSync(
      path.join(clone, "CONTEXT.md"),
      "# Context\n\n## 术语表\n\n| Term | Definition |\n|------|-----------|\n| **Widget** | 仓库既有定义（旧义，冲突时不得覆盖） |\n",
    )
  }
  fs.writeFileSync(path.join(clone, "README.md"), `# ${name}\n`)
  git(["add", "-A"], clone)
  git(["commit", "-m", "seed"], clone)
  git(["push", "origin", "main"], clone)
  return { bare, clone }
}

// ── fs fixtures（home 批次目录 / stub 工作流 / 归档面输入）────────────
function writeStubWorkflow(): void {
  const dir = path.join(HOME_DIR(), "workflows")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, "e2e-td-lc-stub.yaml"),
    [
      "apiVersion: octopus/v1",
      "kind: Workflow",
      "name: e2e-td-lc-stub",
      "description: E2E 票14 主故事 stub —— bash-only（零 LLM），往批次目录写执行侧报告",
      "inputs:",
      "  batch_dir:",
      "    description: \"task 批次目录（ws 相对）\"",
      "    required: true",
      "nodes:",
      "  - id: stub-exec",
      "    type: bash",
      "    timeout: 60",
      "    bash: |",
      "      set -e",
      "      echo \"E2E_TD_LC_ROUND_DONE $(date +%s)\" > \"$vars.batch_dir/exec-report.md\"",
      "      if [ -f \"$vars.batch_dir/issues/1-ticket.md\" ]; then",
      "        python3 -c \"import sys;p=sys.argv[1];s=open(p).read();open(p,'w').write(s.replace('Status: ready-for-agent','Status: done'))\" \"$vars.batch_dir/issues/1-ticket.md\" || true",
      "      fi",
      "",
    ].join("\n"),
  )
}
function writeBatchDirs(): void {
  for (const [batch, n] of [[BATCH1, "一"], [BATCH2, "二"]] as const) {
    const dir = path.join(HOME_DIR(), batch)
    fs.mkdirSync(path.join(dir, "issues"), { recursive: true })
    fs.writeFileSync(path.join(dir, "spec.md"), `# Phase ${n} spec — ${RUN}\n\n范围：E2E_TD 主故事穿线 ${n}。\n验收方式：API↔DB↔fs 四方一致。\n`)
    fs.writeFileSync(path.join(dir, "issues", "1-ticket.md"), `# 票1 stub\n\n## Status\n\nStatus: ready-for-agent\n`)
  }
}
function writeArchiveInputs(): void {
  fs.mkdirSync(path.join(HOME_DIR(), "docs", "adr", PROJ_A), { recursive: true })
  fs.writeFileSync(path.join(HOME_DIR(), "docs", "adr", PROJ_A, "0001-pick-db.md"), `# ADR 选库\n\n选 sqlite（WAL）。\n`)
  fs.mkdirSync(path.join(HOME_DIR(), "docs", "adr", PROJ_B), { recursive: true })
  fs.writeFileSync(path.join(HOME_DIR(), "docs", "adr", PROJ_B, "0001-add-cache.md"), `# ADR 加缓存\n\n内存 LRU。\n`)
  fs.writeFileSync(
    path.join(HOME_DIR(), "context-notes.md"),
    `# E2E_TD 术语笔记（${RUN}）\n\n## ${PROJ_A}\n- **Gizmo** — E2E_TD projA 新部件词\n- **Widget** — E2E_TD 与仓库旧义冲突的新定义\n\n## ${PROJ_B}\n- **Sprocket** — E2E_TD projB 新链轮词\n`,
  )
}
function bindReposToIndex(repoA: { clone: string }, repoB: { clone: string }): void {
  reposIndexBefore = fs.existsSync(REPOS_INDEX) ? fs.readFileSync(REPOS_INDEX, "utf-8") : ""
  fs.writeFileSync(
    REPOS_INDEX,
    `${reposIndexBefore}\n### ${PROJ_A}\n- local: ${repoA.clone} ✓ cloned\n\n### ${PROJ_B}\n- local: ${repoB.clone} ✓ cloned\n`,
  )
}

// ── cleanup ───────────────────────────────────────────────────────────
async function sweep(): Promise<void> {
  const inTry = (label: string, fn: () => void): void => {
    try { fn() } catch (err: unknown) { logError(`${label}: ${err instanceof Error ? err.message : String(err)}`) }
  }
  // ① bound workspace — 走 server API 正常口（done 后 archive-gate 放行；删目录+
  //    prune worktree+删行），失败退回 fs+DB。
  if (boundWsId) {
    try {
      const res = await fetch(`${SERVER_URL}/api/workspaces/${boundWsId}`, { method: "DELETE" })
      log(`ws delete API → ${res.status}`)
    } catch { /* fall through */ }
  }
  const wsRow = boundWsId ? dbGet<{ path: string }>("SELECT path FROM workspaces WHERE id = ?", boundWsId) : undefined
  inTry("rm ws dir", () => { if (wsRow) fs.rmSync(wsRow.path, { recursive: true, force: true }) })
  inTry("db sweep", () => {
    // 单次连接、PRAGMA foreign_keys=OFF：本 run 造的是自洽的父子行集合（tasks →
      // schedules → schedule_* → executions → node_executions → agent_events/
      // llm_calls → workspace），一次性按域删除即可，无需逐表凑 FK 序（executions
      // 被 execution_summaries/interaction_messages/schedule_workspaces 多向引用，
      // 硬凑顺序脆）。仅影响这条短生命周期连接，不碰 server 连接的 FK 语义。
    const db = new DatabaseSync(resolveDbPath())
    try {
      db.prepare("PRAGMA busy_timeout = 5000").run()
      db.prepare("PRAGMA foreign_keys = OFF").run()
      const run = (sql: string, ...p: unknown[]): void => { db.prepare(sql).run(...(p as never[])) }
      if (taskId) {
        const execIds = (db.prepare(
          `SELECT e.id FROM executions e WHERE e.phase_index IS NOT NULL AND e.id IN (
             SELECT se.execution_id FROM schedule_executions se JOIN schedules s ON s.id=se.schedule_id
              WHERE s.origin_type='task' AND s.origin_id=? AND se.execution_id IS NOT NULL)`,
        ).all(taskId) as Array<{ id: string }>).map((r) => r.id)
        for (const e of execIds) {
          run("DELETE FROM agent_events WHERE node_execution_id IN (SELECT id FROM node_executions WHERE execution_id=?)", e)
          run("DELETE FROM node_token_usages WHERE node_execution_id IN (SELECT id FROM node_executions WHERE execution_id=?)", e)
        }
        if (execIds.length) {
          const inList = execIds.map(() => "?").join(",")
          run(`DELETE FROM node_executions WHERE execution_id IN (${inList})`, ...execIds)
          run(`DELETE FROM llm_calls WHERE execution_id IN (${inList})`, ...execIds)
          run(`DELETE FROM execution_summaries WHERE execution_id IN (${inList})`, ...execIds)
          run(`DELETE FROM interaction_messages WHERE execution_id IN (${inList})`, ...execIds)
        }
        run("DELETE FROM schedule_executions WHERE schedule_id IN (SELECT id FROM schedules WHERE origin_id=?)", taskId)
        run("DELETE FROM schedule_workspaces WHERE schedule_id IN (SELECT id FROM schedules WHERE origin_id=?)", taskId)
        run("DELETE FROM executions WHERE workspace_id = ?", boundWsId)
        run("DELETE FROM workspaces WHERE id = ?", boundWsId)
        run("DELETE FROM schedules WHERE origin_id = ?", taskId)
        run("DELETE FROM tasks WHERE id = ?", taskId)
      }
    } finally { db.close() }
  })
  inTry("restore repos index", () => fs.writeFileSync(REPOS_INDEX, reposIndexBefore))
  inTry("rm git fixture", () => fs.rmSync(FIX_ROOT, { recursive: true, force: true }))
  inTry("rm task home", () => { if (taskId) fs.rmSync(HOME_DIR(), { recursive: true, force: true }) })
  // 孤儿登记：账本 trigger 挡 DELETE（票 11 先例）—— 只计数入报告。
  if (taskId) {
    try {
      const orphans = dbAll<{ c: number }>(
        "SELECT COUNT(*) c FROM task_phase_acceptances WHERE task_id IN (SELECT id FROM tasks WHERE name LIKE 'E2E_TD_%')",
      )[0]?.c ?? 0
      const gone = dbAll<{ c: number }>(
        "SELECT COUNT(*) c FROM task_phase_acceptances WHERE task_id NOT IN (SELECT id FROM tasks)",
      )[0]?.c ?? 0
      log(`[sweep] acceptances 孤儿登记（trigger 保护不可 DELETE）: 挂E2E_TD任务=${orphans} 无主=${gone}（本 run 写入 3 行）`)
    } catch (err: unknown) {
      logError(`sweep ledger count: ${err}`)
    }
  }
}

test.describe.configure({ mode: "serial" })

test.describe("票14 主故事：phase 全生命周期（新建→入队→触发→seed→collect→打回→round2→通过→auto advance→末通过→archiving→done）", () => {
  test.beforeAll(async () => {
    serverAvailable = await isServerAvailable()
    // AC1 反假跑：无真 server 直接 FAIL（不 skip）。
    if (!serverAvailable) throw new Error(`server not available at ${SERVER_URL} — 票14 主故事不允许 skip（AC1）`)
    await sse.start()
  })

  test.afterAll(async () => {
    sse.stop()
    await sweep()
  })

  // ── S1 新建 + v4 fixture 直造 + UI 反映 + [入队] 真点击 ──────────────
  test("S1 新建 coding 任务（v4 拆分/绑定 fixture）→ 入队清单四行齐 → 真点击入队 → 信封落库", async ({ page }) => {
    // git fixtures + repos index
    const repoA = makeFixtureRepo(`${RUN}-projA`, { context: true })
    const repoB = makeFixtureRepo(`${RUN}-projB`, { context: false })
    bindReposToIndex(repoA, repoB)

    // POST /api/tasks（票 11/12 先例：API 直造保 org 隔离；「新建」UI 路径由票 11 AC1 覆盖）
    const task: TaskDTO = await createTask({
      org: TASK_E2E_ORG, name: TASK_NAME, task_type: "coding", skill_groups: [], preset: { org: TASK_E2E_ORG },
    })
    taskId = task.id
    taskVersion = task.version
    if (!fs.existsSync(HOME_DIR())) throw new Error(`v3 create 未建 home: ${HOME_DIR()}`)

    // home 产物：批次目录 + stub 工作流 + 归档面输入（对话产物生成端 = stub 域）
    writeBatchDirs()
    writeStubWorkflow()
    writeArchiveInputs()

    // v4 信封（拆分+绑定，spec-field(phases) 等价序列之 PUT 半程 —— 票 12 AC3 已证写回链）
    const put = await updateTask(taskId, taskVersion, {
      task_spec: {
        format: "v4",
        goal: GOAL,
        autoAdvance: true,
        phases: [
          { index: 1, name: "阶段一·打回链", slug: SLUG1, specPath: `${BATCH1}/spec.md`, workflowRef: "e2e-td-lc-stub", inputValues: { batch_dir: BATCH1 } },
          { index: 2, name: "阶段二·直通", slug: SLUG2, specPath: `${BATCH2}/spec.md`, workflowRef: "e2e-td-lc-stub", inputValues: { batch_dir: BATCH2 } },
        ],
        resources: [],
        authoring_resources: [],
      },
      project_ids: [PROJ_A, PROJ_B],
    })
    taskVersion = put.version

    // UI 反映：draft 卡 → 弹窗 → 四行清单 + phase 绑定清单
    await page.goto("/tasks")
    const card = page.locator(`[data-task-column="draft"] [data-task-id="${taskId}"]`)
    await expect(card).toBeVisible({ timeout: 20_000 })
    await card.click()
    const modal = page.getByRole("dialog")
    const checklist = modal.locator('[data-testid="enqueue-checklist-v4"]')
    await expect(checklist).toBeVisible({ timeout: 15_000 })
    for (const row of ["phases", "spec", "bind", "inputs"]) {
      await expect(checklist.locator(`[data-checklist-v4="${row}"]`)).toContainText("✅", { timeout: 15_000 })
    }
    await expect(modal.locator("[data-phase-binding-list]")).toBeVisible({ timeout: 15_000 })
    await expect(modal.locator('[data-phase-bind-button="1"]')).toBeVisible()
    await expect(modal.locator('[data-phase-bind-button="2"]')).toBeVisible()
    await expect(modal.locator("[data-autoadvance-switch]")).toBeChecked() // 默认开（K6）
    await page.screenshot({ path: shot("s1-checklist-v4-ready.png"), fullPage: true })

    // 真点击 [入队执行] —— server v4 gate（四项）全过
    const respPromise = page.waitForResponse((r) => r.url().includes(`/api/tasks/${taskId}/ready`) && r.request().method() === "POST")
    await modal.locator("[data-task-enqueue]").click()
    const resp = await respPromise
    const readyBody = (await resp.json()) as TaskDTO
    expect(resp.status()).toBe(200)
    expect(readyBody.status).toBe("ready")
    await page.waitForSelector(`[data-task-column="ready"] [data-task-id="${taskId}"]`, { timeout: 20_000 })
    await page.screenshot({ path: shot("s1-card-in-ready.png") })

    // DB 交叉：一封套（K5）+ 信封物化 v4 phases + chain[0]=phase1
    const envelope = await until(() => {
      const rows = dbAll<{ id: string; origin_role: string; status: string; config: string }>(
        "SELECT id, origin_role, status, config FROM schedules WHERE origin_type='task' AND origin_id=? AND deleted_at IS NULL", taskId,
      )
      return rows.length === 1 ? rows[0] : null
    }, 15_000, "envelope schedule row")
    envelopeScheduleId = envelope!.id
    expect(envelope!.origin_role).toBe("primary")
    expect(envelope!.status).toBe("draft") // v39 停放，待 trigger
    const cfg = JSON.parse(envelope!.config) as {
      format?: string; phases?: Array<{ index: number; workflowRef: string; specDir: string; inputValues: Record<string, string> }>
      workflow_chain?: Array<{ workflow_ref: string }>
      workspace_spec?: { projects?: Array<{ name: string }> }
    }
    expect(cfg.format).toBe("v4")
    expect(cfg.phases?.map((p) => p.index)).toEqual([1, 2])
    expect(cfg.phases?.[0].workflowRef).toBe("e2e-td-lc-stub")
    expect(cfg.workflow_chain?.[0].workflow_ref).toBe("e2e-td-lc-stub")
    expect(cfg.workspace_spec?.projects?.map((p) => p.name)).toEqual([PROJ_A, PROJ_B])
    // API 回读：GET /:id 仍 draft→ready + phases 结构不丢
    const detail = await getTask(taskId)
    expect(detail.status).toBe("ready")
    expect((detail.task_spec as { format: string }).format).toBe("v4")
    log(`S1 ok: task ${taskId} enqueued; envelope ${envelopeScheduleId}`)
  })

  // ── S2 触发 phase1：真调度 → 首建 ws+worktree → seed → 执行 → collect → 待验收 ──
  test("S2 UI 触发 phase1 → 真 claim/首建/seed/执行/collect → UI 待验收 + AC2 四方交叉", async ({ page }) => {
    test.setTimeout(300_000)
    await page.goto("/tasks")
    const readyCard = page.locator(`[data-task-column="ready"] [data-task-id="${taskId}"]`)
    await expect(readyCard).toBeVisible({ timeout: 20_000 })
    await readyCard.locator("[data-task-trigger-btn]").click()
    const trigResp = page.waitForResponse((r) => r.url().includes(`/api/tasks/${taskId}/trigger`) && r.request().method() === "POST")
    await page.getByRole("dialog").getByRole("button", { name: "立即触发" }).click()
    expect((await trigResp).status()).toBe(200)
    await page.screenshot({ path: shot("s2-triggered.png") })

    // 真执行到终态（首建 createFromSpec + git worktree + bash stub）
    const r1 = await until(() => roundTerminal(1, 1) ?? null, 240_000, "phase1 round1 terminal")
    expect(r1.status).toBe("completed")
    boundWsId = r1.workspace_id
    log(`S2: r1 exec ${r1.id} completed on ws ${boundWsId}`)

    // DB 真相：打标 (1,1)、一 task 一 ws、一信封串行、tasks.workspace_id 绑定
    const tagged = taskRoundExecs()
    expect(tagged.map((e) => [e.phase_index, e.round_index])).toEqual([[1, 1]])
    expect(dbAll<{ id: string }>("SELECT id FROM workspaces WHERE id=?", boundWsId).length).toBe(1)
    const trow = dbGet<{ status: string; workspace_id: string }>("SELECT status, workspace_id FROM tasks WHERE id=?", taskId)!
    expect(trow.workspace_id).toBe(boundWsId)
    // 执行侧副作用：bash 节点行 + agent_events
    const nodes = dbAll<{ node_id: string; status: string }>("SELECT node_id, status FROM node_executions WHERE execution_id=?", r1.id)
    expect(nodes.some((n) => n.node_id === "stub-exec" && n.status === "completed")).toBe(true)
    expect(dbAll<{ c: number }>("SELECT COUNT(*) c FROM agent_events WHERE node_execution_id IN (SELECT id FROM node_executions WHERE execution_id=?)", r1.id)[0].c).toBeGreaterThan(0)

    // fs 真相：seed 下行（ws 批次目录 = home spec 内容）+ collect 上行（exec 侧报告回家）
    const wsDir = dbGet<{ path: string }>("SELECT path FROM workspaces WHERE id=?", boundWsId)!.path
    const homeSpec = fs.readFileSync(path.join(HOME_DIR(), BATCH1, "spec.md"), "utf-8")
    const wsSpec = fs.readFileSync(path.join(wsDir, BATCH1, "spec.md"), "utf-8")
    expect(wsSpec).toBe(homeSpec) // seed 内容一致
    const wsReport = path.join(wsDir, BATCH1, "exec-report.md")
    expect(fs.existsSync(wsReport)).toBe(true) // bash 产物落 ws
    const homeReport = await until(() => (fs.existsSync(path.join(HOME_DIR(), BATCH1, "exec-report.md")) ? true : null), 30_000, "collect home exec-report")
    expect(homeReport).toBe(true)
    // 执行侧对 issues 的改动也上行（写权纪律：issues ws 权威）
    const homeIssue = fs.readFileSync(path.join(HOME_DIR(), BATCH1, "issues", "1-ticket.md"), "utf-8")
    expect(homeIssue).toContain("Status: done")
    // 双 project worktree 就位（归档域的前置）
    expect(fs.existsSync(path.join(wsDir, "projects", PROJ_A, ".git"))).toBe(true)
    expect(fs.existsSync(path.join(wsDir, "projects", PROJ_B, ".git"))).toBe(true)

    // SSE 真相：collect 发射 task_artifacts_update + 终态发射 phase_status_update(awaiting_review)
    await until(() => (
      sse.count("task_artifacts_update", (d) => d.task_id === taskId) >= 1
      && sse.count("phase_status_update", (d) => d.task_id === taskId && d.status === "awaiting_review" && d.phase_index === 1) >= 1
        ? true : null
    ), 30_000, `sse events (got ${sse.events.filter((e) => (e.data as { task_id?: string }).task_id === taskId).map((e) => e.event).join(",")})`)

    // UI 真相：卡片归待验收列 + 角标（AC2 四方之一）
    await page.reload()
    const awaitCard = page.locator(`[data-task-column="awaiting_review"] [data-task-id="${taskId}"]`)
    await expect(awaitCard).toBeVisible({ timeout: 30_000 })
    await expect(awaitCard.locator("[data-task-phase-badge]")).toHaveText("Phase 1/2 · Round 1")
    await page.screenshot({ path: shot("s2-awaiting-r1-badge.png") })

    // API 真相（AC2 四方之二/三/四对齐）
    const detail = await getTask(taskId)
    const derived = (detail as unknown as { derived: TaskDerived }).derived
    expect(derived.isV4).toBe(true)
    expect(derived.taskStatus).toBe("awaiting_review")
    expect(derived.phaseViews[0].status).toBe("awaiting_review")
    expect(derived.phaseViews[0].awaitingRound).toBe(1)
    expect(derived.phaseViews[1].status).toBe("pending")
    // 卡片点开 → phase 时间线两行（US7）
    await awaitCard.click()
    const dlg = page.getByRole("dialog")
    await expect(dlg.locator("[data-testid='phase-row-1']")).toBeVisible({ timeout: 15_000 })
    await expect(dlg.locator("[data-testid='phase-row-2']")).toBeVisible()
    await page.screenshot({ path: shot("s2-phase-timeline.png") })
    log("S2 ok: AC2 four-way (UI badge == API derived == DB rows == fs dirs)")
  })

  // ── S3 打回：三栏弹窗 → 反馈必填 → 真 POST → round2 同 ws + seed 新 spec ──
  test("S3 打回带反馈 → 账本 rejected + fix-feedback-r1.md + round2 同 worktree（seed 反映 home 新 spec）", async ({ page }) => {
    test.setTimeout(300_000)
    // 运行期 home spec 编辑（K16：下一 round seed 生效）
    const specAbs = path.join(HOME_DIR(), BATCH1, "spec.md")
    fs.writeFileSync(specAbs, `${fs.readFileSync(specAbs, "utf-8")}\nE2E_TD_SPEC_R2_EDIT_${RUN}\n`)

    await page.goto("/tasks")
    const card = page.locator(`[data-task-column="awaiting_review"] [data-task-id="${taskId}"]`)
    await expect(card).toBeVisible({ timeout: 20_000 })
    await card.locator("[data-task-accept-btn]").click()
    const modal = page.locator("[data-acceptance-modal]")
    await expect(modal).toBeVisible({ timeout: 15_000 })
    // 三栏齐现 + 左列数据。中列对 .scratch 批次件是「登记可见」语义（票 12 登记
    // 的 v4.1 接缝③：collect 落 home/.scratch 不登记 artifacts.json）→ 断言诚实
    // 空态；产物流动的真证据在 fs/DB 层（S2 collect + 本步 seed/fix-feedback）。
    await expect(modal.locator("[data-acceptance-col-summary]")).toBeVisible()
    await expect(modal.locator("[data-acceptance-col-artifacts]")).toBeVisible()
    await expect(modal.locator("[data-acceptance-col-actions]")).toBeVisible()
    await expect(modal.locator("[data-acceptance-phase-label]")).toHaveText("Phase 1/2 · Round 1")
    await expect(modal.locator("[data-acceptance-round-state]")).toContainText("执行成功")
    await expect(modal.locator("[data-acceptance-artifacts-empty]")).toBeVisible({ timeout: 15_000 })
    await page.screenshot({ path: shot("s3-acceptance-three-columns.png") })

    // 打回：反馈必填 gate → 填写 → 真 POST
    await modal.locator("[data-acceptance-reject]").click()
    const confirm = modal.locator("[data-reject-confirm]")
    await expect(confirm).toBeDisabled()
    await modal.locator("[data-reject-feedback]").fill(`E2E_TD 打回反馈：请补齐 ${RUN} 的出口核对`)
    await expect(confirm).toBeEnabled()
    const accRespP = page.waitForResponse((r) => r.url().includes(`/api/tasks/${taskId}/acceptance`) && r.request().method() === "POST")
    await confirm.click()
    const accResp = await accRespP
    const accBody = (await accResp.json()) as AcceptanceResp["body"]
    expect(accResp.status()).toBe(200)
    expect(accBody!.next_action).toBe("dispatched")
    expect(accBody!.dispatch!.phase_index).toBe(1)
    expect(accBody!.dispatch!.round_index).toBe(2)
    expect(accBody!.dispatch!.workspace_id).toBe(boundWsId) // 同 ws 复用

    // DB 账本：一行 rejected + feedback
    const ledger = dbAll<{ decision: string; feedback: string; round_index: number }>(
      "SELECT decision, feedback, round_index FROM task_phase_acceptances WHERE task_id=? ORDER BY decided_at ASC", taskId,
    )
    expect(ledger.length).toBe(1)
    expect(ledger[0].decision).toBe("rejected")
    expect(ledger[0].feedback).toContain("E2E_TD 打回反馈")
    expect(ledger[0].round_index).toBe(1)

    // fs：fix-feedback-r1.md 入 home 批次目录 + 随同次 seed 进 ws；ws spec 反映新内容
    await until(() => (fs.existsSync(path.join(HOME_DIR(), BATCH1, "fix-feedback-r1.md")) ? true : null), 20_000, "fix-feedback-r1.md in home")
    const wsDir = dbGet<{ path: string }>("SELECT path FROM workspaces WHERE id=?", boundWsId)!.path
    const seededFf = await until(
      () => (fs.existsSync(path.join(wsDir, BATCH1, "fix-feedback-r1.md")) ? fs.readFileSync(path.join(wsDir, BATCH1, "fix-feedback-r1.md"), "utf-8") : null),
      20_000, "fix-feedback seeded to ws",
    )
    expect(seededFf!).toContain("E2E_TD 打回反馈")
    const wsSpec = await until(
      () => (fs.readFileSync(path.join(wsDir, BATCH1, "spec.md"), "utf-8").includes(`E2E_TD_SPEC_R2_EDIT_${RUN}`) ? true : null),
      20_000, "ws spec reflects home r2 edit",
    )
    expect(wsSpec).toBe(true)
    // ws 不新建：workspaces 计数仍 =1；round2 执行行已出现且同 ws
    const r2created = await until(() => {
      const rows = taskRoundExecs()
      return rows.find((e) => e.phase_index === 1 && e.round_index === 2) ?? null
    }, 20_000, "round2 exec row")
    expect(r2created!.workspace_id).toBe(boundWsId)
    expect(dbAll<{ id: string }>("SELECT id FROM workspaces WHERE id=?", boundWsId).length).toBe(1)

    // UI：角标 Round 2（列无关 —— r2 bash 可能几秒内到终态直接回待验收列）。
    await page.reload()
    const anyCard = page.locator(`[data-task-id="${taskId}"]`)
    await expect(anyCard).toBeVisible({ timeout: 20_000 })
    await expect(anyCard.locator("[data-task-phase-badge]")).toHaveText("Phase 1/2 · Round 2", { timeout: 30_000 })
    const inRunning = await page.locator(`[data-task-column="running"] [data-task-id="${taskId}"]`).count()
    const inAwaiting = await page.locator(`[data-task-column="awaiting_review"] [data-task-id="${taskId}"]`).count()
    expect(inRunning + inAwaiting).toBe(1)
    await page.screenshot({ path: shot("s3-round2-running-badge.png") })
    log("S3 ok: reject chain (ledger + fix-feedback + same-ws round2 + seed reflect home edit)")
  })

  // ── S4 round2 终态 → 通过 → auto_advance phase2 ─────────────────────
  test("S4 round2 终态 → 验收通过 → auto_advance 自动开跑 phase2（同 ws）", async ({ page }) => {
    test.setTimeout(300_000)
    const r2 = await until(() => roundTerminal(1, 2) ?? null, 240_000, "r2 terminal")
    expect(r2.status).toBe("completed")

    await page.goto("/tasks")
    const card = page.locator(`[data-task-column="awaiting_review"] [data-task-id="${taskId}"]`)
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expect(card.locator("[data-task-phase-badge]")).toHaveText("Phase 1/2 · Round 2")
    await card.locator("[data-task-accept-btn]").click()
    const modal = page.locator("[data-acceptance-modal]")
    await expect(modal).toBeVisible({ timeout: 15_000 })
    await expect(modal.locator("[data-acceptance-phase-label]")).toHaveText("Phase 1/2 · Round 2")
    await page.screenshot({ path: shot("s4-accept-r2-modal.png") })
    const accP = page.waitForResponse((r) => r.url().includes(`/api/tasks/${taskId}/acceptance`) && r.request().method() === "POST")
    await modal.locator("[data-acceptance-approve]").click()
    const acc = await accP
    const body = (await acc.json()) as AcceptanceResp["body"]
    expect(acc.status()).toBe(200)
    expect(body!.next_action).toBe("dispatched")
    expect(body!.dispatch!.phase_index).toBe(2) // K6 auto_advance 默认开 → 自动起 phase2
    expect(body!.dispatch!.round_index).toBe(1)
    expect(body!.dispatch!.workspace_id).toBe(boundWsId) // 仍同 ws（一 task 一 ws）

    // DB：phase1 终局两行账本 (rejected r1, accepted r2)；执行行 (1,1)(1,2)(2,1)
    const ledger = dbAll<{ phase_index: number; round_index: number; decision: string }>(
      "SELECT phase_index, round_index, decision FROM task_phase_acceptances WHERE task_id=? ORDER BY decided_at ASC", taskId,
    )
    expect(ledger.map((r) => [r.phase_index, r.round_index, r.decision])).toEqual([
      [1, 1, "rejected"], [1, 2, "accepted"],
    ])
    const p2 = await until(() => {
      const rows = taskRoundExecs()
      return rows.find((e) => e.phase_index === 2 && e.round_index === 1) ?? null
    }, 20_000, "phase2 exec row")
    expect(taskRoundExecs().map((e) => [e.phase_index, e.round_index])).toEqual([[1, 1], [1, 2], [2, 1]])
    expect(p2!.workspace_id).toBe(boundWsId)
    // SSE：phase2 running
    await until(() => (sse.count("phase_status_update", (d) => d.task_id === taskId && d.phase_index === 2 && d.status === "running") >= 1 ? true : null), 20_000, "sse p2 running")
    // UI：卡片离开待验收列（执行中或已到 Round1 待验收 —— 列会随终态迁移，角标
    // 恒为 Phase 2/2 · Round 1，列无关断言更稳）。
    await page.reload()
    const anyCard = page.locator(`[data-task-id="${taskId}"]`)
    await expect(anyCard).toBeVisible({ timeout: 20_000 })
    await expect(anyCard.locator("[data-task-phase-badge]")).toHaveText("Phase 2/2 · Round 1", { timeout: 30_000 })
    const inRunning = await page.locator(`[data-task-column="running"] [data-task-id="${taskId}"]`).count()
    const inAwaiting = await page.locator(`[data-task-column="awaiting_review"] [data-task-id="${taskId}"]`).count()
    expect(inRunning + inAwaiting).toBe(1)
    await page.screenshot({ path: shot("s4-phase2-auto-running.png") })
    log("S4 ok: accept r2 → auto_advance dispatched phase2 on same ws")
  })

  // ── S5 phase2 终态 → 末通过 → archiving → done ──────────────────────
  test("S5 phase2 终态 → 末验收通过 → archiving（⚠徽标）→ git 归档 → done", async ({ page }) => {
    test.setTimeout(420_000)
    const p2 = await until(() => roundTerminal(2, 1) ?? null, 240_000, "phase2 r1 terminal")
    expect(p2.status).toBe("completed")
    // collect 上行 phase2 产物
    await until(() => (fs.existsSync(path.join(HOME_DIR(), BATCH2, "exec-report.md")) ? true : null), 30_000, "p2 collect home")

    await page.goto("/tasks")
    const card = page.locator(`[data-task-column="awaiting_review"] [data-task-id="${taskId}"]`)
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expect(card.locator("[data-task-phase-badge]")).toHaveText("Phase 2/2 · Round 1")
    await card.locator("[data-task-accept-btn]").click()
    const modal = page.locator("[data-acceptance-modal]")
    await expect(modal).toBeVisible({ timeout: 15_000 })
    const accP = page.waitForResponse((r) => r.url().includes(`/api/tasks/${taskId}/acceptance`) && r.request().method() === "POST")
    await modal.locator("[data-acceptance-approve]").click()
    const acc = await accP
    const body = (await acc.json()) as AcceptanceResp["body"]
    expect(acc.status()).toBe(200)
    expect(body!.next_action).toBe("archiving") // 末通过 → archiving（K6）
    // 响应的 task 真相：持久态已翻 archiving（beginArchiving 同步先行，编排异步）
    expect(body!.task.status).toBe("archiving")

    // UI：⚠归档中徽标（编排通常几秒内完成，badge 窗口可短 — 响应体已证 archiving
    // 态，徽标断言作 best-effort + 兜底 done 列）。
    await page.reload()
    const archBadge = page.locator(`[data-task-column="running"] [data-task-id="${taskId}"] [data-task-archiving-badge]`)
    const badgeSeen = await archBadge.isVisible().catch(() => false)
    log(`S5: archiving badge ${badgeSeen ? "seen on board" : "already past (response proved archiving)"}`)
    await page.screenshot({ path: shot("s5-archiving-stage.png") })
    const fin = await until(() => {
      const row = dbGet<{ status: string; completed_at: string | null }>("SELECT status, completed_at FROM tasks WHERE id=?", taskId)!
      return row.status === "done" && row.completed_at ? row : null
    }, 120_000, "task done (archive orchestrator)")
    log(`S5: archived → done at ${fin.completed_at}`)
    // SSE：task_status done
    expect(sse.count("task_status", (d) => d.task_id === taskId && d.status === "done")).toBeGreaterThanOrEqual(1)
    // 账本终局：三行可追溯（rejected r1 / accepted r2 / accepted p2r1）
    const ledger = dbAll<{ phase_index: number; round_index: number; decision: string }>(
      "SELECT phase_index, round_index, decision FROM task_phase_acceptances WHERE task_id=? ORDER BY decided_at ASC", taskId,
    )
    expect(ledger.map((r) => [r.phase_index, r.round_index, r.decision])).toEqual([
      [1, 1, "rejected"], [1, 2, "accepted"], [2, 1, "accepted"],
    ])
    await page.reload()
    const doneCard = page.locator(`[data-task-column="done"] [data-task-id="${taskId}"]`)
    await expect(doneCard).toBeVisible({ timeout: 30_000 })
    await page.screenshot({ path: shot("s5-card-in-done.png") })
  })

  // ── S6 归档落地 git fixture：ADR 顺延/术语 append/冲突只报/commit push ──
  test("S6 git 归档真相：双 project ADR 顺延 0004 + 术语 append + 冲突不覆盖 + 归档 commit push → bare", () => {
    const wsDir = dbGet<{ path: string }>("SELECT path FROM workspaces WHERE id=?", boundWsId)!.path
    const bareA = path.join(FIX_ROOT, `${RUN}-projA.git`)
    const bareB = path.join(FIX_ROOT, `${RUN}-projB.git`)

    // projA
    const wtA = path.join(wsDir, "projects", PROJ_A)
    const adrA = fs.readdirSync(path.join(wtA, "docs", "adr")).filter((f) => /^\d{4}-.*\.md$/.test(f)).sort()
    expect(adrA).toContain("0004-pick-db.md") // 0001..0003 既有 → 顺延 0004
    const adrContent = fs.readFileSync(path.join(wtA, "docs", "adr", "0004-pick-db.md"), "utf-8")
    expect(adrContent).toContain(`Synced from task ${taskId}`) // 尾行溯源
    const ctxA = fs.readFileSync(path.join(wtA, "CONTEXT.md"), "utf-8")
    expect(ctxA).toContain("Gizmo") // 新词 append
    expect(ctxA).toContain("仓库既有定义（旧义，冲突时不得覆盖）") // Widget 旧行原样
    expect(ctxA).not.toContain("冲突的新定义") // 冲突不写入
    // 归档 commit：标题正则 + 与 state.json 记账日期一致（server ymd=UTC 日历，
    // 测试进程本地日历可能跨日 —— 真对账用 server 自己的稳定 date，不硬耦合）。
    const report = fs.readFileSync(path.join(HOME_DIR(), "archive", "report.md"), "utf-8")
    const state = JSON.parse(fs.readFileSync(path.join(HOME_DIR(), "archive", "state.json"), "utf-8")) as {
      date: string; projects: Record<string, { status: string }>
    }
    expect(state.date).toMatch(/^\d{8}$/)
    const headA = git(["log", "-1", "--pretty=%s"], wtA)
    expect(headA).toMatch(new RegExp(`^chore\\(archive\\): ${TASK_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} syncback ${state.date}$`))
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], wtA)
    expect(git(["ls-remote", bareA, branch], FIX_ROOT)).toContain(branch) // push 落地 bare
    expect(git(["log", "--oneline", branch], bareA)).toContain("chore(archive)")

    // projB（无 CONTEXT.md → 模板新建）
    const wtB = path.join(wsDir, "projects", PROJ_B)
    expect(fs.readdirSync(path.join(wtB, "docs", "adr"))).toContain("0004-add-cache.md")
    const ctxB = fs.readFileSync(path.join(wtB, "CONTEXT.md"), "utf-8")
    expect(ctxB).toContain("Sprocket")
    const branchB = git(["rev-parse", "--abbrev-ref", "HEAD"], wtB)
    expect(git(["ls-remote", bareB, branchB], FIX_ROOT)).toContain(branchB)
    expect(git(["log", "-1", "--pretty=%s"], wtB)).toContain(`syncback ${state.date}`)

    // home 归档报告：冲突词条在报告（K11 人工裁决面）+ state.json 幂等记账
    expect(report).toContain("Widget")
    expect(report).toContain(state.date)
    expect(Object.values(state.projects).every((p) => p.status === "done")).toBe(true)
    log("S6 ok: archive landed in git fixtures (ADR renumber 0004, append-only glossary, conflict report, commit+push)")
  })

  // ── S7 终局四方对账（AC2 收口）──────────────────────────────────────
  test("S7 终局交叉真相：UI == GET /:id phases == DB 账本/executions == fs 目录", async ({ page }) => {
    // API
    const detail = await getTask(taskId)
    const derived = (detail as unknown as { derived: TaskDerived }).derived
    expect(derived.taskStatus).toBe("done")
    expect(derived.phaseViews[0].status).toBe("accepted")
    // rounds[].state = 执行侧（exec status 映射），decision = 账本侧 — 双真相分列。
    expect(derived.phaseViews[0].rounds.map((r) => [r.roundIndex, r.state, r.decision])).toEqual([
      [1, "succeeded", "rejected"], [2, "succeeded", "accepted"],
    ])
    expect(derived.phaseViews[1].status).toBe("accepted")
    expect(derived.phaseViews[1].rounds.map((r) => [r.roundIndex, r.state, r.decision])).toEqual([[1, "succeeded", "accepted"]])
    // DB
    expect(taskRoundExecs().map((e) => [e.phase_index, e.round_index, e.status])).toEqual([
      [1, 1, "completed"], [1, 2, "completed"], [2, 1, "completed"],
    ])
    expect(dbAll<{ c: number }>("SELECT COUNT(*) c FROM task_phase_acceptances WHERE task_id=?", taskId)[0].c).toBe(3)
    // fs
    for (const b of [BATCH1, BATCH2]) {
      expect(fs.existsSync(path.join(HOME_DIR(), b, "spec.md"))).toBe(true)
      expect(fs.existsSync(path.join(HOME_DIR(), b, "exec-report.md"))).toBe(true)
    }
    expect(fs.existsSync(path.join(HOME_DIR(), BATCH1, "fix-feedback-r1.md"))).toBe(true)
    // UI（角标终局：全 accepted → badge 无「未过 phase」可指，卡归 done 列即可 + 时间线全绿）
    await page.goto("/tasks")
    const doneCard = page.locator(`[data-task-column="done"] [data-task-id="${taskId}"]`)
    await expect(doneCard).toBeVisible({ timeout: 30_000 })
    await doneCard.click()
    const dlg = page.getByRole("dialog")
    await expect(dlg.locator("[data-testid='phase-row-1'][data-phase-status='accepted']")).toBeVisible({ timeout: 15_000 })
    await expect(dlg.locator("[data-testid='phase-row-2'][data-phase-status='accepted']")).toBeVisible()
    await page.screenshot({ path: shot("s7-final-cross-check.png") })
    // 证据落盘（R4）
    const evidence = {
      run: RUN, taskId, wsId: boundWsId, scheduleId: envelopeScheduleId,
      executions: taskRoundExecs(),
      detail,
      sseTaskEvents: sse.events.filter((e) => (e.data as { task_id?: string }).task_id === taskId).map((e) => e.event),
    }
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(path.join(DATA_DIR, `lifecycle-evidence-${RUN}.json`), JSON.stringify(evidence, null, 2))
    log(`S7 ok: final cross-check consistent; evidence → e2e-data/lifecycle-evidence-${RUN}.json`)
  })
})
