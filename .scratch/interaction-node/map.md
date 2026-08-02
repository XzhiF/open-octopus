# Decision Map — Interaction Node

## Destination
新增 `interaction` 类型工作流节点，基于现有 Chatbot 基础设施实现原生多轮人机交互，替代 xzf-dev 中 loop+approval+agent 的 hack 模式。

## Notes
- 现有 ApprovalExecutor 已有暂停/恢复机制（`pending_approval` → SSE → `retryFrom()`），但只支持预定义选项
- Claude Agent SDK 的 PreToolUse hook 已能拦截 `AskUserQuestion`，7 层拦截链完整
- Workspace Chat 系统已完备（ChatService + SSE + QuestionCard UI），但与 Workflow 系统完全隔离
- `AgentNodeRunner` 不处理 `ask_user_question` MessageChunk（死路）
- SDK 的 `query()` 是不可中断的 async iterable，session resume 支持多轮上下文延续

## Decisions so far

| # | Decision | Conclusion |
|---|----------|-----------|
| D1 | 节点定位 | 独立 `interaction` 节点，与 bash/agent/approval 并列 |
| D2 | 问题生成方式 | Agent 动态驱动，不做静态 YAML 定义 |
| D3 | 前端交互形态 | 混合模式 — Agent 决定输出结构化问题或自由文本 |
| D4 | 后端集成策略 | Chat Bridge 模式 — 桥接 WorkflowEngine 与 ChatService，复用 chatbot 全链路 |
| D5 | 显示方式 | 可配置 modal/panel，默认 modal |
| D6 | 完成信号 | 双重机制：`complete_interaction` 工具 + `exit_when` 表达式 |
| D7 | 输出机制 | 复用 Agent 节点：vars_update + 文件写入 + outputs 映射，Skills 驱动 |
| D8 | SDK 集成 | Claude Agent SDK session resume — 每轮消息用 `query(resume=sessionId)` |
| D9 | 实现范围 | 全栈：shared + engine + server + web-app |
| D10 | 验证策略 | 四层递进：单元 → 模拟器 → E2E → 手动 |
| D11 | 不新建 ask_human 工具 | 复用已有 AskUserQuestion（SDK 已拦截，QuestionCard 已渲染） |
| D12 | 不改现有 approval 节点 | 向后兼容，interaction 是新增类型 |
| D13 | 字段命名前缀 | interaction 专属字段统一加 `interaction_` 前缀（如 `interaction_display`、`interaction_max_rounds`、`interaction_exit_when`、`interaction_agent`），避免与 NodeDef 通用字段混淆 |

## Not yet specified
- `complete_interaction` 工具的具体注册方式：SDK tool definition vs hook interception（实现阶段决定）
- Chat Bridge 的进程模型：同进程 vs Worker Thread（实现阶段决定）
- interaction session 的压缩策略：长对话是否需要 auto-compact（实现阶段决定）
- 多个 interaction 节点串行时的 UI 行为（Modal 关闭后下一个 Modal 是否自动弹出）

## Out of scope
- Agent 内置工具模式（`ask_human` tool for agent 自主调用）— 未来考虑
- 静态 YAML 问题定义模式 — 无新增价值
- 非 chatbot 的交互方式（如 CLI 交互、邮件审批）— 不在本期范围
- 工作流编辑器的 interaction 节点可视化配置 — 后续 UX 迭代
