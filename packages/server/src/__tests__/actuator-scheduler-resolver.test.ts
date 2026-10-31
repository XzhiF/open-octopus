import { describe, it, expect, afterEach } from "vitest"
import { SchedulerResolver } from "../services/actuator/scheduler-resolver"
import type { SchedulerService } from "../services/scheduler/scheduler-service"
import type { SchedulerEngine } from "../services/scheduler/scheduler-engine"
import type { ScheduleRunDAO } from "../db/dao/schedule-run-dao"

// Regression guard for the actuator scheduler endpoint's observed lies:
//   A) engine assembled after the actuator captured a null reference → lazy global read
//   B) listJobs paginates via `items`, not `rows` (rows: undefined ⇒ always zero counts)
//   C) enriched jobs carry `enabled` as boolean, not 0/1
//   D) enriched `config` is an object (v1 `workflow_ref` / v2+ `workflow_chain[0]`), not JSON text

const G = global as { __octopus_scheduler?: unknown }

function serviceWith(items: unknown[]): SchedulerService {
  return { listJobs: () => ({ items, total: items.length, page: 1, limit: 100 }) } as unknown as SchedulerService
}
const dao = { getTodayStats: () => ({ total: 99, failed: 3 }) } as unknown as ScheduleRunDAO
const engine = (state: "open" | "closed" | "half-open" = "closed") =>
  ({ getCircuitBreakerSummary: () => ({ state }) }) as unknown as SchedulerEngine

function job(over: Record<string, unknown>) {
  return {
    id: "j1",
    name: "job",
    enabled: true,
    next_trigger_at: null as string | null,
    cron_expression: "* * * * *",
    config: null as unknown,
    ...over,
  }
}

afterEach(() => {
  delete G.__octopus_scheduler
})

describe("SchedulerResolver", () => {
  it("disabled only when neither the injected nor the globally-bound engine exists", () => {
    delete G.__octopus_scheduler
    const r = new SchedulerResolver(serviceWith([]), null, dao)
    expect(r.getScheduler().status).toBe("disabled")
  })

  it("lazy global fallback picks up the later-assembled engine (A)", () => {
    G.__octopus_scheduler = engine()
    const r = new SchedulerResolver(serviceWith([]), null, dao)
    const res = r.getScheduler()
    expect(res.status).toBe("ok")
    expect(res.total_executions_today).toBe(99)
  })

  it("counts active/paused from `items` and lists only enabled next fires (B, C)", () => {
    G.__octopus_scheduler = engine()
    const r = new SchedulerResolver(
      serviceWith([
        job({ id: "a", enabled: true, next_trigger_at: "2026-01-01T00:01:00Z" }),
        job({ id: "b", enabled: false, next_trigger_at: "2026-01-01T00:02:00Z" }),
      ]),
      null,
      dao,
    )
    const res = r.getScheduler()
    expect(res.active_jobs).toBe(1)
    expect(res.paused_jobs).toBe(1)
    expect(res.next_fires.map((j) => j.job_id)).toEqual(["a"])
  })

  it("derives workflow_name from object configs without throwing (D)", () => {
    G.__octopus_scheduler = engine()
    const r = new SchedulerResolver(
      serviceWith([
        job({ id: "v1", next_trigger_at: "2026-01-01T00:01:00Z", config: { schema_version: "1.0", type: "workflow", workflow_ref: "flows/legacy.yaml" } }),
        job({ id: "v2", next_trigger_at: "2026-01-01T00:02:00Z", config: { schema_version: "2.0", type: "workflow", workflow_chain: [{ workflow_ref: "flows/chain.yaml" }] } }),
        job({ id: "agent", next_trigger_at: "2026-01-01T00:03:00Z", config: { schema_version: "1.0", type: "agent", prompt: "p" } }),
      ]),
      null,
      dao,
    )
    const res = r.getScheduler()
    expect(res.status).toBe("ok")
    expect(res.next_fires.map((j) => [j.job_id, j.workflow_name])).toEqual([
      ["v1", "flows/legacy.yaml"],
      ["v2", "flows/chain.yaml"],
      ["agent", "job"],
    ])
  })

  it("open circuit breaker → degraded", () => {
    G.__octopus_scheduler = engine("open")
    const r = new SchedulerResolver(serviceWith([]), null, dao)
    const res = r.getScheduler()
    expect(res.status).toBe("degraded")
    expect(res.circuit_broken_jobs).toBe(1)
  })
})