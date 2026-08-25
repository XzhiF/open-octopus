# Story Walk-Through — Task Authoring v3

> 输入: `.scratch/task-authoring-v3/spec.md`（只读，未修改）
> 协议: `.claude/skills/matt-verified-requirement/references/story-walkthrough.md`
> 日期: 2026-08-18 · 模式: requirement（spec 定稿前设计验证）
> 结论: **2 CRITICAL / 5 HIGH / 5 MEDIUM / 4 LOW** — 修复前不建议定稿 spec

---

## 0. 已核实的代码事实（Evidence Base)

| 事实 | 证据位置 |
|------|---------|
| `/api/tasks` 现有路由: POST / · GET / · GET/:id · PUT/:id(If-Match) · DELETE/:id · POST /:id/spec-field · POST /:id/ready · POST /:id/abort · GET /events(SSE) | `packages/server/src/routes/tasks.ts` |
| POST /api/tasks body 当前只接受 `org / name / source_chat_session_id` | tasks.ts:103-123 |
| draft 隐式创建路径 = autosave seam（首轮聊天结束时按 `source_chat_session_id` 查无则建） | `routes/clone/autosave.ts`, `clone/index.ts:497-503` |
| chat send path 用 `taskDAO.getBySourceChatSession(sessionId)` 解析任务（spec notice / authoring_resources 注入都走这条路） | `clone/index.ts:310-353` |
| `getPlugins()` 目前无参数，返回 2 个 plugin 目录（agent 共享目录 + clone 目录），由 `sendWithProvider()` 内部调用 | `services/agent/clone-runtime.ts:237-246, 375-384` |
| `CloneRuntime.chat(message, sessionId, providerSessionId, cwd, specUpdateNotice?, authoringResourcesContent?, abortSignal?)` — 注释明确警告参数顺序兼容性 | clone-runtime.ts:280-288 |
| `@@spec_updated` notice 只在 `updateTask`（PUT）里 `setSpecNotice`；`updateSpecField`（POST spec-field）**不设置** notice | `services/tasks/tasks-service.ts:346-360, 373-430` |
| `taskSpecSchema` 定义在 **shared/src/types/scheduler-job.ts:102-114**（不是 spec 模块表写的 task.ts）；`goal.min(1)` + `ac.min(1)` 必填；zod 默认 **strip 未知字段** | scheduler-job.ts |
| PUT /:id 对 task_spec 走 `taskSpecSchema.parse`（tasks.ts:167）→ 未声明的新字段会被静默剥离 | tasks.ts + tasks-service.ts:331-334 |
| `TaskSpecFieldSchema` 固定 8 字段（projects/skills/goal/ac/subunits/integration_goal/resources/authoring_resources），`validateSpecFieldValue` 对未知 field 抛 400 | shared/types/task.ts:32-41, tasks-service.ts:180-214 |
| `readyTask` 不校验 goal/ac 非空；简单任务 materialize 时 `workflow_ref ?? ''` | tasks-service.ts:439-502 |
| **物化发生在 server**: `materializeTaskSpecToConfig`（`services/scheduler/scheduler-service.ts:177`）注入 `input_values.subunit_count`（复合路径）；简单路径 `input_values: {}` | scheduler-service.ts |
| 复合路径运行时 input_values 被 `buildCompositeInputValues` **整体替换**（subunits/subunit_count/goal/integration_prompt） | `scheduler/executors/workflow-executor.ts:264-274, 604-625` |
| 子 subunit workflow 的 input_values = `subunit.input_values`（SubunitSpec 携带），由 `TaskDispatchService.dispatchChildSchedule` 透传 | `scheduler/task-dispatch-service.ts:147,177,208` |
| engine 的 `TaskDispatchExecutor` 只做 subunit 解析 + pause-resume，**简单任务根本不经过它** | `engine/src/executors/task-dispatch.ts` |
| `input_values → $vars` 链路成立: ExecutionLifecycle 持久化 input_values，engine 初始化经 pool.update 合入 `$vars`（composition-task.yaml 注释 + loop.ts:670 佐证） | ExecutionLifecycle.ts:1008-1010 |
| ExecutionService 是 **per-workspace** 的（构造需要 org/workspacePath/workspaceDbId；`executions.workspace_id` NOT NULL FK→workspaces；registry `getExecutionService(workspaceId)`） | `services/execution.ts:40-118`, schema.sql:29-69 |
| 表名是 `executions`（无 `workflow_executions` 表）；**无 metadata 列**（候选载体: input_values / pipeline_config） | schema.sql:29-69 |
| 执行日志可查: `GET /:executionId/logs`（SQLite agent_events + JSONL 降级；swarm `expert_*`/`swarm_*` 事件有存） | `routes/execution.ts:619,791-839` |
| registry.json 每个 entry 有 `group` 字段；114 个 skill，分布 superpowers-zh(20)/built-in(43)/mattpocock-skills(39)/open-spec(12) | `~/.octopus/resources/registry.json` |
| `ResourceEntry` **无 description 字段**（name/type/source/ref/group/installed/verified/status/installedAt/installPath/dependsOn/sourceHash/activated） | shared/src/resource/resource-manager.ts:142-156 |
| `ResourceManager.list({type, installed})` 存在 → skill-groups 聚合数据源可行 | resource-manager.ts:573 |
| swarm schema 支持 `mode: moa` + 静态 `experts[]` + `aggregator`；非 dynamic moa 要求 **≥2 experts 且有 aggregator** | shared/types/workflow.ts:380-391 + swarm.ts:60-66 |
| tasks 表无 schema 变更空间问题（task_spec TEXT JSON），`sessions.scope_id` 存在 | schema.sql:396-442 |
| 原型 VariantL 存在（prototype/page.tsx:3003）；e2e helpers 存在（resource-helpers.ts / task-domain-helpers.ts） | web-app |

---

## 1. Core Stories 选择

| # | Story | 覆盖 | 路径类型 |
|---|-------|------|---------|
| A | 模板页创建（类型+Skill组+语境）→ 编写 → goal/ac 浮现 → 逐条确认 → 入队 → dispatch 注入 artifacts_dir | US1/2/3/4/6/12/14，全栈 UI→API→DB→FS→engine | happy path |
| B | 用户直编 goal/ac → agent 感知 @@spec_updated → 对话改产物 → 索引更新 → 用户查看 | US5/7/8，干预路径（人工覆盖） | intervention path |
| C | agent 建议 MoA 评审 → 用户执行 → 过程日志 → 结构化产出勾选采纳（ac + decisions） | US9/10/11，重型辅助流 + 跨服务（server→engine swarm） | heavy/async path |
| D | 删除 draft → 家目录 reap | US13，清理路径 | cleanup path |

---

## 2. Story Traces

### Story A — 模板页创建 → 编写 → 入队（US1/2/3/4/6/12/14）

```
用户在 /tasks 点 [+新建] → TaskModal(task=null)
  │
  ├─[UI] TemplatePicker 渲染（新组件）
  │       ├─ GET /api/skill-groups?org= → 组列表
  │       │    └─[Exec] server 聚合 ResourceManager.list({type:'skill',installed:true}) 按 entry.group
  │       │         ← [断点 BP-13] ResourceEntry 无 description；response 里
  │       │            skills:[{name,description}] 需要逐个读 SKILL.md frontmatter（契约未注明 best-effort）
  │       ├─ 任务类型卡片（coding/generic）+ Skill 组多选 + org/projects（ProjectSelector 可复用 ✓）
  │       └─ US14: coding 预设仅 org+projects ✓（纯 UI，无断点）
  │
  ├─[UI] 用户点「进入编写」
  │       ← [断点 BP-1 ★CRITICAL] 创建时序未定义:
  │          v2 现状 = 会话先创建，draft 由 autosave 在第一轮聊天后隐式创建
  │          （taskDAO.getBySourceChatSession 查无 → insert）。
  │          v3 = 任务先在模板页创建（带 skill_groups），会话后创建。
  │          chat send path 与 autosave 都靠 tasks.source_chat_session_id 解析任务。
  │          spec 的 POST body 扩展只写了 task_type/skill_groups/preset ——
  │          漏了 source_chat_session_id 与时序约定。若 UI 未先建会话并回传
  │          session_id，autosave 第一轮会创建一个「孪生 draft」，
  │          之后 spec-field 绑定/@@notice/SSE 全部打到错误任务上。
  │       FIX 路径: ① UI 先 POST /api/clones/task-author/sessions 拿 sessionId，
  │          ② POST /api/tasks {source_chat_session_id, task_type, skill_groups, preset}
  │          （SG3 现有逻辑会回写 sessions.scope_id ✓），③ 编写页直接使用该 session。
  │
  ├─[API] POST /api/tasks（扩展 body）
  │       ├─[Data] tasks insert（task_spec JSON 含 task_type/skill_groups）
  │       ├─[Exec] TaskHomeService.create(~/.octopus/tasks/{id}/)（新）
  │       ├─[Exec] PluginMaterializer: registry installPath → {home}/skills/ symlink/junction/copy（新）
  │       │    ✓ 数据源成立: entry.installPath 存在；junction 免管理员（R1 已覆盖）
  │       │    ← [断点 BP-11] 「默认通用」内置组物化内容与 plugin#1（~/.octopus/agent
  │       │       共享 skills，getPlugins 已含）重叠风险未定义
  │       └─[Event] 无（创建无需 SSE）✓
  │
  ├─[UI] AuthoringWorkspace 顶栏 🔒 Skill 组 badges（锁定展示）
  │
  ├─[UI→API] 用户发第一条消息 → POST /api/clones/task-author/sessions/:id/chat
  │       ├─[Exec] send path: getBySourceChatSession(sessionId) → task → taskHomePath
  │       │    ├─ clone-runtime.chat(..., taskHomePath?) → getPlugins(taskHomePath)
  │       │    │    ← [断点 BP-15 LOW] chat()/sendWithProvider() 需穿线新参数
  │       │    │       （getPlugins 改动在模块表有，但 chat 签名改动未提）
  │       │    ├─ SDK 扫描第 3 plugin 目录 {home}/skills/ ✓（机制与现有 2 目录同构）
  │       │    └─ system prompt append 产物目录绝对路径一行 + Skill 组锁定上下文
  │       │         ✓ 缝隙存在（specUpdateNotice/authoringResourcesContent 同一 concat 点，
  │       │           clone-runtime.ts:366-373）
  │       └─[Exec] turn-end autosave: getBySourceChatSession 命中已链接任务 →
  │            updateAutosave（仅 name+updated_at）✓ 不产生孪生 draft（前提: BP-1 修复）
  │
  ├─[Event→UI] agent curl POST /api/tasks/:id/spec-field {field:'goal'|'ac'}
  │       ├─[Exec] updateSpecField: merge task_spec + version+1（merge 保留未知字段 ✓）
  │       ├─[Event] SSE spec_field_update（taskpool 通道，已有 ✓）
  │       └─[UI] OutputViewer goal/ac 卡浮现（D8 ghost→实体）✓ 机制已验证
  │            （spec-panel.tsx 现有 applySpecField 同构可移植）
  │
  ├─[UI] 用户逐条确认 goal/ac
  │       ← [断点 BP-5 ★HIGH] 确认状态无处安放:
  │          数据模型只新增 task_type/skill_groups/decisions —— 无 confirmed 概念。
  │          若纯 UI 态: 关弹窗重开 draft 确认全丢；agent 后续 re-bind 也无法区分
  │          「已确认」与「新浮现」。且 readyTask 服务端零校验（空 goal/ac 也能 ready，
  │          简单任务 workflow_ref='' 到运行期才炸）。
  │       FIX: task_spec 增加确认态字段（如 goal_confirmed: boolean +
  │          ac_confirmed: string[]）经 spec-field/UI 持久化；readyTask 校验
  │          goal 非空 ∧ ac≥1 ∧ 全部已确认，否则 409。
  │
  ├─[API] POST /api/tasks/:id/ready（确认后）
  │       └─[Exec] materializeTaskSpecToConfig → schedules envelope
  │            ← [断点 BP-2 ★CRITICAL 关联] 若期间任何一次 [保存草稿]/PUT 全量
  │               task_spec 发生过，task_type/skill_groups 已被 zod strip（见 BP-2）
  │
  └─[Exec] 运行期 claim → workflow-executor
        ├─ 简单: input_values = workflow_chain[0].input_values
        ├─ 复合: input_values = buildCompositeInputValues(...)（整体替换!）
        └─[Data] $vars.task_artifacts_dir ?
             ← [断点 BP-7 ★HIGH] spec 模块表把注入点写在 engine/task-dispatch.ts，
                但: ① 简单任务不经过 task_dispatch；② 复合 coordinator 的
                input_values 被 buildCompositeInputValues 替换，materialize 注入
                会丢；③ 子 subunit 的 input_values 来自 SubunitSpec（yaml/服务端
                需补）。真正注入点 = server scheduler-service.materializeTaskSpecToConfig
                + workflow-executor.buildCompositeInputValues + (engine task-dispatch
                或 composition-task.yaml input_mapping)。详见 BP-7。
```

### Story B — 用户直编 goal/ac → agent 感知 → 改产物（US5/7/8）

```
用户在 OutputViewer 直编 goal 或某条 ac
  │
  ├─[UI→API] 提交编辑
  │    spec D7: 「用户直编（POST spec-field → @@spec_updated 通知 agent）」
  │       ← [断点 BP-4 ★HIGH] 信号链断裂:
  │          现状 setSpecNotice 只在 updateTask(PUT) 触发；updateSpecField 不触发。
  │          且 spec-field 同时是 agent 自己的工具 —— 无差别触发会让 agent
  │          收到自己编辑的 @@spec_updated。API 契约没有 source 判别参数。
  │          US5 验证方法写了「POST spec-field(用户源)」——「用户源」这个概念
  │          在 API 契约里不存在。
  │       FIX: POST spec-field body 增加 source?: 'user'|'agent'（默认 agent）；
  │          source==='user' 时 setSpecNotice(id, `@@spec_updated: ${field}`)。
  │
  ├─[Data] task_spec merge + version+1 ✓（现有）
  ├─[Event] spec_field_update SSE ✓（其他窗口同步）
  │
  ├─[UI→API] 用户下一轮发消息
  │       └─[Exec] send path getSpecNotice(taskId) → system prompt append @@spec_updated ✓
  │            （05 机制已验证，clone/index.ts:310-316）
  │
  ├─ agent 据 @@spec_updated 用 Write 修改 {home}/artifacts/spec.md（绝对路径，D6 ✓）
  │       ← [断点 BP-12 MEDIUM] artifacts.json 由 agent 自觉维护（R4），
  │          写坏 schema 时 GET /artifacts 的降级行为只定义了「不存在→[]」，
  │          未定义「malformed→?」
  │
  └─[UI] OutputViewer 产物列表刷新?
        ← [断点 BP-8 ★MEDIUM] taskpool 通道只有 task_status/spec_field_update/
           schedule_status —— 产物变更无任何事件/轮询约定，列表停留旧态。
```

### Story C — MoA 辅助工作流: 建议 → 执行 → 日志 → 采纳（US9/10/11）

```
agent 在对话中建议运行 moa-requirements-review（气泡 = LLM 文本，R2 manual ✓）
  │
  ├─[UI] 用户点「执行」→ POST /api/tasks/:id/assist-workflows {template, input?}
  │       ├─[Exec] AssistWorkflowService 校验 template ∈ 3 个白名单 ✓（设计明确）
  │       └─[Exec] 启动执行……
  │            ← [断点 BP-6 ★HIGH] 宿主缺失:
  │               ExecutionService 是 per-workspace（executions.workspace_id NOT NULL
  │               FK→workspaces；registry 按 workspaceId 取 service）。
  │               draft 期任务没有 workspace（workspace 在 dispatch 才物化）。
  │               spec 只写了「run = 一次 execution，metadata 记 task_id+template」:
  │               ① 表名实为 executions（无 workflow_executions 表）；
  │               ② executions 无 metadata 列；
  │               ③ 未决定在哪个 workspace/cwd 跑 swarm（专家是纯 LLM，
  │                  但 ExecutionService 构造强制要 workspacePath）。
  │            FIX: 定义 authoring 执行宿主 —— 例如以任务家目录为 workspacePath
  │               注册 assist 执行上下文（workspaces 行 source='task-assist'，
  │               或 AssistWorkflowService 自建轻量 ExecutionService 实例），
  │               task_id+template 记入 pipeline_config 或 input_values 约定键。
  │
  ├─[Exec] engine swarm executor: mode moa, 静态 experts ≥2 + aggregator
  │       ✓ schema 支持（validateSwarmConstraints: moa 非 dynamic 需 ≥2 experts
  │         + aggregator —— spec 示意 yaml 3 experts ✓）
  │       ✓ input: goal/ac/projects 经 input_values → $vars ✓（链路成立）
  │
  ├─[UI] 用户看过程日志 → GET /api/tasks/:id/assist-workflows/:runId
  │       └─ logs ← execution 节点日志 ✓ 机制存在（agent_events + JSONL，
  │            expert_*/swarm_* 事件有存；execution.ts /:id/logs 同构可读）
  │       ← [断点 BP-8 MEDIUM] run 状态变化（running→done）无 SSE，
  │          UI 只能轮询 —— spec 未写明轮询约定
  │
  ├─[Exec] run 完成 → aggregator 输出 JSON → AssistWorkflowService 解析
  │       ← [断点 BP-10 MEDIUM] LLM 输出 malformed JSON 时无降级定义
  │          （output 为空的「完成」= 用户视角的静默失败）
  │
  └─[UI] MoA 卡片勾选采纳
        ├─ ac 候选 → POST spec-field {field:'ac', value: merged} ✓ 现有端点可用
        └─ 建议 → task_spec.decisions
             ← [断点 BP-3 ★HIGH] decisions 孤儿字段:
                TaskSpecFieldSchema 无 'decisions'（validateSpecFieldValue → 400
                unknown field）；PUT 路径又被 taskSpecSchema strip（BP-2）。
                decisions 目前没有任何可写入通道。
```

### Story D — 删除 draft → reap（US13）

```
用户 DELETE /api/tasks/:id（draft）
  ├─[Exec] deleteTask 软删 + cascade-reap schedules ✓（现有）
  ├─[Exec] TaskHomeService.reap(~/.octopus/tasks/{id}/)（新增钩子）
  │    ← [断点 BP-14 LOW] ① {home}/skills 里是 junction/symlink —— reap 必须
  │       只删链接不穿透目标（Windows 行为需单测锁定，R1 可延伸）；
  │       ② DELETE 对 ready 也放行（软删 draft/ready），reap 仅定义了 draft，
  │       ready 删除时家目录归属未说明；
  │       ③ 软删后 getBySourceChatSession 返回 null（deleted_at 过滤 ✓），
  │       同 session 继续聊天会静默创建新 draft —— 建议 UI 在删除时提示/关闭会话。
  └─[Data] 家目录消失 ✓（验证方法 readdir 断言成立）
```

---

## 3. Anti-Pattern Audit（6 项）

| 反模式 | 命中 | 位置 |
|--------|------|------|
| **Magic Bridge** | ✅ ×2 | BP-1（模板页创建的任务 ↔ 聊天会话的链接时序缺失）；BP-6（AssistWorkflowService ↔ ExecutionService 之间没有可用的 workspace 宿主） |
| **Orphan Field** | ✅ ×2 | BP-3（decisions 无写入通道）；BP-2（task_type/skill_groups 写入后被 zod strip —— 写了但留不住） |
| **Silent Failure** | ✅ ×2 | BP-10（aggregator JSON 解析失败无降级）；BP-12（artifacts.json malformed 降级未定义） |
| **Missing Trigger** | ✅ ×2 | BP-8（产物/assist-run 变更无事件、无轮询约定）；BP-5（「逐条确认」无任何持久化与校验触发点） |
| **Unversioned State** | ✅ ×1 | BP-9（skill_groups 锁定仅 UI 层；BP-2 修复后 PUT 可静默改写锁定字段，无拒绝逻辑）。注: spec-field/PUT 本身有乐观锁 ✓，问题只在「锁定字段缺写保护」 |
| **Unconnected Feedback** | ✅ ×2 | BP-4（用户直编 → @@spec_updated 信号链在 spec-field 路径断裂）；BP-7（简单任务路径下 $vars.task_artifacts_dir 到不了执行工作流 —— 注入信号与真实物化点不匹配） |

---

## 4. Break Points 目录

> 严重度定义按协议: CRITICAL=故事无法推进；HIGH=推进但结果错误/不完整；MEDIUM=UX 降级；LOW=外观/便利。

### BP-1 · CRITICAL · 创建时序与会话链接未定义（autosave 孪生 draft）
- **影响故事**: US1（连带 US4/5 全部 SSE 联动打错任务）
- **描述**: v3 把创建从「autosave 隐式」改为「模板页显式 POST」，但 chat send path / autosave / spec-notice 全部依赖 `tasks.source_chat_session_id`。spec 的 POST body 扩展未含 `source_chat_session_id`，也未规定「先建会话后建任务」的时序。不链接 → 第一轮 autosave 创建第二个 draft → 双任务、SSE/notice 错位。
- **修复**:
  1. API 契约: POST /api/tasks body = `{ task_type, skill_groups[], preset:{org,projects}, source_chat_session_id }`；
  2. Key Decision 增补时序: UI 先 `POST /api/clones/task-author/sessions` → 再 POST /api/tasks（SG3 现有 scope_id 回写复用）；
  3. AC: 创建后 `tasks.source_chat_session_id == sessionId ∧ sessions.scope_id == task.id ∧ 首轮后无第二 draft（listTasks 断言）`。

### BP-2 · CRITICAL · task_spec 新字段被 zod strip + schema 文件指错
- **影响故事**: US3（锁定持久化）、US11（decisions）、任何全量保存
- **描述**: `taskSpecSchema` 在 **scheduler-job.ts**（spec 模块表写 task.ts），z.object 默认 strip 未知键。PUT /:id 与 tasks-service.updateTask 都走 `taskSpecSchema.parse` → `task_type/skill_groups/decisions` 在任何一次全量保存后静默消失。skill_groups 丢失 = 锁定态丢失 = 会话语境漂移。
- **修复**:
  1. 模块表改为 `shared/src/types/scheduler-job.ts`（taskSpecSchema）+ task.ts（TaskSpecField/新类型）；
  2. taskSpecSchema 增补: `task_type: z.enum(["coding","generic"]).optional()`, `skill_groups: z.array(z.string()).default([])`, `decisions: z.array(z.string()).default([])`；
  3. AC: PUT 全量保存往返后 GET 返回的 task_spec 仍含 task_type/skill_groups/decisions（round-trip 断言）。

### BP-3 · HIGH · decisions 无写入通道（孤儿字段）
- **影响故事**: US11（MoA 建议采纳）
- **描述**: spec 说「采纳 decisions 复用 spec-field 端点」，但 TaskSpecFieldSchema 只有 8 字段，`validateSpecFieldValue` 对 'decisions' 抛 unknown field → 400；PUT 路径又被 strip（BP-2）。
- **修复**: TaskSpecFieldSchema 加 `"decisions"` + validateSpecFieldValue case（`z.array(z.string())`）+ SpecPanel/OutputViewer applySpecField case；AC: POST spec-field {field:'decisions'} → 200 + DB task_spec.decisions 含值 + SSE 事件可被 UI 应用。

### BP-4 · HIGH · 用户直编 → @@spec_updated 信号链断裂
- **影响故事**: US5
- **描述**: `setSpecNotice` 只在 updateTask(PUT) 内；spec-field 路径不触发，且该端点同时是 agent 工具（无差别触发会自我通知）。API 契约无 `source` 判别，而 US5 验证方法却写了「POST spec-field(用户源)」。
- **修复**: POST /:id/spec-field body 增 `source?: "user" | "agent"`（默认 agent，agent curl 不传 = 行为不变）；`source==="user"` 时 `setSpecNotice(id, "@@spec_updated: " + field)`。AC: spec-field(user) 后下一轮 chat 的 system prompt append 含 @@spec_updated；spec-field(agent) 不产生 notice。

### BP-5 · HIGH · 逐条确认态无存储、入队无服务端门禁
- **影响故事**: US6（连带 US12 —— 未确认意图可能入队）
- **描述**: 「逐条确认 goal/ac」是入队门禁，但确认态不在数据模型、不在 API；纯 UI 态会在关闭/重开 draft 时丢失，且 agent re-bind 会覆盖「已确认」语义。readyTask 服务端不校验 goal/ac（空 spec 可 ready；简单任务空 workflow_ref 到运行期才失败）。
- **修复**:
  1. 数据模型: task_spec 增 `goal_confirmed?: boolean` + `ac_confirmed?: string[]`（已确认条目原文快照，re-bind 时可比对失效）；
  2. 写入通道: 经 spec-field（需 BP-3 同款扩枚举）或专用 UI→PUT 局部更新；
  3. readyTask 校验: goal 非空 ∧ ac.length≥1 ∧ 全部已确认，否则 409 + 错误消息指明缺失项；
  4. AC: 未确认 POST ready → 409；全部确认后 → 200；重开 draft 确认态仍在。

### BP-6 · HIGH · assist workflow 执行宿主缺失（draft 期无 workspace）
- **影响故事**: US9/US10/US11（整个辅助流）
- **描述**: ExecutionService per-workspace（workspace_id NOT NULL FK）；draft 期无 workspace。spec 数据模型写「workflow_executions 复用」但实表为 `executions` 且无 metadata 列；未决定 swarm 在哪里跑（cwd/workspacePath 是 ExecutionService 构造必需）。
- **修复**:
  1. Key Decision 增补（建议 D15/D16）: assist 执行宿主方案 —— 推荐以任务家目录为 workspacePath 注册轻量执行上下文（workspaces 行 `source='task-assist'`，org=任务 org），或 AssistWorkflowService 直接构造 ExecutionService（db/sse 已有，workspacePath=home）；
  2. task_id+template 记入 `executions.pipeline_config`（或 input_values 约定键 `_assist:{task_id,template}`），数据模型表名改 `executions`；
  3. AC: POST assist-workflows → executions 行存在且 workflow_ref=template、可按 task_id 反查；GET :runId 能取到状态。

### BP-7 · HIGH · $vars.task_artifacts_dir 注入点写错模块、三条路径未全覆盖
- **影响故事**: US12
- **描述**: 模块表写 engine/task-dispatch.ts，但物化在 server `materializeTaskSpecToConfig`；engine TaskDispatchExecutor 只在复合子任务派发时运行（简单任务不经过）。三条消费路径: ① 简单 primary = chain[0].input_values（当前 `{}`，server 注入即可）；② 复合 coordinator = buildCompositeInputValues **整体替换** input_values（只在 materialize 注入会丢）；③ 子 subunit = SubunitSpec.input_values（需 composition-task.yaml input_mapping 或 TaskDispatchService/Executor 富化）。
- **修复**:
  1. 模块表改为: server/scheduler-service.ts（materialize 简单路径 + buildCompositeInputValues 复合路径注入 `task_artifacts_dir: ~/.octopus/tasks/{id}/artifacts` 绝对路径）+ engine/task-dispatch.ts 或 composition-task.yaml（子任务传递，`input_mapping: task_artifacts_dir: "$vars.task_artifacts_dir"`）；
  2. AC 三条: 简单/复合 coordinator/子 subunit 各断言 `$vars.task_artifacts_dir == 家目录 artifacts 绝对路径`。

### BP-8 · MEDIUM · 产物与 assist-run 无刷新通道（unconnected feedback）
- **影响故事**: US7/US8/US10/US11
- **描述**: taskpool SSE 只有 task_status/spec_field_update/schedule_status。agent 更新产物后 OutputViewer 无感知；assist run 完成后 MoA 卡片无出现时机。
- **修复**: 二选一并写入 API 契约: (a) 新增 SSE 事件 `task_artifacts_update` / `assist_run_update`（artifacts.json 变更可由 route 写入时触发 —— 若坚持 agent 直写文件则只能轮询）；(b) OutputViewer 打开期间 + 每轮 chat done 后轮询 GET artifacts / :runId（写明间隔，如 3s）。推荐 (b) 起步 + turn-done 强刷（零新机制，与 R2 一致）。

### BP-9 · MEDIUM · skill_groups 锁定缺服务端写保护
- **影响故事**: US3
- **描述**: 锁定目前只有 UI（🔒 无下拉）。BP-2 修复后 skill_groups 进入 taskSpecSchema，PUT 全量保存即可静默改组（无拒绝逻辑）——「创建后锁定」承诺在 API 层不成立。
- **修复**: TasksService.updateTask 检测 task_spec.skill_groups/task_type 与现值不一致 → 抛 TaskStatusConflictError(409)（创建后不可变）；AC: PUT 携带变更的 skill_groups → 409，家目录 plugin 不变。

### BP-10 · MEDIUM · MoA 聚合 JSON 解析失败无降级（silent failure）
- **影响故事**: US11
- **描述**: 结构化产出依赖解析 LLM 聚合文本；malformed → output 空 → 「完成但无可采纳」无提示。R2 只说 LLM 非确定性 manual 验证，未定义运行时降级。
- **修复**: AssistWorkflowService 解析失败时 GET :runId 返回 `{ status:'done', output_raw: <聚合原文>, output_parse_error: true }`；UI 展示原文 + 手动复制；AC: malformed JSON fixture → output_raw 存在、无 500、卡片降级态渲染。

### BP-11 · MEDIUM · 「默认通用」组语义未定义（与 plugin#1 重叠）
- **影响故事**: US1/US2
- **描述**: getPlugins 已含共享 skills 目录（~/.octopus/agent/skills 经 plugin#1 被 SDK 扫描）。若「默认通用」组把同一批 skills 再物化进 {home}/skills/，SDK 将看到双份同名 skill，优先级未定义。
- **修复**: Key Decision 增补: 「默认通用」= 空标记（不物化，共享 skills 天然可得）或显式 curated 清单（与共享目录不重叠）；AC: 仅选默认组时 {home}/skills 内容符合定义且 SDK skill 列表无重复名。

### BP-12 · MEDIUM · artifacts.json 写坏时无读侧降级定义
- **影响故事**: US7/US8
- **描述**: 索引是单一事实来源但由 agent 直写（persona 自觉）。spec 只定义「不存在→[]」；malformed JSON / schema 不符的降级未定义。
- **修复**: TaskHomeService 读侧: malformed → [] + error 日志 + （可选）`_degraded` 标记；persona 内嵌 artifacts.json 精确 schema + 示例；integration 测试: 写坏文件 → GET 200 []。

### BP-13 · LOW · skill-groups 的 description 数据源缺失
- **影响故事**: US1
- **描述**: ResourceEntry 无 description；response 形状 `skills:[{name,description}]` 需要逐个读 SKILL.md frontmatter（N 次文件读）。
- **修复**: API 契约注明 description best-effort（读 frontmatter 失败→空串），或从 response 形状删除 description。

### BP-14 · LOW · reap 边界（junction 语义 / ready 删除 / 遗留会话）
- **影响故事**: US13
- **描述**: ① skills/ 内是 junction/symlink，reap 须只删链接不穿透（Windows 单测锁定）；② DELETE 对 ready 放行但 reap 只定义了 draft；③ 软删后同 session 继续聊天会静默新建 draft。
- **修复**: Risks 增补三条；单测覆盖 junction reap；明确 ready 删除是否 reap（建议 reap，产物已无消费者）。

### BP-15 · LOW · getPlugins 参数穿线
- **影响故事**: US1/US2
- **描述**: 模块表写了 `getPlugins(taskHomePath?)`，但调用链 chat()→sendWithProvider()→getPlugins() 的签名穿线未提（chat 已有参数顺序兼容性警告注释）。
- **修复**: Implementation Decisions 注明 chat()/sendWithProvider() 追加末尾可选参数 `taskHomePath?: string`，仅 task-author send path 传值，其余调用者不传（行为不变）。

---

## 5. 无需修复的已验证链路（避免过度设计）

| 链路 | 状态 |
|------|------|
| spec_field_update SSE → UI 实时应用（浮现机制 D8） | ✓ 现有（spec-panel.tsx applySpecField 同构） |
| @@spec_updated 反向通知机制（05 seam） | ✓ 现有，仅需 BP-4 的 source 扩展 |
| registry group 聚合 → GET /api/skill-groups 数据源 | ✓ ResourceManager.list + entry.group/installPath |
| swarm moa 静态 experts + aggregator YAML 形态 | ✓ schema 校验规则吻合（≥2 experts + aggregator） |
| 执行日志（含 swarm expert 步骤）可查 | ✓ agent_events + JSONL + /:executionId/logs 同构 |
| input_values → $vars 注入链路 | ✓ pool.update 语义（composition-task.yaml 注释佐证） |
| 乐观锁 / 版本冲突（spec-field 与保存） | ✓ updateWithVersion 现有 |
| e2e 测试基建（resource-helpers / task-domain-helpers / draft-linkage spec） | ✓ 存在，可复用 |
| 原型 VariantL（UI 结构参照） | ✓ prototype/page.tsx:3003 |

---

## 6. 对 spec.md 的建议改动清单（供 parent agent）

1. **Key Decisions**: 增补 D15（创建时序与会话链接，BP-1）、D16（assist 执行宿主，BP-6）、D17（默认通用组语义，BP-11）、D18（确认态模型与入队门禁，BP-5）。
2. **API Contracts**: POST /api/tasks body 增 `source_chat_session_id`；POST spec-field 增 `source` 与 `decisions` field；GET assist-workflows/:runId response 增 `output_raw/output_parse_error`；产物/assist 刷新策略（BP-8）。
3. **Data Model**: taskSpecSchema（scheduler-job.ts）增 task_type/skill_groups/decisions + goal_confirmed/ac_confirmed；表名 executions 纠正；锁定字段写保护（BP-9）。
4. **Modules**: engine/task-dispatch.ts 改为 server scheduler-service + workflow-executor（BP-7）；clone-runtime 增 chat 签名说明（BP-15）。
5. **AC Mapping**: US1 增时序断言；US3 增 409 服务端断言；US5 改「spec-field(user源)」为契约化参数；US6 增服务端 409；US11 增 decisions 写入 + 解析降级；US12 拆三条路径断言。
6. **Risks**: 增补 BP-10/12/14 对应条目。
