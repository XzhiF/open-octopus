# 07 — SSE 注入 SchedulerEngine + 全转换点 emit

## What to build
server：SchedulerEngine 构造注入 `sse: SSEService`（现 constructor 无此依赖，workflow-executor.ts:51 有）。在所有状态转换点 emit `sse.emit('taskpool',{event:'schedule_status',data:{schedule_id,status}})`：checkQueuedTasks(claimed)、enqueueJob(queued)、checkStaleClaimed(rollback→queued)、abortJob(aborted)、handleChainComplete(failed + done 已有)。composite 父+各子都 emit。

## Blocked by
05

## Status
ready-for-agent

## Acceptance Criteria
- [ ] SchedulerEngine 构造含 SSEService
- [ ] queued/claimed/rollback/abort/failed 全 emit schedule_status（done/running 已有）
- [ ] composite 父 + 各子 schedule_status 都 emit
- [ ] UI SSE 订阅收到（不再只靠 10s 轮询）

## Verification Method
**Type**: integration
**Steps**: dispatch → 监听 SSE channel 'taskpool' → assert queued/claimed/running/done 事件；stale rollback → assert rollback→queued 事件；abort → assert aborted 事件。
**Pass**: assert 各事件收到。**Fail**: max 3 then SKIP。
