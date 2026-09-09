/**
 * Code-job handler registry (ADR-0021) — the `job` job type.
 *
 * A `job` schedule row stores nothing but a handler NAME; the executable is TypeScript
 * that is already in this process. That direction matters for safety: editing a schedule
 * row through the API can retarget *which* registered handler runs and with what args,
 * but it can never introduce code the deployment didn't ship — an unregistered handler
 * name fails the run rather than running anything.
 *
 * This is also where the system stops scattering `setInterval` for its own housekeeping.
 * A periodic internal duty becomes a registered handler + a seeded schedule row, and it
 * then inherits everything the pump already does for jobs: cron cadence, timezone,
 * `enabled`, timeout, consecutive-failure backoff, run history in schedule_executions,
 * manual trigger, and visibility on the ops page.
 */

/** What a handler may rely on. Deliberately narrow: a handler gets an arm, not the engine. */
export interface CodeJobContext {
  /** The schedule row being fired. */
  scheduleId: string
  jobName: string
  org: string
  /** `schedule_executions.id` for THIS fire — the correlation key for anything recorded. */
  fireId: string
  /** Opaque per-handler config from the schedule's `config.args`. */
  args: Record<string, unknown>
  /** Aborted when the job's timeout elapses. Long handlers must check it to bail early. */
  signal: AbortSignal
  /** Epoch ms at which this fire began. */
  startedAtMs: number
}

export interface CodeJobOutcome {
  /** One-line result persisted to `agent_output` so the ops page shows what happened. */
  summary?: string
  /** Optional counters, JSON-persisted alongside the summary (runs started, orphans reaped…). */
  metrics?: Record<string, number>
}

export type CodeJobHandler = (ctx: CodeJobContext) => Promise<CodeJobOutcome | void>

export class UnknownCodeJobHandlerError extends Error {
  override readonly name = "UnknownCodeJobHandlerError"
  constructor(readonly handler: string, readonly registered: string[]) {
    super(`未注册的 job handler: ${handler}（已注册: ${registered.join(", ") || "无"}）`)
  }
}

export class DuplicateCodeJobHandlerError extends Error {
  override readonly name = "DuplicateCodeJobHandlerError"
  constructor(readonly handler: string) {
    super(`job handler 重复注册: ${handler}`)
  }
}

const registry = new Map<string, CodeJobHandler>()

/**
 * Bind a name to an in-process handler. Boot-time only (called from the composition
 * root), so a second binding of the same name to a *different* function is a wiring bug
 * and throws — re-registering the identical function is a no-op so hot-reload / test
 * setup can't trip over it.
 */
export function registerCodeJobHandler(name: string, handler: CodeJobHandler): void {
  const existing = registry.get(name)
  if (existing && existing !== handler) throw new DuplicateCodeJobHandlerError(name)
  registry.set(name, handler)
}

export function resolveCodeJobHandler(name: string): CodeJobHandler {
  const handler = registry.get(name)
  if (!handler) throw new UnknownCodeJobHandlerError(name, listCodeJobHandlers())
  return handler
}

export function hasCodeJobHandler(name: string): boolean {
  return registry.has(name)
}

/** Names currently bound — the ops page's "what can a job row point at" list. */
export function listCodeJobHandlers(): string[] {
  return [...registry.keys()].sort()
}

/** Test seam only: production wiring registers once at boot. */
export function resetCodeJobHandlerRegistry(): void {
  registry.clear()
}
