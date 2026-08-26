# 06 — SpecPanel 三级结构落点与关联可视化

Type: grilling
Status: resolved
Blocked by: None

## Answer

**A(v3 主线 + v2 共享组件)。**
- 落点:v3 AuthoringWorkspace 右栏加 `WorkflowBox`(GoalAcCard ↔ OutputViewer 之间),三段垂直 = GoalAcCard(WHAT)/ WorkflowBox(HOW)/ OutputViewer(OUTPUT)。
- v2 SpecPanel 挂同一个 `WorkflowBox` 组件(兼容旧 draft):v2 只有 目标&验收 + 工作流 两段(产物区在 v3 才有)。
- 关联可视化:WorkflowBox 内 input 行来源 chip(goal/ac/manual)、GoalAcCard 底部 footnote"执行工作流: ref(未绑定)"、OutputViewer 产物行保留 `by` 溯源。
- 绑定弹窗(搜索 + 详情 + inputs 表单)由 WorkflowBox 打开;数据来自 `GET /api/workflow-presets` + built-in list。