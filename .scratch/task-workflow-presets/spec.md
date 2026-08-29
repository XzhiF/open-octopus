# Spec — task-workflow-presets

> Brief: [brief.md](brief.md) · Decisions: [decisions/](decisions/) · Map: [map.md](map.md)

## 1. 功能概述

任务绑定工作流时带齐**输入预设**:`workflow-presets.yaml`(catalog)提供"技能组→工作流+输入骨架"映射;绑定弹窗支持 `${goal}`/`${ac}` 模板映射 input_values;入队 ready-gate 校验必填输入;v3/v2 工作区显示 WorkflowBox 三段结构。

## 2. 数据模型变更

### 2.1 task_spec.input_values 扩展

`taskSpecSchema` (shared/src/types/scheduler-job.ts) 增可选字段:

```ts
input_values: z.record(z.string(), z.string()).max(2048).optional()
```

校验规则:
- 键/值均为非空 string
- 单个值 ≤ 2KB(2048 字符)
- 整体为 plain object(无嵌套)

存储:随 task_spec JSON 存于 tasks.task_spec 列。PUT /api/tasks/:id 更新 task_spec 时保留该字段(不丢失)。

### 2.2 workflow-presets catalog

```yaml
# ~/.octopus/agent/built-in/task-author/workflow-presets.yaml
presets:
  - name: basic-dev
    skills_group: []          # 空 = 兜底所有组
    workflow: built-in/basic-dev-flow
    inputs:
      requirement: "${goal}"
      acceptance: "${ac}"
  - name: mattpocock-dev
    skills_group: [mattpocock-skills]
    workflow: built-in/basic-dev-flow
    inputs:
      requirement: "${goal}"
```

Shape 定义(shared/src/types/workflow-presets.ts):

```ts
export const workflowPresetSchema = z.object({
  name: z.string().min(1),
  skills_group: z.array(z.string()).default([]),
  workflow: z.string().min(1),
  inputs: z.record(z.string(), z.string()).default({}),
})

export const workflowPresetsCatalogSchema = z.object({
  presets: z.array(workflowPresetSchema).default([]),
})
```

## 3. API 合约

### 3.1 GET /api/workflow-presets

| Param | Type | Default |
|-------|------|---------|
| `?skills_group` | comma-sep string | (none → 返回全量) |

Response:
```json
{
  "presets": [
    { "name": "basic-dev", "skills_group": [], "workflow": "built-in/basic-dev-flow", "inputs": {...} }
  ]
}
```

过滤逻辑:
1. 传入 skills_group → 返回 skills_group 有交集的 preset + 空 skills_group(兜底) preset
2. 未传 → 返回全量
3. catalog 文件不存在/空 → `{ presets: [] }`

数据来源:读 `~/.octopus/agent/built-in/task-author/workflow-presets.yaml`。Server 可注入测试 baseDir。

### 3.2 PUT /api/tasks/:id (扩展)

已有端点。task_spec body 中 `input_values` 字段透传到 DB。与 `workflow_ref` 原子写入。

### 3.3 POST /api/tasks/:id/ready (扩展)

已有端点。ready-gate 增加必填 inputs 校验:
- simple 任务(subunits < 2) resolve workflow → 解析 input schema → 每个 `required: true` 的 input 检查**物化后**的 input_values 值非空
- 缺失项 → `missing.push("input:<name>")` → 409

## 4. 物化模板替换

`materializeTaskSpecToConfig` (scheduler-service.ts) 修改:

```
simpleInputValues = {
  ...resolveInputValues(task_spec.input_values, task_spec.goal, task_spec.ac),
  task_artifacts_dir,   // 已有
  task_workflows_dir,   // 已有
}
```

`resolveInputValues` 逻辑:
1. 取 task_spec.input_values(无 → `{}`)
2. 对每个值做 `${goal}` → task_spec.goal 替换
3. 对每个值做 `${ac}` → task_spec.ac.join('\n') 替换
4. 发现未知占位符 `${xxx}` → 抛错(fail-fast)
5. 管理键(`task_artifacts_dir`, `task_workflows_dir`)最后写入,优先于 input_values

**不动引擎 substituteVars**(研究 01 结论)。

## 5. Ready-Gate 扩展

在 `readyTask` (tasks-service.ts) 的 v3 gate 检查中:

```
// 现有: goal, ac, goal_confirmed, ac_confirmed, workflow_ref
// 新增: input:<name> for each required input
if (subunits.length < 2 && ref) {
  const resolved = resolveWorkflowRef(ref, deps)
  if (resolved) {
    const wfInputs = parseWorkflowInputs(resolved.content)  // 解析 YAML 的 variables/inputs
    const materialized = resolveInputValues(task_spec.input_values, task_spec.goal, task_spec.ac)
    for (const inp of wfInputs) {
      if (inp.required && !materialized[inp.name]?.trim()) {
        missing.push(`input:${inp.name}`)
      }
    }
  }
}
```

## 6. Web-App: WorkflowBox

### 6.1 位置

- v3 AuthoringWorkspace 右栏:`GoalAcCard` ↔ `OutputViewer` 之间
- v2 SpecPanel:底部区域(与现有 spec 编辑并列)

共享同一 `WorkflowBox` 组件。

### 6.2 功能

- **展示**: 当前绑定的 workflow_ref + input_values 状态
- **绑定弹窗**:
  - 搜索内置 27+ 自建工作流
  - 详情面板(YAML 预览 + inputs 表单)
  - 按 preset 预填 `${goal}`/`${ac}` 值
  - 提交 → PUT /api/tasks/:id (workflow_ref + task_spec.input_values 原子写)
- **入队检查卡**: workflow_ref 状态行(已绑/未绑)

### 6.3 API Client

```ts
// lib/workflow-presets-api.ts
export async function listWorkflowPresets(skillsGroup?: string[]): Promise<{ presets: WorkflowPreset[] }>
export async function getBuiltInWorkflow(ref: string): Promise<WorkflowDetail>
```

## 7. 文案修正

### 7.1 builtin-clones.ts:174

```
- 旧: workflow_ref 选择是 HOW，由用户/scheduler 决定
+ 新: workflow_ref 由 task-author HOW-handoff 推荐，用户确认绑定
```

### 7.2 task-author SKILL.md HOW-handoff 步骤

补充:按 workflow-presets.yaml 过滤、1-3 候选+理由。

## 8. 种子机制

workflow-presets.yaml 由 core-pack 提供(`packages/core-pack/presets/workflow-presets.yaml`)。安装/clone 流程将其复制到 `~/.octopus/agent/built-in/task-author/workflow-presets.yaml`。

开发阶段:server 接受可注入的 baseDir 以支持测试 fixture。

## 9. 风险与缓解

- R1: clone dir 被覆盖 → catalog 随 clone 清单供给(种子机制)
- R2: ac 换行序 → join('\n') 保持原数组序
- R3: 旧任务无 input_values → 物化当 `{}`,不破坏已有 ready
- R4: agent 可靠性 → WorkflowBox + gate 闭环兜底

## 10. 不动清单

- 引擎 substituteVars(研究 01)
- workflow YAML schema(决策 02 已否决)
- spec-field 枚举(决策 05: input_values 不入枚举)
- `${projects}` 占位符(决策 04: 已删除)
