# 02 — DB: tasks 表 + schedules 清理 + sessions.scope_id 重指

## What to build
`schema.sql` + `schema.ts`：新 `tasks` 表（id/org/name/status/source_chat_session_id FK→sessions/task_spec/authoring_resources/resources/skills/project_ids/workflow_ref/version/deleted_at/created/updated/completed_at；无 schedule_id/execution_id/claimed_at）。`schedules` **ADD** `origin_type`(default 'cron')/`origin_id`/`origin_role`/`assoc_meta`（**ADDITIVE — trigger_source/source_chat_session_id KEPT**，removal + 3 承重 sites migration 是 ticket 06 的 job，一起做以保持 build green）。`sessions.scope_id` 注释/语义重指 tasks.id（writer 是 04）。tasks DAO + schedules DAO origin 列读写。`config.task_spec` removal 是 app-level（06/SG5 materialize，非 schema 列 drop）。

## Blocked by
01 (shared types)

## Status
done

## Acceptance Criteria
- [x] AC1: tasks 表创建（无 schedule_id/execution_id per S2）
- [x] AC2: schedules ADD origin_type/origin_id/origin_role/assoc_meta（**trigger_source/source_chat_session_id KEPT**，removal deferred to 06）；config.task_spec removal 是 app-level（06/SG5，非 schema）
- [x] AC3: sessions.scope_id 注释/语义 → tasks.id
- [x] AC4: tasks DAO CRUD（insert/get/getById/updateWithVersion/listByStatus/listByOrg/softDelete）+ schedules DAO origin 列读写（findSchedulesByOrigin）

## Verification Method
**integration**: `applySchema` 建表 + INSERT tasks/schedules(origin_type=task) + PRAGMA table_info 断 origin 列存在（trigger_source/source_chat_session_id **KEPT** per additive-only coordinator 调整）+ DAO round-trip。Pass: tasks 列齐全无 schedule_id；schedules origin 列齐全；TaskDAO + ScheduleConfigDAO origin round-trip green。（`packages/server/src/db/dao/__tests__/task-dao.test.ts` 14/14 PASS。）

## Exploration

**Analog studied:** `schedules` table + `ScheduleConfigDAO` (closest existing table+DAO; same lifecycle/JSON-config shape; v37 migration `migrateSchedulesV37` is the rename-to-backup precedent; `dropLegacyColumnsFromChatSessions` is the ALTER-DROP-COLUMN precedent).

**Files needing modification (all in `packages/server/src/db/` — my lane):**
- `schema.sql` — NEW `tasks` table + indexes; `schedules` CREATE **ADD** `origin_type`/`origin_id`/`origin_role`/`assoc_meta` (ADDITIVE — `trigger_source`/`source_chat_session_id` KEPT, removal deferred to 06 per coordinator); NEW `idx_schedules_origin` index (additive); `sessions.scope_id` comment retarget → tasks.id.
- `schema.ts` — `SCHEMA_VERSION` 37→38; **ADD** `ensureColumn(schedules, origin_type/origin_id/origin_role/assoc_meta, ...)` alongside the existing `trigger_source`/`source_chat_session_id` ensureColumn calls (additive — NO `DROP COLUMN` migration). tasks table created by schema.sql `CREATE IF NOT EXISTS` (no migration needed for new table).
- `types.ts` — NEW `TaskRow` interface; `ScheduleRow` **ADD** origin cols (KEEP trigger cols).
- `dao/task-dao.ts` (NEW) — `TaskDAO` (insert/get/getById/getByIdRaw/getBySourceChatSession/updateWithVersion/updateAutosave/listByStatus/listByOrg/softDelete).
- `dao/schedule-config-dao.ts` — `insertSchedule` INSERT **ADD** origin cols (32 cols, keep trigger cols); NEW `findSchedulesByOrigin(originType, originId)` for task-detail children / cascade-reap / orphan-reaper (SG12).
- `dao/index.ts` — re-export `TaskDAO`.

**Out of lane (NOT touched — owned by 06/03/04/05/07):** `routes/scheduler.ts`, `services/scheduler/*.ts` (SG1 trigger→origin migration of 3 承重 sites + the actual `trigger_source`/`source_chat_session_id` column+type REMOVAL), `__tests__/scheduler-*.test.ts` (v1 task-pool behavior tests). The removal MUST happen together with the 3-site usage migration in ticket 06 so the build stays green — hence additive-only here.

**Specific functions chosen:**
- `ensureColumn(db, table, col, def)` (schema.ts:194) — reuse for origin cols on existing DBs (mirrors how v37 added status/trigger cols).
- `ALTER TABLE schedules DROP COLUMN <col>` (SQLite 3.35+) — reuse the `dropLegacyColumnsFromChatSessions` pattern with try/catch (won't re-add dropped cols because I remove the `ensureColumn` calls for them).
- `BaseDAO` (base.ts) — extend for `TaskDAO` (stmt cache + transaction).
- `insertSchedule` (schedule-config-dao.ts:108) — adapt in place; callers (03/04) update callsites concurrently.

**`config.task_spec` removal note:** `config` is a single JSON TEXT column; removing `task_spec` from its content is an app-level concern (SG5 `materializeTaskSpecToConfig` drops it — ticket 03/05), NOT a schema column drop. No schema action needed beyond keeping `config TEXT NOT NULL DEFAULT '{}'`.

**Time budget:** <15 min. Complexity is within scope.
