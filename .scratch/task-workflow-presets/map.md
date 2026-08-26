# Decision Map — task-workflow-presets

## Destination

任务能**按技能组看到/选中正确的工作流**并**带齐输入预设**再入队:workflow 有"task-dev 专用"标识与技能组预设可供 agent 推荐;绑定其他内置工作流时 `${goal}`/`${ac}` 模板自动映射 input_values;SpecPanel 呈现 目标&验收 → 工作流 → 产物 三级结构并可视化关联。入队 gate 校验 workflow_ref 可解析 **且必填 inputs 已满足**。

## Notes

- ADR-0013(workflow-ref-authoring-provisioning, 2026-08-23): authoring agent 拥有 HOW;绑定=预检;解析集 = 已安装内置 ∨ task-home;S3 gate 已升级为"可解析";dispatch 拷贝 home→ws。**本次缺口**:门是 ADR-0013 加的,但①agent 实际没做 HOW-handoff(eb93b74a 实测)②即便绑了,workflow 自身必填 inputs(如 `requirement`)无人供给 → 白执行。
- 现状(已核实):
  - 27 个已安装 workflow,group = `built-in`(25)/`archive-extracted`/`test`;ref = `{group}/{name}`。
  - workflow YAML schema 顶层: apiVersion/kind/name/description/model/engine/timeout/execution_mode/max_concurrent/variables/auto_answers/inputs/providers/channels/hooks/nodes。`parseWorkflow` 用 Zod safeParse(非 strict)→ **未知字段会被剥离**,加分类字段需扩展 WorkflowSchema。
  - `simpleInputValues` 物化只注入 `task_artifacts_dir`/`task_workflows_dir`,不含 workflow 自身 inputs(`scheduler-service.ts:214-228`)。
  - TaskSpec 无 `input_values` 字段;前端 `updateTask` 已支持 `workflow_ref` 载荷;`GET /api/workflows/built-in/:ref` 有 content。
  - TaskHomeService 已有 listWorkflowFiles/readWorkflowFile,未暴露路由。
  - core-pack 有 7 个编排类 workflow(composition/matt-dev-pipeline/xzf-dev/clarify/moa-review/spec-review)。

## Decisions so far

- [01-research-var-interpolation-seam](decisions/01-research-var-interpolation-seam.md)(resolved): 引擎无 `${goal}` 解析;`$vars.xxx` 原生可吃;input_values 经 pool.update 原样入池;接入点在 materialize simpleInputValues 组装处。→ 双机制。
- [02-workflow-category-metadata](decisions/02-grilling-workflow-category-metadata.md)(**SUPERSEDED**): WorkflowSchema 加 `category` 已否决 —— 不改 workflow schema。
- [03-skill-preset-source](decisions/03-grilling-skill-preset-source.md)(**SUPERSEDED**): workflow YAML 声明 skills 已否决 —— 技能组概念模糊。
- [09-preset-catalog](decisions/09-grilling-preset-catalog.md)(resolved): preset catalog 放 task-author clone 目录;每条 name + skills_group[] + 单 workflow + 单 inputs;无 category;兜底 general 条目 + 无底退全量 + UI 模式标注。
- [04-variable-template-syntax](decisions/04-grilling-variable-template-syntax.md)(resolved): 占位符 `${goal}` `${ac}`(ac 换行);无保留名自动映射(显式模板);未知/缺值 = 绑定 fail-fast;实现于物化前替换。
- [05-input-values-storage](decisions/05-grilling-input-values-storage-contract.md)(resolved): 存 task_spec.input_values;只走绑定弹窗 updateTask PUT(不入 spec-field);物化合并管理键优先;校验非空 string;不暴露 agent。
- [06-specpanel-triptych](decisions/06-grilling-specpanel-triptych-placement.md)(resolved): v3 右栏 WorkflowBox(GoalAcCard/WorkflowBox/OutputViewer 三段),v2 共享组件。
- [07-ready-gate-inputs](decisions/07-grilling-ready-gate-input-validation.md)(resolved): gate 校验必填 inputs(解析后值,missing push "input:<name>"),simple 仅;防白执行。
- [08-agent-recommendation](decisions/08-grilling-agent-recommendation-basis.md)(resolved): agent 只绑 workflow_ref,inputs 用户弹窗确认;a 按 preset 过滤推荐;可靠性靠 UI+gate 闭环;修 builtin-clones:174 与 SKILL 文案。

## Not yet specified

(已全部升格为决策票并 resolve — 无剩余 fog。)

## Out of scope

- 全局 `~/.octopus/workflows/` 作为来源(ADR-0013 已排除)
- 引擎侧穿透改 S2b(ADR-0013 已选拷贝方案)
- 复合任务子树 workflow 级校验(ADR-0013 范围外)
- org 级 preset catalog 差异图层(09 范围外,将来可叠加)
- `${projects}` 占位符(04: projects 已由 workspace_spec 供给,删)

## Out of scope

- 全局 `~/.octopus/workflows/` 作为来源(ADR-0013 已排除)
- 引擎侧穿透改 S2b(ADR-0013 已选拷贝方案)
- 复合任务子树 workflow 级校验(ADR-0013 范围外)