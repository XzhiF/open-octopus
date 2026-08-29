# Requirement Brief — task-workflow-presets

## Overview

任务选择/绑定工作流时带齐输入预设:preset catalog(放 task-author clone 目录)给 agent 推荐和工作流绑定提供依据;绑定支持 `${goal}`/`${ac}` 模板映射 input_values;入队 gate 校验必填输入,杜绝"白执行"。SpecPanel/v3 工作区呈现 目标&验收 → 工作流 → 产物 三级结构。

## Projects Involved

- [ ] [shared] (任务 spec 类型、preset schema)
- [ ] [server] (preset 读取/API、物化替换、ready-gate 扩展)
- [ ] [web-app] (WorkflowBox + 绑定弹窗 + 入队检查卡)
- [ ] [skills / core-pack] (task-author clone advice: workflow-presets.yaml + SKILL + builtin-clones persona)
- [ ] engine — **不动**(研究 01 结论:引擎侧零改动,`$vars` 原生消费,替换在物化侧)

## Feature Scope

**Do:**
- preset catalog 文件(放 task-author clone 目录),每条 = name + skills_group[] + 单 workflow + 单 inputs
- `GET /api/workflow-presets?skills_group=a,b`(server 读 clone dir)
- `task_spec.input_values` 存储 + 绑定弹窗 `updateTask` PUT(与 workflow_ref 原子写入)
- 物化时 `${goal}`/`${ac}` 模板替换(ac 换行拼);未解析/缺值 fail-fast
- ready-gate:必填 inputs 校验(解析后值),missing push `input:<name>`
- WorkflowBox(v3 右栏 + v2 SpecPanel 共享组件)+ 绑定弹窗(搜索/详情/inputs 表单)+ 入队检查卡 workflow_ref 状态行
- task-author SKILL / builtin-clones persona 文案修正(推荐依据 = preset 过滤)

**Don't:**
- 不改 workflow YAML schema(不新增 category/skills 字段)
- 不改搜索引擎变量解析(substituteVars)
- inputs 不入 spec-field 枚举;agent 不写 input_values(只绑 ref)
- 不做 org 级 preset 差异层(范围外,将来叠加)
- 不引入 `${projects}` 占位符

## Key Decisions

| # | 票 | 决策 | 结论 |
|---|-----|------|------|
| 1 | 01 research | 变量缝 | 引擎不识别 `${goal}`;`$vars` 原生;materialize 前替换 |
| 2 | 09 catalog | 映射层放哪 | **task-author clone 目录** `workflow-presets.yaml`(行为资产) |
| 3 | 09 catalog | 形状 | 每条 name + skills_group[] + 无 category + 单 workflow + 单 inputs |
| 4 | 09 catalog | 兜底 | 空 skills_group 的 general 条目;无底退全量;UI 标推荐/手动 |
| 5 | 04 模板 | 占位符 | `${goal}` `${ac}`(ac 换行);无保留名映射;未知/缺值绑定 fail-fast |
| 6 | 05 存储 | input_values | 存 `task_spec.input_values`;仅绑定弹窗 PUT;不入 spec-field;不暴露 agent |
| 7 | 05/物化 | 合并 | `simpleInputValues = { ...resolve(input_values), task_*_dir }` 管理键优先 |
| 8 | 06 UI | 落点 | v3 右栏 WorkflowBox(v2 共享组件);三段 GoalAcCard/WorkflowBox/OutputViewer |
| 9 | 07 gate | 必填校验 | resolve workflow → required inputs 检查解析后值 → missing `input:<name>` |
| 10 | 08 agent | 绑定方式 | agent 只绑 ref;inputs 用户弹窗确认(弹窗按 preset 预填) |

Map: [map.md](./map.md) · 决策票: [decisions/](./decisions/)

## Data Model Changes

| Table | Operation | Details |
|-------|-----------|---------|
| tasks.task_spec (JSON) | 扩展 | 新增 `input_values?: Record<string,string>`(内含模板串,物化时替换) |
| 新文件 | 新增 | `~/.octopus/agent/built-in/task-author/workflow-presets.yaml`(catalog) |

## API Contracts

| Method | Path | Side | Params | Response | Notes |
|--------|------|------|--------|----------|-------|
| GET | /api/workflow-presets | server | `?skills_group=a,b` | `{ presets: [{name, skills_group[], workflow, inputs}] }` | 读 task-author clone dir;含 general 兜底;空 ⇒ [] |
| PUT | /api/tasks/:id | server | body `{workflow_ref, task_spec:{...,input_values}}` + If-Match | Task | 绑定弹窗原子写;schema 校验 input_values |
| POST | /api/tasks/:id/ready | server | — | Task / 409 + missing[] | gate 增加 `input:<name>` 项 |

## Acceptance Criteria

| # | 用户故事 | AC | 验证方法 |
|---|----------|-----|---------|
| 1 | 我在作者工作区能选择工作流 | WorkflowBox 显示推荐(按 skill_groups 过滤)+ 全部;绑定弹窗可搜索、看详情 | 浏览器 E2E |
| 2 | 我要 `${goal}` 自动映射 | 绑定带 `${goal}` 的 preset,入队后调度配置 `requirement` = goal 真值 | 集成测试(断言 schedule config) |
| 3 | 缺必填输入不白执行 | ready-gate 返回 409 missing 含 `input:requirement` | 集成测试 |
| 4 | agent 推荐有依据 | task-author SKILL 按 workflow-presets.yaml 过滤给 1-3 候选 | 手工 + 集成(enum API) |
| 5 | 三段结构 | v3 右栏 GoalAcCard/WorkflowBox/OutputViewer;v2 SpecPanel 有 WorkflowBox | 浏览器 E2E |

## Verification Strategy

### Global Config
- 环境:本地 dev;org `E2E_TD_org`
- 数据:preset catalog 用测试 fixture(临时修改 clone dir 或用可注入 baseDir)

### Per-layer Methods
#### Unit Tests
- TaskHomeService/workflow-presets 解析(Zod schema、空文件、坏字段)
- materialize 模板替换(goal/ac 换行、未知占位符抛错、管理键优先)
- ready-gate 必填校验(缺/足/模版本解析后判定)

#### Integration Tests
- 绑定 → ready → 查 schedule config input_values 注入断言
- gate 409 missing 含 input:<name>;resolver 三处一致

#### Browser E2E
- WorkflowBox 渲染/绑定弹窗/入队门禁拒绝路径

#### Contract Tests
- 前端 `WorkflowPreset` 类型 vs server DTO key 一致

#### Manual Checklist
- 真实任务走一遍:讨论 → 绑 preset → 入队 → 产物可见

### Prerequisites
- task-author clone dir 存在并含 workflow-presets.yaml
- 至少一个 preset 命中测试技能组

## Risks & Notes

- R1: clone dir 可能被重新安装脚本覆盖 → catalog 需随 clone 清单一起供给(种子机制纳入实现)
- R2: `${ac}` 换行序是字符串 → 下游若按行解析,顺序敏感(ac 数组序)保持
- R3: 旧任务无 input_values → 物化当 `{}` + 兜底,不破坏已有 ready
- R4: agent 可靠性仍软依赖 → 依赖 06 WorkflowBox + 07 gate 闭环兜底

## Glossary (new domain terms)

| Term | Meaning |
|------|---------|
| preset catalog | task-author clone 的 workflow-presets.yaml:技能组→工作流+输入映射 |
| `skills_group` | preset 里声明适用的技能组名数组(空=兜底所有) |
| `${goal}`/`${ac}` | 绑定弹窗/物化前的一次性模板占位符(非引擎语法) |
| task-dev 契约 | 在 catalog 中的 workflow 视为 task 专用;task-dev 流程直接消费 `$vars.goal/ac` |