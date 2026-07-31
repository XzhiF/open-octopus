# Requirement Brief — Interaction 节点架构重设计

## Overview
将 Interaction 节点从"借用 chatbot session"重构为"workflow-native 对话系统"——对话数据归 workflow 所有，chatbot 通过 skill 获得 workflow 感知能力，两个系统彻底解耦。

## Projects Involved
- [ ] `@octopus/server` (新增 interaction_messages 表 + interaction route + workflow ops API)
- [ ] `@octopus/web-app` (interaction modal 改用 workflow API + chatbot 去掉 interaction 相关逻辑)
- [ ] `@octopus/shared` (类型定义：InteractionMessage + 删除 chat_sessions 的 interaction 字段)
- [ ] `@octopus/core-pack` (新增 octo-workflow-ops skill)

## Feature Scope

**Do:**
- 新建 `interaction_messages` 表，存储 interaction 节点的对话消息
- 将 interaction 对话的 SSE streaming 从 chat route 迁移到 workflow 系统自己的 interaction route
- Interaction modal UI 改用 workflow API 发送/接收消息（复用 ChatPanel 组件渲染）
- Chatbot 通过 `octo-workflow-ops` skill 获得 workflow 查询和控制能力
- 删除 `chat_sessions` 表的 interaction 相关字段（`linked_execution_id`、`linked_node_id`、`interaction_mode`、`interaction_status`）
- 删除 `ChatBridge` 类（不再需要）
- Token/cost 天然写入 `node_token_usages` + `llm_calls`（无需同步桥接）
- Interaction 关键事件（start/ask_user_question/complete）双写到 `agent_events`
- 新建 `InteractionDetailTabs` 组件：对话记录 + 追踪 + 结果三 tab

**Don't:**
- 不改工作流引擎的核心执行逻辑（InteractionExecutor 的 execute/resume 接口不变）
- 不改 chatbot 的 chat route（只是不再需要 interaction-specific 分支）
- 不做 slash command 系统——chatbot 用 skill + 自然语言调 workflow API

## Key Decisions

| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| D1 | 架构模型 | **彻底解耦** | Workflow 拥有所有 interaction 数据，Chatbot 是独立对等系统通过 skill 交互 |
| D2 | 对话存储 | **interaction_messages 表** | Workflow 系统自己的消息表，语义清晰，与 node_executions 天然关联 |
| D3 | Session linking | **删除** | 不再在 chat_sessions 上关联 workflow，两个系统通过 API 交互 |
| D4 | Chatbot 控制 | **Skill 驱动** | Clone agent 通过 octo-workflow-ops skill 调 workflow API，自然语言即可 |
| D5 | ChatBridge | **删除** | 不再需要跨系统 session 管理 |
| D6 | Token/Cost | **天然统一** | Interaction route 写入 node_token_usages + llm_calls，与 agent 节点一致 |
| D7 | UI 组件 | **复用 ChatPanel** | Modal 渲染复用现有 chat 组件，只改数据源 |
| D8 | 竞品参考 | **LangGraph interrupt/resume** | 对话和工作流分离，通过 API 桥接。"新对话轮次"和"恢复中断"是不同路径 |
| D9 | 日志整合 | **关键事件双写 agent_events** | 对话细节在 interaction_messages，关键事件（start/ask/complete）写入 agent_events 供右侧面板展示 |
| D10 | 节点详情 UI | **InteractionDetailTabs** | 三个 tab：对话记录（chat 回放）+ 追踪（token/cost）+ 结果（summary + vars_update） |

## Data Model Changes

### 新增表: `interaction_messages`

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | UUID |
| `execution_id` | TEXT | FK → executions.id |
| `node_id` | TEXT | 交互节点 ID |
| `role` | TEXT | `user` / `assistant` / `system` |
| `type` | TEXT | `text` / `thinking` / `tool_call` / `ask_user_question` |
| `content` | TEXT | 消息内容 |
| `metadata` | TEXT | JSON — tokens, cost, tool info, displayType |
| `created_at` | TEXT | ISO timestamp |

### 删除列: `chat_sessions`

| Column | Action |
|--------|--------|
| `linked_execution_id` | 删除 |
| `linked_node_id` | 删除 |
| `interaction_mode` | 删除 |
| `interaction_status` | 删除 |

### 删除: `ChatBridge` 类

整个 `packages/server/src/services/chat-bridge.ts` 文件删除。其职责：
- `createInteractionSession` → 不再需要（不创建 chat session）
- `findActiveSession` → 不再需要
- `trackSession` / `recordRound` → 迁移到 interaction route 的内存 tracking
- `COMPLETE_INTERACTION_TOOL` → 迁移到 interaction route

## API Contracts

### Interaction Route (新增，workflow 系统内)

| Method | Path | Params | Response | Notes |
|--------|------|--------|----------|-------|
| POST | `/api/workspaces/:id/interactions/:execId/:nodeId/start` | — | `{ sessionId }` | 初始化交互对话（内部 session，非 chatbot） |
| POST | `/api/workspaces/:id/interactions/:execId/:nodeId/messages` | `{ content }` | SSE stream | 发送消息，返回 SSE 流（text_delta, ask_user_question, etc.） |
| GET | `/api/workspaces/:id/interactions/:execId/:nodeId/messages` | `?limit&before` | `InteractionMessage[]` | 获取历史消息 |
| POST | `/api/workspaces/:id/interactions/:execId/:nodeId/complete` | `{ summary, vars_update? }` | `{ ok }` | 强制完成交互 |

### Workflow Ops API (新增，供 chatbot skill 调用)

| Method | Path | Response | Notes |
|--------|------|----------|-------|
| GET | `/api/workspaces/:id/workflows/executions` | `Execution[]` | 列出执行（支持 ?status=running 过滤） |
| GET | `/api/workspaces/:id/workflows/executions/:id/status` | `{ status, progress, currentNode }` | 执行状态概览 |
| POST | `/api/workspaces/:id/workflows/executions/:id/abort` | `{ ok }` | 中止执行 |
| GET | `/api/workspaces/:id/workflows/executions/:id/nodes/:nodeId/events` | `AgentEvent[]` | 节点事件历史 |

### 删除的 API 路径

| Old Path | Reason |
|----------|--------|
| `POST /executions/:id/interaction/:nodeId/start` (execution route) | 迁移到 interaction route |
| `GET /executions/:id/interaction/:nodeId/status` | 合并到 workflow ops API |
| `POST /executions/:id/interaction/:nodeId/complete` | 迁移到 interaction route |

## Acceptance Criteria

| # | User Story | AC | Verification Method |
|---|-----------|----|-------------------|
| 1 | 运行含 interaction 的工作流 | Modal 弹出，对话正常进行，选择颜色后工作流继续 | E2E: 运行 pick-color 工作流完整流程 |
| 2 | 对话数据归 workflow | `interaction_messages` 表有记录，`chat_sessions` 表无 interaction 相关记录 | DB 断言: SELECT 验证 |
| 3 | Token/cost 在分析仪表盘可见 | `node_token_usages` 有 interaction 节点的记录 | 集成测试: 查询验证 |
| 4 | Chatbot 查工作流状态 | 在 chatbot 中问"当前工作流什么状态"，agent 返回正确信息 | 手动验证: chatbot 对话 |
| 5 | F5 刷新恢复对话 | 刷新后 modal 重新打开，历史消息加载 | E2E: 刷新页面验证 |
| 6 | Chatbot tab 栏无 interaction 记录 | `chat_sessions` 中没有任何 interaction 相关 session | DB 断言 + UI 验证 |
| 7 | 强制完成交互 | 点击"结束交互"按钮，工作流继续 | E2E: 强制完成后验证下游节点 |
| 8 | 右侧日志面板展示 interaction 活动 | `agent_events` 有 interaction 节点的关键事件（start/ask/complete） | 集成测试: 查询 agent_events 验证 |
| 9 | 点击已完成 interaction 节点查看详情 | NodeInfoDialog 展示 InteractionDetailTabs：对话记录、追踪、结果 | E2E: 右键节点 → 查看信息 → 验证三 tab |
| 10 | 对话记录 tab 显示完整对话 | 从 interaction_messages 加载，展示所有 user/assistant 消息 | UI 验证: 消息内容与交互时一致 |
| 11 | 追踪 tab 显示 token/cost | 从 llm_calls + node_token_usages 读取，显示模型、token 数、成本 | UI 验证: 数据与仪表盘一致 |
| 12 | 结果 tab 显示交互产出 | 展示 summary 文本、vars_update 键值对、outputs 映射结果 | UI 验证: 数据与 VarPool 一致 |

## Verification Strategy

### Global Config
- Environment: local dev (server:3001, web:3000)
- Test workspace: test-interaction-1
- Test workflow: pick-color.yaml

### Per-layer Methods

#### Unit Tests
- `interaction_messages` DAO: CRUD 操作
- Interaction route: SSE streaming、completion detection
- Workflow ops API: 状态查询、abort
- `octo-workflow-ops` skill: API 调用格式

#### Integration Tests
- 运行 pick-color → 验证 interaction_messages 有记录 → 验证 node_token_usages 有记录
- 验证 chat_sessions 表无 interaction 记录（回归）
- Chatbot skill 调用 workflow API → 返回正确数据

#### Manual Checklist
- [ ] 运行 pick-color 工作流，Modal 弹出，对话正常
- [ ] F5 刷新后对话历史恢复
- [ ] 在 chatbot 中询问工作流状态
- [ ] 查看分析仪表盘，interaction 节点的 token/cost 可见
- [ ] 强制完成交互，下游节点正常执行

### Prerequisites
- [ ] pick-color.yaml 工作流可正常运行
- [ ] 开发环境 server + web-app 可启动
- [ ] 测试前清空 test-interaction-1 工作空间的所有执行记录和 chat sessions，确保干净环境

## Risks & Notes

- R1: **迁移工作量** — 需要将 chat route 中所有 interaction-specific 逻辑迁移到新的 interaction route。包括 SSE streaming、completion detection、system prompt 注入。方案：分阶段迁移，先建新 route，再删旧逻辑。
- R2: **ChatPanel 适配** — ChatPanel 当前通过 `useChatStream` hook 与 chat API 交互。需要适配为与 interaction API 交互，或创建一个平行的 `useInteractionStream` hook。方案：复用 ChatPanel 的渲染组件，替换数据层。
- R3: **SDK session resume** — 当前 chatbot 的 chat session 有 `provider_session_id` 用于 SDK session resume。新架构下 interaction 需要自己管理 SDK session ID。方案：在 `node_executions.session_id` 中存储（已有字段）。
- R4: **AskUserQuestion 拦截** — 当前在 chat route 的 provider 层处理。迁移到 interaction route 后需要重新实现 PreToolUse hook + canUseTool。方案：从 provider.ts 中提取为独立模块，两边复用。
- R5: **InteractionDetailTabs 组件** — 需要新建组件并注册到 NodeInfoDialog。对话记录 tab 需要消息渲染能力（复用 MessageBubble）。方案：从 ChatPanel 提取纯渲染组件 `MessageList`，两边共用。
- R6: **agent_events 双写** — 关键事件写入 agent_events 需要在 interaction route 中完成，不经过 engine 的 EngineCallbacks。方案：interaction route 直接调用 `dao.insertAgentEvent()`。

## Glossary

| Term | Meaning |
|------|---------|
| Interaction Messages | Workflow 系统内存储的交互对话消息，独立于 chatbot |
| Workflow Ops API | 供外部（chatbot skill、CLI 等）查询和控制工作流的 API |
| octo-workflow-ops Skill | Workspace chatbot clone 的 skill，让 agent 能查询和控制工作流 |
| Interaction Route | Workflow 系统内处理交互对话 SSE streaming 的路由 |
