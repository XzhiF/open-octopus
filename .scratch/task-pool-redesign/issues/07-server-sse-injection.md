# 07 — SSE 注入 SchedulerEngine + 全转换点 emit

## What to build
server：SchedulerEngine 构造注入 `sse: SSEService`（现 constructor 无此依赖，workflow-executor.ts:51 有）。在所有状态转换点 emit `sse.emit('taskpool',{event:'schedule_status',data:{schedule_id,status}})`：checkQueuedTasks(claimed)、enqueueJob(queued)、checkStaleClaimed(rollback→queued)、abortJob(aborted)、handleChainComplete(failed + done 已有)。composite 父+各子都 emit。

## Blocked by
05

## Status
done

## Acceptance Criteria
- [ ] SchedulerEngine 构造含 SSEService
- [ ] queued/claimed/rollback/abort/failed 全 emit schedule_status（done/running 已有）
- [ ] composite 父 + 各子 schedule_status 都 emit
- [ ] UI SSE 订阅收到（不再只靠 10s 轮询）

## Verification Method
**Type**: integration
**Steps**: dispatch → 监听 SSE channel 'taskpool' → assert queued/claimed/running/done 事件；stale rollback → assert rollback→queued 事件；abort → assert aborted 事件。
**Pass**: assert 各事件收到。**Fail**: max 3 then SKIP。

## Exploration

### Analog studied
`WorkflowExecutor` (packages/server/src/services/scheduler/executors/workflow-executor.ts) — the precedent for how an SSE-dependent scheduler component receives `SSEService`. Ticket 05 already wired `running`/`done`/`failed`(handleChainComplete) emits there via `this.sse.emit('taskpool', { event: 'schedule_status', data: { schedule_id, status } })`. Ticket 07 mirrors that exact emit shape in `scheduler-engine.ts` + `scheduler-service.ts`.

### SSEService API (packages/server/src/services/sse.ts)
- `emit(workspaceId: string, event: { event: string; data: unknown }): void` — delivers to subscribers of `workspaceId` channel + pushes to ring buffer.
- `subscribe(workspaceId, listener): () => void` — the `'taskpool'` channel is the global schedule-status channel (events.ts:36 `taskpoolEventRoutes`).
- Emit shape used everywhere: `{ event: 'schedule_status', data: { schedule_id, status } }`.

### Files needing modification (all in scope)
1. `packages/server/src/services/scheduler/scheduler-engine.ts`
   - Constructor (88-97): add `sse?: SSEService` param + `private sse?` field. Import `SSEService`.
   - `checkQueuedTasks` claim (450-453): emit `'claimed'` right after `updateSchedule({status:'claimed'})`.
   - `checkQueuedTasks` catch rollback (467-470): emit `'queued'` (real claimed→queued transition, "ALL lifecycle transitions").
   - `checkStaleClaimed` rollback (488-491): emit `'queued'`.
   - `onExecutionComplete` retry-cap (374-382): emit `'failed'` — **ticket 05 explicitly deferred this emit to 07** (comment at 372-373).
2. `packages/server/src/services/scheduler/scheduler-service.ts`
   - Constructor (227-230): add `sse?: SSEService` param + field. Import `SSEService`.
   - `enqueueJob` (after transaction, ~596): emit `'queued'`.
   - `abortJob` (after transaction, replacing the 633 marker comment): emit `'aborted'`.
3. `packages/server/src/index.ts` (boot-construction sites — pass the `sse` singleton from line 186):
   - Line 373: `new SchedulerService(d.scheduleConfig, d.scheduleRun, sse)`.
   - Line 668: `new SchedulerService(daos!.scheduleConfig, daos!.scheduleRun, sse)`.
   - Line 690: `new SchedulerEngine(daos!.scheduleConfig, daos!.scheduleRun, scheduleService, executors, sse)`.

### Design decision: optional `sse?` param (NOT required positional)
~15 test call sites construct `new SchedulerService(a,b)` / `new SchedulerEngine(a,b,c,d)` across files owned by OTHER tickets (t1/t3/t5/t8, scheduler-engine.test.ts, scheduler-service.test.ts, scheduler-routes.test.ts, t5-crash-recovery-concurrency.test.ts, t3-enqueue-tick-execution.test.ts, t8-claimed-transition.test.ts, scheduler-executors.test.ts). Making `sse` required positional would break all of them and force editing other tickets' files (a scope violation). Decision: **optional** `sse?: SSEService`, every emit guarded with `this.sse?.emit(...)`. Production (index.ts) always passes the real `sse`; tests that don't assert emits stay green unchanged; my new 07 test passes a real `SSEService` and asserts emits. This follows the injection precedent without the breakage.

### Functions chosen
- Use `this.sse?.emit('taskpool', { event: 'schedule_status', data: { schedule_id, status } })` — the exact emit shape WorkflowExecutor (05) established. Do NOT use `emitToAll` (would spam workspace channels); the `'taskpool'` channel is the dedicated global channel for schedule status (events.ts:36).

### Emits NOT added (read-only verification, 05 owns workflow-executor.ts)
- `running` (workflow-executor.ts:257-261), `done` (360-363), `failed` in handleChainComplete (397-401) — already present, left untouched.

### Test seam
Public `SchedulerService` methods (`enqueueJob`, `abortJob`) + `SchedulerEngine.checkQueuedTasks`/`checkStaleClaimed` (via private-method cast, t8 precedent) + a real `SSEService` subscribed to `'taskpool'`. Asserts both DB state (anti-fake-run R3/R4) AND SSE events.
