# Spec: Task Domain Redesign — 一等 tasks 表 + 确定性草稿 + spec↔agent 联动

> 单一真相源，供 matt-dev-runner / pipeline / code-review 消费。
> 决策细节见 `map.md`（v2-D1..D14）+ `docs/adr/0009-task-domain-orchestration-hybrid.md`。
> 这是 v1（`.scratch/task-pool-redesign/`，已实现为 PR #50）的 **v2**：推翻 v1 D9（"不建表，task_spec 塞 schedules.config"），并在 tasks 表语境下修订 ADR-0008（→ ADR-0009 混合）。
> 现状研究见 5 个 research 子代理 findings（DB/编排/自动保存/skill-resource/spec 联动）。

## Problem Statement

v1 任务池（PR #50）把任务塞进 `schedules` 表（`trigger_source='requirement'` + `status='draft'` + `config.task_spec`），三处真问题：
1. **草稿无确定性保存时机**：draft 由 task-author agent 自觉调 `POST /api/scheduler/jobs` 产生；`resolveDraft` 轮询"碰运气"，无 autosave 端点、无保存按钮。用户要"早上好对话后自动存草稿 + 保存按钮"。
2. **spec 面板与 author agent 脱钩**：SpecPanel 6 字段全本地 useState、仅 [保存] 回写；agent 只能整包 POST，对话中不能自动绑定目标/技能/goal。用户要"联动 + 自动填写"。
3. **task-pool 是 cron scheduler 的多态分支**：`trigger_source==='requirement'` 糊满 scheduler-service；task 从诞生起活在 scheduler 肚里，无域边界。用户要"清掉 schedules 的 hack + tasks 一等表 + 全生命周期"。

## Solution

新建一等 `tasks` 域：拥有 `draft→ready→running→done/failed/aborted` 全生命周期 + task_spec(WHAT) + 资源/技能绑定 + 草稿↔agent 双向联动。**确定性草稿保存**（turn-end 服务端 autosave row+title + [保存草稿] 按钮）。**spec↔agent 联动**（agent `update_task_spec_field` 工具 → `spec_field_update` SSE → SpecPanel；反向 context msg）。**task-author 可现场加载已安装非-cwd 资源**（draft 期 prompt-inject / workspace 期 workflow.requires）。`schedules` 清掉 task-pool hack，泛化 `trigger_source`→`origin_type` 多态关联（S2，无 FK，app 级 integrity）。编排委托现有 `task_dispatch`/`WorkflowExecutor`（ADR-0009 混合，coordinator-ws 条件化）。

## Projects Involved

- [ ] `@octopus/shared` — TaskSpec/SubunitSpec(+resources/authoring_resources)/TaskStatus/TaskDispatch 已有/`update_task_spec_field` tool schema/`spec_field_update` SSE payload/`origin_type` enum
- [ ] `@octopus/server` — tasks DAO+service+routes、autosave seam（`clone/index.ts:406`）、`update_task_spec_field` tool handler、`spec_field_update` SSE、schedules 清理（origin_type/origin_id/origin_role/assoc_meta，移除 trigger_source/source_chat_session_id/config.task_spec）、sessions.scope_id 重指 tasks.id、dispatch seam（ready→建 schedules envelope）、composite coordinator-ws 条件化
- [ ] `@octopus/engine` — task_dispatch 已有（ADR-0008 产出，保留）；orchestration-strategy seam（简单任务直分发跳 coordinator-ws）
- [ ] `@octopus/web-app` — /tasks 看板（tasks 状态列）、TaskModal authoring（spec↔agent 联动 + 资源 picker + [保存草稿]）、SpecPanel 订阅 `spec_field_update`、dispatch viewer
- [ ] `@octopus/core-pack` — task-author SKILL.md（改调 /api/tasks + update_task_spec_field，不再 curl /api/scheduler/jobs）、composition-task.yaml（已有）

## Feature Scope

**Do：** 新 `tasks` 表 + 全生命周期；schedules 清 hack + 泛化 origin_type 多态关联（S2）；确定性 autosave（row+title，server-side `clone/index.ts:406`）+ [保存草稿] 按钮；spec↔agent 双向联动（update_task_spec_field 工具 + spec_field_update SSE + 反向 context msg + 409 retry）；task-author 加载非-cwd 赃源（draft prompt-inject / ws workflow.requires，两 scope 持久化 authoring_resources[]/resources[]）；编排委托 task_dispatch + coordinator-ws 条件化（ADR-0009）；sessions.scope_id→tasks.id。

**Don't：** 推翻 v1 仍成立的决策（D1/D2/D3/D5/D7/D8/D10/D13/D14/D15/D16）；跨 ws sub_workflow；xzf-dev 当默认；重写前端 chat 组件；数据迁移（无历史包袱，dev DB 可重建）；建独立任务编排引擎（B 方案，ADR-0009 已否决）。

## Key Decisions

| # | Decision | Conclusion |
|---|---------|-----------|
| v2-D1 | tasks 一等表 | 拥有 lifecycle+spec+resources；schedules 清 hack |
| v2-D2 | 状态机 | draft→ready→running + 终态 |
| v2-D3 | 资源分层 | draft 加载 / ws require |
| v2-D4 | 确定性草稿保存 | autosave + 保存按钮（app 驱动，非 LLM whim） |
| v2-D5 | spec↔agent 联动 | 双向（agent 自动绑 + 用户覆盖） |
| v2-D6 | autosave 机制 | server-side `clone/index.ts:406`，cloneName='task-author' 门控 |
| v2-D7 | spec 联动机制 | update_task_spec_field 工具 + spec_field_update SSE + 反向 context msg |
| v2-D8 | 资源加载机制 | draft prompt-inject from installPath / ws provisioner |
| v2-D9 | 编排 | **混合 C**（→ ADR-0009）：tasks 拥 lifecycle，委托 task_dispatch，coordinator-ws 条件化 |
| v2-D10 | tasks↔schedules 关联 | **S2 多态 origin**（origin_type+origin_id 无 FK + origin_role），tasks 无 schedule 指针 |
| v2-D11 | autosave scope | row+title only（spec 走工具/按钮） |
| v2-D12 | spec 联动字段 | 全 6 字段自动绑 + 反向通知 + 409 retry |
| v2-D13 | 资源 UX | 两 scope 持久化（authoring_resources[] / resources[]） |
| v2-D14 | 状态终态 | draft\|ready\|running\|done\|failed\|aborted；claimed 折入 running；discard=软删 |

继承 v1：D1(project bind)/D2(spec=WHAT,workflow_ref=HOW)/D3(task-author clone)/D5(subunits 声明)/D7(结构化 spec)/D8(execution HITL=interaction 节点)/D10(engine DAG/Loop/Swarm/moa)/D13(手动 enqueue=confirm)/D14(integration_goal)/D15(复合父卡+drill-down)/D16(workflow_chain 留作简单同-ws 快路径)。

### Story Gap Fixes (story-walkthrough + peer; user confirmed "修实现不变项，不改决定")

> 全部为实现已决定 v2 架构的缺口（缺 writer/trigger/字段/审计），不改 D1-D14/ADR-0009。3 默认（异议可调）：agent-origin 失败=v1 auto-disable；resources UNION 合并；反向 msg=prepend-to-user-msg（SPIKE S1 验）。

| # | 断点 | 修复（落地 v2 决定） |
|---|------|------|
| SG1 (CRITICAL) | `trigger_source` 移除承重 3 站点：`:379-391` failed-提升门控 / `:448` 认领过滤 / `:314` 子创建 | 全迁 `origin_type`：failed-提升→`origin_type='task'`（agent-origin 默认 v1 auto-disable）；认领过滤→`origin_type IN('task','manual','api')`；子创建+`TaskDispatchPort`+`origin_role`→设 origin_type/origin_role/origin_id。审计 scheduler-engine 其它 trigger_source 分支 |
| SG2 | 无 `schedules.status`→`tasks.status` writer；无 `/api/tasks/events` 桥 | 加 `ScheduleStatusListener`：schedule 转换→tasks.status（queued/claimed→running, done→done, failed→failed, aborted→aborted）+ emit `task_status` SSE 到 `/api/tasks/events` |
| SG3 | `sessions.scope_id→tasks.id` 无 writer | autosave seam + `POST /api/tasks` 建 tasks 行后 `updateSession(scope_id=task.id)` |
| SG4 | 反向 context msg 机制 | **SPIKE S1 已验**：system-prompt append（`CloneRuntime.chat` 加 `specUpdateNotice?` 参→concat 进 `sendWithProvider.append`，clone-runtime.ts:310-329；`assembleContext()` 每 turn fresh :261）。v2-D7 保持 PUSH（无需 pull 回退）。优于 prepend-to-user-msg（避免 DB 污染+SDK 历史留存+`@@` 被当指令） |
| SG5 | `materializeTaskSpecToConfig` 未 export + 仍写 task_spec + 复合缺 subunit_count | export（或移 shared util / dispatch seam 内联 scheduler-service）；输出 **drop task_spec**（留 tasks 表）；复合注入 `input_values.subunit_count` |
| SG6 | authoring_resources 每 turn 注入 | **机制修正（peer audit）**：task-author 用 **Claude SDK provider**（builtin-clones.ts:340 `getProvider('claude')`），非 Pi——SPIKE S2 调研错 provider。正解=`CloneRuntime.assembleContext()`（每 turn fresh, clone-runtime.ts:261）读 `tasks.authoring_resources[]`→解析 SKILL.md（ResourceManager installPath）→append 进 `sendWithProvider` 的 `systemPrompt.append`（同 05 specUpdateNotice seam, clone-runtime.ts:346-348）。route 解析 authoring_resources→内容→传 chat()。**不用** pi-sdk-adapter/_rebuildSystemPrompt/fresh-session/load_resource_for_authoring（均不适用/不存在）。不改 v2-D8 |
| SG18 | peer audit: update_task_spec_field 非 native tool；load_resource_for_authoring 不存在 | `update_task_spec_field` 是 REST 端点（POST /api/tasks/:id/spec-field），agent 经 **curl/Bash** 调（非 native SDK tool）。`load_resource_for_authoring` **删除**——authoring_resources 经 spec-field 工具设→assembleContext 自动注入。SKILL.md 经 plugin scan 可发现（非自动注入 system prompt），agent 按需 Read |
| SG7 | `WorkflowConfig` 无 `requires`；materialize 零资源处理；EngineInitPhase 读 `workflow.requires` 非 `config.requires` | Data Model 加 `WorkflowConfig.requires?`（镜像 WorkflowDef.requires）；materialize 传播 `tasks.resources[]`/`subunit.resources[]`→`config.requires`；EngineInitPhase 合并 `config.requires`→`workflow.requires`（**UNION**，不 override） |
| SG8 | autosave vs 工具版本竞争 | autosave targeted UPDATE `title+updated_at` only，**不 bump version、不碰 task_spec/resources** |
| SG9 | `isCompositeTask` 阈值 N≥1 | 改 `subunits.length>=2`；1-subunit 走简单 workflow_chain |
| SG10 | child `running` SSE emit 缺 | `task-dispatch-service` 加 child running SSE emit |
| SG11 | `enhancePromptWithSkills` 死码 | 新 `TaskAuthorSessionAugmenter` 服务：ResourceManager→读 SKILL.md→enhance→pi-sdk systemPrompt |
| SG12 | 孤儿 reaper 无 schedule | 每 N min 扫 `schedules WHERE origin_type='task' AND origin_id NOT IN(active tasks)` 删孤儿 |
| SG13 | `SubunitsEditor` 缺 resources picker | 加 per-subunit 资源 picker |
| SG14 | web-app 读 `SchedulerJob` | 全量改读 `Task` 类型 |
| SG15 | `router.push('/scheduler/jobs/:id')` | → `/tasks/:id/children/:scheduleId` |
| SG16 | `TaskDispatchService` 未 barrel re-export | `scheduler/index.ts` 加 re-export |
| SG17 | `isCompositeTask` 行号不准 | 修 spec 引用（method@490-497, call@142） |



1. /tasks 点 [+新建] → authoring modal（spec 左 / task-author 对话 右，**联动**）
2. 与 task-author 对话 → **turn-end 自动存 draft 行 + 标题**（v2-D4/D6/D11）
3. agent 对话中 **自动绑定** project/skills/goal/ac/subunits/integration（update_task_spec_field 工具，SpecPanel 实时刷新）
4. 用户改 SpecPanel + [保存草稿] → 持久化 + **反向通知 agent**（context msg）
5. agent 可现场 **加载已安装非-cwd 资源**（load_resource_for_authoring / authoring_resources[] prompt-inject）
6. 资源 picker（用户指定）+ agent 协助，绑定到 draft（authoring）或目标 ws（resources→workflow.requires）
7. [入队] → draft→ready（confirm gate，v1 D13）→ dispatch seam 建 schedules envelope
8. ready→running（runner 认领，coordinator-ws 条件化：简单跳过，复合建）→ done/failed/aborted
9. 看板实时 SSE（task_status + spec_field_update）
10. 复合任务：父卡 + drill-down（N 子 schedule + moa 聚合，v1 D15）
11. [中止] running→aborted + ws 清理（v1 G4）；失败→failed 终态不回滚（v1 G2）
12. 丢弃 draft/ready = 软删（deleted_at）

## Implementation Decisions

- **`tasks` 表**（新）：见 Data Model。`source_chat_session_id` FK→sessions(id)；**无 schedule_id/execution_id**（S2：经 `schedules.origin_type='task' AND origin_id=task.id` 查）；无 claimed_at（runner 细节在 schedules）。
- **autosave seam**（v2-D6/D11）：`packages/server/src/routes/clone/index.ts:406`（auto-title 块后、done SSE 前），`cloneName==='task-author'` 门控：首 turn 若无关联 tasks 行则建（status=draft, source_chat_session_id, title=auto）；每轮更新 title+updated_at。spec 不经 autosave。
- **`update_task_spec_field` 工具**（v2-D7/D12）：agent 工具 `{task_id(or via session), field, value}` → tasks DAO 局部合并 task_spec/resources/authoring_resources → emit `spec_field_update` SSE（taskpool 通道，payload {task_id,field,value,version}）。field∈{projects,skills,goal,ac,subunits,integration_goal,resources,authoring_resources}。冲突：stale version→409→agent re-GET+retry。
- **spec_field_update SSE**：SpecPanel `subscribeSSE` 订阅，useEffect 应用到本地 state + 更新 version（避免后续 [保存] 409）。
- **反向 context msg**：[保存草稿]→PUT /tasks/:id 持久化后，注入 `@@spec_updated: <field>=<value>` 到 task-author session（下一轮 agent 可见用户覆盖）。
- **资源加载**（v2-D8/D13）：draft 期—`load_resource_for_authoring(name)` 工具 / `tasks.authoring_resources[]` 变更 → 服务端从全局 registry 解析 `installPath` → 读 SKILL.md → 经 `pi-sdk-adapter.ts:99-112` getSystemPrompt override + `prompt-enhancer.ts` 注入 task-author session prompt。重开 draft 重载 authoring_resources[]。workspace 期—`materializeTaskSpecToConfig` 把 `tasks.resources[]`/`subunit.resources[]` 传播到 `config.requires` → `EngineInitPhase`+`ResourceProvisioner` 分发。
- **schedules 清理**（v2-D10）：加 `origin_type`(default 'cron')/`origin_id`(TEXT NULL 无 FK)/`origin_role`/`assoc_meta`；移除 `trigger_source`/`source_chat_session_id`/`config.task_spec`；保留 status(queued/claimed/running/done/failed/aborted)+claimed_at+cron 字段+job_type+config(WorkflowConfig)+workspace_id+max_retain+version。`sessions.scope_id`→tasks.id。删 scheduler-service 的 `trigger_source==='requirement'` 分支。
- **dispatch seam**（v2-D9/ADR-0009）：ready（enqueue）→ orchestration-strategy 建 schedules envelope(s)：简单=1 schedule(origin_type='task',origin_role='primary',status='queued',config=materializeTaskSpecToConfig) 直分发（跳 coordinator-ws）；复合=coordinator schedule(origin_role='coordinator')+composition-task.yaml+task_dispatch fan-out N 子(origin_role='subunit')。runner 认领 schedules 'queued' 不变。
- **integrity（R-INT）**：origin_id 无 FK → app 级 cascade-reap（task 删/废弃→清 `schedules WHERE origin_type='task' AND origin_id`）+ 孤儿 reaper + 保留 createJob-rollback 清孤儿。
- **task-author SKILL.md**：改教 agent 调 `/api/tasks` + `update_task_spec_field` 工具（不再 curl `/api/scheduler/jobs`）；保留 task_spec schema curl recipes 改指向 /api/tasks。

### Story Gap Fix Mechanisms (Implementation Decisions)

- **SG1 origin 迁移**：`scheduler-engine.ts:379-391/448` + `task-dispatch-service.ts:314` + `TaskDispatchPort`+`origin_role` 全迁 `origin_type`；审计其它 trigger_source 分支。
- **SG2 ScheduleStatusListener**：注入 SchedulerEngine，schedule 转换→tasks.status + emit `task_status` SSE 到 `/api/tasks/events`。
- **SG3 scope_id writer**：autosave seam + `POST /tasks` 建 tasks 后 `updateSession(scope_id=task.id)`。
- **SG5 materialize**：export `materializeTaskSpecToConfig`（或内联 dispatch seam），输出 drop task_spec，复合注 `input_values.subunit_count`。
- **SG6 authoring re-inject**：`TaskAuthorSessionAugmenter` 每 turn 读 `authoring_resources`→SKILL.md→`_rebuildSystemPrompt`（pi-sdk-adapter.ts:106）。
- **SG7 requires 传播**：materialize 传播 `resources`→`config.requires`；`EngineInitPhase` UNION 合并 `config.requires`→`workflow.requires`。
- **SG8 autosave UPDATE**：targeted `title+updated_at` only，不 bump version、不碰 task_spec/resources。
- **SG9 isComposite N≥2**：`workflow-executor.ts:491` 改阈值；1-subunit 走简单 workflow_chain。
- **SG10 child running SSE**：`task-dispatch-service` 加 child running emit。
- **SG11 augmenter**：新 `TaskAuthorSessionAugmenter` 接 `enhancePromptWithSkills`（救活死码）。
- **SG12 orphan reaper**：定时扫删孤儿 schedules（cron/auxiliary tick）。
- **SG13-15 web-app**：`SubunitsEditor` resources picker / 全量改读 `Task` 类型 / `router.push` 重指 `/tasks/:id/children/:scheduleId`。
- **SG16 barrel**：`scheduler/index.ts` re-export `TaskDispatchService`。

## Data Model Changes

| Table/Type | Operation | Details |
|-----------|-----------|---------|
| `tasks` (NEW) | create | id,org,name,status(draft\|ready\|running\|done\|failed\|aborted),source_chat_session_id FK→sessions,task_spec JSON,authoring_resources JSON,resources JSON,skills JSON,project_ids JSON,workflow_ref,version,deleted_at,created/updated_at,completed_at. **无 schedule_id/execution_id/claimed_at** |
| `schedules` | +cols / -cols | +origin_type(default 'cron'),origin_id NULL,origin_role,assoc_meta；-trigger_source,-source_chat_session_id,-config.task_spec；保留 status 运行态+claimed_at+cron+job_type+config(WorkflowConfig)+workspace_id+max_retain+version |
| `sessions.scope_id` | retarget | → tasks.id（was schedules.id 软链） |
| `TaskSpec` (shared) | extend | +resources[],+authoring_resources[]（[{type,name}]） |
| `SubunitSpec` (shared) | extend | +resources[]（workspace-scope，→ child workflow.requires） |
| `TaskStatus` (shared) | new enum | draft\|ready\|running\|done\|failed\|aborted |
| `OriginType` (shared) | new enum | cron\|task\|agent\|manual\|api（可扩展） |
| `spec_field_update` SSE payload (shared) | new | {task_id,field,value,version} |
| `update_task_spec_field` tool schema (shared) | new | {task_id,field,value} |

### Data Model Additions (Story Gap)

- `WorkflowConfig` (shared) + `requires?: {skills, agent_files, commands, rules}`（镜像 `WorkflowDef.requires`；SG7）
- `TaskDispatchPort` (shared) + `origin_role` param（SG1；`dispatchChildSchedule` 设 origin_type/origin_role/origin_id）
- `schedules` `trigger_source`→`origin_type` 迁移：3 站点（SG1）
- `ScheduleStatusListener` (server) + `task_status` SSE payload (shared)

## API Contracts

| Method | Path | Params | Response | Notes |
|--------|------|--------|----------|-------|
| POST | `/api/tasks` | {source_chat_session_id?, name?} | Task | 显式建 draft（autosave 也会隐式建） |
| GET | `/api/tasks` | ?status=&org= | {items[]} | 看板（tasks 状态列） |
| GET | `/api/tasks/:id` | — | TaskDetail（+children schedules via origin lookup + dag） | modal（复合 drill-down） |
| PUT | `/api/tasks/:id` | {task_spec?/fields} + If-Match | Task | [保存草稿]；draft/ready 可编辑 |
| POST | `/api/tasks/:id/spec-field` | {field,value} | {version} | **agent update_task_spec_field 工具** → +spec_field_update SSE |
| POST | `/api/tasks/:id/ready` | — | Task | **[入队]** draft→ready（confirm gate；dispatch seam 建 schedules envelope） |
| POST | `/api/tasks/:id/abort` | — | Task | running→aborted + ws 清理（v1 G4） |
| DELETE | `/api/tasks/:id` | — | {ok} | 软删 draft/ready（deleted_at）+ cascade-reap schedules |
| GET | `/api/tasks/events` | SSE | task_status / spec_field_update | 看板实时 |
| POST | `/api/clones/task-author/sessions/:id/chat` | {message} | SSE stream | 不变；**server-side autosave 在此路由 turn-end**（v2-D6） |
| (removed) | `POST /api/scheduler/jobs` (requirement path) | — | — | task-author 不再 curl scheduler；改 /api/tasks |

## Design Specs

- Figma: none
- ASCII: `decisions/14-prototype-authoring-panel-ux.md`（v1，沿用：看板 + 统一 modal authoring/composite/simple/done，spec 左/对话 右）
- 复用引擎流程图组件画 composition DAG（v1 D15）

## Verification Strategy

### Environment
local dev（`pnpm dev` server:3001 web:3000）· SQLite `~/.octopus/db/octopus.db`（无历史包袱，dev DB 可重建）· `http://localhost:3000/tasks` · data prefix `E2E_TD_`

### Test Users & Data
test admin account · data prefix `E2E_TD_` · DELETE after test

### AC → Verification Method Mapping
| US# | AC | Level | Method |
|-----|----|-------|--------|
| 1-2 | modal + autosave row+title | integration+E2E | task-author 首轮 → tasks 行存在+title=auto（DB assert）|
| 3 | agent 自动绑 spec 字段 | integration | update_task_spec_field → tasks.task_spec 字段 + spec_field_update SSE 收到 |
| 4 | 反向 context msg | integration | [保存草稿] → session message 含 @@spec_updated |
| 5 | 非cwd 资源加载 | integration | authoring_resources[] → task-author session prompt 含 SKILL.md 内容 |
| 6 | 资源 picker + 两 scope | E2E | Playwright 选资源 → authoring_resources vs resources 分流 |
| 7 | [入队] draft→ready + schedules envelope | integration | POST /ready → tasks.status=ready + schedules(origin_type=task,status=queued) 存在 |
| 8 | ready→running + coordinator-ws 条件化 | integration | 简单=1 schedule 无 coordinator；复合=coordinator+N 子 |
| 9 | SSE task_status+spec_field_update | integration | 订听 → assert 全转换点 + 字段更新 |
| 10 | 复合父卡+drill-down | E2E | Playwright |
| 11 | abort+failed 终态 | integration | POST /abort→aborted+ws cleaned；失败→failed 不回滚 |
| 12 | 软删+cascade-reap | integration | DELETE draft→deleted_at + schedules(origin_id) 清 |
| R-INT | origin_id 孤儿 reap | integration | task 删 → schedules 不留孤儿 |

| SG2 | schedule→tasks.status + SSE | integration | schedule 转换→tasks.status 1s 内 + task_status SSE 收到 |
| SG3 | scope_id writer | integration | autosave/POST /tasks 后 sessions.scope_id=tasks.id |
| SG5 | schedules 清 task_spec | integration | dispatch 后 schedules.config 无 task_spec |
| SG1 | origin 迁移 | integration | origin_type='task' schedules 可被认领 + failed-提升 |
| SG7 | 资源传播 | integration | tasks.resources[]→config.requires→workflow.requires UNION |
| SG12 | 孤儿 reaper | integration | task 删→N min 内孤儿 schedules 清 |

### Anti-Fake-Run R1-R8
R1 真 task-author clone/scheduler · R2 断 task_spec 字段+origin_type · R3 API↔DB 双向 · R4 response+SQL · R5 写 DB · R6 真 /tasks UI · R7 E2E_TD_ · R8 无手动前置。

### Prerequisites
- pnpm dev 起 · Playwright · test project + 简单/复合 task_spec · task-author clone + SKILL 安装 · test 全局资源（/api/resources）

## Risks & Notes

- **R-INT（已接受）**：origin_id 无 FK（S2）→ 孤儿风险。缓解=app 级 cascade-reap + 孤儿 reaper + createJob-rollback。S2 uniformity 的代价。
- **R1** dispatch seam（ready→建 schedules envelope）是新代码，须验证简单（跳 coordinator）与复合（coordinator+N 子）两路。
- **R2** `update_task_spec_field` 并发：autosave（row+title）与 spec 工具同 turn—服务端在 clone route 串行（autosave 在 turn-end 后、工具调用已落），无竞态。
- **R3** 非-cwd 资源 prompt-inject 依赖 `pi-sdk-adapter.ts:99-112` getSystemPrompt override + `prompt-enhancer.ts`（研究④ seam），须实测 SDK 接受注入。
- **R4** schedules 清理迁移：dev DB 无包袱可重建；prod（若有）须 migration 脚本（本 spec 范围=dev/新功能，prod 迁移另议）。
- **R5** ADR-0009 coordinator-ws 条件化逻辑落 `WorkflowExecutor.isCompositeTask` 分支（加 simple-direct-dispatch 路径）。
- **SPIKE S1（SG4）— RESOLVED**：反向 context msg 走 system-prompt append（`CloneRuntime.chat` 加 `specUpdateNotice?` 参→`sendWithProvider.append`）；v2-D7 保持 PUSH，无需 pull 回退。优于 prepend-to-user-msg。
- **SPIKE S2（SG6）— RESOLVED + 机制修正（peer audit）**：SPIKE S2 调研了 **Pi adapter**，但 task-author 用 **Claude SDK provider**（builtin-clones.ts:340）— Pi 发现（_rebuildSystemPrompt/before_agent_start/fresh-session）不适用。正解=`assembleContext` 每 turn fresh → `sendWithProvider` systemPrompt.append（同 SPIKE S1/05 seam）。不改 v2-D8。**Latent bug（pre-existing, ticket 13 已修）**：Pi SDK resume 路径 broken（findSession 返 SessionManager）— 13 已修；且 task-author 经 Claude SDK 路径本就绕开 Pi resume。
- **R6（SG12）**：孤儿 reaper 须定 schedule（cron/auxiliary tick），否则 R-INT 缓解悬空。

## Glossary

tasks 域 · task_spec(WHAT) · authoring_resources[]（draft-scope prompt-inject）/ resources[]（workspace-scope → workflow.requires）· origin_type/origin_id/origin_role（S2 多态关联，无 FK）· dispatch seam（ready→schedules envelope）· update_task_spec_field 工具 · spec_field_update SSE · autosave seam（clone/index.ts:406）· orchestration-strategy（ADR-0009）· 状态 draft/ready/running/done/failed/aborted（claimed 折入 running）

## Appendix: Core User Stories（闭环 trace）

### Story A: 简单任务全链路
`/tasks [+新建]` → authoring modal（task-author clone）→ 用户"早上好，做 X" → **turn-end autosave 建 tasks 行(status=draft, source_chat_session_id, title=auto)** → agent `update_task_spec_field(goal=...)` → spec_field_update SSE → SpecPanel 显 goal → 用户改 project + [保存草稿] → PUT /tasks + 反向 @@spec_updated → [入队] → **draft→ready，dispatch seam 建 1 schedules(origin_type=task,role=primary,status=queued)** → runner 认领→claimed→running(tasks.status=running, SSE) → createFromSpec 1 ws → run workflow_ref → done(SSE done) → modal 结果。失败→failed(SSE, G2)。[UI]→[API /tasks]→[Data tasks]→[autosave seam]→[spec-field tool+SSE]→[/ready+dispatch seam]→[Exec schedules runner]→[SSE]→[UI]

### Story B: 复合任务全链路
编辑 3 subunits + integration_goal=synthesis + 各 subunit.resources → [入队] → draft→ready → dispatch seam 建 coordinator schedule(role=coordinator,status=queued)+composition-task.yaml → runner 认领 → coordinator-ws 跑 composition wf → Loop× task_dispatch（各建子 schedule origin_role=subunit + 子 ws + sub-workflow；子完成→resume 父+output_mapping）→ moa 聚合 → done → modal 复合视图（父卡+drill-down N 子）。子失败→父 failed(G2)。resources[] 传播到各子 workflow.requires → provisioner 分发。[UI]→[/tasks]→[dispatch seam: coordinator+N 子 schedules]→[Exec task_dispatch pause-resume]→[SSE 父+各子]→[UI modal]

### Story C: 草稿自动保存 + spec 联动 + 资源加载
早上好对话 → turn-end autosave 建 draft 行+title（v2-D4/D6/D11）→ agent 对话中 `update_task_spec_field`(goal/ac/projects/skills) → SpecPanel 实时刷新（v2-D7/D12）→ agent `load_resource_for_authoring(octo-backend)` → prompt-inject SKILL.md（v2-D8）→ 用户资源 picker 补 resources[](workspace-scope) → [保存草稿] → 反向通知 agent → [入队]→ready。[UI chat]→[autosave seam]→[spec-field tool+SSE]→[resource prompt-inject]→[UI SpecPanel]
