import type { ScheduleConfigDAO } from "../../db/dao"
import { codeJobConfigSchema, type CodeJobConfig } from "@octopus/shared"
import { registerCodeJobHandler, type CodeJobContext, type CodeJobOutcome } from "./code-job-registry"

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
   * Seeded OFF until the handler does real work, so adding a built-in job can never
   * change behavior before its ticket lands. A user enabling it afterwards is respected:
   * the seed only repairs the handler pointer, never `enabled` or the cadence.
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
    // 票03 打开：handler 目前是占位实现，跑起来只会留一条「未实装」记录。
    enabled: 0,
  },
]

export function builtinJobId(handler: string): string {
  return `builtin-${handler}`
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
export async function taskLifecycleHandler(_ctx: CodeJobContext): Promise<CodeJobOutcome> {
  return {
    summary: "task-lifecycle 尚未实装（票03）：本轮不做任何启动/回收",
    metrics: { armed: 0, started: 0, reconciled: 0 },
  }
}

/**
 * Bind built-in handlers and seed their rows. Called once from the composition root
 * (index.ts) before `engine.start()`, so the very first tick sees a consistent pair.
 */
export function registerAndSeedBuiltinCodeJobs(dao: ScheduleConfigDAO, org = ""): SeedResult {
  registerCodeJobHandler(TASK_LIFECYCLE_HANDLER, taskLifecycleHandler)
  return seedBuiltinCodeJobs(dao, org)
}
