# Agent Config Optimization — Decision Map

## Destination
Agent Config 模块从"半成品"变为"闭环可用" — 每个功能都有清晰的 UI 反馈、完整的交互能力、且 Agent 自身能感知并利用这些配置。

## Notes
- 后端实现基本完整，问题集中在前端 UX 和 Agent 自身感知
- ConfigTab 包含 7 个面板: GeneralConfig, SafeModePanel, PersonaEditor, NotificationConfig, MemoryStrategyConfig, SafetyAudit, DebugLogViewer
- 前端使用 `useAgentConfig` hook 管理状态，`ConfigSection` 作为共享卡片组件

## Decisions so far
- [01-debug-mode-placement](./decisions/01-debug-mode-placement.md) — Debug Mode 开关移到 DebugLogViewer 面板顶部
- [02-save-feedback](./decisions/02-save-feedback.md) — 根布局添加 Toaster + 清理 Radix toast 死代码
- [03-debug-log-enhancement](./decisions/03-debug-log-enhancement.md) — MVP 级：后端真分页 + 前端加载更多 + 基础搜索
- [04-prompt-detail-scroll](./decisions/04-prompt-detail-scroll.md) — 后端返回完整 content + 前端可折叠区域
- [05-notification-agent-awareness](./decisions/05-notification-agent-awareness.md) — 创建 octo-notify skill
- [06-panel-layout](./decisions/06-panel-layout.md) — 按场景分组重排面板顺序

## Not yet specified
_(已清空 — 所有 fog 已 graduate 为 tickets 并解决)_

## Out of scope
- 后端业务逻辑重构（已实现完整）
- 新增配置项（本轮只做 UX 优化）
- 多语言国际化
