# 03 — server: tasks service + /api/tasks routes

## What to build
`@octopus/server` tasks service + routes：`POST/GET/GET/:id/PUT/DELETE /api/tasks`、`POST /:id/spec-field`(update_task_spec_field 工具端点→emit spec_field_update)、`POST /:id/ready`(draft→ready+dispatch seam 建 schedules envelope origin_type=task)、`POST /:id/abort`(running→aborted+ws 清理)、`GET /events` SSE(task_status+spec_field_update)。dispatch seam：简单=1 schedule(role=primary,status=queued,config=materialize drop task_spec)；复合=coordinator+composition-task+task_dispatch N 子。ScheduleStatusListener 注入 SchedulerEngine（schedule→tasks.status + task_status SSE）。

## Blocked by
02 (DB schema)

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: /api/tasks CRUD + spec-field + ready + abort 端点工作
- [ ] AC2: dispatch seam ready→建 schedules envelope（简单 1 schedule role=primary；复合 coordinator+N 子 role=subunit）
- [ ] AC3: ScheduleStatusListener：schedule 转换→tasks.status（queued/claimed→running, done→done, failed→failed, aborted→aborted）+ emit task_status SSE
- [ ] AC4: abort→aborted+ws 清理（v1 G4）

## Verification Method
**integration**: curl POST /tasks + POST /ready → DB 断 tasks.status=ready + schedules(origin_type=task,status=queued) 存在；mock schedule 转换 → tasks.status 镜像 + SSE 收到。Pass: 全转换点镜像+SSE。
