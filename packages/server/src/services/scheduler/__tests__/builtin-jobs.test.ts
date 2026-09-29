import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { parseExpression } from "cron-parser"
import { ScheduleConfigDAO } from "../../../db/dao/schedule-config-dao"
import {
  BUILTIN_CODE_JOBS,
  TASK_LIFECYCLE_HANDLER,
  builtinJobId,
  seedBuiltinCodeJobs,
  registerAndSeedBuiltinCodeJobs,
  unboundTaskLifecycleHandler,
} from "../builtin-jobs"
import {
  resolveCodeJobHandler,
  resetCodeJobHandlerRegistry,
  listCodeJobHandlers,
} from "../code-job-registry"
import { describePg, setupPgSchema, type PgFixture } from "../../../db/pg/__tests__/dao-fixture"
import type { CodeJobConfig } from "@octopus/shared"

/**
 * 票02 (ADR-0021) — the built-in `job` rows.
 *
 * A built-in job is a normal schedule row that happens to be system-owned, so seeding it
 * has two obligations that a hand-made row doesn't: it must be idempotent across restarts
 * (the pump re-seeds on every boot), and it must never steamroll what a human changed on
 * it. Everything else here is "does the row describe something the pump can actually
 * run".
 *
 * P1 B5 票4：ScheduleConfigDAO 已迁 BasePgDAO（B5 票1）—— schedules 行落 PG 随机
 * 测试库，DAO 断言全量 async 化；直改 schedules 的裸 sql 走 pg.sql。
 */

describePg("builtin jobs (PG)", () => {
  let pg: PgFixture
  let dao: ScheduleConfigDAO

  beforeEach(async () => {
    pg = await setupPgSchema()
    dao = new ScheduleConfigDAO(pg.sql)
    resetCodeJobHandlerRegistry()
  })

  afterEach(async () => {
    resetCodeJobHandlerRegistry()
    await pg.close()
  })

  async function row(id: string) {
    return await dao.findByIdRaw(id)
  }

  async function configOf(id: string): Promise<CodeJobConfig> {
    return JSON.parse((await row(id))!.config) as CodeJobConfig
  }

  async function jobRowCount(): Promise<number> {
    return Number((await pg.sql`SELECT COUNT(*)::int AS c FROM schedules WHERE job_type='job'`)[0]!.c)
  }

  describe("seedBuiltinCodeJobs", () => {
    it("creates one row per built-in job, keyed deterministically by handler", async () => {
      const res = await seedBuiltinCodeJobs(dao, "xzf")
      expect(res.created).toEqual([builtinJobId(TASK_LIFECYCLE_HANDLER)])
      expect(res.repaired).toEqual([])
      const r = (await row(builtinJobId(TASK_LIFECYCLE_HANDLER)))!
      expect(r.job_type).toBe("job")
      expect(r.org).toBe("xzf")
      expect((await configOf(builtinJobId(TASK_LIFECYCLE_HANDLER))).handler).toBe(TASK_LIFECYCLE_HANDLER)
      expect(BUILTIN_CODE_JOBS.length).toBeGreaterThan(0)
    })

    it("is idempotent — a second boot creates nothing", async () => {
      await seedBuiltinCodeJobs(dao)
      const again = await seedBuiltinCodeJobs(dao)
      expect(again.created).toEqual([])
      expect(again.untouched).toEqual([builtinJobId(TASK_LIFECYCLE_HANDLER)])
      expect(await jobRowCount()).toBe(1)
    })

    it("repairs a row whose handler pointer or job_type was clobbered", async () => {
      const id = builtinJobId(TASK_LIFECYCLE_HANDLER)
      await seedBuiltinCodeJobs(dao)
      await pg.sql`UPDATE schedules SET job_type='workflow', config='{}'::jsonb WHERE id=${id}`

      const res = await seedBuiltinCodeJobs(dao)
      expect(res.repaired).toEqual([id])
      expect(res.created).toEqual([])
      expect((await row(id))!.job_type).toBe("job")
      expect((await configOf(id)).handler).toBe(TASK_LIFECYCLE_HANDLER)
    })

    it("respects what a human changed: enabled and cadence are never rolled back", async () => {
      const id = builtinJobId(TASK_LIFECYCLE_HANDLER)
      await seedBuiltinCodeJobs(dao)
      // The direction that matters after 票03: the job is seeded ON, and an operator who
      // PAUSES it (which pauses every scheduled task start in the system) must stay paused
      // across restarts. A seed that re-armed it would turn a deliberate stop into a lie.
      await pg.sql`
        UPDATE schedules SET enabled=false, cron_expression='*/5 * * * *', timeout_seconds=60 WHERE id=${id}`

      const res = await seedBuiltinCodeJobs(dao)
      expect(res).toEqual({ created: [], repaired: [], untouched: [id] })
      const r = (await row(id))!
      expect(r.enabled).toBe(0)
      expect(r.cron_expression).toBe("*/5 * * * *")
      expect(r.timeout_seconds).toBe(60)
    })

    it("a soft-deleted built-in row comes back — pausing survives, a missing row does not", async () => {
      // The seed repairs nothing else about a deleted row on purpose: every read the pump
      // uses filters deleted_at IS NULL, so "found it, leaving it alone" is "the system's
      // housekeeping never runs again". 票05 also refuses the DELETE at the API; this is the
      // backstop for a row deleted by hand or by an older build.
      await seedBuiltinCodeJobs(dao, "xzf")
      await dao.softDelete(builtinJobId(TASK_LIFECYCLE_HANDLER))
      expect(await dao.findById(builtinJobId(TASK_LIFECYCLE_HANDLER))).toBeNull() // invisible to the pump

      const result = await seedBuiltinCodeJobs(dao, "xzf")
      expect(result.repaired).toContain(builtinJobId(TASK_LIFECYCLE_HANDLER))
      const revived = await dao.findById(builtinJobId(TASK_LIFECYCLE_HANDLER))
      expect(revived).not.toBeNull()
      expect(revived!.job_type).toBe("job")
      // Reviving is not re-tuning: a human's pause still wins over the seed's default.
      await dao.softDelete(builtinJobId(TASK_LIFECYCLE_HANDLER))
      await dao.updateSchedule(builtinJobId(TASK_LIFECYCLE_HANDLER), { enabled: 0 })
      await seedBuiltinCodeJobs(dao, "xzf")
      expect((await dao.findById(builtinJobId(TASK_LIFECYCLE_HANDLER)))!.enabled).toBe(0)
    })

    it("every built-in job's cron expression parses in its own timezone", async () => {
      await seedBuiltinCodeJobs(dao)
      for (const job of BUILTIN_CODE_JOBS) {
        const r = (await row(builtinJobId(job.handler)))!
        expect(() => parseExpression(r.cron_expression, { tz: r.timezone }).next()).not.toThrow()
      }
    })

    it("is seeded ENABLED from 票03 — the handler does the real work now", async () => {
      // 票02 seeded it OFF so a skeleton could not change behavior; 票03 implements the
      // body, so an armed row is what makes 定时启动 work out of the box after a wipe.
      await seedBuiltinCodeJobs(dao)
      for (const job of BUILTIN_CODE_JOBS) {
        expect((await row(builtinJobId(job.handler)))!.enabled).toBe(1)
      }
    })
  })

  describe("the built-in task-lifecycle handler", () => {
    it("is registered under exactly the name the seeded row points at", async () => {
      await registerAndSeedBuiltinCodeJobs(dao)
      const id = builtinJobId(TASK_LIFECYCLE_HANDLER)
      expect(listCodeJobHandlers()).toContain((await configOf(id)).handler)
      expect(resolveCodeJobHandler(TASK_LIFECYCLE_HANDLER)).toBe(unboundTaskLifecycleHandler)
    })

    it("an injected handler wins, and re-seeding with a fresh closure does not throw", async () => {
      // The composition root binds the real body as a NEW closure each boot; the registry
      // rejects two different functions for one name (a wiring bug), so the built-in seed
      // path rebinds instead. Without that, a second seed in one process would take the
      // scheduler down over a job that is fine.
      const first = async () => ({ summary: "first" })
      const second = async () => ({ summary: "second" })
      await registerAndSeedBuiltinCodeJobs(dao, "", first) // 不得抛 —— 抛出即用例红
      expect(resolveCodeJobHandler(TASK_LIFECYCLE_HANDLER)).toBe(first)
      await registerAndSeedBuiltinCodeJobs(dao, "", second)
      expect(resolveCodeJobHandler(TASK_LIFECYCLE_HANDLER)).toBe(second)
    })

    it("re-registering on a later boot does not throw (same function tolerated)", async () => {
      await registerAndSeedBuiltinCodeJobs(dao)
      await registerAndSeedBuiltinCodeJobs(dao) // 同函数再注册必须容忍（重启形态）
      expect(await jobRowCount()).toBe(1)
    })

    it("the fallback says plainly that nothing is wired, rather than silently doing nothing", async () => {
      const outcome = await unboundTaskLifecycleHandler({
        scheduleId: "s", jobName: "n", org: "", fireId: "f", args: {},
        signal: new AbortController().signal, startedAtMs: Date.now(),
      })
      expect(outcome?.summary).toContain("未接线")
      expect(outcome?.metrics).toMatchObject({ armed: 0, launched: 0 })
    })
  })
})
