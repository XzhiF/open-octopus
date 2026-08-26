# 08 — agent 推荐依据与 HOW-handoff 强化

Type: grilling
Status: resolved
Blocked by: 09(resolved)

## Question

agent 枚举/推荐工作流的"依据"怎么给(避免 eb93b74a 那种全不推荐):
- 推荐算法输入:skill_groups + workflow 分类 + 预设索引 → 给 1-3 个候选 + 理由。
- 枚举 API 是否带 `?skills=` / `?category=` 过滤参数给前端与 skill。
- HOW-handoff 强化:不依赖模型自觉的方案(加入 ready 前 UI 引导?技能提示加粗?)
- 用户绑定走的是 agent 还是 UI 直绑(两者并行,UI 兜底)。

## Answer

**(a) agent 只绑 workflow_ref(spec-field),inputs 留在用户 WorkflowBox 弹窗确认(弹窗按 preset 预填)。** 与 05"input_values 只走绑定弹窗"一致,输入拍板权在用户。
- 推荐依据 = task-author 自身 workflow-presets.yaml:按 skill_groups 过滤 → 1-3 候选 + 理由;无命中 → general 兜底 → 全部内置。
- UI 经 `GET /api/workflow-presets?skills_group=...` 同源。
- 可靠性软强化(不必靠自觉):WorkflowBox(06)+ 入队 gate(07)形成"必须绑定 + 输入齐备"的 UI/门禁闭环;agent 忘了 HOW 用户也能完成。
- 文案修正:`builtin-clones.ts:174` "workflow_ref 由用户/scheduler 决定" → "task-author HOW-handoff 推荐,用户确认绑定";task-author SKILL HOW-handoff 步骤补"按 workflow-presets.yaml 过滤、1-3 候选+理由"。