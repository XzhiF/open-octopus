import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import type { SchedulerJob } from "@octopus/shared"
import { applySchema } from "../../../db/schema"
import { ScheduleRunDAO } from "../../../db/dao/schedule-run-dao"
import { CodeJobExecutor } from "../executors/code-job-executor"
import {
  registerCodeJobHandler,
  resolveCodeJobHandler,
  hasCodeJobHandler,
  listCodeJobHandlers,
  resetCodeJobHandlerRegistry,
  UnknownCodeJobHandlerError,
  DuplicateCodeJobHandlerError,
  type CodeJobContext,
} from "../code-job-registry"

/**
 * 票02 (ADR-0021) — the `job` job type: a schedule row pointing at a registered
 * TypeScript handler.
 *
 * The load-bearing property is the direction of trust: a schedule row can retarget WHICH
 * registered handler runs and with what args, but it can never make the server execute
 * code the deployment didn't register. So most of these tests are about the failure
 * paths being loud and terminal-written — a job that dies must leave a readable record
 * and must never wedge the pump.
 */

let db: Database.Database
let runDAO: ScheduleRunDAO
let dbPath: string
let fireSeq = 0

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `test-code-job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`)
  db = new Database(dbPath)
  db.pragma("foreign_keys = ON")
  applySchema(db)
  runDAO = new ScheduleRunDAO(db)
  resetCodeJobHandlerRegistry()
  fireSeq = 0
})

afterEach(() => {
  resetCodeJobHandlerRegistry()
  db.close()
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath)
})

function job(overrides: Partial<SchedulerJob> = {}): SchedulerJob {
  return {
    id: "sch-1",
    name: "系统 · 示例 job",
    job_type: "job",
    cron_expression: "* * * * *",
    timezone: "Asia/Shanghai",
    enabled: true,
    org: "xzf",
    config: { schema_version: "1.0", type: "job", handler: "noop", args: {} } as unknown as SchedulerJob["config"],
    parallel_policy: "skip",
    timeout_seconds: 3600,
    notify_on_failure: false,
    max_retain: 10,
    version: 1,
    consecutive_failures: 0,
    next_trigger_at: null,
    deleted_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: "queued",
    trigger_source: "cron",
    source_chat_session_id: null,
    claimed_at: null,
    ...overrides,
  } as SchedulerJob
}

function openFire(scheduleId = "sch-1"): string {
  const id = `fire-${++fireSeq}`
  db.prepare(
    `INSERT INTO schedules (id, org, name, cron_expression, timezone, enabled, job_type, config, created_at, updated_at)
     VALUES (?,?,?,?,?,1,'job','{}',?,?)`,
  ).run(scheduleId, "xzf", `S_${scheduleId}`, "* * * * *", "UTC", "now", "now")
  runDAO.insertTriggeredExecution(id, scheduleId, "scheduled", new Date().toISOString(), "+00:00", "UTC", "scheduler")
  return id
}

function fireRow(id: string): Record<string, unknown> {
  return db.prepare("SELECT * FROM schedule_executions WHERE id=?").get(id) as Record<string, unknown>
}

describe("code-job registry", () => {
  it("resolves a registered handler by name", () => {
    const handler = async () => ({ summary: "did it" })
    registerCodeJobHandler("demo", handler)
    expect(resolveCodeJobHandler("demo")).toBe(handler)
    expect(hasCodeJobHandler("demo")).toBe(true)
    expect(listCodeJobHandlers()).toEqual(["demo"])
  })

  it("tolerates re-registering the SAME function but rejects a different one", () => {
    const handler = async () => {}
    registerCodeJobHandler("demo", handler)
    expect(() => registerCodeJobHandler("demo", handler)).not.toThrow()
    expect(() => registerCodeJobHandler("demo", async () => {})).toThrow(DuplicateCodeJobHandlerError)
  })

  it("names the unknown handler AND what was actually available", () => {
    registerCodeJobHandler("present", async () => {})
    let caught: unknown
    try {
      resolveCodeJobHandler("absent")
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(UnknownCodeJobHandlerError)
    const e = caught as UnknownCodeJobHandlerError
    expect(e.handler).toBe("absent")
    expect(e.registered).toEqual(["present"])
    expect(e.message).toContain("present")
  })
})

describe("CodeJobExecutor — happy path", () => {
  it("runs the handler with the fire's context and records a completed row", async () => {
    const seen: CodeJobContext[] = []
    registerCodeJobHandler("noop", async (ctx) => {
      seen.push(ctx)
      return { summary: "扫了 3 个", metrics: { armed: 3, reaped: 1 } }
    })
    const executor = new CodeJobExecutor(runDAO)
    const fireId = openFire()

    const result = await executor.execute(
      job({ config: { type: "job", handler: "noop", args: { batchSize: 50 } } as unknown as SchedulerJob["config"] }),
      fireId,
    )

    expect(result.success).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.status).toBe("success")
    expect(result.agentOutput).toContain("扫了 3 个")

    expect(seen).toHaveLength(1)
    expect(seen[0].scheduleId).toBe("sch-1")
    expect(seen[0].fireId).toBe(fireId)
    expect(seen[0].org).toBe("xzf")
    expect(seen[0].args).toEqual({ batchSize: 50 })
    expect(seen[0].signal.aborted).toBe(false)

    const row = fireRow(fireId)
    expect(row.status).toBe("completed")
    expect(row.exit_code).toBe(0)
    expect(row.agent_output).toContain("armed=3")
    expect(row.model_used).toBe("job:noop")
    expect(row.completed_at).not.toBeNull()
  })

  it("a void handler still completes", async () => {
    registerCodeJobHandler("quiet", async () => {})
    const fireId = openFire()
    const result = await new CodeJobExecutor(runDAO)
      .execute(job({ config: { type: "job", handler: "quiet" } as unknown as SchedulerJob["config"] }), fireId)
    expect(result.success).toBe(true)
    expect(fireRow(fireId).status).toBe("completed")
  })

  it("getType is 'job' so the pump routes it by job_type", () => {
    expect(new CodeJobExecutor(runDAO).getType()).toBe("job")
  })
})

describe("CodeJobExecutor — failure paths are loud and terminal", () => {
  it("an unregistered handler fails the fire and lists what exists", async () => {
    registerCodeJobHandler("real", async () => {})
    const fireId = openFire()
    const result = await new CodeJobExecutor(runDAO)
      .execute(job({ config: { type: "job", handler: "ghost" } as unknown as SchedulerJob["config"] }), fireId)

    expect(result.success).toBe(false)
    expect(result.errorMessage).toContain("ghost")
    expect(result.errorMessage).toContain("real")
    const row = fireRow(fireId)
    expect(row.status).toBe("failed")
    expect(row.error_summary).toContain("ghost")
  })

  it("a config without a handler is refused, not defaulted to something", async () => {
    const fireId = openFire()
    const result = await new CodeJobExecutor(runDAO)
      .execute(job({ config: { type: "job" } as unknown as SchedulerJob["config"] }), fireId)
    expect(result.success).toBe(false)
    expect(result.errorMessage).toContain("config.handler")
    expect(fireRow(fireId).status).toBe("failed")
  })

  it("a handler that throws fails the fire with its message", async () => {
    registerCodeJobHandler("boom", async () => { throw new Error("磁盘炸了") })
    const fireId = openFire()
    const result = await new CodeJobExecutor(runDAO)
      .execute(job({ config: { type: "job", handler: "boom" } as unknown as SchedulerJob["config"] }), fireId)

    expect(result.success).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.errorMessage).toBe("磁盘炸了")
    expect(fireRow(fireId).status).toBe("failed")
    expect(fireRow(fireId).error_summary).toBe("磁盘炸了")
  })

  it("aborts a hung handler at its deadline and reports a timeout", async () => {
    registerCodeJobHandler("stuck", async (ctx) => {
      // A well-behaved handler bails when signalled; the fire is still a timeout.
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) return resolve()
        ctx.signal.addEventListener("abort", () => resolve(), { once: true })
      })
      return { summary: "unwound" }
    })
    const fireId = openFire()
    const result = await new CodeJobExecutor(runDAO).execute(
      job({ timeout_seconds: 1, config: { type: "job", handler: "stuck" } as unknown as SchedulerJob["config"] }),
      fireId,
    )

    expect(result.success).toBe(false)
    expect(result.status).toBe("timeout")
    expect(result.exitCode).toBe(124)
    expect(fireRow(fireId).exit_code).toBe(124)
    expect(fireRow(fireId).status).toBe("failed")
  }, 15_000)

  it("never leaves a fire in 'running' whatever happens", async () => {
    registerCodeJobHandler("thrower", async () => { throw new Error("x") })
    const fireId = openFire()
    await new CodeJobExecutor(runDAO)
      .execute(job({ config: { type: "job", handler: "thrower" } as unknown as SchedulerJob["config"] }), fireId)
    const statuses = (db.prepare("SELECT status FROM schedule_executions WHERE id=?").get(fireId) as { status: string }).status
    expect(["completed", "failed"]).toContain(statuses)
  })
})
