# 05 — failed/aborted 生命周期 writers + buildSchedulerJob cast

## What to build
server：handleChainComplete 失败路径（workflow-executor.ts:372-399 现只标 schedule_executions）→ 加 `schedules.status='failed'` writer。buildSchedulerJob（scheduler-engine.ts:653）cast 扩到全 ScheduleStatus（含 running/done/failed/aborted，不再只 draft/queued/claimed）。

## Blocked by
01

## Status
done

## Acceptance Criteria
- [x] 执行失败 → schedules.status='failed'（非卡 running）
- [x] **failed/aborted 是 terminal：checkStaleClaimed 不回滚 failed/aborted**（否则 stale→重派无限循环，scheduler-engine.ts:413）
- [x] retry cap：连续失败 N 次后停（不再无限重派）
- [x] buildSchedulerJob 返回 running/done/failed/aborted 正确（不丢类型）
- [~] 看板 failed 列能收到 failed 任务 — server-side writer done; kanban column is ticket 12 (web-app)

## Verification Method
**Type**: unit + integration
**Steps**: unit — buildSchedulerJob 各 status assert；integration — 触发执行失败（mock workflow fail）→ SELECT schedules.status='failed' + schedule_executions.status='failed'。
**Pass**: assert PASS。**Fail**: max 3 then SKIP。

## Exploration

### Analog studied
`handleChainComplete` **done path** (workflow-executor.ts:355-364) — already writes
`schedules.status='done'` + `sse.emit('taskpool', {event:'schedule_status',...})`
for `isRequirement` schedules. The `failed` writer mirrors this exactly.

### Files needing modification (all in packages/server, ticket 05-owned)
1. `services/scheduler/executors/workflow-executor.ts` — `handleChainComplete`
   failure branch (lines 372-399): add `schedules.status='failed'` writer +
   SSE emit, gated on `isRequirement` (mirror done path).
2. `services/scheduler/scheduler-engine.ts`:
   - `buildSchedulerJob` (line 653): cast `'draft'|'queued'|'claimed'` → `ScheduleStatus`.
   - `onExecutionComplete` (lines 345-381): retry cap — when
     `failureTracker.recordFailure` returns `autoDisabled` AND
     `trigger_source==='requirement'`, set `status='failed'` (terminal). NO SSE
     here (ticket 07 owns SchedulerEngine SSE injection, blocked by 05).
   - `checkStaleClaimed` (lines 459-479): VERIFIED — `findStaleClaimed` SQL is
     `status IN ('claimed','running')`, so `failed`/`aborted` already excluded
     from rollback. No SQL change; add clarifying comment only.

### Specific functions chosen
- `ScheduleConfigDAO.updateSchedule(id, { status, claimed_at })`
  (schedule-config-dao.ts:105) — generic field setter; reuse for both the
  `failed` writer and the retry-cap terminal promotion. Do NOT use
  `updateScheduleWithVersion` (optimistic-concurrency path, not needed here).
- `ConsecutiveFailureTracker.recordFailure` (consecutive-failure-tracker.ts:25)
  — already returns `{autoDisabled}` after atomic increment + threshold check
  (N=5). Reuse as the retry-cap signal; do NOT add a new retry_count column
  (YAGNI — `consecutive_failures` already IS the retry counter).
- `ScheduleConfigDAO.findQueuedSchedules` / `findStaleClaimed`
  (schedule-config-dao.ts:144, 153) — terminal `failed` is naturally excluded
  by both (`status='queued'` filter; `status IN ('claimed','running')` filter),
  so no query changes needed for the loop-break.

### Key finding (why retry cap is needed even with the failed writer)
The `failed` writer (#1) breaks the **async chain-failure** loop (chain fails →
`handleChainComplete` → `status='failed'` terminal). But the **sync-failure**
loop (createFromSpec throws → `execute()` returns `{success:false}` →
`onExecutionComplete` → `recordFailure` → `status` stays `'claimed'` → stale
rollback → `queued` → re-dispatch → fail again) is NOT broken by #1, because
`onExecutionComplete` never set a terminal `status`, and `autoDisable`
(`enabled=0`) doesn't stop requirement re-dispatch (`findQueuedSchedules`
ignores `enabled`). The retry-cap fix promotes requirement-type schedules to
terminal `failed` exactly when the existing N=5 threshold fires.

### Out of scope (owned by other tickets)
- `SchedulerEngine` SSE injection + all scheduler-engine transition-point emits
  → ticket 07 (G5, blocked by 05).
- abort endpoint + `aborted` writer → ticket 06 (G4).
- routes/scheduler.ts, builtin-clones.ts → ticket 09.
