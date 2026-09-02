# 09 — skill_groups/preset/goal/ac 退场影响面（research）

Type: research
Status: resolved

## Question

用户已定方向（D7：四者全部取消，"都在 spec 以及其他产物里了"）。摸清退场爆炸半径：

1. schema：taskSpecSchema goal min(1)/ac min(1)（shared/scheduler-job.ts:111）— 字段保留为 optional/deprecated vs 删除的影响
2. ready-gate（tasks-service.ts:1006-1069）：goal/ac/confirmed/required-inputs 校验链拆除后 gate 还剩什么（phase 数量≥1？workflow 绑定？）
3. UI：TemplatePicker（skill_groups 勾选）、GoalAcCard、WorkflowBox/preset 过滤、入队清单四行的拆除与替代
4. preset 体系：workflow-presets-seed/service/route/consumers 全链，general-dev→task-dev 迁移史
5. template-resolver ${goal}/${ac} 占位符、buildCompositeInputValues（composite 依赖 goal/integration_prompt——out of scope 但共字段，需兼容策略）
6. goal 模式（agent 节点 goal: 字段）还有没有 task 域入口；spec-field 9 字段哪些存活（projects/subunits→phases?/resources）
7. 测试/E2E spec 清单（tasks-v3-*.test、task-domain-*.spec 哪些重写）

## Answer

### 结论先行

**四个机制都不能"物理删除"，只能 coding 路径停用 + schema 降级。** 三处隐藏耦合决定了这一点（危险度排序）：

1. **composite 与辅助工作流共吃 task_spec.goal/ac** — `buildCompositeInputValues` 把 goal 当 moa topic（workflow-executor.ts:720,732）、`assist-workflow-service.buildInputValues` 把 goal+ac 喂给 moa-requirements-review / spec-review-swarm / clarify-debate（assist-workflow-service.ts:537-560）。删字段 → 这两条路静默变空输入。
2. **generic 任务与 coding 共享 taskSpecSchema**（goal/ac 是全局必填，schema 不分 task_type，shared/scheduler-job.ts:111-112）。coding 停用后 generic 仍靠 goal/ac 撑起草稿对话 + gate。只能 schema 转 optional + gate 按 task_type 分叉。
3. **goal 有三个"不起眼"的下沉消费者**：workspace 展示名从 spec.goal 前 20 字生成（task-ws-name.ts:20-29）、agent 读 `{home}/spec.json` 的 goal/ac 快照协议（tasks-service.ts:946-960 + task-author SKILL.md:50-63）、`context.md` 含 skill_groups 清单（tasks-service.ts:922-936 → taskHomeService.writeContextFile）。删字段不删这三处 → ws 名退化、agent 按文档读不到快照。

### 爆炸半径明细表

| 机制 | 消费方（文件:行号） | 处置建议 | 风险 |
|---|---|---|---|
| **task_spec.goal/ac** | schema 必填 `shared/types/scheduler-job.ts:111-112`；ready-gate 6 项中 4 项 `tasks-service.ts:1008-1013`；required-inputs 占位解析 `tasks-service.ts:1046-1049`；materialize 传参 `scheduler-service.ts:221-222`；占位符语义 `scheduler/template-resolver.ts:9-10,47-48`；composite moa topic `executors/workflow-executor.ts:720,732`；assist 三工作流入参 `assist-workflow-service.ts:537-560`；ws 命名 `scheduler/task-ws-name.ts:20-29`；spec.json 快照 `tasks-service.ts:946-960` | coding：gate 改查 phase 完备性，goal/ac 转 optional 保留字段；generic/composite 维持现状；ws 命名 fallback=task.name；spec.json 快照扩展为 phase specs 索引 | 中。字段转 optional 后所有 `parseJSON<TaskSpec>(…, {goal:"",ac:[]})` 兜底点行为不变（已空串兜底），主要是 gate/UI 分叉 |
| **goal_confirmed/ac_confirmed/decisions** | schema `scheduler-job.ts:136-139`；gate `tasks-service.ts:1010-1013`；spec-field switch `tasks-service.ts:854-865`；MoA 采纳 `decisions` 见 assist 链 | confirmed 双字段随 goal/ac 停用（generic 保留）；**decisions 保留**——它绑 MoA 采纳流（assist 依赖），且 phase spec 需要决策记录位 | 低 |
| **skill_groups** | schema 默认 `scheduler-job.ts:130`；createTask 落盘+物化 plugin 目录 `tasks-service.ts:440-448,481`；**创建后锁定** SW-BP9 `tasks-service.ts:665-712`、`routes/tasks.ts:155-156,285-286`；task-author 会话 plugin `routes/clone/index.ts:429-431`；context.md 注入 `tasks-service.ts:779-781,922-936`；UI TemplatePicker 勾选 / WorkflowBox 过滤 / `lib/skill-groups-api.ts` | coding 创建时**不再暴露勾选**，固定注入内置组（= matt 套件进 task-author clone 自身 skills 目录，ADR-0010 的 per-task plugin 机制保留给 generic）；UI 勾选仅 generic 或整体下线（票 09 决议：下线勾选控件，字段留） | 低-中。注意别删 PluginMaterializer 本体——generic 草稿会话仍靠它加载技能 |
| **preset catalog 全链** | seed `services/agent/workflow-presets-seed.ts:146-169`（v2 三条 general-dev/xzf-dev/superpowers-task-dev）；seed/迁移 `clone-init-service.ts:122-133`（写 `~/.octopus/agent/built-in/task-author/workflow-presets.yaml`）；service 读取+组过滤 `workflow-presets-service.ts:26-28,80-89`；route `routes/workflow-presets.ts:14-22`；UI `lib/workflow-presets-api.ts`、`authoring/workflow-box.tsx:149,161,206-231`、`spec-panel.tsx:49,285`（v2 复用 WorkflowBox）；agent 推荐协议 `task-author/SKILL.md:189`；测试 `services/__tests__/workflow-presets-service.test.ts`、`agent/__tests__/workflow-presets-seed.test.ts`、`authoring/__tests__/workflow-box.test.tsx` | **整链退役**（preset 概念消失），但 phase 仍要绑 workflow_ref → 「工作流目录浏览 + input_values 表单」能力保留，数据源改 `GET /api/workflows/built-in`（builtin-workflow list，顺带修其 S1/S4 无缓存问题）；resolverDeps 解析集不变（ADR-0013 的 resolution set 部分保留，HOW-handoff 单次绑定部分作废） | 中。**命名冲突警告**：`CreateTaskInput.preset`（tasks-service.ts:217-220，模板预选项 org+projects）与 workflow-preset 无关，重构时勿误删 |
| **goal 模式（引擎）** | agent 节点 goal 分支 `engine/executors/agent.ts:389-490`（buildGoalPrompt//goal 直通）；节点级 `goal:` 仅两处 YAML：`task-dev.yaml:57`、`superpowers-task-dev.yaml:117`（inputs 亦 goal/ac）；composition-task 的 goal 是 variables 名非节点 goal | task 域入口（general-dev→task-dev）退役后这两个 YAML 无看板绑定路径，随 preset 退役（文件或转手动跑）；**引擎 goal: 字段与 /goal 适配器保留**（通用能力，与本次退场正交）| 低。R8 教训：确认无用户环境的 `workflow-presets.yaml` 还挂着旧绑定即可 |
| **ready-gate 拆后剩余** | `tasks-service.ts:984-1080` | coding v4 gate 候选：phase≥1 ∧ 每 phase spec 存在 ∧ 每 phase workflow_ref 可解析 ∧（可选）task.name；`missing[]` 的 UI 消费链（authoring-workspace gateMissing 红条、`TaskReadyGateError` routes/tasks.ts:344-）结构不变仅换 key | 低 |
| **spec-field 端点 12 字段命运** | switch `tasks-service.ts:852-884`：goal/ac/subunits/integration_goal/decisions/goal_confirmed/ac_confirmed → task_spec；skills/projects/resources/authoring_resources → 列；workflow_ref → 列（fail-fast 解析） | 存活：projects、resources、authoring_resources、decisions；停用（coding）：goal、ac、goal_confirmed、ac_confirmed；composite 保留：subunits、integration_goal；**新增**：phases[]（或 phase 级子资源端点）+ per-phase workflow_ref 绑定替代任务级（任务级 workflow_ref 列留供 generic/v2） | 低 |

### 测试/E2E 重写清单

- server：`tasks-v3-gates.test.ts`、`tasks-v3-ready-inputs.test.ts` 必重写（gate 语义变）；`tasks-v3-dispatch.test.ts`、`tasks-routes.test.ts`、`tasks-v3-routes.test.ts`、`tasks-v3-assist.test.ts`（goal 入参）改断言；`scheduler-task-spec.test.ts`、`workflow-presets-service.test.ts`+`workflow-presets-seed.test.ts` 删除或迁移；`task-dispatch-service.test.ts`/`tasks-trigger-mutex.test.ts` 大概率不动
- web e2e：`task-domain-simple.spec.ts`、`task-domain-draft-linkage.spec.ts`、`task-authoring-v3.spec.ts` 随 UI 重写；`task-domain-composite.spec.ts` 保留（out of scope）；`task-domain-crash-abort.spec.ts` 看 abort 语义
- web 组件测试：`goal-ac-card.test.tsx`、`template-picker.test.tsx`、`workflow-box.test.tsx`、`authoring-workspace.test.tsx`、`task-modal-composite.test.tsx`、`task-modal-spec-panel.test.tsx` 中前三者重写
- `task-author/SKILL.md`：描述行（9 字段）、:32-46 task_spec 形状、:50-63 spec.json 读取协议、:84-108 spec-field 表、:189 preset 推荐段 → 全部按 phase 模型重写（这本身是升级版 spec agent 票 06 的交付范围）

### 给票 01/02/10 的直接输入

- 票 01 状态机：gate 改造点唯一在 `readyTask` 的 `task_type` 分叉处，加 `coding-v4` 分支即可，v2/generic 通道原样保留
- 票 02 数据模型：phases 若进 task_spec JSON（同 subunits 模式）可复用 spec-field/SSE/乐观锁全链，省一张表但失去 SQL 查询能力——与 schedule 映射关系决定取舍
- 票 10 迁移：存量 coding 任务全部无 phases 字段 → 读时补 `phases=[{legacy:true}]` 的视图层派生比数据迁移便宜；`goal/ac` 转 optional 的 zod 升级对存量行零破坏（default 兜底已在）
