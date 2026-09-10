import type { ScheduleConfigDAO } from "../../db/dao"
import { codeJobConfigSchema, type CodeJobConfig } from "@octopus/shared"
import {
  rebindCodeJobHandler,
  type CodeJobContext,
  type CodeJobHandler,
  type CodeJobOutcome,
} from "./code-job-registry"

/**
 * Built-in `job`-type schedules (ADR-0021).
 *
 * Each entry is a system duty that used to need its own `setInterval` and now rides the
 * pump like any other job: cron cadence, timezone, `enabled`, timeout, the
 * consecutive-failure backoff, run history in `schedule_executions`, manual trigger from
 * the API, and a row on the ops page.
 *
 * The row id is DETERMINISTIC (`builtin-<handler>`), so "has this been seeded?" is a
 * primary-key lookup — idempotent across restarts with no unique-name dance.
 */
export const TASK_LIFECYCLE_HANDLER = "task-lifecycle"

interface BuiltinCodeJob {
  handler: string
  /** Stable row name shown in the ops page; also the human-facing identifier. */
  name: string
  description: string
  cronExpression: string
  timezone: string
  timeoutSeconds: number
  /**
   * Whether the row is armed at seed time. The seed only ever writes this on CREATE —
   * pausing a built-in job from the ops page survives every later boot.
   */
  enabled: number
}

export const BUILTIN_CODE_JOBS: readonly BuiltinCodeJob[] = [
  {
    handler: TASK_LIFECYCLE_HANDLER,
    name: "系统 · 任务生命周期",
    description: "启动到点的任务、推进 phase/round、回收孤儿与滞留运行（ADR-0021）。停用会暂停全部定时启动。",
    // Every minute. The pump's own aux tick is 60s too, and an armed one-shot task is
    // picked up immediately via wake() — the cron here is the backstop pass, not the
    // latency path.
    cronExpression: "* * * * *",
    timezone: "Asia/Shanghai",
    timeoutSeconds: 300,
    // 票03 起打开：handler 已实装（到点起任务 / 领取 / 对账 / 回收）。关掉这一行等于
    // 暂停全系统的定时启动 —— 描述里写明了，运维页可见。
    enabled: 1,
  },
]

/** Every built-in row's id starts with this — the guard in `deleteJob`/`updateJob` keys on
 *  it, and the web's `isBuiltinJob()` mirrors the same convention. Deterministic ids are
 *  what make the seed idempotent, so they are also what makes "is this one of ours" a
 *  question answerable without a table of special cases. */
export const BUILTIN_JOB_ID_PREFIX = "builtin-"

export function builtinJobId(handler: string): string {
  return `${BUILTIN_JOB_ID_PREFIX}${handler}`
}

export interface SeedResult {
  created: string[]
  repaired: string[]
  untouched: string[]
}

/**
 * Ensure every built-in job row exists and points at its registered handler.
 *
 * Create-if-missing; on conflict it ONLY repairs `job_type`/`config` (a row whose handler
 * pointer got clobbered). `enabled`, `cron_expression`, `timeout_seconds` and
 * `notify_*` are left alone — a user who paused or re-tuned a built-in job stays paused
 * across restarts.
 *
 * A SOFT-DELETED built-in row is repaired too (deleted_at cleared), and that is not a
 * contradiction of the paragraph above: pausing is a user decision about running, deleting
 * a row that the system cannot function without is a broken state. `findByIdRaw` deliberately
 * ignores `deleted_at` while every read the pump uses filters on it — so without this, a
 * DELETE on `builtin-task-lifecycle` (which the API happily served before 票05's guard)
 * leaves the seed reporting "untouched" while no tick ever runs again: every 定时/周期 task
 * silently stops launching, and the recovery is a manual DB edit.
 */
export function seedBuiltinCodeJobs(dao: ScheduleConfigDAO, org = ""): SeedResult {
  const result: SeedResult = { created: [], repaired: [], untouched: [] }

  for (const job of BUILTIN_CODE_JOBS) {
    const id = builtinJobId(job.handler)
    const config: CodeJobConfig = codeJobConfigSchema.parse({
      schema_version: "1.0",
      type: "job",
      handler: job.handler,
      timeout_seconds: job.timeoutSeconds,
      args: {},
    })
    const existing = dao.findByIdRaw(id)

    if (!existing) {
      dao.insertSchedule({
        id,
        org,
        name: job.name,
        cron_expression: job.cronExpression,
        timezone: job.timezone,
        job_type: "job",
        config: JSON.stringify(config),
        enabled: job.enabled,
        timeout_seconds: job.timeoutSeconds,
        parallel_policy: "skip",
        description: job.description,
        next_trigger_at: null,
      })
      result.created.push(id)
      continue
    }

    if (existing.deleted_at) {
      dao.undelete(id)
      // Re-point the row as well: a deleted-then-revived row is also the case where a
      // hand-edited or clobbered config is most likely, and one UPDATE is cheaper than a
      // second opinion.
      if (existing.job_type !== "job" || parseHandler(existing.config) !== job.handler) {
        dao.updateSchedule(id, { job_type: "job", config: JSON.stringify(config) })
      }
      result.repaired.push(id)
      continue
    }

    const pointsAtTheRightHandler =
      existing.job_type === "job" && parseHandler(existing.config) === job.handler
    if (!pointsAtTheRightHandler) {
      dao.updateSchedule(id, { job_type: "job", config: JSON.stringify(config) })
      result.repaired.push(id)
      continue
    }
    result.untouched.push(id)
  }

  return result
}

function parseHandler(config: string | null | undefined): string | null {
  if (!config) return null
  try {
    const parsed = JSON.parse(config) as { handler?: unknown }
    return typeof parsed.handler === "string" ? parsed.handler : null
  } catch {
    return null
  }
}

/**
 * The task-lifecycle handler.
 *
 * Placeholder by design until 票03, which moves the whole task-launch path here: due-scan
 * `tasks.next_fire_at` → arm `executions(task_id, status='pending')` → claim under the
 * concurrency cap → create/reuse workspace → start the engine → advance phase/round,
 * derive `awaiting_review`, seed/collect artifacts, and reconcile orphans + stranded
 * rows. It is registered NOW so the pump can route a `job` row end-to-end and so the
 * built-in row never resolves to a missing handler; enabling it deliberately says so
 * instead of pretending to work.
 */
/** The handler a `job` row points at until the composition root binds the real one.
 *  Loud on purpose: a system duty that silently does nothing is worse than one that
 *  reports it is not wired. */
export async function unboundTaskLifecycleHandler(_ctx: CodeJobContext): Promise<CodeJobOutcome> {
  return {
    summary: "task-lifecycle 未接线（composition root 未注册 handler）：本轮不做任何启动/回收",
    metrics: { armed: 0, launched: 0, reconciled: 0 },
  }
}

/**
 * Bind built-in handlers and seed their rows. Called once from the composition root
 * (index.ts) before `engine.start()`, so the very first tick sees a consistent pair.
 */
/**
 * Bind built-in handlers and seed their rows.
 *
 * `taskLifecycle` is INJECTED rather than imported: the real body lives in the task
 * domain (`services/tasks/task-lifecycle-service.ts`), and the scheduler must not import
 * task code — the direction that used to be the coupling. The composition root hands the
 * service's tick over here, which keeps the one bridge in exactly one place: a `job` row
 * names a handler, the handler is whatever the root decided to bind.
 *
 * Without it the row still seeds and still fires, and reports that nothing is wired
 * rather than pretending to work.
 */
export function registerAndSeedBuiltinCodeJobs(
  dao: ScheduleConfigDAO,
  org = "",
  taskLifecycle?: CodeJobHandler,
): SeedResult {
  rebindCodeJobHandler(TASK_LIFECYCLE_HANDLER, taskLifecycle ?? unboundTaskLifecycleHandler)
  return seedBuiltinCodeJobs(dao, org)
}
