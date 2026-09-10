// packages/web-app/e2e/task-trigger-loop.spec.ts
//
// ADR-0021 票06（新增）— 周期任务闭环：把「任务不再拥有调度器行」这件事一次走穿。
//
// 顺序照 spec §8 手测清单：
//   ① 建任务 → [入队] → 断言 schedules 里**没有任何一行属于这个任务**（该 org 的行数
//      一动不动 + task id 不出现在 id/config/name/workflow_ref 里 —— 只用 COUNT(*)
//      不算证据，环境里本来就有真作业行）。
//   ② POST /:id/trigger/schedule {cron:"* * * * *"} → tasks.trigger_mode='cron' +
//      cron_expression + next_fire_at 非空在未来，且**仍然**没建任何 job 行。
//   ③ 等到点（不点任何东西，≤75s）→ tasks.last_fired_at 已写、next_fire_at 前进到
//      下一次（周期不被一次失败钉死 —— 这一轮在本环境里可能就是失败的）。
//   ④ 闩锁：任务存在一条非终态根执行时，再一次到点不得产生第二根 —— 非终态根数恒 ≤1，
//      且那一轮之后根行总数不变（被拒的到点只推进游标，不武装第二根）。
//   ⑤ abort → 那条根进终态（槽位释放：ux_exec_task_active 让位）+ 中止被记录
//      （executions.var_pool.error → 徽章 error_summary === 「用户中止」）。
//
// ── 需要真 LLM / 真引擎才能覆盖的部分（明确列出，不假装）────────────────
// 本 spec 的 ①②③⑤ 全是数据形状 + 游标语义，**不需要** provider，也不需要工作流真的
// 跑起来：③ 里那一轮如果因为「任务没绑可解析的 workflow_ref」而 arm 失败，正是 §新行为8
// 要断的那条路径（游标照走、不发第二根、失败经 task_trigger_failed 上报）。
// 需要真引擎才能覆盖的只有一件事：**一根真的在跑的轮**（claimed→running→完成→collect）。
// 那属票 14 主故事（task-phase-lifecycle.spec.ts 已用 bash-stub 工作流真跑一段）与 server
// 集成测试域，本 spec 不重复；④ 因此按「用行做闩锁」构造（见该测试注释）。
//
// Anti-fake-run: R1（真 server + 真内置 job 行 + 真 cron 到点，无 mock）；R3（API↔DB 交叉，
// 「何时」七列逐列比）；R4（response+SQL 双断言）；R5（写操作后回读 DB）；R7（E2E_TD_ 前缀，
// 行按 id 精确清理）；R8（无人工前置）。
// 跳过约定沿用 helpers：server 不可达 / rw-sqlite 不可用时 skip（不是通过）。

import { test, expect } from "@playwright/test"
import { DatabaseSync } from "node:sqlite"
import * as os from "os"
import * as path from "path"
import {
  SERVER_URL,
  TASK_E2E_ORG,
  DATA_PREFIX,
  log,
  logError,
  isServerAvailable,
  createTask,
  updateSpecField,
  readyTask,
  abortTask,
  deleteTask,
  getTask,
  scheduleTaskTrigger,
  startSseSubscriber,
  readTaskRow,
  readTaskExecutions,
  readTaskRootExecutions,
  isTerminalExecutionStatus,
  countSchedulesInOrg,
  countAllSchedules,
  findTaskEnvelopeScheduleRows,
  assertTaskMatchesDb,
  resolveDbPath,
  waitFor,
  type TaskExecutionRow,
  type SseSubscriber,
} from "./helpers/task-domain-helpers"

// ── 常量 / 运行态 ──────────────────────────────────────────────────────

const RUN = `tl${Date.now().toString(36)}`
const TASK_NAME = `${DATA_PREFIX}周期闭环_${RUN}`
const CRON_EVERY_MINUTE = "* * * * *"
/** 内置 job 行 id（builtin-<handler>，seed 幂等）—— 它属于 org ''，不是任务的。 */
const BUILTIN_JOB_ID = "builtin-task-lifecycle"
/** 一次 cron 到点最长等待：60s 周期 + 一跳 tick + 余量。 */
const FIRE_TIMEOUT_MS = 95_000

let serverAvailable = false
let dbAvailable = true
let taskId = ""
// ④ 直种的行（⑤ 之后由本 spec 精确删除）+ 它引用的 workspace 行。
const planted: { executionIds: string[]; workspaceIds: string[] } = { executionIds: [], workspaceIds: [] }
let sseSub: SseSubscriber | null = null

// ── 读写 sqlite（helper 的连接是 readOnly：它只断言，这里要种行）────────

function dbRun(sql: string, ...params: unknown[]): void {
  const db = new DatabaseSync(resolveDbPath())
  try {
    db.prepare("PRAGMA busy_timeout = 5000").run()
    db.prepare(sql).run(...(params as never[]))
  } finally {
    db.close()
  }
}
function dbGet<T>(sql: string, ...params: unknown[]): T | undefined {
  const db = new DatabaseSync(resolveDbPath())
  try {
    db.prepare("PRAGMA busy_timeout = 5000").run()
    return db.prepare(sql).get(...(params as never[])) as T | undefined
  } finally {
    db.close()
  }
}

/** tasks 的「何时」快照（游标 + 开关 + 模式），用于比较「到点之后游标是否前进」。 */
interface TriggerCursor {
  status: string
  trigger_mode: string
  trigger_enabled: number
  next_fire_at: string | null
  last_fired_at: string | null
}
const cursor = (): TriggerCursor =>
  dbGet<TriggerCursor>(
    "SELECT status, trigger_mode, trigger_enabled, next_fire_at, last_fired_at FROM tasks WHERE id = ?",
    taskId,
  )!

/** ④ 的正题：一条**已武装未起跑**（pending）或**在跑**（running）的根执行。
 *  种 running 而不是 pending：pending 行会被同一跳的 launchQueued 领走（那是队列的本职，
 *  不是本用例要测的），而 started_at=now 的 running 行在 STALE_CLAIMED_THRESHOLD 之内
 *  reconcile 也不会碰 —— 于是闩锁窗口干净地只剩「到点扫描 vs 已有活实例」这一件事。 */
function plantLiveRootExecution(status: "running" | "pending"): string {
  const uid = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const wsId = `e2e-td-tl-ws-${uid}`
  const execId = `e2e-td-tl-exec-${uid}`
  const now = new Date().toISOString()
  dbRun(
    `INSERT INTO workspaces (id, name, org, status, path, created_at, updated_at, source, task_id)
     VALUES (?, ?, ?, 'active', ?, ?, ?, 'task', ?)`,
    wsId, `E2E_TD_tl_ws_${uid}`, TASK_E2E_ORG, path.join(os.homedir(), ".octopus", `e2e-td-tl-${uid}`), now, now, taskId,
  )
  dbRun(
    `INSERT INTO executions (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name,
       node_type, org, task_id, status, started_at, created_at, updated_at)
     VALUES (?, ?, '0', 0, 'e2e-td-tl-stub', 'e2e-td-tl-stub', 'normal', ?, ?, ?, ?, ?, ?)`,
    execId, wsId, TASK_E2E_ORG, taskId, status, now, now, now,
  )
  planted.workspaceIds.push(wsId)
  planted.executionIds.push(execId)
  return execId
}

const liveRoots = (rows: TaskExecutionRow[]): TaskExecutionRow[] =>
  rows.filter((r) => r.parent_id === "0" && !isTerminalExecutionStatus(r.status))

test.describe.configure({ mode: "serial" })

test.describe("ADR-0021 票06: 周期任务闭环（零信封 → 排期 → 到点 → 闩锁 → 中止）", () => {
  test.beforeAll(async () => {
    serverAvailable = await isServerAvailable()
    if (!serverAvailable) {
      log(`server not available at ${SERVER_URL} — tests will be skipped`)
      return
    }
    try {
      new DatabaseSync(resolveDbPath()).close()
    } catch (err: unknown) {
      dbAvailable = false
      logError(`rw sqlite unavailable: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      sseSub = await startSseSubscriber()
    } catch (err: unknown) {
      logError(`SSE subscriber failed to start: ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  test.afterAll(async () => {
    sseSub?.stop()
    if (taskId) {
      // ⑤ 之后卡片是 aborted；deleteTask 允许（只 running 被挡）。软删即可让游标扫描
      // （谓词含 status='ready' AND deleted_at IS NULL）彻底看不到它。
      try {
        await deleteTask(taskId)
      } catch (err: unknown) {
        logError(`cleanup deleteTask ${taskId}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (!dbAvailable) return
    try {
      const inList = (xs: string[]) => xs.map(() => "?").join(",")
      if (planted.executionIds.length) {
        const list = inList(planted.executionIds)
        dbRun(`DELETE FROM node_executions WHERE execution_id IN (${list})`, ...planted.executionIds)
        dbRun(`DELETE FROM executions WHERE id IN (${list})`, ...planted.executionIds)
      }
      if (planted.workspaceIds.length)
        dbRun(`DELETE FROM workspaces WHERE id IN (${inList(planted.workspaceIds)})`, ...planted.workspaceIds)
      if (taskId) dbRun("DELETE FROM tasks WHERE id = ?", taskId) // 硬删：不把 E2E_TD_ 行留给下一轮
    } catch (err: unknown) {
      logError(`cleanup: ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  // ── ① 入队：任务在 schedules 里零行 ────────────────────────────────

  test("① 建任务 + 入队 → schedules 里没有任何一行属于这个任务（org 行数不动 + task id 不出现）", async () => {
    test.skip(!serverAvailable, "Server not available")

    const task = await createTask({ name: TASK_NAME, org: TASK_E2E_ORG })
    taskId = task.id
    expect(task.status, "新任务应为 draft").toBe("draft")
    await updateSpecField(task.id, "goal", "周期闭环 E2E：到点起一轮，不需要 LLM")
    await updateSpecField(task.id, "ac", ["到点后 tasks.next_fire_at 前进", "同任务同时至多一条非终态根"])

    const orgBefore = countSchedulesInOrg(TASK_E2E_ORG)
    const allBefore = countAllSchedules()

    const ready = await readyTask(task.id)
    expect(ready.status, "入队 → ready").toBe("ready")

    // 「总数不变」+「没有一行在 id/config/name/workflow_ref 里带这个 task id」两条一起断：
    // 环境里本来就可能有真作业行，只有 id 搜索能证明「这一条不是任务带来的」。
    expect(
      findTaskEnvelopeScheduleRows(task.id),
      "票03 §新行为1: 入队后 task id 在 schedules 的任何一列里都不该出现",
    ).toHaveLength(0)
    expect(countSchedulesInOrg(TASK_E2E_ORG), "该 org 的 schedules 行数一动不动").toBe(orgBefore)
    expect(countAllSchedules(), "全库 schedules 行数一动不动（没偷偷建 job 行）").toBe(allBefore)

    // 「已入队」是三个不同的事实，旧信封里它们是同一次翻转：卡 ready、无游标、无实例。
    expect(readTaskExecutions(task.id), "入队不武装任何实例").toHaveLength(0)
    const row = cursor()
    expect(row.status).toBe("ready")
    expect(row.trigger_mode, "默认 manual（「何时」在 tasks 上）").toBe("manual")
    expect(row.next_fire_at, "没有到期游标 = 什么都没排").toBeNull()
    expect(row.trigger_enabled, "触发总开关默认开").toBe(1)

    // API↔DB（R3）：读模型的 trigger_* 与库里逐列一致（assertTaskMatchesDb 现在比七列）。
    assertTaskMatchesDb(await getTask(task.id), { status: "ready" })
    log(`① ok: task ${task.id} ready; schedules 未被触碰 (org=${orgBefore}, all=${allBefore})`)
  })

  // ── ② 排期：写任务自己的列，不建 job 行 ────────────────────────────

  test("② /trigger/schedule {cron} → tasks.trigger_mode='cron' + next_fire_at，且不建 job 行", async () => {
    test.skip(!serverAvailable || !taskId, "Server not available / ① did not run")

    const allBefore = countAllSchedules()
    const orgBefore = countSchedulesInOrg(TASK_E2E_ORG)

    const scheduled = await scheduleTaskTrigger(taskId, CRON_EVERY_MINUTE)
    expect(scheduled.trigger_mode, "DTO 说 cron").toBe("cron")
    expect(scheduled.cron_expression, "DTO 带回表达式").toBe(CRON_EVERY_MINUTE)
    expect(scheduled.next_fire_at, "DTO 的到期游标非空").toBeTruthy()
    expect(
      new Date(scheduled.next_fire_at!).getTime(),
      "游标指向未来（下一次），不是「现在」",
    ).toBeGreaterThan(Date.now() - 1000)

    // DB 交叉（R4/R5）：同一件事在 tasks 行上。
    const row = cursor()
    expect(row.trigger_mode, "库里也是 cron").toBe("cron")
    expect(
      dbGet<{ cron_expression: string | null; cron_timezone: string }>(
        "SELECT cron_expression, cron_timezone FROM tasks WHERE id = ?", taskId,
      ),
      "cron_expression / cron_timezone 落在任务行上（信封时代它们根本不存在）",
    ).toEqual({ cron_expression: CRON_EVERY_MINUTE, cron_timezone: "Asia/Shanghai" })
    expect(row.next_fire_at, "库里的游标与 DTO 同一值").toBe(scheduled.next_fire_at)
    expect(row.status, "排期不启动：卡仍 ready").toBe("ready")
    expect(readTaskExecutions(taskId), "排期不武装实例（游标 ≠ 运行）").toHaveLength(0)
    assertTaskMatchesDb(await getTask(taskId))

    // 「不建 job 行」的正面证据：id 搜索 + 行数不变（内置 job 行属 org ''，与本任务无关）。
    expect(findTaskEnvelopeScheduleRows(taskId), "定时触发没在 schedules 里留下任何行").toHaveLength(0)
    expect(countSchedulesInOrg(TASK_E2E_ORG), "该 org 的 schedules 行数仍不动").toBe(orgBefore)
    expect(countAllSchedules(), "全库 schedules 行数仍不动").toBe(allBefore)

    // task_trigger SSE（票05 契约：scheduled_at 改名 next_fire_at）—— 排期上报的是游标。
    if (sseSub) {
      await waitFor(
        () => sseSub!.taskTriggerEvents.find(
          (e) => e.task_id === taskId && e.action === "scheduled" && e.next_fire_at === scheduled.next_fire_at,
        ),
        { timeoutMs: 10_000, message: "task_trigger SSE (scheduled + next_fire_at) not received" },
      )
    }
    log(`② ok: cron 已排在 tasks.next_fire_at=${scheduled.next_fire_at}，schedules 零行`)
  })

  // ── ③ 到点：不点任何东西，游标自己前进 ─────────────────────────────

  test("③ 到点（无人工动作）→ last_fired_at 已写 + next_fire_at 前进到下一次", async () => {
    test.setTimeout(FIRE_TIMEOUT_MS + 30_000)
    test.skip(!serverAvailable || !taskId, "Server not available / ② did not run")

    // 前置而非跳过：内置 job 行被暂停时全系统定时启动都停（票05 §新事实6 说它可暂停），
    // 那是运维状态，不是被测契约 —— 明说并 skip，不在这里改库把它打开。
    const builtin = dbAvailable
      ? dbGet<{ enabled: number; job_type: string; status: string }>(
          "SELECT enabled, job_type, status FROM schedules WHERE id = ?", BUILTIN_JOB_ID,
        )
      : undefined
    test.skip(dbAvailable && !builtin, `内置 job 行 ${BUILTIN_JOB_ID} 不存在（server 未 seed？）`)
    test.skip(!!builtin && builtin.enabled !== 1, "内置 task-lifecycle job 被暂停（运维状态，非本契约）")

    const before = cursor()
    const dueAt = before.next_fire_at
    expect(dueAt, "③ 需要 ② 排好的游标").toBeTruthy()
    const rootsBefore = readTaskExecutions(taskId).length

    // 什么都不点。到点由内置 job 处理（§新行为2 的 future 分支就是这个意思）。
    const fired = await waitFor(
      () => {
        const now = cursor()
        return now.last_fired_at && now.last_fired_at !== before.last_fired_at ? now : null
      },
      { timeoutMs: FIRE_TIMEOUT_MS, intervalMs: 2000, message: `到点未处理（next_fire_at=${dueAt}）` },
    )
    expect(new Date(fired.last_fired_at!).getTime(), "last_fired_at 是这次到点写的").toBeGreaterThan(
      new Date(dueAt!).getTime() - 61_000,
    )
    expect(fired.next_fire_at, "周期任务跑完不落「完成」：游标跳到下一次").toBeTruthy()
    expect(
      new Date(fired.next_fire_at!).getTime(),
      `游标严格前进（${dueAt} → ${fired.next_fire_at}）—— 一次失败/一轮结束都不把它钉在过去`,
    ).toBeGreaterThan(new Date(dueAt!).getTime())
    expect(fired.status, "cron 任务仍在 ready（被排期，不是被点燃一次就完）").toBe("ready")

    // 这一轮到 DB 上是什么形状：arm 成功 → 一行（pending/running/终态）；arm 被拒 → 零行 +
    // task_trigger_failed。两种都合法，共同点是「至多一条非终态根」。
    const roots = readTaskExecutions(taskId)
    expect(
      roots.length,
      "一次到点至多武装一根（不会因重试/多次扫描堆行）",
    ).toBeLessThanOrEqual(rootsBefore + 1)
    expect(
      liveRoots(roots).length,
      "非终态根 ≤1 —— 同任务互斥现在是一条 DB 约束（ux_exec_task_active）",
    ).toBeLessThanOrEqual(1)
    if (roots.length > rootsBefore) {
      const armed = readTaskRootExecutions(taskId)[0]!
      expect(armed.task_id, "行经 task_id 直连任务").toBe(taskId)
      expect(armed.parent_id, "到点起的是根执行").toBe("0")
      log(`③ ok: 到点 ${dueAt} → last_fired_at=${fired.last_fired_at}，游标 ${fired.next_fire_at}，武装根 ${armed.id} (${armed.status})`)
    } else {
      // 本环境里这一轮在门前就被拒（例如任务没绑可解析的 workflow_ref）—— 这正是 §新行为8
      // 「周期不被一次失败钉死」要断的那条路径，且它有自己的事件（票05：失败要能上报，
      // 不留静默）。SSE 帧可能比 DB 写晚到几百毫秒，所以这里等，不做瞬时快照断言。
      // 订阅器没起来时（beforeAll 里失败过）这一路只能跳过 —— 明写，不静默通过。
      test.skip(!sseSub, "SSE subscriber not started — 事件面无法断言")
      const failedEvent = await waitFor(
        () => sseSub!.taskTriggerFailedEvents.find((e) => e.task_id === taskId) ?? null,
        {
          timeoutMs: 10_000,
          intervalMs: 500,
          message: "arm 失败未经 task_trigger_failed 上报（不留静默）",
        },
      )
      expect(String(failedEvent.reason).length, "事件带了拒因这一行话").toBeGreaterThan(0)
      expect(failedEvent.trigger_mode, "事件说的是 cron 这一类触发").toBe("cron")
      log(`③ ok: 到点但 arm 被拒（${String(failedEvent.reason).slice(0, 60)}），游标仍前进 + task_trigger_failed 已上报`)
    }
  })

  // ── ④ 闩锁：有活实例时，再一次到点不产生第二根 ────────────────────

  test("④ 闩锁：存在非终态根时再一次到点只推进游标，不武装第二根", async () => {
    test.setTimeout(FIRE_TIMEOUT_MS + 30_000)
    test.skip(!serverAvailable || !taskId || !dbAvailable, "Server/DB not available or ③ did not run")

    // 用行做闩锁（正题）：这次重构让「一个任务现在有没有在跑」变成一个可问的列查询，所以
    // 闩锁不再需要真引擎就能被钉住 —— 种一条 started_at=now 的 running 根，任务留在 ready，
    // 下一跳到点扫描看到「有非终态根」就只该 retireFireCursor，不该 INSERT 第二根。
    // （真在跑的轮属票 14 主故事；见文件头「需要真 LLM/引擎」清单。）
    let existing = liveRoots(readTaskExecutions(taskId))
    if (existing.length > 1) {
      test.skip(true, `前置破坏：库里已有 ${existing.length} 条非终态根（互斥约束未生效？）`)
    }
    const plantedId = existing.length === 0 ? plantLiveRootExecution("running") : existing[0]!.id
    const usedPlanted = existing.length === 0
    existing = liveRoots(readTaskExecutions(taskId))
    expect(existing.length, "构造后恰好一条非终态根").toBe(1)
    expect(existing[0]!.id, "那条根就是我们看着的行").toBe(plantedId)

    const before = cursor()
    expect(before.status, "有活实例时卡片仍写 ready（这正是旧信封会骗人的地方）").toBe("ready")
    const rootsBefore = readTaskExecutions(taskId).length

    // 轮询到点：期间任何一刻都不允许出现第二条非终态根（不是「最后看一眼」，是全程）。
    const after = await waitFor(
      () => {
        const rows = readTaskExecutions(taskId)
        expect(
          liveRoots(rows).length,
          "闩锁 violated：同时出现 >1 条非终态根",
        ).toBeLessThanOrEqual(1)
        const now = cursor()
        return now.last_fired_at && now.last_fired_at !== before.last_fired_at ? now : null
      },
      { timeoutMs: FIRE_TIMEOUT_MS, intervalMs: 2000, message: "有活实例期间再一次到点未被处理" },
    )
    expect(
      new Date(after.next_fire_at!).getTime(),
      "被拒的到点同样只推进游标（不重试风暴，也不钉死周期）",
    ).toBeGreaterThan(new Date(before.next_fire_at ?? before.last_fired_at!).getTime())

    const rows = readTaskExecutions(taskId)
    expect(rows.length, "第二根没有被武装 —— 根行总数不变").toBe(rootsBefore)
    expect(liveRoots(rows).length, "仍是那一条非终态根").toBe(1)
    log(`④ ok: ${usedPlanted ? "直种 running 根" : "复用 ③ 的真根"} 上闩锁生效（游标 ${before.next_fire_at} → ${after.next_fire_at}，根行仍 ${rows.length} 条）`)
  })

  // ── ⑤ abort：槽位释放 + 中止被记录 ────────────────────────────────

  test("⑤ abort → 根行进终态（槽位释放）+ 中止原因被记录（error_summary）", async () => {
    test.skip(!serverAvailable || !taskId, "Server not available / ④ did not run")

    const live = liveRoots(readTaskExecutions(taskId))
    expect(live.length, "abort 前存在那条活根").toBe(1)
    const liveId = live[0]!.id

    const aborted = await abortTask(taskId)
    expect(aborted.status, "卡进 aborted").toBe("aborted")

    // 槽位释放：终态行不再占 ux_exec_task_active 的位置（旧版这里断的是 schedule_executions
    // 被标 failed 以归还一个借来的 UNIQUE 索引 —— 那个借据本身已经没有了）。
    const rows = await waitFor(
      () => {
        const all = readTaskExecutions(taskId)
        return liveRoots(all).length === 0 ? all : null
      },
      { timeoutMs: 20_000, message: "abort 后仍有非终态根（槽位未释放）" },
    )
    const stopped = rows.find((r) => r.id === liveId)!
    expect(stopped.status, "那条根停在 aborted").toBe("aborted")
    expect(stopped.completed_at, "停止时刻记在行上").not.toBeNull()
    expect(
      findTaskEnvelopeScheduleRows(taskId),
      "abort 全程不写 schedules（§新行为4：不碰调度器表）",
    ).toHaveLength(0)

    // 「中止真的被记录了」的唯一观测点：每条失败写路径都把原因并进 var_pool.error，读侧
    // 只在终态失败行露出（票05 §新事实2）。不需要 provider 就能验。
    const varPool = JSON.parse(stopped.var_pool || "{}") as { error?: string }
    expect(varPool.error, "行上记了原因").toBe("用户中止")
    const detail = await getTask(taskId)
    expect(detail.execution, "徽章还在（这是任务最近一次运行）").not.toBeNull()
    expect(detail.execution!.id, "徽章指向刚停的那根").toBe(liveId)
    expect(detail.execution!.status, "徽章 aborted").toBe("aborted")
    expect(detail.execution!.error_summary, "徽章把原因投影成 error_summary").toBe("用户中止")
    assertTaskMatchesDb(detail, { status: "aborted" })

    // aborted 是终态：到期游标不再被扫（谓词含 status='ready'），周期就此停住。
    const row = cursor()
    expect(row.status, "卡停在 aborted（重跑=重新入队）").toBe("aborted")
    expect(
      dbGet<{ c: number }>(
        "SELECT COUNT(*) c FROM tasks WHERE id = ? AND status = 'ready' AND deleted_at IS NULL AND trigger_enabled = 1 AND next_fire_at IS NOT NULL",
        taskId,
      )!.c,
      "终态任务不在到期扫描的谓词里 —— 不会再自己起轮",
    ).toBe(0)

    // SSE：卡停下来的那一站（注意：stop 路径只发 task_status，不发 task_execution —— 已记
    // 为票05 的可改进点，本 spec 只断存在的那条）。
    if (sseSub) {
      await waitFor(
        () => sseSub!.taskStatusEvents.find((e) => e.task_id === taskId && e.status === "aborted"),
        { timeoutMs: 10_000, message: "task_status SSE for aborted not received" },
      )
    }
    log(`⑤ ok: 根 ${liveId} aborted + 原因「用户中止」上徽章；周期停摆在终态`)
  })
})
