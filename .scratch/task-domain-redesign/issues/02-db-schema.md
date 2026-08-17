# 02 — DB: tasks 表 + schedules 清理 + sessions.scope_id 重指

## What to build
`schema.sql` + `schema.ts`：新 `tasks` 表（id/org/name/status/source_chat_session_id FK→sessions/task_spec/authoring_resources/resources/skills/project_ids/workflow_ref/version/deleted_at/created/updated/completed_at；无 schedule_id/execution_id/claimed_at）。`schedules` +`origin_type`(default 'cron')/`origin_id`/`origin_role`/`assoc_meta`，-`trigger_source`/`source_chat_session_id`/`config.task_spec`（保留 status 运行态+claimed_at+cron+job_type+config(WorkflowConfig)+workspace_id+max_retain+version）。`sessions.scope_id` 语义重指 tasks.id。tasks DAO + schedules DAO 适配。

## Blocked by
01 (shared types)

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: tasks 表创建（无 schedule_id/execution_id per S2）
- [ ] AC2: schedules 加 origin_type/origin_id/origin_role/assoc_meta；移除 trigger_source/source_chat_session_id/config.task_spec
- [ ] AC3: sessions.scope_id 注释/语义 → tasks.id
- [ ] AC4: tasks DAO CRUD（insert/get/update/list-by-status/soft-delete）+ schedules DAO origin 列读写

## Verification Method
**integration**: `sqlite3` 建表 + INSERT tasks/schedules(origin_type=task) + PRAGMA table_info 断列存在/移除。Pass: 列齐全 + trigger_source 不存在。
