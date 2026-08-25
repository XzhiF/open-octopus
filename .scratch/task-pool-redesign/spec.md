# Spec: Task Pool Redesign — Project-Bound Authoring + Composite Dispatch (v2, story-gap-fixed)

> 单一真相源，供 matt-dev-runner / pipeline / code-review 消费。
> 决策细节见 `map.md`（D1-D17）+ `docs/adr/0008-composition-layer-workflow-task-dispatch.md`。
> 现状断点见 `research-findings.md` + `walkthrough-*-peer.md`（file:line cited）。
> v2 = v1 + story-walkthrough 8 断点修复（user-confirmed "都要"）。

## Problem Statement

PR #50 任务池断裂 + 缺失：① /tasks chatbot 走 context-free scheduler clone（错路由+错 prompt）；② WorkflowConfig 预览卡无入队按钮（commit 路径断）；③ chat↔schedule 用 'taskpool-draft' 假 id 悬挂（FK 风险）；④ 不支持复合任务（N 独立 ws 编排+整合）。用户需针对 projects（多仓库）+ 定制 skills 提需求，产 spec，调度执行——简单（1 ws）或复合（N ws 编排+整合）。

## Solution

project-bound task-author clone chatbot 产结构化 spec（WHAT）；手动入队（confirm gate）→ scheduler dispatch；简单 = createFromSpec 1 ws 跑 workflow_ref；复合 = composition workflow + 新 `task_dispatch` 节点 fan-out N 子 schedule（各 createFromSpec 独立 ws），engine DAG/Loop/Swarm 编排，swarm/moa 聚合。统一任务弹窗 UI 上下文感知。xzf-dev = opt-in spec-workflow。

## Projects Involved

- [ ] `@octopus/shared` — TaskSpec/SubunitSpec/ScheduleStatus(+failed/aborted)/task_dispatch NodeDef/TaskDispatchPort interface/workflowConfigSchema v3.0
- [ ] `@octopus/engine` — TaskDispatchExecutor + TaskDispatchConfig + executor-factory case + pause-resume await
- [ ] `@octopus/server` — TaskDispatchPort impl、composite dispatch、failed/aborted writers、abort、SSE 注入、source_path 修复、task-author clone、retire 哨兵、JobDetail
- [ ] `@octopus/web-app` — /tasks 看板（+failed/aborted 列）+ 统一 TaskModal
- [ ] `@octopus/core-pack` — task-author SKILL.md、composition workflow 模板

## Feature Scope

**Do:** 新 `task_dispatch` 节点 + `TaskDispatchPort` 注入 + **pause-resume 跨边界桥**（复用 interaction/approval 基建，触发源=子 schedule 完成）；task-author clone + SKILL；per-task skills 注入；config v3.0 + task_spec；composite dispatch（coordinator-ws + composition wf + N 子 schedule）；整合节点（integration_goal：moa synthesis 默认 / merge opt-in）；统一 TaskModal；入队按钮接线；**failed/aborted 生命周期态 + writers**；**abort 端点**；**SSE 注入 SchedulerEngine + 全转换点 emit**；**source_path 修复**（repos/index.md 接入 initWorktreesFromSpec + 错误传播）；**retire 'taskpool-draft' 哨兵**；孤儿字段清理。

**Don't：** 跨 ws sub_workflow；动态编排 sub_workflows；xzf-dev 当默认；重写前端 chat 组件；数据迁移。

## Key Decisions

| # | Decision | Conclusion |
|---|---------|-----------|
| D1 | 任务绑定 | authoring 绑 project(s)；workspace 在 dispatch 物化 |
| D2 | spec vs workflow | spec=WHAT, workflow_ref=HOW |
| D3 | authoring chatbot | 新 task-author clone（curl→scheduler API via skill） |
| D4 | composite 编排层 | **workflow 层**（ADR-0008）：composition wf + task_dispatch |
| D5 | subunits | 声明式 |
| D6 | per-task skills | 两层模型 + CloneDef.skills 过滤 |
| D7 | spec 成熟度 | 结构化 spec 始终；workflow_ref 选深度 |
| D8 | execution HITL | workflow-native interaction 节点 |
| D9 | task body 数据模型 | task_spec in config v3.0；subunits/plan/skills in composition wf YAML |
| D10 | engine 原语 | DAG/Loop/Swarm/moa 复用 |
| D11 | skills 注入 | synthetic dir 或 re-enable loadSkills |
| D12 | chain 现状 | engine-execution 父子 within one ws；N-call 需 N 子 schedule |
| D13 | confirm gate | 手动 enqueue 按钮；draft=审查态 |
| D14 | integration | 可配 integration_goal（默认 moa synthesis / merge opt-in） |
| D15 | 复合看板 | 父卡 + drill-down（modal 复合视图） |
| D16 | workflow_chain | 保留为简单顺序同-ws 快路径 |

### Story Gap Fixes (walkthrough 8 断点，user-confirmed "都要")

| # | 断点 | 修复 |
|---|------|------|
| G1 | R1 cross-boundary await 假设不存在机制 | 重定义为 **pause-resume**（复用 interaction/approval 基建），触发源=子 schedule 完成回调；子输出经 output_mapping 带回 → 下游 $taskDispatchId.output。构建期验证 resume API 支持 server-内部触发 |
| G2 | failed/aborted 态缺失 → 失败卡 running→stale 回滚→**重派无限循环**（scheduler-engine.ts:413） | 加 `failed`/`aborted`（**terminal，checkStaleClaimed 不回滚**）+ writer（失败→failed；abort→aborted）+ retry cap + 看板 failed/aborted 列 |
| G3 | source_path 静默失败（repos/index.md 在另一方法，注释是谎话） | 把 repos/index.md 解析接进 initWorktreesFromSpec + 失败传播到 schedule_executions/status + 删/改谎话注释 |
| G4 | abort 端点 spec 误标 existing | 改为**新建** + 'aborted' 态 + workspace 清理 |
| G5 | SSE 断反馈（只 running/done；SchedulerEngine 无 SSEService） | 注入 SSEService 到 SchedulerEngine + 全转换点 emit schedule_status（queued/claimed/rollback/abort/failed） |
| G6 | buildSchedulerJob 类型窄化丢 running/done | cast 扩到全 ScheduleStatus |
| G7 | 'taskpool-draft' 哨兵 FK 风险 | task-author clone 落地后退役哨兵：authoring chat 用真 clone session（sessions 表），source_chat_session_id 链 task，scope_id=task_id；createJob 失败清孤儿 |
| G8 | 孤儿字段（ProjectSpec.group；legacy workflow_ref/input_values/workspace_id） | group 读或删；legacy 标记/清理 |
| G9 | task_spec↔WorkflowConfig 物化未定义（executor 读 config.workflow_chain:114，不读 task_spec） | task-author 产 task_spec（authoring 产物）；**enqueue/build 转 WorkflowConfig**：简单=workflow_chain 单项；复合=workflow_ref 指向 composition wf，subunits 经 Loop 喂 task_dispatch |
| G10 | subunits[]→composition 节点未定义（静态模板不能消费动态 N） | composition wf = **Loop over subunits**（每 iteration task_dispatch(subunit[i])）+ 后置 moa 聚合读 loop 累积 output |

## User Stories

1. /tasks 点 [+新建] → authoring modal（spec 左/对话 右）
2. 选 projects（多仓库）+ 勾 skills
3. task-author chatbot 产结构化 spec
4. 复合：编辑 N subunits + integration_goal
5. [入队] → draft→queued
6. 点简单卡 → modal 简单执行视图
7. 点复合卡 → modal 复合视图（一步到位）
8. 点 done 卡 → 结果视图
9. 复合子 ws 跳转执行详情
10. crash recovery：stale 回滚 queued
11. real-time：SSE 全转换点（含 rollback/claimed/abort/failed）秒级刷新
12. per-task skills 定制
13. xzf-dev opt-in
14. execution HITL（interaction 节点，复用 ChatPanel）
15. **中止运行中任务**（[中止] → abort → aborted + ws 清理）
16. **失败任务显示**（failed 列，不再卡 running）

## Implementation Decisions

- **engine `task_dispatch`**：NodeDef type + `TaskDispatchExecutor` + `TaskDispatchConfig`（executor-config.ts）+ executor-factory switch case。`TaskDispatchPort` interface 在 shared（engine 仅依赖 shared+providers），impl 在 server，经 ExecutorFactoryContext 注入（createSessionFn 先例，executor-config.ts:147）。
- **G1 pause-resume 跨边界桥**：TaskDispatchExecutor 不用 in-memory Promise，而是**复用 interaction/approval 的 pause-resume 基建**——节点持久化"等待子 schedule X"，engine 暂停该 composition-wf 执行；server 端子 schedule 完成（handleChainComplete 或新 child-complete 回调）→ resume 父 task_dispatch 节点，传子输出（output_mapping，sub-workflow.ts:247-255 先例）→ 下游聚合节点读 `$taskDispatchId.output.key`（substitute.ts:79-86，已验证 generic）。**构建期验证** resume API 支持 server-内部触发（非仅人 SSE）。
- **G2 failed/aborted writers**：handleChainComplete 失败路径（workflow-executor.ts:372-399 现只标 schedule_executions）→ 加 `schedules.status='failed'`；abort 端点 → `schedules.status='aborted'`。
- **G4 abort**：`POST /jobs/:id/abort` → `service.abortJob(id)`：guard status in (claimed,running) → `schedules.status='aborted'` + `markStaleExecutionsFailed` 释 unique_active + ExecutionService.cancel + markScheduleWorkspacesCleaned。
- **G5 SSE 注入**：SchedulerEngine 构造加 `sse: SSEService`；checkQueuedTasks(claimed)、enqueueJob(queued)、checkStaleClaimed(rollback→queued)、abortJob(aborted)、handleChainComplete(failed) 各加 `sse.emit('taskpool',{event:'schedule_status',data:{schedule_id,status}})`。
- **G6 cast 修复**：buildSchedulerJob（scheduler-engine.ts:653）cast 扩到全 ScheduleStatus（含 running/done/failed/aborted）。
- **G3 source_path**：initWorktreesFromSpec（workspace-git.ts:99-166）空 source_path → 读 `~/.octopus/orgs/{org}/repos/index.md` 解析（复用 initWorktreesSync:16-94 的逻辑，抽公共 resolveRepoPath）；解析失败 → throw，createFromSpec 传播 → schedule_executions.error_summary + schedules.status='failed'。删 projectSpecSchema source_path 注释谎话。
- **G7 退役哨兵**：task-author clone 落地后，authoring chat 走 `/api/clones/task-author/sessions/:id/chat`（sessions 表，clone-session），source_chat_session_id 链 task，clone-session scope_id=task_id；删 TASKPOOL_DRAFT_CHAT_SCOPE + 'taskpool-draft' 假 workspace_id；createJob 失败 rollback 清孤儿 session。
- **task-author clone**：builtin `task-author`（persona + skills filter + cwd=project.source_path）+ `task-author/SKILL.md`（scheduler API + task_spec schema curl recipes）。多仓库：主 cwd + 余作 refs in prompt。
- **per-task skills**：synthetic per-task skills dir（plugin path 指向临时组装目录含勾选 skills）或 re-enable loadSkills 文本注入过滤（ADR-006 下 getPlugins 不过滤）。
- **config v3.0**：workflowConfigSchema 加 `task_spec?` + schema_version "3.0"（v2.0 兼容：无 task_spec=简单 workflow_chain 任务）。
- **G8 孤儿字段**：ProjectSpec.group 读取（initWorktreesFromSpec 用 group 定位 repos/index.md 分组）或删；legacy schedules.workflow_ref/input_values/workspace_id 标 deprecated 注释（v1 残留）。
- **web-app**：/tasks 全宽看板（+failed/aborted 列）+ 统一 TaskModal（status+type 切 authoring/composite/simple/done）。复用引擎流程图组件画 composition DAG。
- **整合**：composition wf 末尾 swarm/moa 节点（integration_goal 驱动）；task_dispatch 节点 depends_on 聚合节点，输出经 $nodeId.output 流入。

## Data Model Changes

| Table/Type | Operation | Details |
|-----------|-----------|---------|
| `ScheduleStatus` (shared) | extend | +'failed' +'aborted'（G2） |
| `schedules.config` | extend | schema_version "2.0"→"3.0"；add `task_spec`。versioned TEXT 无 migration |
| `schedules` | unchanged cols | workflow_ref/input_values/workspace_id 标 legacy deprecated（G8） |
| `schedule_executions` | unchanged | unique_active 留存（composite 走 N 子 schedule_id） |
| NodeDef (shared) | add type | `"task_dispatch"` + subunit/workflow_ref/input_mapping/output_mapping/await |
| `TaskDispatchPort` (shared) | new interface | dispatchChildSchedule(subunit)→ScheduleHandle；resumeOnCompletion(handle, output) |
| `TaskSpec` (shared) | new type | { goal, ac[], data_model?, contracts?, subunits?, integration_goal? } |
| `SubunitSpec` (shared) | new type | { name, workspace_spec, workflow_ref, input_values, skills[] } |
| `CloneDef` (shared) | add builtin | task-author (persona, skills filter, cwd strategy) |
| `projectSpecSchema` | fix | source_path 注释改实；group 读取或删（G8） |

## API Contracts

| Method | Path | Params | Response | Notes |
|--------|------|--------|----------|-------|
| POST | `/api/scheduler/jobs` | { trigger_source:'requirement', task_spec, project_ids, skills, workflow_ref? } | SchedulerJob | task-author curl 创建 draft |
| PUT | `/api/scheduler/jobs/:id` | { task_spec?, subunits? } + If-Match | SchedulerJob | draft 编辑 |
| POST | `/api/scheduler/jobs/:id/enqueue` | — | { ok } | [入队] confirm gate |
| POST | `/api/scheduler/jobs/:id/abort` | — | { ok } | **新建**（G4）：aborted + ws 清理 |
| GET | `/api/scheduler/jobs` | ?trigger_source=requirement | { items[] } | 看板 |
| GET | `/api/scheduler/jobs/:id` | — | JobDetail（含 children[]+dag） | modal 复合视图（新建 shape） |
| GET | `/api/scheduler/events` | SSE | schedule_status（全转换点） | G5 |
| POST | `/api/clones/task-author/sessions/:id/chat` | { message } | SSE stream | task-author clone（G7，复用 generic clone 路由） |

## Design Specs

- Figma: none
- ASCII: `decisions/14-prototype-authoring-panel-ux.md`（看板 + 统一 modal authoring/composite/simple/done，v2.1 spec 左/对话 右）
- 复用引擎流程图组件画 composition DAG

## Verification Strategy

### Environment
local dev（`pnpm dev` server:3001 web:3000）· SQLite `~/.octopus/db/octopus.db` · `http://localhost:3000/tasks` · data prefix `E2E_TP_`

### AC → Method

| US# | AC | Level | Method |
|-----|----|-------|--------|
| 1-2 | modal + project/skill 选 | E2E | Playwright |
| 3 | chatbot 产 task_spec | integration | mock task-author → Zod v3.0 + draft |
| 4 | 复合编辑 N subunits | E2E | Playwright PUT /jobs |
| 5 | [入队] draft→queued + SSE | integration | POST /enqueue + SSE assert queued |
| 6 | 简单执行 modal | E2E | Playwright |
| 7 | 复合 modal DAG+N子+聚合 | E2E | Playwright |
| 8 | done 结果 | E2E | Playwright |
| 10 | crash recovery | integration | stale claimed → 回滚 + SSE rollback |
| 11 | SSE 全转换点 | integration | 监听 → assert queued/claimed/rollback/abort/failed |
| 12 | per-task skills | unit | assembleContext 只含勾选 |
| 15 | abort | integration | POST /abort → aborted + ws cleaned + SSE |
| 16 | failed 显示 | integration | handleChainComplete 失败 → schedules.status=failed + 看板 failed 列 |
| G1 | task_dispatch pause-resume | integration | mock 子 schedule 完成 → resume 父 + output 流入聚合 |
| G3 | source_path 解析 | integration | 空 source_path + repos/index.md → worktree 建成；无解析 → failed+error |
| G6 | buildSchedulerJob cast | unit | running/done/failed/aborted 不丢 |

### Anti-Fake-Run R1-R8
R1 真 scheduler/clone · R2 断 task_spec 字段 · R3 API↔DB 双向 · R4 response+SQL · R5 写 DB · R6 真 /tasks UI · R7 E2E_TP_ · R8 无手动前置。

### Prerequisites
- pnpm dev 起 · Playwright · test project + 简单 spec-workflow YAML · task-author clone + SKILL 安装 · test repos/index.md

## Risks & Notes

- R1(G1) **pause-resume 跨边界桥**：复用 interaction/approval 基建（非新原语），但需验证 resume API 支持 server-内部触发（child-complete），非仅人 SSE。最大技术风险，降级自"新原语"。
- R2 per-task skills 注入（ADR-006 下 getPlugins 不过滤）需实测 SDK。
- R3 MAX_PARALLEL_WORKSPACES=3 + unique_active，复合 N>3 排队，task_dispatch 层处理。
- R4(G3) source_path 不修则多仓库不工作。
- R5 workflow_chain（D16）与 composition 并存，文档 when-to-use。
- R6 xzf-dev opt-in 需裁剪 execution-only 入口与 task-author spec 衔接。

## Glossary

task-author clone · task_spec · SubunitSpec · composition workflow · task_dispatch 节点 · TaskDispatchPort · pause-resume 跨边界桥（G1，复用 interaction/approval）· integration_goal · 统一 TaskModal · failed/aborted 态（G2）

## Appendix: Core User Stories（闭环 trace）

### Story A: 简单任务全链路
`/tasks [+新建]` → authoring modal（task-author clone 产 task_spec）→ [入队] → draft→queued（SSE queued，G5）→ claim→claimed（SSE claimed）→ createFromSpec 1 ws → run workflow_ref → done（SSE done）→ modal 结果。失败 → failed（SSE failed，G2/G5）。[UI]→[API]→[Data task_spec]→[/enqueue]→[Exec createFromSpec]→[SSE]→[UI]

### Story B: 复合任务全链路
编辑 3 subunits + integration_goal=synthesis → [入队] → dispatch → coordinator-ws run composition wf → 3× task_dispatch（G1：pause-resume，各 createFromSpec 独立 ws + sub-workflow；子完成→resume 父+output_mapping）→ engine DAG/Loop → moa 聚合（读 $taskDispatchId.output）→ done → modal 复合视图。子失败 → 父 failed（G2）。[UI]→[API]→[Data]→[Exec task_dispatch pause-resume→child schedules]→[SSE 父+各子]→[UI modal]

### Story C: crash recovery + abort
stale claimed/running >10min → checkStaleClaimed → 回滚 queued + SSE rollback（G5）。用户 [中止] → POST /abort → aborted + ws cleaned + SSE aborted（G4/G5）。
