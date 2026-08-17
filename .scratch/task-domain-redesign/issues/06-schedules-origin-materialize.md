# 06 — server: schedules origin 迁移 + materialize + reaper

## What to build
SG1 origin 迁移：`scheduler-engine.ts:379-391`(failed-提升门控→origin_type='task')+`:448`(认领过滤→origin_type IN task/manual/api)+`task-dispatch-service.ts:314`(子创建设 origin_type/origin_role/origin_id，替 trigger_source='requirement')+`TaskDispatchService.dispatchChildSchedule` 重写+`TaskDispatchPort`+origin_role。审计其它 trigger_source 分支。**SG1b（从 02 移交）：REMOVE trigger_source + source_chat_session_id**——schema DROP COLUMN（migrateSchedulesV38）+ ScheduleRow 类型删字段（02 已 ADD origin cols，06 做类型移除+用法迁移**一起**，保 build 绿；这是为何 02 改 additive-only）。SG5 `materializeTaskSpecToConfig` export+输出 drop task_spec+复合注 subunit_count。SG9 isComposite N≥2（1-subunit 走 workflow_chain）。SG10 child running SSE emit。SG16 barrel re-export TaskDispatchService。SG12 孤儿 reaper（定时扫删 schedules WHERE origin_type='task' AND origin_id NOT IN active tasks）。R-INT cascade-reap on task delete。

## Blocked by
02 (DB schema), 03 (tasks service)

## Status
ready-for-agent

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
