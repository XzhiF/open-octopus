# Decision Map — Main Agent Optimization

## Destination

Main Agent 从一个半成品变成一个完整的自主 Agent 工作台：
- Skill 可查看/编辑/进化，有清晰的详情页面
- 进化管道自动运行：Agent 在对话中标记洞察，批量处理时自动进化 skill、提取经验
- 记忆系统完整可用（长期记忆编辑、日记记忆编辑、会话搜索）
- Tasks tab 移除，职责归 Scheduler
- 进化日志和经验库有真实数据

## Notes

- Main Agent 核心职责：对话 + 记忆 + Skill + 进化 + 分身
- 两套经验系统各有用途，不整合：DB（Main Agent 通用）vs 文件系统（octo-skill-creator 专有）
- Knowledge tab 属于工作流引擎（Workspace 顶级模块），不在本次范围
- Clone 系统已在上个 PR (#33) 优化完成
- 现有进化管道基础设施已建好大半（DB 表、API 路由、EvolutionService），缺的是触发层和 Agent tool

## Decisions so far

- [01-direction](./decisions/01-direction.md) — 完整自主 Agent 工作台（选项 B）
- [02-evolution-trigger](./decisions/02-evolution-trigger.md) — 混合触发：即时标记 + 批量处理（选项 D）
- [03-skill-ui](./decisions/03-skill-ui.md) — Skill 详情子页面（选项 C）
- [04-experience-systems](./decisions/04-experience-systems.md) — 保持两套系统独立
- [05-knowledge-tab](./decisions/05-knowledge-tab.md) — 不碰，属于工作流引擎
- [06-tasks-tab](./decisions/06-tasks-tab.md) — 移除
- [07-daily-memory](./decisions/07-daily-memory.md) — 支持编辑
- [08-priority](./decisions/08-priority.md) — 全部拆 issue 一次交付
- [09-agent-tools](./decisions/09-agent-tools.md) — 注册进化工具集

## Not yet specified

（已清空——所有 fog 已毕业为决策或移出范围）

## Out of scope

- Knowledge tab 挂载/优化（属于 Workspace 工作流引擎模块）
- 两套经验系统整合（用户明确不整合）
- Clone 系统进一步优化（上个 PR 已完成）
- Workflow Engine 本身的改进
