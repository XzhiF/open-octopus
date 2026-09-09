import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import { parseExpression } from "cron-parser"
import { applySchema } from "../../../db/schema"
import { ScheduleConfigDAO } from "../../../db/dao/schedule-config-dao"
import {
  BUILTIN_CODE_JOBS,
  TASK_LIFECYCLE_HANDLER,
  builtinJobId,
  seedBuiltinCodeJobs,
  registerAndSeedBuiltinCodeJobs,
  taskLifecycleHandler,
} from "../builtin-jobs"
import {
  resolveCodeJobHandler,
  resetCodeJobHandlerRegistry,
  listCodeJobHandlers,
} from "../code-job-registry"
import type { CodeJobConfig } from "@octopus/shared"

/**
 * 票02 (ADR-0021) — the built-in `job` rows.
 *
 * A built-in job is a normal schedule row that happens to be system-owned, so seeding it
 * has two obligations that a hand-made row doesn't: it must be idempotent across restarts
 * (the pump re-seeds on every boot), and it must never steamroll what a human changed on
 * it. Everything else here is "does the row describe something the pump can actually
 * run".
 */

let db: Database.Database
let dao: ScheduleConfigDAO
let dbPath: string

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `test-builtin-jobs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`)
  db = new Database(dbPath)
  db.pragma("foreign_keys = ON")
  applySchema(db)
  dao = new ScheduleConfigDAO(db)
  resetCodeJobHandlerRegistry()
})

afterEach(() => {
  resetCodeJobHandlerRegistry()
  db.close()
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath)
})

function row(id: string) {
  return dao.findByIdRaw(id)
}

function configOf(id: string): CodeJobConfig {
  return JSON.parse(row(id)!.config) as CodeJobConfig
}

describe("seedBuiltinCodeJobs", () => {
  it("creates one row per built-in job, keyed deterministically by handler", () => {
    const res = seedBuiltinCodeJobs(dao, "xzf")
    expect(res.created).toEqual([builtinJobId(TASK_LIFECYCLE_HANDLER)])
    expect(res.repaired).toEqual([])
    const r = row(builtinJobId(TASK_LIFECYCLE_HANDLER))!
    expect(r.job_type).toBe("job")
    expect(r.org).toBe("xzf")
    expect(configOf(builtinJobId(TASK_LIFECYCLE_HANDLER)).handler).toBe(TASK_LIFECYCLE_HANDLER)
    expect(BUILTIN_CODE_JOBS.length).toBeGreaterThan(0)
  })

  it("is idempotent — a second boot creates nothing", () => {
    seedBuiltinCodeJobs(dao)
    const again = seedBuiltinCodeJobs(dao)
    expect(again.created).toEqual([])
    expect(again.untouched).toEqual([builtinJobId(TASK_LIFECYCLE_HANDLER)])
    const count = (db.prepare("SELECT COUNT(*) AS c FROM schedules WHERE job_type='job'").get() as { c: number }).c
    expect(count).toBe(1)
  })

  it("repairs a row whose handler pointer or job_type was clobbered", () => {
    const id = builtinJobId(TASK_LIFECYCLE_HANDLER)
    seedBuiltinCodeJobs(dao)
    db.prepare("UPDATE schedules SET job_type='workflow', config='{}' WHERE id=?").run(id)

    const res = seedBuiltinCodeJobs(dao)
    expect(res.repaired).toEqual([id])
    expect(res.created).toEqual([])
    expect(row(id)!.job_type).toBe("job")
    expect(configOf(id).handler).toBe(TASK_LIFECYCLE_HANDLER)
  })

  it("respects what a human changed: enabled and cadence are never rolled back", () => {
    const id = builtinJobId(TASK_LIFECYCLE_HANDLER)
    seedBuiltinCodeJobs(dao)
    // Seeded OFF (票03 opens it); a user turns it on and re-tunes the cadence.
    db.prepare("UPDATE schedules SET enabled=1, cron_expression='*/5 * * * *', timeout_seconds=60 WHERE id=?").run(id)

    const res = seedBuiltinCodeJobs(dao)
    expect(res).toEqual({ created: [], repaired: [], untouched: [id] })
    const r = row(id)!
    expect(r.enabled).toBe(1)
    expect(r.cron_expression).toBe("*/5 * * * *")
    expect(r.timeout_seconds).toBe(60)
  })

  it("every built-in job's cron expression parses in its own timezone", () => {
    seedBuiltinCodeJobs(dao)
    for (const job of BUILTIN_CODE_JOBS) {
      const r = row(builtinJobId(job.handler))!
      expect(() => parseExpression(r.cron_expression, { tz: r.timezone }).next()).not.toThrow()
    }
  })

  it("starts disabled, so landing the skeleton cannot change behavior before 票03", () => {
    seedBuiltinCodeJobs(dao)
    for (const job of BUILTIN_CODE_JOBS) {
      expect(row(builtinJobId(job.handler))!.enabled).toBe(0)
    }
  })
})

describe("the built-in task-lifecycle handler", () => {
  it("is registered under exactly the name the seeded row points at", async () => {
    registerAndSeedBuiltinCodeJobs(dao)
    const id = builtinJobId(TASK_LIFECYCLE_HANDLER)
    expect(listCodeJobHandlers()).toContain(configOf(id).handler)
    expect(resolveCodeJobHandler(TASK_LIFECYCLE_HANDLER)).toBe(taskLifecycleHandler)
  })

  it("re-registering on a later boot does not throw (same function tolerated)", () => {
    registerAndSeedBuiltinCodeJobs(dao)
    expect(() => registerAndSeedBuiltinCodeJobs(dao)).not.toThrow()
    expect((db.prepare("SELECT COUNT(*) AS c FROM schedules WHERE job_type='job'").get() as { c: number }).c).toBe(1)
  })

  it("says plainly that it is a placeholder, rather than silently doing nothing", async () => {
    const outcome = await taskLifecycleHandler({
      scheduleId: "s", jobName: "n", org: "", fireId: "f", args: {},
      signal: new AbortController().signal, startedAtMs: Date.now(),
    })
    expect(outcome?.summary).toContain("票03")
    expect(outcome?.metrics).toMatchObject({ armed: 0, started: 0 })
  })
})
