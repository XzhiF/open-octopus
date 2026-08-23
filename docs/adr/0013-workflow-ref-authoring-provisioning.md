# ADR-0013: workflow_ref 的归属与供给 — authoring agent 拥有 HOW,自建 flow 落 task home + 分发拷贝

Date: 2026-08-23
Status: Accepted
Related: **amends** ADR-0008 (composition-layer-workflow-task-dispatch) 的 "spec (WHAT) + workflow_ref (HOW)" 缺口; task-workflow-handoff brief

## Context

ADR-0008 建立任务模型: **spec (WHAT) + workflow_ref (HOW)**。但模型断言每个任务"天生带着" workflow_ref 后,**从未有人认领"这个值由谁、在什么时候、以什么方式填充"**:

- `task-author` skill(`SKILL.md:178`)明说 "你只产 task_spec;workflow_ref/composition 编排是 HOW",作者自我约束不产。
- dispatch seam(`TasksService.readyTask`)把 `tasks.workflow_ref` 原样物化进 `workflow_chain[0].workflow_ref`(`scheduler-service.ts:239`,空值 `?? ''`)。
- 空 ref 在执行器侧才炸: `EngineFactory.resolveWorkflowWithSnapshot` 三步(`{ws}/state` 快照 → `{ws}/workflows/` → 资源库已安装)全空 → `Workflow not found: `,发生在**已 claim + 已建 ws + 已建 execution** 之后——白烧一个 claim 槽和一个 workspace。

此前一次修复(`tasks-service.readyTask` gate, 2026-08-23)把"简单任务 workflow_ref 非空"加进 v3 入队门槛,让空 ref 在入队时就被拒(409 + missing `workflow_ref`)。但**门把上了,钥匙没人发**:UI(8 个 bindable spec-field 不含 workflow_ref)+ authoring 流程都没有任何给 workflow_ref 赋值的路径,simple v3 任务从此被永久挡在入队前。

同时存在来源蔓延问题:`~/.octopus/workflows/` 全局目录被 `WorkspaceScaffold.copyBuiltInWorkflows`(`workspace.ts:357`)拷贝进**每一个**执行 ws —— 共享可变全局命名空间,任何任务都能"意外命中",且与预检语义冲突。

## Decision

**authoring agent 拥有 HOW 的选择权,task 自带其工作流文件:**

1. **选择权归 authoring agent(用户确认)**:任务 authoring 对话在确认 goal/ac 之后、宣布可入队之前,agent 必须执行 HOW-handoff:枚举可复用工作流(`GET /api/workflows/built-in` 已安装清单)→ 给出推荐 + 理由 → **用户确认 / 指定换一个 / 说"没有" → agent 自建**。复用或自建选定后绑定 `workflow_ref`。绑定是确认 gate 的一部分:SpecPanel 展示绑定值 + 可打开查看;用户不看直接入队,后果自负。

2. **workflow_ref 并入 spec-field 可绑通道**:`ServerSpecField` 增加 `workflow_ref`,与 goal/ac/确认标记同走 `POST /:id/spec-field` → bump version → `spec_field_update` SSE → SpecPanel 实时更新。复用既有机制,不发明新工具;task_spec 之外它是顶层列字段(与 `skills` 同处理模式)。

3. **绑定即预检(fail-fast)**:`updateSpecField(field=workflow_ref)` 时立刻 resolve 一次,**命中以下解析集才算过**,否则 400 `workflow not resolvable`:
   - ① 已安装内置工作流(BuiltInWorkflowService / ResourceManager,ref = `group/name`)
   - ② task home `~/.octopus/tasks/{id}/workflows/{ref}`(S2 之源)
   - ③(排除)全局 `~/.octopus/workflows/` —— **不是有效来源**
   同一 resolver 供三处复用:绑定预检 / ready-gate(S3)/ SpecPanel 打开查看。

4. **自建 flow 落 task home,分发时拷贝(S2a)**:agent 自建的工作流写 `{home}/workflows/*.yaml`(先 validate + 模拟器跑通,见 D6)。dispatch 侧沿用 `task_artifacts_dir` 注入模式,再注入 `task_workflows_dir`;`WorkflowExecutor` 在 `createFromSpec` 之后、`execution.start` 之前,把该目录 YAML 拷进执行 ws 的 `workflows/`。执行解析链**零改动**(命中既有的 ws/workflows 文件解析)。

5. **S3 gate 升级**:v3 simple 任务入队时,`workflow_ref` 不再只查"非空",而是用同一 resolver **预检可解析**;不可解析同样进 missing 列表。composite 任务维持现状(走内置 `composition-task`,不需要 task 级 ref)。

## Consequences

- **新增**:spec-field 枚举值 `workflow_ref`(shared `ServerSpecField` server 侧;client `ClientSpecField` 同步);绑定预检 resolver(server);`GET /api/tasks/:id/workflow-ref` 查看端点(`{ref, content, source}`);dispatch 拷贝逻辑(注入 + 拷 YAML);ready-gate 从非空升级为可解析。
- **skill 层**:`task-author` 增加 HOW-handoff 步骤(workflow 枚举 API、复用决策、自建必须 validate+模拟器、绑定前确认);`update_task_spec_field` 工具签名增加 `workflow_ref`。
- **解析集归一**:binding 预检、ready-gate、运行时解析三处语义一致(内置 ∨ task-home;执行 ws 中 task-home 拷贝物以 ws 文件命中)。
- **清理缺口(不在本 ADR,另行处理)**:`copyBuiltInWorkflows` 全局种子(`workspace.ts:357`)与"全局不是有效来源"语义冲突——运行时可能命中一个预检拒绝的 ref。后续单独停用全局种子,让预检集与运行集完全重合。
- **范围外**:项目仓库内工作流的拷贝/供给机制(S4 方向)本轮**无施工路径**;composite 的 subunit workflow_ref 校验不在本轮。

## Alternatives considered

- **(A) 物化层内置兜底**:simple 任务无 ref → 默认内置单任务 flow。成本最低,但吞掉"作者应为任务选合适 flow"的意图,所有无 ref 任务永远跑同一默认流。否决:**"跑得对"优先于"能跑"**。
- **(B) 引擎直查 task home(S2b)**:`resolveWorkflowWithSnapshot` 追加 task-origin 直查,不拷贝。来源构造上保证但需在 `SchedulerJob`/execution 管道穿透 origin_id,触碰 ADR 反复刻画的 engine 边界。否决:**拷贝的窗口在 dispatch 同步段,竞态≈0,而 boundary 穿透的测试面大**。
- **(C) 全局 `~/.octopus/workflows/` 作为有效来源**:复用 `copyBuiltInWorkflows` 已有拷贝,零新机制。否决:**共享可变全局命名空间 + 预检/运行语义冲突**,且发散无归属。
- **(D) 绑定不预检,只靠 ready-gate**:省一次 resolve 调用。否决:agent 想纠错必须等下一轮对话,且"先建后绑"的顺序约束无法当场强制。