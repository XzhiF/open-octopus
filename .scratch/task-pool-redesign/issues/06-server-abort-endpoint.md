# 06 — abort 端点 + workspace 清理

## What to build
server：`POST /api/scheduler/jobs/:id/abort` → `service.abortJob(id)`。guard status in (claimed, running) → `schedules.status='aborted'` + `runDAO.markStaleExecutionsFailed`（释 unique_active）+ ExecutionService.cancel（中止运行 exec）+ `configDAO.markScheduleWorkspacesCleanedBySchedule`。audit log action='aborted'。

## Blocked by
05

## Status
ready-for-agent

## Acceptance Criteria
- [ ] POST /jobs/:id/abort → schedules.status='aborted'
- [ ] unique_active 释放（可重派/不再阻塞）
- [ ] 运行 exec 取消 + ws 标 cleaned
- [ ] 非 claimed/running 状态 abort → 400

## Verification Method
**Type**: integration
**Steps**: dispatch 任务 → POST /abort → SELECT status='aborted' + schedule_executions failed + ws cleaned；abort draft → assert 400。
**Pass**: assert PASS。**Fail**: max 3 then SKIP。
