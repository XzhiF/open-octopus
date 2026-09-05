// packages/web-app/e2e/task-phase-acceptance.spec.ts
//
// task-phase-redesign 票 12 — 验收三栏 modal / 打回链 / per-phase 绑定弹窗 /
// autoAdvance 开关 的浏览器 E2E（AC1-AC5）。
//
// Fixture 策略沿用票 11 spec（R1/R3/R7）：v4 任务经 API 直造（POST→PUT
// task_spec），派生 round 经 sqlite 直造 executions+schedules 链；产物文件写
// 进真实 task home（~/.octopus/tasks/<id>/artifacts/... — scan-first 索引）。
//
// 诚实边界（票 12 记录）：
//   • 「提交后 round+1 真开跑」需要真实 workspace/agent 执行 —— Web E2E 不
//     拉起活体执行。rejected 的**真实提交**在此断到 server 409（信封无 v4
//     物化 phases → dispatch 前抛，账本行保留 — 票 07 设计）+ DB 账本核对；
//     提交成功后的 UI（形态推荐占位卡 / 影响清单空态）用 page.route fulfill
//     票 07 契约形状的 200 驱动（请求 body 仍真实断言）。
//   • AC3（影响清单批准→spec 变化+version bump）：server 无 impact API（v4.1
//     接缝），批准→updateSpecField(phases) 写回链路由组件测试断言；e2e 断
//     空态渲染。phases spec-field 的服务端 bump 由票 07 AC5 集成覆盖。
//   • 直插 task_phase_acceptances 的 fixture 行同票 11：append-only trigger
//     挡 DELETE，E2E_TD_acc_* 孤儿归票 14 清扫脚本。
//
// 运行：npx playwright test e2e/task-phase-acceptance.spec.ts（栈不可用自动 skip）

import { test, expect } from "@playwright/test"
import { DatabaseSync } from "node:sqlite"
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
  updateSpecField,
  getTask,
  resolveDbPath,
  screenshotPath,
} from "./helpers/task-domain-helpers"

const NOW_ISO = () => new Date().toISOString()
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()

let serverAvailable = false
let dbAvailable = true
const created = {
  taskIds: [] as string[],
  scheduleIds: [] as string[],
  executionIds: [] as string[],
  seIds: [] as string[],
  workspaceIds: [] as string[],
  homeDirs: [] as string[],
}

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
async function dbAll<T>(sql: string, ...params: unknown[]): Promise<T[]> {
  const db = openRwDb()
  try {
    return db.prepare(sql).all(...(params as never[])) as T[]
  } finally {
    db.close()
  }
}
async function setTaskStatus(taskId: string, status: string): Promise<void> {
  await dbRun("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?", status, NOW_ISO(), taskId)
}

/** v4 fixture（票 11 makeV4Task 形状）：n 个 phase，slug= e2e-td-acc-pK。 */
async function makeV4Task(
  name: string,
  opts: { phases?: number; autoAdvance?: boolean; withHome?: boolean } = {},
): Promise<string> {
  const task = opts.withHome
    ? await createTask({ org: TASK_E2E_ORG, name, task_type: "coding", skill_groups: [], preset: { org: TASK_E2E_ORG } })
    : await createTask({ org: TASK_E2E_ORG, name })
  created.taskIds.push(task.id)
  const n = opts.phases ?? 2
  const phases = Array.from({ length: n }, (_, i) => ({
    index: i + 1,
    name: `票12阶段${i + 1}`,
    slug: `e2e-td-acc-p${i + 1}-${task.id.slice(0, 8)}`,
    specPath: `.scratch/20260903/e2e-td-acc-p${i + 1}-${task.id.slice(0, 8)}/spec.md`,
    workflowRef: "task-dev",
    inputValues: {},
  }))
  await updateTask(task.id, task.version, {
    task_spec: {
      format: "v4",
      goal: "票12验收弹窗",
      ...(opts.autoAdvance === undefined ? {} : { autoAdvance: opts.autoAdvance }),
      phases,
      resources: [],
      authoring_resources: [],
    },
  })
  return task.id
}

/** sqlite 直造一条 phase-round 执行链（票 11 模式；se 行带 duration/completed
 *  以喂三栏左列的「用时」）。 */
async function insertPhaseRoundExec(
  taskId: string,
  opts: { phaseIndex: number; roundIndex: number; execStatus: string; createdAt: string; durationMs?: number },
): Promise<void> {
  const uid = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const wsId = `e2e-td-acc-ws-${uid}`
  const schId = `e2e-td-acc-sch-${uid}`
  const execId = `e2e-td-acc-exec-${uid}`
  const seId = `e2e-td-acc-se-${uid}`
  const now = NOW_ISO()
  const done = opts.execStatus === "completed" || opts.execStatus === "failed"
  await dbRun(
    `INSERT INTO workspaces (id, name, org, status, path, created_at, updated_at, source)
     VALUES (?, ?, ?, 'active', ?, ?, ?, 'user')`,
    wsId, `E2E_TD_acc_ws_${uid}`, TASK_E2E_ORG, `/tmp/e2e-td-acc-${uid}`, now, now,
  )
  await dbRun(
    `INSERT INTO schedules (id, org, name, enabled, timeout_seconds, created_at, updated_at,
       config, status, origin_type, origin_id, origin_role, workspace_id)
     VALUES (?, ?, ?, 1, 3600, ?, ?, '{}', 'running', 'task', ?, 'primary', ?)`,
    schId, TASK_E2E_ORG, `E2E_TD_acc_sch_${uid}`, now, now, taskId, wsId,
  )
  await dbRun(
    `INSERT INTO executions (id, workspace_id, workflow_ref, workflow_name, node_type, org,
       status, phase_index, round_index, created_at, updated_at)
     VALUES (?, ?, 'task-dev', 'e2e-td-acc-round', 'normal', ?, ?, ?, ?, ?, ?)`,
    execId, wsId, TASK_E2E_ORG, opts.execStatus, opts.phaseIndex, opts.roundIndex, opts.createdAt, now,
  )
  await dbRun(
    `INSERT INTO schedule_executions (id, schedule_id, execution_id, status, trigger_type,
       triggered_at, timezone_offset, timezone_iana, duration_ms, workspace_id, created_at, completed_at)
     VALUES (?, ?, ?, ?, 'manual', ?, '+08:00', 'Asia/Shanghai', ?, ?, ?, ?)`,
    seId, schId, execId, done ? "done" : "running", opts.createdAt,
    opts.durationMs ?? null, wsId, now, done ? new Date(Date.parse(opts.createdAt) + (opts.durationMs ?? 0)).toISOString() : null,
  )
  created.workspaceIds.push(wsId)
  created.scheduleIds.push(schId)
  created.executionIds.push(execId)
  created.seIds.push(seId)
}

/** 写真实 task home 产物（scan-first：文件即产物，无需登记）。 */
function writeHomeArtifact(taskId: string, relPath: string, content: string): string {
  const dir = path.join(os.homedir(), ".octopus", "tasks", taskId, "artifacts")
  const file = path.join(dir, relPath)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, "utf-8")
  const home = path.join(os.homedir(), ".octopus", "tasks", taskId)
  if (!created.homeDirs.includes(home)) created.homeDirs.push(home)
  return file
}

/** makeV4Task 的 phase-1 slug 字面量（与内联生成规则一致）。 */
const phase1Slug = (taskId: string): string => `e2e-td-acc-p1-${taskId.slice(0, 8)}`

async function awaitingTaskFixture(name: string, opts: { autoAdvance?: boolean } = {}): Promise<string> {
  const taskId = await makeV4Task(name, opts)
  await insertPhaseRoundExec(taskId, { phaseIndex: 1, roundIndex: 1, execStatus: "completed", createdAt: hoursAgo(1), durationMs: 600_000 })
  await setTaskStatus(taskId, "running") // 票 07 活体交互 #1 的镜像窗口 → 派生 awaiting_review 归列
  return taskId
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
  // 票 12 fixture 的 home：withHome 任务（v3 create 建目录）+ 真实 rejected
  // POST 的 fix-feedback-rN.md 都落在 ~/.octopus/tasks/<id> — 任务行删除后
  // home 成孤儿，按创建过的 id 统一清扫。
  const homeRoot = path.join(os.homedir(), ".octopus", "tasks")
  for (const id of created.taskIds) {
    const dir = path.join(homeRoot, id)
    if (!created.homeDirs.includes(dir)) created.homeDirs.push(dir)
  }
  for (const home of created.homeDirs) {
    try {
      fs.rmSync(home, { recursive: true, force: true })
    } catch (err: unknown) {
      logError(`rm home ${home}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
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
    // task_phase_acceptances 由 append-only trigger 保护（同票 11）：本 spec
    // 写入的行（decision accepted/rejected, task∈E2E_TD 前缀）留归票 14 清扫。
  } catch (err: unknown) {
    logError(`cleanup: ${err instanceof Error ? err.message : String(err)}`)
  }
})

// ── AC1: 三栏齐现且数据正确；产物点击展开全文 ────────────────────────

test("AC1 acceptance modal renders three columns with fixture data; artifact row opens full content", async ({ page }) => {
  test.skip(!serverAvailable || !dbAvailable, "server or rw-sqlite unavailable")
  const taskId = await awaitingTaskFixture("E2E_TD_验收三栏")
  const phaseSlug = phase1Slug(taskId)
  writeHomeArtifact(taskId, `${phaseSlug}/report-r1.md`, "# E2E_TD_报告\nround-1 执行报告\n")
  writeHomeArtifact(taskId, "e2e-td-acc-p2-OTHER/spec.md", "should be filtered out\n")

  await page.goto("/tasks")
  const card = page.locator(`[data-task-column="awaiting_review"] [data-task-id="${taskId}"]`)
  await expect(card).toBeVisible({ timeout: 20_000 })
  await card.locator("[data-task-accept-btn]").click()

  const dialog = page.locator("[data-acceptance-modal]")
  await expect(dialog).toBeVisible()
  // 三栏齐现
  await expect(dialog.locator("[data-acceptance-col-summary]")).toBeVisible()
  await expect(dialog.locator("[data-acceptance-col-artifacts]")).toBeVisible()
  await expect(dialog.locator("[data-acceptance-col-actions]")).toBeVisible()
  // 左列数据（fixture：phase1 round1 completed, duration 600s = 10m；token
  // 无 llm_calls → 暂无口径提示也属「数据正确」的诚实空态）
  await expect(dialog.locator("[data-acceptance-phase-label]")).toHaveText("Phase 1/2 · Round 1")
  await expect(dialog.locator("[data-acceptance-round-state]")).toHaveText("执行成功")
  await expect(dialog.locator("[data-acceptance-duration]")).toHaveText("10m 0s")
  // 中列：slug 过滤命中本 phase 文件，别的 phase 不混入
  const row = dialog.locator(`[data-acceptance-artifact-row$="${phaseSlug}/report-r1.md"]`)
  await expect(row).toBeVisible()
  await expect(dialog.locator('[data-acceptance-artifact-row*="OTHER"]')).toHaveCount(0)
  // 点击展开全文（ArtifactViewerDialog 叠层）
  await row.click()
  // data-artifact-viewer-dialog / data-artifact-content 都在 DialogContent 子树
  // （前者即 dialog 元素本身 → 用属性直查，不玩 role+filter 自嵌套）
  await expect(page.locator("[data-artifact-viewer-dialog]")).toBeVisible({ timeout: 15_000 })
  await expect(page.locator("[data-artifact-content]")).toContainText("E2E_TD_报告", { timeout: 15_000 })
  await page.screenshot({ path: screenshotPath("T12-AC1-three-columns.png") })
  await page.keyboard.press("Escape") // 关 viewer（保留 modal）
})

// ── AC2: 反馈必填 gate + 真实账本 + 提交成功态（route-fulfill 票 07 契约） ──

test("AC2 reject requires feedback; real POST writes the ledger; success chain shows D13/D14 seam UI", async ({ page }) => {
  test.skip(!serverAvailable || !dbAvailable, "server or rw-sqlite unavailable")
  const taskId = await awaitingTaskFixture("E2E_TD_打回链")
  await page.goto("/tasks")
  const card = page.locator(`[data-task-column="awaiting_review"] [data-task-id="${taskId}"]`)
  await expect(card).toBeVisible({ timeout: 20_000 })
  await card.locator("[data-task-accept-btn]").click()
  const dialog = page.locator("[data-acceptance-modal]")
  await expect(dialog).toBeVisible()

  // 反馈为空 / 全空白 → 打回确认 disabled
  await dialog.locator("[data-acceptance-reject]").click()
  const confirm = dialog.locator("[data-reject-confirm]")
  await expect(confirm).toBeDisabled()
  await dialog.locator("[data-reject-feedback]").fill("   ")
  await expect(confirm).toBeDisabled()
  await page.screenshot({ path: screenshotPath("T12-AC2-reject-disabled.png") })

  // —— 真实提交（不拦截）：server 写账本 + fix-feedback-r1.md；派发因 fixture
  // 信封无物化 phases 而 409（票 07：账本保留，重试=人工动作）→ UI 报错不崩。
  await dialog.locator("[data-reject-feedback]").fill("E2E_TD 路由没接上，请修复")
  await expect(confirm).toBeEnabled()
  await confirm.click()
  await expect
    .poll(async () => {
      const rows = await dbAll<{ decision: string; feedback: string }>(
        "SELECT decision, feedback FROM task_phase_acceptances WHERE task_id = ?", taskId,
      )
      return rows.length
    }, { timeout: 15_000 })
    .toBe(1)
  const rejected = await dbAll<{ decision: string; feedback: string }>(
    "SELECT decision, feedback FROM task_phase_acceptances WHERE task_id = ?", taskId,
  )
  expect(rejected[0].decision).toBe("rejected")
  expect(rejected[0].feedback).toContain("E2E_TD 路由没接上")
  await page.screenshot({ path: screenshotPath("T12-AC2-real-ledger-409.png") })
  await page.keyboard.press("Escape")

  // —— 成功态（route fulfill 票 07 契约 200）：形态推荐占位卡 + 影响清单空态。
  // 请求 body 仍真实断言；response 由本测试构造（活体 agent 执行不在 Web E2E
  // 范围内 — 拉起真 workspace/LLM 属票 14 主故事与 server 集成域）。

  const taskId2 = await awaitingTaskFixture("E2E_TD_打回链成功态")
  await page.route(`**/api/tasks/${taskId2}/acceptance`, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>
    ;(page as unknown as { __t12: Record<string, unknown> }).__t12 = body
    const d2 = await getTask(taskId2) as Awaited<ReturnType<typeof getTask>> & {
      derived?: { phaseViews: Array<Record<string, unknown>> }
    }
    const derived = structuredClone(d2.derived!)
    const pv = derived.phaseViews[0] as Record<string, unknown> & {
      status: string; awaitingRound: number | null; currentRound: number | null
      rounds: Array<unknown>
    }
    pv.status = "running"
    pv.awaitingRound = null
    pv.currentRound = 2
    pv.rounds.push({
      roundIndex: 2,
      exec: { id: "e2e-td-acc-sim-exec2", status: "running", phase_index: 1, round_index: 2, created_at: NOW_ISO() },
      state: "running",
      decision: null,
    } as never)
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        task: { ...d2, status: "running", derived },
        acceptance_id: "e2e-td-acc-sim2",
        next_action: "dispatched",
        dispatch: { schedule_id: "sim-sch", execution_id: "sim-exec2", workspace_id: "sim-ws", phase_index: 1, round_index: 2 },
      }),
    })
  })
  await page.goto("/tasks")
  const card2 = page.locator(`[data-task-column="awaiting_review"] [data-task-id="${taskId2}"]`)
  await expect(card2).toBeVisible({ timeout: 20_000 })
  await card2.locator("[data-task-accept-btn]").click()
  const dlg2 = page.locator("[data-acceptance-modal]")
  await expect(dlg2).toBeVisible()
  await dlg2.locator("[data-acceptance-reject]").click()
  await dlg2.locator("[data-reject-feedback]").fill("E2E_TD 成功路径反馈")
  // ADR-0018 打回二分路由：二选一 radio 是活的，默认 = 修订重跑
  await expect(dlg2.locator('[data-reject-flow="rerun"] input')).toBeChecked()
  await expect(dlg2.locator('[data-reject-flow="fix"] input')).toBeEnabled()
  await dlg2.locator("[data-reject-confirm]").click()
  // 提交后路由回显卡（原 D13① disabled 假卡已兑现为真回显）+ D14 影响清单空态。
  await expect(dlg2.locator("[data-agent-recommend-card]")).toBeVisible({ timeout: 15_000 })
  await expect(dlg2.locator("[data-agent-recommend-card]")).toContainText("修订重跑")
  await expect(dlg2.locator('[data-recommend-option="fix-flow"]')).toHaveCount(0)
  await expect(dlg2.locator("[data-impact-list-empty]")).toBeVisible()
  const body = (page as unknown as { __t12: Record<string, unknown> }).__t12
  expect(body.decision).toBe("rejected")
  expect(body.phase_index).toBe(1)
  expect(body.round_index).toBe(1)
  expect(body.next_flow).toBe("rerun")
  expect(String(body.feedback)).toContain("E2E_TD 成功路径反馈")
  await page.screenshot({ path: screenshotPath("T12-AC2-post-reject-seams.png") })
})

// ── AC3（拆分）: 影响清单批准写回链的服务端半程 — spec-field(phases) →
//    home manifest.json 内容变化 + version bump（API 回读断言）。
//    web 半程（勾选→updateSpecField(phases) 整数组）由组件测试
//    acceptance-modal.test.tsx「ImpactApprovalList」断言；e2e 里弹窗无法
//    注入 items（server 无 impact API — v4.1 接缝，票头已记）。 ──────────

test("AC3 phases write-back roundtrip: spec-field(phases) changes home manifest.json + bumps version", async () => {
  test.skip(!serverAvailable || !dbAvailable, "server or rw-sqlite unavailable")
  const { request } = await import("@playwright/test")
  const taskId = await makeV4Task("E2E_TD_影响写回链", { withHome: true }) // v3 create 建 home → manifest.json 快照可回读
  const before = await getTask(taskId)
  const beforePhases = (before.task_spec as { phases: Array<Record<string, unknown>> }).phases
  const ctxBefore = await (await request.newContext()).get(`${SERVER_URL}/api/tasks/${taskId}/context`)
  const manifestBefore = (await ctxBefore.json()) as { manifestContent: string }

  // 模拟「批准影响清单」的写回：整数组替换 + workflowRef 改写（组件测试证明
  // ImpactApprovalList 发出的正是这个 body）。
  const next = beforePhases.map((p) =>
    p.index === 2 ? { ...p, workflowRef: "task-fix", name: "观测(受 r1 决策影响)" } : p,
  )
  const sf = await (await request.newContext()).post(`${SERVER_URL}/api/tasks/${taskId}/spec-field`, {
    data: { field: "phases", value: next, source: "user" },
    headers: { "Content-Type": "application/json" },
  })
  expect(sf.ok()).toBe(true)

  const after = await getTask(taskId)
  expect(after.version).toBeGreaterThan(before.version) // version bump
  const afterPhases = (after.task_spec as { phases: Array<Record<string, unknown>> }).phases
  expect(afterPhases[1].workflowRef).toBe("task-fix") // API 回读内容变化

  const ctxAfter = await (await request.newContext()).get(`${SERVER_URL}/api/tasks/${taskId}/context`)
  const manifestAfter = (await ctxAfter.json()) as { manifestContent: string }
  const snap = JSON.parse(manifestAfter.manifestContent) as { spec: { phases: Array<Record<string, unknown>> } }
  expect(snap.spec.phases[1].workflowRef).toBe("task-fix") // home manifest.json 快照随写变更
  expect(manifestAfter.manifestContent).not.toBe(manifestBefore.manifestContent)
})

// ── AC4: 绑定弹窗 fetch=1 / 点选不闪 / 版本被 bump 后保存不 409 ───────

test("AC4 per-phase binding dialog: single list fetch, no spinner-clear on rapid picks, save survives version bump", async ({ page }) => {
  test.skip(!serverAvailable || !dbAvailable, "server or rw-sqlite unavailable")
  const taskId = await makeV4Task("E2E_TD_绑定弹窗")
  let listFetches = 0
  await page.goto("/tasks")
  const card = page.locator(`[data-task-column="draft"] [data-task-id="${taskId}"]`)
  await expect(card).toBeVisible({ timeout: 20_000 })
  await card.click()

  const modal = page.getByRole("dialog")
  await expect(modal.locator("[data-phase-binding-list]")).toBeVisible({ timeout: 15_000 })
  // AuthoringWorkspace 挂载会先取一次目录（v4 入队预检）— 计数从「开窗前」清零。
  await page.waitForTimeout(800)
  page.on("request", (req) => {
    if (new URL(req.url()).pathname === "/api/workflows/built-in") listFetches += 1
  })

  await modal.locator('[data-phase-bind-button="1"]').click()
  const items = modal.locator("[data-workflow-item]")
  await expect(items.first()).toBeVisible({ timeout: 15_000 })
  expect(listFetches).toBe(1) // 弹窗打开：恰一次 list fetch（票 10 缓存端点）

  // 快速点选（至多 3 个）— 列表不被 spinner 清掉（items 恒在），零次重取
  const n = Math.min(3, await items.count())
  expect(n).toBeGreaterThanOrEqual(1)
  const count0 = await items.count()
  for (let i = 0; i < n; i++) await items.nth(i).click()
  await expect(modal.locator("[data-workflow-item]")).toHaveCount(count0)
  expect(listFetches).toBe(1) // 点选期间零 list/detail 重取（YAML 预览未展开）

  // 选中第一项并记录 ref；弹窗开着时轮询/agent bump 了 version（S5 病根）→
  // 保存仍成功（保存前重取 version）。
  const targetRef = (await items.first().getAttribute("data-workflow-item")) ?? ""
  await items.first().click()
  await updateSpecField(taskId, "goal", "票12 e2e bump", { source: "user" })
  const before = await getTask(taskId)
  const fields = modal.locator("[data-input-field]")
  if ((await fields.count()) > 0) {
    await fields.first().fill("E2E_TD bound")
  }
  await modal.locator("[data-bind-save-button]").click()
  // 保存成功 = 弹窗关闭（失败走 toast 不关闭）
  await expect(modal.locator("[data-bind-save-button]")).toHaveCount(0, { timeout: 15_000 })
  const after = await getTask(taskId)
  const phases = (after.task_spec as { phases?: Array<{ index: number; workflowRef: string; inputValues: Record<string, string> }> }).phases ?? []
  expect(phases[0].workflowRef).toBe(targetRef)
  if ((await fields.count()) > 0) {
    expect(Object.values(phases[0].inputValues ?? {})).toContain("E2E_TD bound")
  }
  expect(after.version).toBeGreaterThan(before.version) // bump = PUT 成功（未 409）
  await page.screenshot({ path: screenshotPath("T12-AC4-binding-dialog.png") })
})

// ── AC5: autoAdvance 开关可见可切（真实 PUT + API 回读） ──────────────

test("AC5 autoAdvance switch visible and toggleable in v4 authoring panel (real PUT read-back)", async ({ page }) => {
  test.skip(!serverAvailable || !dbAvailable, "server or rw-sqlite unavailable")
  const taskId = await makeV4Task("E2E_TD_自动推进开关")
  await page.goto("/tasks")
  const card = page.locator(`[data-task-column="draft"] [data-task-id="${taskId}"]`)
  await expect(card).toBeVisible({ timeout: 20_000 })
  await card.click()
  const modal = page.getByRole("dialog")
  const sw = modal.locator("[data-autoadvance-switch]")
  await expect(sw).toBeVisible({ timeout: 15_000 })
  await expect(sw).toBeChecked() // 默认开（K6）
  await sw.uncheck()
  await expect.poll(async () => {
    const d = await getTask(taskId)
    return (d.task_spec as { autoAdvance?: boolean }).autoAdvance
  }, { timeout: 15_000 }).toBe(false)
  // 再切回开
  await sw.check()
  await expect.poll(async () => {
    const d = await getTask(taskId)
    return (d.task_spec as { autoAdvance?: boolean }).autoAdvance !== false
  }, { timeout: 15_000 }).toBe(true)
  await page.screenshot({ path: screenshotPath("T12-AC5-autoadvance-switch.png") })
})

// ── B 面: 卡片动作接线 — 真实 accepted → 停 my gate → 「启动下一 Phase」 ──

test("B: real accept on autoAdvance=false parks at the gate and surfaces 启动下一 Phase; POST advance fires with contract body", async ({ page }) => {
  test.skip(!serverAvailable || !dbAvailable, "server or rw-sqlite unavailable")
  const taskId = await awaitingTaskFixture("E2E_TD_放行停gate", { autoAdvance: false })
  await page.goto("/tasks")
  const card = page.locator(`[data-task-column="awaiting_review"] [data-task-id="${taskId}"]`)
  await expect(card).toBeVisible({ timeout: 20_000 })
  await card.locator("[data-task-accept-btn]").click()
  const dialog = page.getByRole("dialog")
  await dialog.locator("[data-autoadvance-readonly]").filter({ hasText: "关" }).waitFor({ timeout: 15_000 })
  // 真实 POST /:id/acceptance accepted（autoAdvance=false → 零派发，K6 人工 gate）
  await dialog.locator("[data-acceptance-approve]").click()
  await expect
    .poll(async () => {
      const rows = await dbAll<{ decision: string }>(
        "SELECT decision FROM task_phase_acceptances WHERE task_id = ? AND phase_index = 1", taskId,
      )
      return rows[0]?.decision
    }, { timeout: 15_000 })
    .toBe("accepted")

  // SSE/轮询驱动：卡片归「待执行」列并出现 启动下一 Phase（票 08 advance 入口）
  const readyCard = page.locator(`[data-task-column="ready"] [data-task-id="${taskId}"]`)
  await expect(readyCard.locator("[data-task-advance-btn]")).toBeVisible({ timeout: 20_000 })
  await page.screenshot({ path: screenshotPath("T12-B-advance-button.png") })

  // 点击 → 真实 POST /advance（fixture 信封无物化 phases → server 409 人话
  // toast = 网络链 + 错误面的真实证明；不起活体执行）
  await readyCard.locator("[data-task-advance-btn]").click()
  // 真实 POST /advance → server 409（fixture 信封无物化 phases）→ 人话 toast
  await expect(page.locator("[data-sonner-toast]", { hasText: "不在信封已解析" })).toBeVisible({ timeout: 15_000 })
})

// ── B 面: archiving 卡「重试归档」 ────────────────────────────────────

test("B: archiving card surfaces 重试归档 button wired to POST archive/retry", async ({ page }) => {
  test.skip(!serverAvailable || !dbAvailable, "server or rw-sqlite unavailable")
  const taskId = await makeV4Task("E2E_TD_归档重试", { phases: 1 })
  await insertPhaseRoundExec(taskId, { phaseIndex: 1, roundIndex: 1, execStatus: "completed", createdAt: hoursAgo(2), durationMs: 300_000 })
  const uid = `${Date.now()}`
  await dbRun(
    `INSERT INTO task_phase_acceptances (id, task_id, phase_index, round_index, decision, feedback, decided_at)
     VALUES (?, ?, 1, 1, 'accepted', NULL, ?)`,
    `E2E_TD_acc_t12_${uid}`, taskId, hoursAgo(1),
  )
  await setTaskStatus(taskId, "archiving")

  await page.goto("/tasks")
  const card = page.locator(`[data-task-column="running"] [data-task-id="${taskId}"]`)
  await expect(card).toBeVisible({ timeout: 20_000 })
  await expect(card.locator("[data-task-archive-retry-btn]")).toBeVisible()
  await page.screenshot({ path: screenshotPath("T12-B-archive-retry.png") })
  // 不点击：真实 retry 会拉起票 08 归档编排（git fixture 属票 08 集成域）
})
