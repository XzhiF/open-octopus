# 03 — server: tasks service + /api/tasks routes

## What to build
`@octopus/server` tasks service + routes：`POST/GET/GET/:id/PUT/DELETE /api/tasks`、`POST /:id/spec-field`(update_task_spec_field 工具端点→emit spec_field_update)、`POST /:id/ready`(draft→ready+dispatch seam 建 schedules envelope origin_type=task)、`POST /:id/abort`(running→aborted+ws 清理)、`GET /events` SSE(task_status+spec_field_update)。dispatch seam：简单=1 schedule(role=primary,status=queued,config=materialize drop task_spec)；复合=coordinator+composition-task+task_dispatch N 子。ScheduleStatusListener 注入 SchedulerEngine（schedule→tasks.status + task_status SSE）。

## Blocked by
02 (DB schema)

## Status
done

## Acceptance Criteria
- [x] AC1: /api/tasks CRUD + spec-field + ready + abort 端点工作
- [x] AC2: dispatch seam ready→建 schedules envelope（简单 1 schedule role=primary；复合 coordinator+N 子 role=subunit）
- [x] AC3: ScheduleStatusListener：schedule 转换→tasks.status（queued/claimed→running, done→done, failed→failed, aborted→aborted）+ emit task_status SSE
- [x] AC4: abort→aborted+ws 清理（v1 G4）

## Verification Method
**integration**: curl POST /tasks + POST /ready → DB 断 tasks.status=ready + schedules(origin_type=task,status=queued) 存在；mock schedule 转换 → tasks.status 镜像 + SSE 收到。Pass: 全转换点镜像+SSE。

## Exploration

### Analog studied
`/api/scheduler` routes + `SchedulerService` (scheduler-service.ts) + `SchedulerEngine` (scheduler-engine.ts) — the closest existing feature. The task domain mirrors the scheduler job lifecycle (create/enqueue/abort + SSE emits).

### Files needing modification / creation
- **NEW** `packages/server/src/services/scheduler/schedule-status-listener.ts` — `TaskScheduleStatusListener` impl (SG2). Constructor: TaskDAO + ScheduleConfigDAO + SSEService. `onScheduleTransition` self-filters origin_type='task', maps ScheduleStatus→TaskStatus (queued/claimed/running→running, done→done, failed→failed, aborted→aborted), direct UPDATE tasks.status via `taskDAO.getDb()` (NO version bump — status mirrors are system events, not spec edits; version tracks spec/resource changes), emits `task_status` SSE on taskpool channel.
- **NEW** `packages/server/src/services/tasks/tasks-service.ts` — `TasksService` (create/get/list/update/delete/updateSpecField/ready/abort). Uses TaskDAO + ScheduleConfigDAO + SSEService. Dispatch seam calls exported `materializeTaskSpecToConfig`.
- **NEW** `packages/server/src/routes/tasks.ts` — `createTasksRoutes(service, sse)` factory: POST/GET/GET:id/PUT/DELETE, POST /:id/spec-field, POST /:id/ready, POST /:id/abort, GET /events (SSE on taskpool channel).
- **MODIFY** `packages/server/src/services/scheduler/scheduler-service.ts` — (a) `export` `materializeTaskSpecToConfig` (one line, SG5 export — boundary-allowed); (b) add optional 4th ctor arg `scheduleStatusListener?` + call in `emitScheduleStatus` (abort→aborted, enqueue→queued). Body of materializeTaskSpecToConfig UNTOUCHED (06 does SG5 body: drop task_spec + subunit_count).
- **MODIFY** `packages/server/src/services/scheduler/scheduler-engine.ts` — add optional 6th ctor arg `scheduleStatusListener?`; call in `emitScheduleStatus` (claim→claimed, rollback→queued, retry-cap→failed). Fetch schedule row via `findByIdRaw` to pass origin_type/origin_id. trigger_source gates UNMIGRATED (06 does SG1).
- **MODIFY** `packages/server/src/services/scheduler/executors/workflow-executor.ts` — add optional ctor arg `scheduleStatusListener?`; call at the 3 emit sites (running@283, done/failed@402, failed@439) passing `schedule.origin_type/origin_id`. NOT touching the `isRequirement` gate (06 migrates it); listener self-filters by origin_type.
- **MODIFY** `packages/server/src/index.ts` — wire TasksService + createTasksRoutes + listener injection (engine/service/executor). Mount `/api/tasks` + `/api/tasks/events`.
- **NEW** `packages/server/src/__tests__/tasks-routes.test.ts` — integration: create draft, spec-field→SSE, ready→schedules envelope, abort, listener mock-transition mirror.

### Functions chosen
- `materializeTaskSpecToConfig` (scheduler-service.ts:154) — call from dispatch seam (after adding `export`). Do NOT use `isCompositeTaskSpec` for the simple/composite decision in the seam — use my own `subunits.length >= 2` (SG9; the body's `!!subunits?.length` threshold is 06's to change). The 1-subunit edge case is avoided in tests (use 0 or 2+ subunits).
- `TaskDAO.updateWithVersion` — for spec-field + PUT (optimistic concurrency, 409 on stale).
- `TaskDAO.getDb()` (from BaseDAO) — for direct status-only UPDATE in the listener (no version bump; status mirrors are system events).
- `ScheduleConfigDAO.findSchedulesByOrigin('task', task.id)` (02) — for GET /:id children, cascade-reap on delete, abort ws cleanup.
- `ScheduleConfigDAO.insertSchedule` — dispatch seam creates the schedules envelope (origin_type='task', origin_role='primary'|'coordinator', status='queued').
- `SchedulerService.abortJob` — delegate running-schedule cleanup in task abort (G4 ws cleanup, already implements markStaleExecutionsFailed + markScheduleWorkspacesCleanedBySchedule + cancel execution).
- `AgentSessionDAO.updateSession(id, { scope_id: task.id })` — POST /tasks links the bound chat session (SG3 API part; the autosave-seam writer is 04's job).
