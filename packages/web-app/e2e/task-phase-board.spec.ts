// packages/web-app/e2e/task-phase-board.spec.ts
//
// task-phase-redesign 票 11 — 五列看板 + TemplatePicker 直通 + Phase 时间线 +
// ⏳ 超预算徽标 的浏览器 E2E（AC1-AC4）。
//
// Fixture 策略（R1/R3：真实 server + 真实 DB 双真相）：
//   • v4 任务经 API 直造：POST /api/tasks（legacy create，无 home）→ PUT
//     task_spec {format:"v4", phases:[…]}（draft 可编辑 + If-Match）。
//   • 派生态（awaiting_review / 在跑轮）经 sqlite 直造 executions+schedules
//     链（deriveTaskView 吃 schedule_executions 归属链 — 票 07），并把
//     tasks.status 归一到与派生一致的持久态。
//   • 清理按创建的 id 精确 DELETE（E2E_TD_ 前缀隔离 R7）。
//
// AC4 运行方式（阈值是 Next 编译期 inlined 的 NEXT_PUBLIC_*）：
//   NEXT_PUBLIC_PHASE_BUDGET_MS=1000 npx playwright test e2e/task-phase-board.spec.ts
// 未设该 env 时 AC4 用例 skip 并打印原因（组件级覆盖见
// components/tasks/__tests__/phase-timeline.test.tsx + task-board.test.ts）。

import { test, expect } from "@playwright/test"
import { DatabaseSync } from "node:sqlite"
import {
  SERVER_URL,
  TASK_E2E_ORG,
  log,
  logError,
  isServerAvailable,
  createTask,
  updateTask,
  resolveDbPath,
  screenshotPath,
} from "./helpers/task-domain-helpers"

const NOW_ISO = () => new Date().toISOString()
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()

let serverAvailable = false
// 本 spec 创建的全部行 id（afterAll 精确清理）。
const created = {
  taskIds: [] as string[],
  scheduleIds: [] as string[],
  executionIds: [] as string[],
  seIds: [] as string[],
  workspaceIds: [] as string[],
}

/**
 * Read-WRITE sqlite 连接（helpers 的 openTaskDb 是 readOnly:true 只读连接，
 * 只能做 R3 断言；本 spec 的 fixture 必须写库——tasks.status 归一 + exec 链）。
 * WAL 模式（dev DB 现状）下与 server 连接并发短事务安全；busy_timeout 兜底。
 */
let dbAvailable = true
function openRwDb(): DatabaseSync {
  const db = new DatabaseSync(resolveDbPath())
  db.prepare("PRAGMA busy_timeout = 5000").run()
  return db
}

async function dbRun(sql: string, ...params: unknown[]): Promise<void> {
  const db = openRwDb()
  try {
    db.prepare(sql).run(...(params as never[]))
  } finally {
    db.close()
  }
}

async function setTaskStatus(taskId: string, status: string): Promise<void> {
  // 参数序必须与占位符一致（status, updated_at, id）——错序会静默 0 行更新。
  await dbRun("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?", status, NOW_ISO(), taskId)
}

/** v4 fixture：draft create → PUT task_spec{format:"v4", phases[n]}。返回 id。 */
async function makeV4Task(name: string, phaseCount: number): Promise<string> {
  const task = await createTask({ org: TASK_E2E_ORG, name })
  created.taskIds.push(task.id)
  const phases = Array.from({ length: phaseCount }, (_, i) => ({
    index: i + 1,
    name: `票11阶段${i + 1}`,
    slug: `e2e-td-phase-${i + 1}`,
    specPath: `docs/spec-e2e-p${i + 1}.md`,
    workflowRef: "task-dev",
    inputValues: {},
  }))
  await updateTask(task.id, task.version, {
    task_spec: { format: "v4", phases, resources: [], authoring_resources: [] },
  })
  return task.id
}

/** sqlite 直造 deriveTaskView 吃的执行链：workspace→schedule(origin task)→
 *  execution(phase/round 打标)→schedule_executions。返回 execution created_at。 */
async function insertPhaseRoundExec(
  taskId: string,
  opts: { phaseIndex: number; roundIndex: number; execStatus: string; createdAt: string },
): Promise<void> {
  const uid = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const wsId = `e2e-td-ws-${uid}`
  const schId = `e2e-td-sch-${uid}`
  const execId = `e2e-td-exec-${uid}`
  const seId = `e2e-td-se-${uid}`
  const now = NOW_ISO()
  await dbRun(
    `INSERT INTO workspaces (id, name, org, status, path, created_at, updated_at, source)
     VALUES (?, ?, ?, 'active', ?, ?, ?, 'user')`,
    wsId, `E2E_TD_ws_${uid}`, TASK_E2E_ORG, `/tmp/e2e-td-${uid}`, now, now,
  )
  await dbRun(
    `INSERT INTO schedules (id, org, name, enabled, timeout_seconds, created_at, updated_at,
       config, status, origin_type, origin_id, origin_role, workspace_id)
     VALUES (?, ?, ?, 1, 3600, ?, ?, '{}', 'running', 'task', ?, 'primary', ?)`,
    schId, TASK_E2E_ORG, `E2E_TD_sch_${uid}`, now, now, taskId, wsId,
  )
  await dbRun(
    `INSERT INTO executions (id, workspace_id, workflow_ref, workflow_name, node_type, org,
       status, phase_index, round_index, created_at, updated_at)
     VALUES (?, ?, 'task-dev', 'e2e-td-round', 'normal', ?, ?, ?, ?, ?, ?)`,
    execId, wsId, TASK_E2E_ORG, opts.execStatus, opts.phaseIndex, opts.roundIndex, opts.createdAt, now,
  )
  await dbRun(
    `INSERT INTO schedule_executions (id, schedule_id, execution_id, status, trigger_type,
       triggered_at, timezone_offset, timezone_iana, workspace_id, created_at)
     VALUES (?, ?, ?, 'running', 'manual', ?, '+08:00', 'Asia/Shanghai', ?, ?)`,
    seId, schId, execId, opts.createdAt, wsId, now,
  )
  created.workspaceIds.push(wsId)
  created.scheduleIds.push(schId)
  created.executionIds.push(execId)
  created.seIds.push(seId)
}

test.beforeAll(async () => {
  serverAvailable = await isServerAvailable()
  if (!serverAvailable) log(`server not available at ${SERVER_URL} — specs will skip`)
  try {
    openRwDb().close()
  } catch (err: unknown) {
    dbAvailable = false
    logError(`rw sqlite unavailable: ${err instanceof Error ? err.message : String(err)}`)
  }
})

test.afterAll(async () => {
  if (!serverAvailable || !dbAvailable) return
  try {
    const inList = (xs: string[]) => xs.map(() => "?").join(",")
    if (created.seIds.length)
      await dbRun(`DELETE FROM schedule_executions WHERE id IN (${inList(created.seIds)})`, ...created.seIds)
    if (created.executionIds.length)
      await dbRun(`DELETE FROM executions WHERE id IN (${inList(created.executionIds)})`, ...created.executionIds)
    if (created.scheduleIds.length)
      await dbRun(`DELETE FROM schedules WHERE id IN (${inList(created.scheduleIds)})`, ...created.scheduleIds)
    if (created.workspaceIds.length)
      await dbRun(`DELETE FROM workspaces WHERE id IN (${inList(created.workspaceIds)})`, ...created.workspaceIds)
    if (created.taskIds.length)
      await dbRun(`DELETE FROM tasks WHERE id IN (${inList(created.taskIds)})`, ...created.taskIds)
  } catch (err: unknown) {
    logError(`cleanup: ${err instanceof Error ? err.message : String(err)}`)
  }
})

// ── AC1: 新建 coding 任务全程无技能组/preset 控件 ───────────────────

test("AC1 coding template picker renders no skill-group checkboxes and no preset section", async ({ page }) => {
  test.skip(!serverAvailable, "server not available")
  await page.goto("/tasks")
  await page.waitForLoadState("domcontentloaded")
  await page.locator("[data-task-new]").click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()

  // coding 为默认类型：直通 task-author，无任何勾选/预选控件。
  await expect(dialog.locator("[data-template-picker]")).toBeVisible()
  await expect(dialog.locator("[data-skill-group]")).toHaveCount(0)
  await expect(dialog.getByText("Skill 组")).toHaveCount(0)
  await expect(dialog.getByText(/codebase/)).toHaveCount(0)

  // generic 保留现状：勾选段回来（组内容取决于注册表，只断言段存在）。
  await dialog.getByRole("button", { name: /通用任务/ }).click()
  await expect(dialog.locator("[data-skill-groups-section]")).toBeVisible()

  await page.screenshot({ path: screenshotPath("T11-AC1-coding-direct.png") })
})

// ── AC2: awaiting_review 归「待验收」列且琥珀高亮 ───────────────────

test("AC2 five columns render; awaiting_review task sits in 待验收 with amber highlight", async ({ page }) => {
  test.skip(!serverAvailable || !dbAvailable, "server or rw-sqlite unavailable")
  // v4 两 phase；phase1 round1 completed 无验收 → derived phase=awaiting_review。
  const taskId = await makeV4Task("E2E_TD_待验收卡", 2)
  await insertPhaseRoundExec(taskId, { phaseIndex: 1, roundIndex: 1, execStatus: "completed", createdAt: hoursAgo(1) })
  await setTaskStatus(taskId, "running") // 归一持久态（票 07 活体交互 #1 的镜像窗口）

  await page.goto("/tasks")
  await page.waitForLoadState("domcontentloaded")
  // 五列齐在。
  for (const col of ["draft", "ready", "running", "awaiting_review", "done"]) {
    await expect(page.locator(`[data-task-column="${col}"]`)).toBeVisible({ timeout: 15_000 })
  }
  await expect(page.locator('[data-task-column="failed"]')).toHaveCount(0)

  // 卡片在待验收列 + 琥珀高亮（data-task-awaiting-review 在 article 自身）+
  // Phase 角标（current=第一个非 accepted → 1/2，round=awaitingRound=1）。
  const card = page.locator(`[data-task-column="awaiting_review"] [data-task-id="${taskId}"]`)
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(
    page.locator(`[data-task-column="awaiting_review"] [data-task-awaiting-review][data-task-id="${taskId}"]`),
  ).toHaveCount(1)
  await expect(card.locator("[data-task-phase-badge]")).toHaveText("Phase 1/2 · Round 1")
  await page.screenshot({ path: screenshotPath("T11-AC2-awaiting-review-column.png") })
})

// ── AC3: 时间线行数=phases 数；v3 legacy 单行不报错 ─────────────────

test("AC3 phase timeline shows one row per phase; v3 legacy card shows single row", async ({ page }) => {
  test.skip(!serverAvailable || !dbAvailable, "server or rw-sqlite unavailable")

  // v4：3 个 phase → 3 行
  const v4Id = await makeV4Task("E2E_TD_时间线三阶段", 3)
  await setTaskStatus(v4Id, "ready")
  await page.goto("/tasks")
  await page.waitForLoadState("domcontentloaded")
  await page.locator(`[data-task-column="ready"] [data-task-id="${v4Id}"]`).click({ timeout: 20_000 })
  const dialog = page.getByRole("dialog")
  await expect(dialog.locator("[data-testid='phase-timeline']")).toBeVisible()
  await expect(dialog.locator("[data-testid^='phase-row-']")).toHaveCount(3)
  await expect(dialog.getByText("票11阶段1")).toBeVisible()
  await expect(dialog.getByText("未开始")).toHaveCount(3)
  await page.screenshot({ path: screenshotPath("T11-AC3-timeline-3phases.png") })
  await page.keyboard.press("Escape")

  // v3 legacy：无 format → 单行 legacy 呈现，不报错。
  const v3Task = await createTask({ org: TASK_E2E_ORG, name: "E2E_TD_v3存量" })
  created.taskIds.push(v3Task.id)
  await setTaskStatus(v3Task.id, "running")
  await page.reload()
  await page.waitForLoadState("domcontentloaded")
  const v3Card = page.locator(`[data-task-column="running"] [data-task-id="${v3Task.id}"]`)
  await expect(v3Card).toBeVisible({ timeout: 15_000 })
  // v3 卡不渲染 phase 角标。
  await expect(v3Card.locator("[data-task-phase-badge]")).toHaveCount(0)
  await v3Card.click()
  await expect(dialog.locator("[data-testid='phase-row-legacy']")).toBeVisible()
  await expect(dialog.getByText(/v3 单阶段/)).toBeVisible()
  await page.screenshot({ path: screenshotPath("T11-AC3-legacy-single-row.png") })
})

// ── AC4: ⏳ 超预算徽标（阈值 env 注入）─────────────────────────────

test("AC4 over-budget round flags ⏳ on card + timeline chip", async ({ page }) => {
  const budgetEnv = process.env.NEXT_PUBLIC_PHASE_BUDGET_MS
  test.skip(
    !serverAvailable || !budgetEnv || !dbAvailable,
    "AC4 需要 NEXT_PUBLIC_PHASE_BUDGET_MS 在 next dev 编译前注入（小值，如 1000）— " +
      "run: NEXT_PUBLIC_PHASE_BUDGET_MS=1000 npx playwright test e2e/task-phase-board.spec.ts",
  )
  // 在跑轮 created_at = 2h 前 → 超过注入的小阈值。
  const taskId = await makeV4Task("E2E_TD_超预算", 1)
  await insertPhaseRoundExec(taskId, { phaseIndex: 1, roundIndex: 1, execStatus: "running", createdAt: hoursAgo(2) })
  await setTaskStatus(taskId, "running")

  await page.goto("/tasks")
  const card = page.locator(`[data-task-column="running"] [data-task-id="${taskId}"]`)
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card.locator("[data-task-overbudget-badge]")).toBeVisible()
  await expect(card.locator("[data-task-phase-badge]")).toHaveText("Phase 1/1 · Round 1")

  await card.click()
  const dialog = page.getByRole("dialog")
  const chip = dialog.locator("[data-testid='phase-round-1-1']")
  await expect(chip).toBeVisible()
  await expect(chip).toHaveAttribute("data-overbudget", "true")
  await page.screenshot({ path: screenshotPath("T11-AC4-overbudget.png") })
})

// ── archiving 留执行中列 + ⚠ 徽标（AC2 的姊妹断言）──────────────────

test("AC2b archiving task stays in 执行中 column with ⚠归档中 badge", async ({ page }) => {
  test.skip(!serverAvailable || !dbAvailable, "server or rw-sqlite unavailable")
  // archiving 只能由「末 phase 账本 accepted」派生（K3 派生不存 — 持久
  // archiving 无账本会被 derive 归零成 ready），故 fixture 必须写 2 行账本。
  // ⚠ task_phase_acceptances 是 trigger 保护的 append-only（UPDATE/DELETE 都
  // 被拦），这 2 行 e2e-td-acc-* 无法由本 spec 清除 — 归票 14 的 E2E_TD_
  // 清扫脚本按 id 前缀处理（主故事 reject/accept 链同样必产账本行）。
  const taskId = await makeV4Task("E2E_TD_归档中", 2)
  await insertPhaseRoundExec(taskId, { phaseIndex: 1, roundIndex: 1, execStatus: "completed", createdAt: hoursAgo(3) })
  await insertPhaseRoundExec(taskId, { phaseIndex: 2, roundIndex: 1, execStatus: "completed", createdAt: hoursAgo(2) })
  const uid = `${Date.now()}`
  await dbRun(
    `INSERT INTO task_phase_acceptances (id, task_id, phase_index, round_index, decision, feedback, decided_at)
     VALUES (?, ?, 1, 1, 'accepted', NULL, ?), (?, ?, 2, 1, 'accepted', NULL, ?)`,
    `E2E_TD_acc_p1_${uid}`, taskId, hoursAgo(2.5),
    `E2E_TD_acc_p2_${uid}`, taskId, hoursAgo(1.5),
  )
  await setTaskStatus(taskId, "running")

  await page.goto("/tasks")
  const card = page.locator(`[data-task-column="running"] [data-task-id="${taskId}"]`)
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card.locator("[data-task-archiving-badge]")).toBeVisible()
  await page.screenshot({ path: screenshotPath("T11-AC2b-archiving-badge.png") })
})
