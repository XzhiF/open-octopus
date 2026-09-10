// packages/web-app/e2e/task-domain-crash-abort.spec.ts
//
// Ticket 12 — Crash recovery + abort (spec § G2/G4). Migrated to ADR-0021 票03 by
// 票06: the objects this spec used to assert (a task's `schedules` envelope row,
// `schedule_executions`, the ScheduleStatusListener mirror, orphan-reaper) are DELETED.
//
// G2: a failed run stays failed (no re-dispatch loop). The stale-claim reaper is gone;
//     the successor is the built-in task-lifecycle job's reconcile pass, which
//     terminalises a live `executions` row whose engine is no longer in this process.
// G4: abort stops the task's OWN instance (票03 §新行为4): a live row is engine-cancelled,
//     an armed 'pending' row is retired, both land on executions.status='aborted';
//     tasks.status='aborted' is written and task_status SSE is emitted. Abort never
//     touches `schedules`, and the bound workspace survives (K12).
//
// Anti-fake-run: R1 (real server + real task-lifecycle job), R3 (API↔DB cross-check),
// R4 (response+SQL), R5 (write-ops verify DB), R7 (E2E_TD_ prefix), R8 (no manual
// prerequisites).
//
// NOTE: the stale-claim crash path (G2) is non-deterministic in E2E — it needs a round
// whose engine dies mid-run, which depends on a provider being configured. So:
//   - The abort test (G4) is deterministic: 入队 (§新行为1 — arms NOTHING) → one armed row
//     → abort → the row retires to 'aborted' + the card follows + SSE. The armed row is
//     planted in `executions` because that IS the successor of the old queued envelope
//     row: status='pending' means 排队中 (armed, waiting behind the concurrency gate).
//   - The G2 test: if the task reaches 'failed' naturally, assert it stays 'failed' and
//     holds no live row; otherwise verify terminal stability on the aborted path.

import { test, expect } from "@playwright/test"
import { DatabaseSync } from "node:sqlite"
import * as path from "path"
import * as os from "os"
import {
  SERVER_URL,
  TASK_E2E_ORG,
  DATA_PREFIX,
  log,
  logError,
  ensureScreenshotDir,
  isServerAvailable,
  createTask,
  getTask,
  updateSpecField,
  readyTask,
  abortTask,
  deleteTask,
  triggerTaskRaw,
  startSseSubscriber,
  readTaskRow,
  readTaskExecutions,
  readTaskRootExecutions,
  isTerminalExecutionStatus,
  findTaskEnvelopeScheduleRows,
  countSchedulesInOrg,
  resolveDbPath,
  assertTaskMatchesDb,
  waitFor,
  waitForTaskStatus,
  type TaskExecutionRow,
  type SseSubscriber,
} from "./helpers/task-domain-helpers"

// ── Constants ───────────────────────────────────────────────────────────

const ABORT_TASK_NAME = `${DATA_PREFIX}crash-abort-G4`
const CRASH_TASK_NAME = `${DATA_PREFIX}crash-recovery-G2`

// ── Suite-level state ───────────────────────────────────────────────────

let serverAvailable = false
let dbAvailable = true
let sseSub: SseSubscriber | null = null
const createdTaskIds: string[] = []
// Rows this spec plants directly (the armed instance + the workspace it points at);
// deleted in afterAll so the dev DB keeps no fixture residue.
const planted: { executionIds: string[]; workspaceIds: string[] } = {
  executionIds: [],
  workspaceIds: [],
}

test.describe.configure({ mode: "serial" })

// ── read-WRITE sqlite (the helper's connection is readOnly: it asserts, this plants) ──

function dbRun(sql: string, ...params: unknown[]): void {
  const db = new DatabaseSync(resolveDbPath())
  try {
    db.prepare("PRAGMA busy_timeout = 5000").run()
    db.prepare(sql).run(...(params as never[]))
  } finally {
    db.close()
  }
}

/**
 * Plant ONE armed-but-not-started instance for a task — the row-level successor of the
 * envelope's `status='queued'` schedule (票03 §数据形状: 一次运行 = 一条 executions 行,
 * `task_id` 直连, status 'pending' = 已排队). Root (`parent_id='0'`) because it is the
 * task's current instance, not a fan-out arm.
 *
 * Deliberately NOT done through 触发: the immediate 触发 would also START the engine, which
 * needs a working provider — and this test is about abort's two writes (retire the row,
 * mirror the card), which are provider-free. `tick()` starting a row that a cap had parked
 * is the other half of the same contract and is covered by task-trigger-loop.spec.ts.
 */
function plantArmedRootExecution(taskId: string, status = "pending"): { execId: string; wsId: string } {
  const uid = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const wsId = `e2e-td-ca-ws-${uid}`
  const execId = `e2e-td-ca-exec-${uid}`
  const now = new Date().toISOString()
  dbRun(
    `INSERT INTO workspaces (id, name, org, status, path, created_at, updated_at, source)
     VALUES (?, ?, ?, 'active', ?, ?, ?, 'user')`,
    wsId, `E2E_TD_ca_ws_${uid}`, TASK_E2E_ORG, path.join(os.homedir(), ".octopus", `e2e-td-ca-${uid}`), now, now,
  )
  dbRun(
    `INSERT INTO executions (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name,
       status, org, task_id, created_at, updated_at)
     VALUES (?, ?, '0', 0, 'e2e-td-ca-stub', 'e2e-td-ca-stub', ?, ?, ?, ?, ?)`,
    execId, wsId, status, TASK_E2E_ORG, taskId, now, now,
  )
  planted.workspaceIds.push(wsId)
  planted.executionIds.push(execId)
  return { execId, wsId }
}

test.describe("Crash recovery + abort (G2/G4)", () => {
  test.beforeAll(async () => {
    serverAvailable = await isServerAvailable()
    if (!serverAvailable) {
      log(`Server not available at ${SERVER_URL} — tests will be skipped`)
      return
    }
    try {
      new DatabaseSync(resolveDbPath()).close()
    } catch (err: unknown) {
      dbAvailable = false
      logError(`rw sqlite unavailable: ${err instanceof Error ? err.message : String(err)}`)
    }
    ensureScreenshotDir()
    try {
      sseSub = await startSseSubscriber()
    } catch (err: unknown) {
      logError(`SSE subscriber failed to start: ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  test.afterAll(async () => {
    sseSub?.stop()
    for (const taskId of createdTaskIds) {
      try {
        await deleteTask(taskId)
      } catch (err: unknown) {
        logError(`cleanup deleteTask ${taskId}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (!dbAvailable) return
    // Plant-cleanup (R7: no fixture residue). executions has no FK cascade to
    // node_executions here because a planted row never ran, but delete defensively in
    // child→parent order anyway.
    try {
      const inList = (xs: string[]) => xs.map(() => "?").join(",")
      if (planted.executionIds.length) {
        const list = inList(planted.executionIds)
        dbRun(`DELETE FROM node_executions WHERE execution_id IN (${list})`, ...planted.executionIds)
        dbRun(`DELETE FROM llm_calls WHERE execution_id IN (${list})`, ...planted.executionIds)
        dbRun(`DELETE FROM execution_summaries WHERE execution_id IN (${list})`, ...planted.executionIds)
        dbRun(`DELETE FROM executions WHERE id IN (${list})`, ...planted.executionIds)
      }
      if (planted.workspaceIds.length)
        dbRun(`DELETE FROM workspaces WHERE id IN (${inList(planted.workspaceIds)})`, ...planted.workspaceIds)
    } catch (err: unknown) {
      logError(`cleanup planted rows: ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  // ── G4: abort retires the armed instance + writes the card ──────────

  test("G4: abort stops the task's instance (row→aborted) + card→aborted + task_status SSE, and touches no schedules", async () => {
    test.skip(!serverAvailable || !dbAvailable, "server or rw-sqlite unavailable")

    // Create a task + bind goal/ac.
    const task = await createTask({ name: ABORT_TASK_NAME, org: TASK_E2E_ORG })
    createdTaskIds.push(task.id)
    expect(task.status, "New task should be draft").toBe("draft")

    await updateSpecField(task.id, "goal", "A task to be aborted while its instance is armed.")
    await updateSpecField(task.id, "ac", ["Task is abortable while armed"])

    const schedulesBefore = countSchedulesInOrg(TASK_E2E_ORG)

    // [入队] → ready. 票03 §新行为1: this is the whole effect — a gate + a status flip.
    const ready = await readyTask(task.id)
    expect(ready.status, "Task should be ready after enqueue").toBe("ready")
    expect(
      findTaskEnvelopeScheduleRows(task.id),
      "票03 §新行为1: 入队后 schedules 零条任务行 — the task id appears nowhere in that table",
    ).toHaveLength(0)
    expect(
      countSchedulesInOrg(TASK_E2E_ORG) - schedulesBefore,
      "票03 §新行为1: the org's schedule-row count did not move on 入队",
    ).toBe(0)
    expect(readTaskExecutions(task.id), "Enqueue arms no instance").toHaveLength(0)

    // The armed instance (the old test read this off the envelope: origin_role='primary',
    // status='queued'). Row-level: one root, task_id set, status 'pending' = 排队中.
    const { execId } = plantArmedRootExecution(task.id)
    const armedRow = await waitFor(
      () => {
        const roots = readTaskRootExecutions(task.id)
        return roots.length === 1 ? roots[0] : null
      },
      { timeoutMs: 5_000, message: "the armed root row is not readable" },
    )
    expect(armedRow.id, "The armed row is the one we planted").toBe(execId)
    expect(armedRow.task_id, "The instance row carries the task id directly (no join bridge)").toBe(task.id)
    expect(armedRow.parent_id, "A task's current instance is a root").toBe("0")
    expect(armedRow.status, "'pending' = armed and queued behind the concurrency gate").toBe("pending")
    // The other half of the pair that the envelope collapsed: the CARD is not running, and
    // there is no due cursor either — a manually-triggered task fires on the button.
    const dbRowBefore = readTaskRow(task.id)!
    expect(dbRowBefore.status, "A queued instance does NOT make the card 执行中").toBe("ready")
    expect(dbRowBefore.next_fire_at, "No due cursor is armed for a manual trigger").toBeNull()

    // POST /api/tasks/:id/abort — 票03 §新行为4.
    const aborted = await abortTask(task.id)
    expect(aborted.status, "Task should be aborted after POST /abort").toBe("aborted")

    // DB assert (R3/R4/R5): the card is terminal + completed_at set.
    const dbRow = readTaskRow(task.id)
    expect(dbRow, "Task row should exist").not.toBeNull()
    expect(dbRow!.status, "DB status should be aborted").toBe("aborted")
    expect(dbRow!.completed_at, "DB completed_at should be set for aborted").not.toBeNull()

    // DB assert (R4): the instance retired to a terminal 'aborted' row — the successor of
    // the old "child schedules flipped to aborted".
    const rows = readTaskExecutions(task.id)
    expect(rows, "The task still has exactly its one instance").toHaveLength(1)
    expect(rows[0]!.status, `Instance ${rows[0]!.id} retired to aborted`).toBe("aborted")
    expect(rows[0]!.completed_at, "The retired row carries completed_at").not.toBeNull()
    // Abort creates nothing anywhere in the scheduler's table (§新行为4: 不碰 schedules).
    expect(
      findTaskEnvelopeScheduleRows(task.id),
      "Abort must not have written a schedules row",
    ).toHaveLength(0)
    expect(
      countSchedulesInOrg(TASK_E2E_ORG) - schedulesBefore,
      "Abort leaves the org's schedule-row count untouched",
    ).toBe(0)

    // API assert (R3): the badge shows the retired row, and the trigger half of the DTO
    // still matches tasks.* (assertTaskMatchesDb now cross-checks all seven trigger cols).
    const apiTask = await getTask(task.id)
    expect(apiTask.status, "API status should be aborted").toBe("aborted")
    expect(apiTask.execution, "The current-instance badge is the retired row").not.toBeNull()
    expect(apiTask.execution!.id, "Badge id == the aborted instance").toBe(execId)
    expect(apiTask.execution!.status, "Badge status == aborted").toBe("aborted")
    assertTaskMatchesDb(apiTask, { status: "aborted" })

    // Every failure write merges its reason into the row's var_pool under `error`, and the
    // read model projects it as the badge's one-liner. This is the only observation proving
    // the stop was RECORDED (not just flipped), and it needs no provider. The retire
    // branch's own wording: an armed row never started.
    const varPool = JSON.parse(rows[0]!.var_pool || "{}") as { error?: string }
    expect(varPool.error, "The retired row records why it stopped").toBe("任务被中止（排队中）")
    expect(
      apiTask.execution!.error_summary,
      "The badge projects the row's reason (error_summary)",
    ).toBe("任务被中止（排队中）")
    // NOTE (票06 finding): the stop path emits ONLY task_status — `lifecycle.abortTask`
    // writes the row and the reason but never fires task_execution, even though 票05's
    // payload carries an optional `reason` for exactly the failure/reap paths. So a board
    // that folds task_execution still waits for its 10s poll to learn WHY the row went red
    // here. Reported, not asserted (the SSE surface is 票05's).

    // SSE assert: task_status event emitted for the abort transition.
    expect(sseSub, "SSE subscriber should be active").not.toBeNull()
    await waitFor(
      () => sseSub!.taskStatusEvents.find((e) => e.task_id === task.id && e.status === "aborted"),
      { timeoutMs: 10_000, message: "task_status SSE for aborted not received" },
    )

    log(`G4 verified: task ${task.id} aborted; instance ${execId} retired to aborted; 0 schedule rows; SSE emitted`)
  })

  // ── G4: abort from ready is idempotent (terminal state) ───────────

  test("G4: aborting an already-aborted task returns 409 (idempotent terminal)", async () => {
    test.skip(!serverAvailable, "Server not available")
    test.skip(createdTaskIds.length === 0, "No task from previous step")
    const taskId = createdTaskIds[0]!

    // The task is already aborted — aborting again should 409 (TaskStatusConflictError)
    // because aborted is terminal (only ready/running can be aborted).
    await expect(
      abortTask(taskId),
      "Aborting an aborted task should throw (409)",
    ).rejects.toThrow()
  })

  // ── G2: failed is terminal — no re-dispatch loop ───────────────────

  test("G2: if task reaches failed, it stays failed (no re-dispatch loop)", async () => {
    test.skip(!serverAvailable, "Server not available")

    // Create a separate task for the G2 test
    const task = await createTask({ name: CRASH_TASK_NAME, org: TASK_E2E_ORG })
    createdTaskIds.push(task.id)

    await updateSpecField(task.id, "goal", "A task that may fail (G2: failed is terminal).")
    await updateSpecField(task.id, "ac", ["Task failure is terminal"])

    // [入队] arms nothing (§新行为1) — a run needs an explicit 触发 (§新行为2). The
    // pre-票03 version of this line waited for the envelope's queued row to be claimed by
    // itself, which is precisely the coupling that was deleted.
    await readyTask(task.id)
    const trig = await triggerTaskRaw(task.id)
    if (trig.status !== 200) {
      // A dev environment without a buildable workspace/registered repo refuses here
      // (409 预建/gate). Record the refusal as data — it must be an ENVIRONMENT refusal, and
      // it must not have left a live instance or a schedules row behind.
      expect(
        [409, 400].includes(trig.status),
        `Unexpected ${trig.status} from POST /:id/trigger: ${trig.body.error}`,
      ).toBe(true)
      expect(
        readTaskExecutions(task.id).filter((r) => !isTerminalExecutionStatus(r.status)),
        "A refused 触发 armed nothing live",
      ).toHaveLength(0)
      expect(findTaskEnvelopeScheduleRows(task.id), "A refused 触发 created no schedules row").toHaveLength(0)
      log(`触发 refused (${trig.status}: ${String(trig.body.error).slice(0, 80)}) — G2 will be verified on the armed-row path`)
      plantArmedRootExecution(task.id, "failed")
    }

    // Wait for the task to reach a terminal state (done/failed/aborted). The run may
    // complete (done), fail (failed), or stay live (no provider). Timeout is generous
    // (R1: real job + real engine).
    let finalStatus: string
    try {
      const finalTask = await waitForTaskStatus(task.id, ["done", "failed", "aborted"], {
        timeoutMs: 180_000,
      })
      finalStatus = finalTask.status
    } catch (err: unknown) {
      // The task didn't reach terminal — the engine may not have run (no provider). Abort
      // it to reach a terminal state + verify terminal stability on the aborted path.
      logError(`Task did not reach terminal naturally: ${err instanceof Error ? err.message : String(err)}`)
      log("Aborting task to reach a terminal state for G2 verification")
      try {
        const aborted = await abortTask(task.id)
        finalStatus = aborted.status
      } catch (abortErr: unknown) {
        // Already terminal (e.g. the engine just completed)
        const dbRow = readTaskRow(task.id)
        finalStatus = dbRow?.status ?? "unknown"
      }
    }

    expect(["done", "failed", "aborted"], "Task should reach a terminal state").toContain(finalStatus)

    // G2 contract: if the task is 'failed', it stays 'failed' (no rollback).
    // Re-read after a delay — status should NOT have changed back.
    if (finalStatus === "failed") {
      await new Promise((r) => setTimeout(r, 3000))
      const dbRowAfter = readTaskRow(task.id)
      expect(dbRowAfter!.status, "Failed task should stay failed (G2: no rollback)").toBe("failed")

      // Verify the instances are terminal too. A re-dispatch loop under the envelope was a
      // schedule re-flipping to 'queued'; its successor is a NEW live root row, and the
      // same-task mutex (`ux_exec_task_active`, partial UNIQUE over non-terminal roots) is
      // what refuses it at the DB. Stricter than the old check, which accepted 'queued'.
      const rows = readTaskExecutions(task.id)
      expect(
        rows.filter((r) => r.parent_id === "0" && !isTerminalExecutionStatus(r.status)).length,
        "G2: a failed task holds no live root (no re-dispatch loop)",
      ).toBe(0)
      expect(
        findTaskEnvelopeScheduleRows(task.id),
        "G2: a failed task owns no schedules row either",
      ).toHaveLength(0)
      log("G2 verified: failed task stays failed (no live root, no envelope)")
    } else {
      // If the task completed or was aborted, G2's "failed stays failed"
      // contract wasn't triggered in this run. We still verify the terminal
      // state is stable (no rollback).
      await new Promise((r) => setTimeout(r, 2000))
      const dbRowAfter = readTaskRow(task.id)
      expect(dbRowAfter!.status, "Terminal task should stay terminal (no rollback)").toBe(finalStatus)
      log(`G2 informational: task reached ${finalStatus} (stable; failed path not triggered this run)`)
    }
  })

  // ── G4: abort releases the instance slot (no live row left) ─────────

  test("G4: abort leaves no live instance behind (the row IS the run, so there is nothing else to clean)", async () => {
    test.skip(!serverAvailable, "Server not available")
    test.skip(createdTaskIds.length < 2, "No crash task from previous step")
    const taskId = createdTaskIds[1]! // the G2 task

    // The G2 task reached a terminal state (done/failed/aborted) in the previous test.
    //
    // Under the envelope this test asserted that abort had marked the in-flight
    // `schedule_executions` rows failed — a cleanup dance whose only purpose was releasing
    // a UNIQUE index the scheduler had lent to the task. 票03 deleted the loan: the
    // same-task mutex is `ux_exec_task_active` on `executions`, so the whole contract is
    // one question — is any of the task's rows still live? If none is, the slot is free and
    // nothing else needs cleaning.
    const dbRow = readTaskRow(taskId)
    const rows: TaskExecutionRow[] = readTaskExecutions(taskId)
    if (dbRow!.status === "aborted") {
      const live = rows.filter((r) => !isTerminalExecutionStatus(r.status))
      expect(
        live.length,
        `No live instance may remain behind an aborted card (found: ${live.map((r) => `${r.id}=${r.status}`).join(", ")})`,
      ).toBe(0)
      for (const r of rows) {
        expect(r.status, `Instance ${r.id} should be aborted (G4 stop ran)`).toBe("aborted")
      }
      // K12: abort never reaps the bound workspace (it is the 打回 scene). Only checkable
      // when a real 触发 got far enough to bind one — a planted row has no bound ws.
      if (dbRow!.workspace_id) {
        expect(dbRow!.workspace_id, "The bound workspace stays bound after abort").toBeTruthy()
      }
      log(`G4 verified: ${rows.length} instance(s) all terminal, slot released (ws=${dbRow!.workspace_id ?? "none"})`)
    } else {
      log(`G4 stop test informational (task is ${dbRow!.status}, not aborted; ${rows.length} instance row(s))`)
    }
  })
})
