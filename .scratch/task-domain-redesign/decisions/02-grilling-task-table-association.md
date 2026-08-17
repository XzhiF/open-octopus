# 02 — tasks↔schedules 关联：通用可扩展方案（schedules 作为通用 dispatch 表）

Type: grilling
Status: resolved (user chose S2 → v2-D10)
Blocked by: None

## Answer

User selected **S2 (pure polymorphic origin, no FK)** — prioritized maximal uniformity/extensibility over FK integrity.
`schedules` + `origin_type`(cron|task|agent|manual|api|…) + `origin_id`(TEXT NULL, no FK — tasks.id when
origin_type='task') + `origin_role`(coordinator|subunit|primary). Removed: trigger_source, source_chat_session_id,
config.task_spec. `tasks` has NO schedule pointer; lookups via `schedules WHERE origin_type='task' AND origin_id=task.id`.
Composite N children share `origin_id`=parent task + `origin_role='subunit'`. Cron: origin_type='cron',origin_id=NULL.
Agent-direct: origin_type='agent',origin_id=NULL.

**Integrity risk (R-INT, tracked — accepted by user):** origin_id is free TEXT → orphan risk (the 'taskpool-draft'
dangling-FK pain can recur). Mitigation (REQUIRED, app-level): cascade-reap schedules WHERE origin_type='task' AND
origin_id=task.id on task delete/block; orphan reaper for lingering schedules whose task was deleted; keep the
createJob-rollback pattern (clean orphan session/schedule on failure). This is the price of S2's uniformity.

## Question (reframed per user)

`schedules` 是**通用 dispatch/run 表**，已服务多来源：
- **cron** 跑 workspace/workflow（不绑 task；job_type='workflow'|'agent'，cron_expression，enabled）。
- **agent-direct** 直接委派 agent 做任务（job_type='agent'）。
- **[新] task-bound** 由 tasks 域 dispatch 产生（简单 1 个、复合 coordinator+N 子）。

关联设计要 **通用（uniform association model）+ 可扩展（新来源免迁移）+ 清晰 + 不重蹈
'taskpool-draft' 悬挂 FK 的覆辙**。综合 O1=C（复用 schedule-driven runner，dispatch 必建 schedules 行）
与"清掉 schedules 的 task-pool hack"。

## 现状（research ① + ②）
- schedules 的 task-pool hack = `trigger_source`(cron|requirement, 2 值) + `status` draft 态 +
  `source_chat_session_id` + `claimed_at` + cron nullable + `config.task_spec` blob。
- runner（`SchedulerEngine.checkQueuedTasks`/`checkStaleClaimed`/`WorkflowExecutor`）是 schedules.status 驱动。
- 复合 = 1 coordinator schedule + N child schedule（每 subunit 一个 schedule_id）→ tasks↔schedules **1:N**。
- sessions↔schedule 双向软链（scope_id / source_chat_session_id，无 FK）。

## 方案

### S1（推荐）— 通用 origin_type + 具体 task_id FK + role + meta
`schedules`（清理后，通用 dispatch）：
- 保留运行态：`status`(queued|claimed|running|done|failed|aborted)、`claimed_at`（runner 需要）。
- 保留 cron：`cron_expression`(nullable)、`timezone`、`enabled`、`next_trigger_at`。
- 保留 work：`job_type`(workflow|agent)、`workflow_ref`、`config`(WorkflowConfig, **无 task_spec**)、`workspace_id`、`max_retain`、`version`、`timeout_seconds`、`notify_*`。
- **新增（通用可扩展关联）**：
  - `origin_type` TEXT NOT NULL DEFAULT 'cron' — **替代 trigger_source**，泛化为 cron|task|agent|manual|api|…（加值免迁移）。
  - `task_id` TEXT NULL **REFERENCES tasks(id)** — task 来源的具体 FK（integrity；origin_type='task' 时必设）。
  - `origin_role` TEXT NULL — coordinator|subunit|primary|NULL（复合 N 子用；可扩展）。
  - `assoc_meta` TEXT DEFAULT '{}' — 未来可扩展关联元数据 JSON。
- **移除**：`trigger_source`（→origin_type）、`source_chat_session_id`（→tasks）、`config.task_spec`（→tasks）。

`tasks`（新，authoring/origin 层）：`status`(draft|ready|running|done|failed|aborted)、`task_spec`、`resources`、`skills`、`source_chat_session_id`→sessions(id)、`root_schedule_id`→schedules(id)（coordinator/primary 便捷指针）、`execution_id`→executions(id)、`version`、`created_at/updated_at/completed_at`。
`sessions.scope_id` → retarget `tasks.id`。

复合 N 子：每 child schedule `task_id`=父 task + `origin_role='subunit'`。简单：1 schedule `origin_role='primary'`。cron：origin_type='cron',task_id=NULL。agent-direct：origin_type='agent',task_id=NULL。
**通用**（所有来源一个关联模型）+ **可扩展**（origin_type 加值 + assoc_meta，免迁移）+ **integrity**（task_id 真 FK，杜绝悬挂）+ **清晰**（canonical：schedules.task_id + origin_type）。

### S2 — 纯多态 origin（无 FK）
`schedules` + `origin_type` + `origin_id`(TEXT, 无 FK) + `origin_role`。移除同 S1。
- 通用性最高、最 uniform（所有来源一列集）；加 origin_type 值免迁移。
- **无 FK integrity**（origin_id 自由 TEXT → 孤儿风险，'taskpool-draft' 悬挂 FK 痛可复发）；查询需 origin_type+origin_id 过滤。

### S3 — 关联表 schedule_links
新表 `schedule_links(schedule_id FK→schedules, origin_type, origin_id(无FK), role, meta, created_at)`。schedules 不带关联列。
- schedules 表最干净；M:N；完全可扩展免列迁移。
- 间接（每次 task↔schedule 查询多一 join）；origin_id 无 FK（孤儿风险）；多一表。

## Recommendation

**S1。** origin_type 把 trigger_source 泛化（正是你要清的"相关"hack，同时变通用可扩展）；task_id 给 task 来源真 FK（你之前被 'taskpool-draft' 悬挂 FK 咬过，integrity 是硬约束）；origin_role + assoc_meta 提供复合 N 子区分与未来扩展，免迁移。composite N 子天然 fit（task_id + origin_role='subunit'）。cron/agent-direct 以 task_id=NULL 共存，origin_type 区分。S2/S3 的 uniformity/扩展性略强但牺牲 integrity，不值。

## Note
若选 S1，tasks↔schedules 的 1:N（复合）= 多 schedules 共享 task_id；`tasks.root_schedule_id` 仅便捷指针（coordinator）。dispatch seam（ready→running 由 tasks 建 schedules 行 status='queued'）属 ADR-0009 的 orchestration-strategy。
