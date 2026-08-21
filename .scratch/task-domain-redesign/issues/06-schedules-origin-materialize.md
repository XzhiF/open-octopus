# 06 — server: schedules origin 迁移 + materialize + reaper

## What to build
SG1 origin 迁移：`scheduler-engine.ts:379-391`(failed-提升门控→origin_type='task')+`:448`(认领过滤→origin_type IN task/manual/api)+`task-dispatch-service.ts:314`(子创建设 origin_type/origin_role/origin_id，替 trigger_source='requirement')+`TaskDispatchService.dispatchChildSchedule` 重写+`TaskDispatchPort`+origin_role。审计其它 trigger_source 分支。**SG1b（从 02 移交）：REMOVE trigger_source + source_chat_session_id**——schema DROP COLUMN（migrateSchedulesV38）+ ScheduleRow 类型删字段（02 已 ADD origin cols，06 做类型移除+用法迁移**一起**，保 build 绿；这是为何 02 改 additive-only）。SG5 `materializeTaskSpecToConfig` export+输出 drop task_spec+复合注 subunit_count。SG9 isComposite N≥2（1-subunit 走 workflow_chain）。SG10 child running SSE emit。SG16 barrel re-export TaskDispatchService。SG12 孤儿 reaper（定时扫删 schedules WHERE origin_type='task' AND origin_id NOT IN active tasks）。R-INT cascade-reap on task delete。

## Blocked by
02 (DB schema), 03 (tasks service)

## Status
done

## Acceptance Criteria
- [ ] AC1: origin_type='task' schedules 可被 checkQueuedTasks 认领（:448 过滤改）
- [ ] AC2: failed-提升门控 origin_type='task'（:379-391）；agent-origin 默认 auto-disable
- [ ] AC3: dispatchChildSchedule 子 schedule 设 origin_type/origin_role/origin_id
- [ ] AC4: materialize 输出无 task_spec；复合注 subunit_count；isComposite N≥2
- [ ] AC5: child running SSE emit；barrel re-export
- [ ] AC6: 孤儿 reaper 定时清；task 删→cascade-reap schedules
- [ ] AC7: trigger_source + source_chat_session_id 列从 schedules DROP；ScheduleRow 删字段；build 绿（用法同票迁移，02 additive→06 removal）

## Verification Method
**integration**: 建 origin_type=task schedule→被认领；stale→failed(不回滚)；child schedule origin 字段齐全；dispatch 后 schedules.config 无 task_spec；删 task→schedules 清。Pass: 全 AC。

## Exploration

### Analog studied
The closest existing feature is the v1 task-pool (`trigger_source='requirement'`), already partially migrated by 02 (additive origin cols) and 03 (ScheduleStatusListener emit points + TasksService dispatch seam). 06 finishes the migration: origin_type takes over the 3 承重 sites, trigger cols are dropped, and the v1 `trigger_source='requirement'` DTO field is derived from origin_type (shared `SchedulerJob` type stays — boundary forbids touching shared).

### Files needing modification (all scheduler-* + the 02-carved schema.ts/types.ts exceptions + schedule-config-dao since 02 is done+committed)
- `packages/server/src/db/schema.ts` — add `migrateSchedulesV38` (DROP COLUMN trigger_source + source_chat_session_id, try-catch); remove `ensureColumn` calls for those two cols; call migrateSchedulesV38 from handleSchemaMigrations.
- `packages/server/src/db/types.ts` — remove `trigger_source` + `source_chat_session_id` from `ScheduleRow`.
- `packages/server/src/db/dao/schedule-config-dao.ts` — `insertSchedule`: drop trigger_source/source_chat_session_id from INSERT col list + values (02 done+committed, no conflict).
- `packages/server/src/services/scheduler/scheduler-engine.ts` — SG1 site 1 (:388 failed-promotion `trigger_source==='requirement'`→`origin_type==='task'`); SG1 site 2 (:455 checkQueuedTasks filter→`origin_type IN ('task','manual','api')`); `buildSchedulerJob` derive `trigger_source` from `origin_type` (SchedulerJob shared type still requires it); remove trigger cols from local `ScheduleRow`.
- `packages/server/src/services/scheduler/scheduler-service.ts` — migrate `createJob` (derive origin_type from trigger_source at the boundary, set on row), `toggleJob` guard (origin_type!=='cron'→throw), `enqueueJob` guard (origin_type!=='task'→throw), `listJobs` filter, `enrichJobRow` (derive trigger_source from origin_type), `createJobSchema` (keep trigger_source field for backward-compat with routes/scheduler.ts, but no longer persisted); remove trigger cols from local `ScheduleRow`.
- `packages/server/src/services/scheduler/task-dispatch-service.ts` — SG1 site 3: `createChildScheduleRow` set `origin_type='task', origin_role='subunit', origin_id=<parent task id>` (resolved via coordinator workspace's source_schedule_id → schedule.origin_id); drop `trigger_source:'requirement'`; SG10: emit child `running` SSE when child starts.
- `packages/server/src/services/scheduler/executors/workflow-executor.ts` — SG9: `isCompositeTask` threshold `!!subunits?.length`→`subunits.length >= 2` (1-subunit→simple workflow_chain).
- `packages/server/src/services/scheduler/index.ts` — SG16: barrel re-export `TaskDispatchService`.
- `packages/server/src/services/scheduler/orphan-reaper.ts` (NEW) — SG12: scan `schedules WHERE origin_type='task' AND origin_id NOT IN (SELECT id FROM tasks WHERE deleted_at IS NULL)` → soft-delete orphans. Scheduled via the auxiliary tick.
- `packages/server/src/services/scheduler/scheduler-engine.ts` — wire orphan reaper into `auxiliaryTick`.
- `packages/server/src/__tests__/06-schedules-origin-materialize.test.ts` (NEW) — integration verification for AC1-AC6.
- Existing v1 tests (`scheduler-engine.test.ts`, `07-sse-schedule-status.test.ts`, `composite-dispatch.test.ts`, `scheduler-task-spec.test.ts`, `t1/t5/t8` etc.) — migrate INSERTs to `origin_type='task'` + assertions; they test scheduler-* code I own, and "usage-migration" is explicitly in-scope per AC7.

### Functions chosen
- `ScheduleConfigDAO.findSchedulesByOrigin(type, id)` (02) — used by orphan reaper + cascade-reap verification (03's deleteTask already calls it — R-INT verify).
- `ScheduleConfigDAO.findByIdRaw` — read origin_type/origin_id for buildSchedulerJob derivation + orphan reaper context.
- `materializeTaskSpecToConfig` (03 exported) — SG5 body: drop task_spec from output + inject `input_values.subunit_count` for composite.
- `WorkflowExecutor.isCompositeTask` — SG9: change threshold to `>= 2`.
- `TaskDispatchService.dispatchChildSchedule(subunit, origin_role)` (01 added origin_role param) — SG1 site 3 + SG10 child running SSE.

### Boundary-respect notes
- schema.sql OFF-LIMITS → fresh test DBs still CREATE trigger_source/source_chat_session_id columns; the `migrateSchedulesV38` DROP only affects existing dev DBs. This is acceptable: the CODE no longer reads/writes those cols (type-clean), and the migration cleans real DBs. Tests that still raw-INSERT trigger_source won't error at runtime (column exists on fresh DBs), but I migrate them to origin_type for consistency + AC7 spirit.
- shared `SchedulerJob.trigger_source` field STAYS (boundary: no shared edits). `buildSchedulerJob`/`enrichJobRow` DERIVE it from `origin_type` so the DTO contract holds and `workflow-executor.isRequirement = job.trigger_source === 'requirement'` keeps working for task-origin schedules.
- routes/scheduler.ts not explicitly in scope; keep its requirement path working by having scheduler-service createJob map trigger_source→origin_type at the boundary (backward-compat).

