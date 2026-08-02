# Requirement Brief

## Overview
修复交互节点右键查看信息的 Bug，并美化右侧事件日志中交互事件的显示。

## Projects Involved
- [ ] web-app (前端修复)

## Feature Scope
**Do:**
- 修复 `getExecutorType()` 函数，让交互节点能正确显示 `InteractionDetailTabs`
- 美化右侧 `ExecutionLogViewer` 中 `interaction_started`、`interaction_ask_user_question`、`interaction_completed` 事件的图标和标签

**Don't:**
- 不改变数据存储结构（不同步对话消息到 agent_events）
- 不重新设计 InteractionDetailTabs 组件

## Key Decisions
| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| 1 | 修复方式 | 在 `getExecutorType()` 中添加 `nodeType === "interaction"` 检查 | 最小改动，明确区分节点类型 |
| 2 | 事件美化范围 | 只美化 3 个里程碑事件的图标/标签 | 不改变数据层，只做 UI 层改进 |

## Data Model Changes
无

## API Contracts
无

## Design Specs (if any)
- Figma link: none
- Fidelity: N/A

## Acceptance Criteria
| # | User Story | AC | Verification Method |
|---|-----------|----|-------------------|
| 1 | 作为用户，我右键点击已完成的交互节点选择"查看信息" | 弹出 `InteractionDetailTabs` 对话框，显示"对话记录"、"追踪"、"结果"三个标签页 | 手动测试：右键交互节点 → 查看信息 → 验证标签页存在且内容正确 |
| 2 | 作为用户，我查看右侧事件日志 | `interaction_started`、`interaction_ask_user_question`、`interaction_completed` 有专用图标和中文标签 | 手动测试：运行交互节点工作流 → 查看右侧事件日志 → 验证图标和标签 |
| 3 | 作为用户，我查看交互节点的对话记录标签页 | 显示完整对话历史（用户消息、AI 回复、工具调用） | 手动测试：完成交互后右键查看 → 对话记录标签 → 验证消息列表 |
| 4 | 作为用户，我查看交互节点的追踪标签页 | 显示 token 使用统计 | 手动测试：完成交互后右键查看 → 追踪标签 → 验证统计数据 |

## Verification Strategy

### Global Config
- Environment: local dev (`pnpm dev`)
- Test user: N/A
- Data prefix: N/A

### Per-layer Methods
#### Unit Tests
- 可选：为 `getExecutorType()` 添加单元测试，验证 `nodeType === "interaction"` 返回 `"interaction"`

#### Integration Tests
- 无

#### Browser E2E
- 可选：Playwright 测试右键菜单 → 对话框内容

#### Contract Tests
- 无

#### Manual Checklist
- [ ] 右键交互节点 → 查看信息 → 显示 InteractionDetailTabs（对话/追踪/结果）
- [ ] 对话记录标签显示完整消息历史
- [ ] 追踪标签显示 token 统计
- [ ] 结果标签显示 summary 和 vars_update
- [ ] 右侧事件日志中 interaction_started 显示"交互开始"和专用图标
- [ ] 右侧事件日志中 interaction_ask_user_question 显示"用户提问"和专用图标
- [ ] 右侧事件日志中 interaction_completed 显示"交互完成"和专用图标

### Prerequisites
- [ ] 本地开发服务器运行 (`pnpm dev`)
- [ ] 有包含交互节点的工作流可执行

## Risks & Notes
- R1: `getExecutorType()` 是基于启发式的函数，未来新增节点类型时需要同步更新

## Glossary (new domain terms)
无新术语
