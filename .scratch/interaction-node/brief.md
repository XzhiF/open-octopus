# Requirement Brief — Interaction Node

## Overview
新增 `interaction` 类型工作流节点，基于 Chatbot UI 实现原生多轮人机交互，替代现有的 loop+approval+agent 三件套 hack 模式。

## Projects Involved
- [x] `@octopus/shared` (类型定义 — NodeDef 新增 interaction)
- [x] `@octopus/engine` (InteractionExecutor + complete_interaction 工具)
- [x] `@octopus/server` (Chat Bridge — 连接工作流执行与 Chat Session)
- [x] `@octopus/web-app` (Modal/Panel chatbot UI 集成)

## Feature Scope

**Do:**
- 新增 `interaction` 节点类型，与 bash/python/agent/condition/approval/loop/swarm 并列
- Agent 驱动的多轮动态对话（非静态 YAML 定义问题）
- 复用现有 Chat 基础设施的 AskUserQuestion 7 层拦截链 + QuestionCard UI
- 支持 mixed 输出格式（结构化问题 + 自由文本，由 Agent 决定）
- 双重完成信号：`complete_interaction` 工具 + `interaction_exit_when` 表达式
- 灵活的输出：vars_update（VarPool）、文件写入、outputs 映射（与 Agent 节点一致）
- 两种显示模式：modal（弹窗，默认）和 panel（嵌入侧边栏），YAML 可配置
- 全栈实现：shared → engine → server → web-app

**Don't:**
- 不做静态问题定义模式（跟 approval 无区别，无新增价值）
- 不做独立的 `ask_human` 工具（复用已有的 `AskUserQuestion`）
- 不改变现有 approval 节点行为（向后兼容）
- 不改 Chat Service 的核心逻辑（只做 Bridge 层）

## Key Decisions

| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| 1 | 节点定位 | 独立 `interaction` 节点 | 坍缩 loop+approval+agent 三件套为一个原生节点，与现有 executor 并列 |
| 2 | 问题生成 | Agent 动态驱动 | 静态定义跟 approval 无区别，无新增价值；动态生成支持根据上下文自适应 |
| 3 | 前端交互 | 混合模式（Agent 决定） | 支持结构化问题（QuestionCard）+ 自由文本，最灵活 |
| 4 | 后端集成 | Chat Bridge 模式 | 复用现有 chatbot 基础设施（7 层 AskUserQuestion 链路已完备），不需要造暂停/恢复机制 |
| 5 | 显示方式 | 可配置 modal/panel，默认 modal | Modal 强制焦点适合澄清场景；Panel 适合不阻塞工作流查看 |
| 6 | 完成信号 | 双重机制 | Agent 调用 `complete_interaction` 主动结束 + `interaction_exit_when` 表达式安全网 |
| 7 | 输出机制 | 复用 Agent 节点 | vars_update + 文件写入 + outputs 映射，Skills 驱动输出格式和内容 |
| 8 | SDK 集成 | 利用 Claude Agent SDK 的 session resume | 每次用户消息是一轮新的 `query(resume=sessionId)`，共享 session 上下文 |
| 9 | 范围 | 全栈实现 | 端到端交付，包含后端 + 前端 |
| 10 | 验证 | 单元 → 模拟器 → E2E → 手动 | 四层递进，自动验证完成后交人工确认 |

## Architecture Design

### 核心流程

```
Workflow Engine 执行到 interaction 节点
  ↓
InteractionExecutor.execute()
  ↓
创建 Chat Session（通过 Chat Bridge）
  → chatService.createSession(workspaceId, { title, linkedExecutionId, linkedNodeId })
  ↓
发送初始 Prompt（Agent 的第一轮 prompt）
  → chatService.sendMessage(sessionId, agentPrompt)
  → Claude SDK query() 启动
  ↓
Agent 运行中...
  → 调用 AskUserQuestion → PreToolUse hook 拦截 → ask_user_question chunk
  → SSE 推送到前端 → QuestionCard 渲染
  ↓
用户回答问题
  → 作为新的 user message 发送到 chat session
  → Claude SDK query(resume=sessionId) 继续对话
  ↓
[循环：Agent 可以继续问或决定完成]
  ↓
完成信号（两种之一）：
  A. Agent 调用 complete_interaction({ summary, vars_update })
  B. 引擎每轮检测 interaction_exit_when 表达式 → true
  ↓
InteractionExecutor 返回 NodeExecutionResult
  → status: "completed"
  → outputs: { summary, vars_update applied }
  ↓
Workflow Engine 继续下一步
```

### Chat Bridge 设计

Chat Bridge 是 Server 层的新组件，连接两个现有系统：

```
┌─────────────────┐     ┌──────────────┐     ┌──────────────┐
│ Workflow Engine  │     │ Chat Bridge  │     │ Chat Service │
│                  │────→│              │────→│              │
│ InteractionExec  │     │ 创建 session │     │ 管理 session │
│                  │←────│ 注入 prompt  │     │ 发送消息     │
│                  │     │ 监控完成信号 │     │ 流式响应     │
└─────────────────┘     └──────────────┘     └──────────────┘
                              ↕
                        ┌──────────────┐
                        │ 前端 UI      │
                        │ Modal/Panel  │
                        │ QuestionCard │
                        └──────────────┘
```

**Chat Bridge 职责**：
1. **创建 session** — `createInteractionSession(executionId, nodeId, agentConfig)` → 返回 sessionId
2. **注入初始 prompt** — `sendInitialPrompt(sessionId, prompt)` → 启动第一轮对话
3. **监控消息流** — 监听 SSE 事件，检测：
   - `complete_interaction` 工具调用 → 触发节点完成
   - 每轮 `result` chunk → 评估 `interaction_exit_when` 表达式
   - Agent 调用 `AskUserQuestion` → 已自动处理（7 层链路）
4. **转发用户输入** — 用户在 chatbot 中发送的消息自动注入 Agent session
5. **节点完成回调** — 检测到完成信号后，构造 `NodeExecutionResult`，通知 WorkflowEngine 继续

### Chat Session 扩展字段

```sql
-- chat_sessions 表新增字段
ALTER TABLE chat_sessions ADD COLUMN linked_execution_id TEXT;
ALTER TABLE chat_sessions ADD COLUMN linked_node_id TEXT;
ALTER TABLE chat_sessions ADD COLUMN interaction_mode TEXT;  -- 'modal' | 'panel'
ALTER TABLE chat_sessions ADD COLUMN interaction_status TEXT; -- 'active' | 'completed' | 'timeout'
```

### `complete_interaction` 工具

注册为 Claude SDK 的一个自定义工具（通过 hooks 或 tool 定义）：

```typescript
// 工具定义
{
  name: "complete_interaction",
  description: "当你认为已收集到足够信息时调用此工具结束交互",
  input_schema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "交互结果摘要" },
      vars_update: { type: "object", description: "要写入 VarPool 的变量" },
    },
    required: ["summary"]
  }
}
```

**拦截机制**：与 AskUserQuestion 类似，使用 PreToolUse hook 拦截 `complete_interaction`，不实际执行，而是捕获数据通知 Chat Bridge。

### YAML Schema

```yaml
- id: clarify-requirements
  type: interaction
  interaction_display: modal     # modal | panel（默认 modal）
  interaction_max_rounds: 10    # 最大对话轮次（安全网，默认 20）
  interaction_exit_when: >      # 可选：表达式驱动退出
    $vars.clarify_status == "COMPLETE"
  interaction_timeout: 3600     # 可选：超时秒数（默认无超时）
  interaction_agent:            # Agent 配置（同 Agent 节点的 agent 字段）
    skills: [octo-xzf-clarify]
    prompt: |
      你是需求澄清助手。根据以下信息开始澄清：
      $file:.scratch/$vars.feature/01-research/research.md
    model: sonnet               # 可选：模型选择
    context: continue           # 可选：session 上下文模式
  outputs:                      # 可选：输出映射（同 Agent 节点，复用通用字段）
    $vars.clarify_summary: "$last_output"
```

### NodeDef Schema 扩展

```typescript
// packages/shared/src/types/workflow.ts
export interface NodeDef {
  // ... existing fields ...

  // interaction 新增字段（统一 interaction_ 前缀，避免与通用字段混淆）
  interaction_display?: "modal" | "panel"
  interaction_max_rounds?: number
  interaction_exit_when?: string
  interaction_timeout?: number
  interaction_agent?: {
    skills?: string[]
    prompt?: string
    model?: string
    context?: "new" | "continue"
    goal?: string
    constraints?: string[]
  }
}

// NodeTypeSchema 扩展
export const NodeTypeSchema = z.enum([
  "bash", "python", "agent", "condition", "approval", "loop", "swarm",
  "interaction",  // 新增
])
```

## Data Model Changes

| Table | Operation | Details |
|-------|-----------|---------|
| `chat_sessions` | ADD COLUMN | `linked_execution_id TEXT` — 关联的执行 ID |
| `chat_sessions` | ADD COLUMN | `linked_node_id TEXT` — 关联的节点 ID |
| `chat_sessions` | ADD COLUMN | `interaction_mode TEXT` — modal/panel |
| `chat_sessions` | ADD COLUMN | `interaction_status TEXT` — active/completed/timeout |

## API Contracts

| Method | Path | Side | Params | Response | Notes |
|--------|------|------|--------|----------|-------|
| POST | `/api/executions/:id/interaction/:nodeId/start` | Server | `{ interaction_display }` | `{ sessionId }` | 启动交互 chat session（通常由引擎自动调用） |
| GET | `/api/executions/:id/interaction/:nodeId/status` | Server | — | `{ status, rounds, sessionId }` | 查询交互状态 |
| POST | `/api/executions/:id/interaction/:nodeId/complete` | Server | `{ summary, vars_update }` | `{ ok }` | 手动强制完成（超时/管理员干预） |

**SSE 事件**（复用现有机制）：
- `execution_interaction_started` — 交互节点开始，携带 sessionId 和 interaction_display mode
- `execution_interaction_completed` — 交互节点完成，携带 summary 和 vars_update
- Chat 本身的 SSE 事件流不变（text_delta, ask_user_question, etc.）

## Design Specs
- Figma link: none（复用现有 QuestionCard + Chat UI 组件）
- Fidelity: 与现有 workspace chatbot UI 一致

## Acceptance Criteria

| # | User Story | AC | Verification Method |
|---|-----------|----|-------------------|
| 1 | 工作流执行到 interaction 节点时暂停并打开 chatbot | 节点状态变为 `pending_interaction`，前端收到 SSE 事件，Modal 弹出 chatbot 界面 | E2E: 验证 Modal 弹出 + SSE 事件 |
| 2 | Agent 在 chatbot 中向用户提问 | Agent 调用 AskUserQuestion → QuestionCard 渲染（单选/多选/自由文本） | E2E: 验证 QuestionCard 正确渲染 |
| 3 | 用户回答后 Agent 继续对话 | 用户提交答案 → 新消息发送 → Agent 收到并继续 → 可能再次提问 | E2E: 验证多轮对话链路 |
| 4 | Agent 调用 complete_interaction 结束 | 节点状态变为 completed，VarPool 更新，工作流继续下一步 | 集成测试: 验证 vars_update 写入 + 下游节点执行 |
| 5 | interaction_exit_when 表达式触发退出 | 表达式为 true 时节点完成，即使 Agent 未调用 complete_interaction | 单元测试: 表达式评估 |
| 6 | panel 模式嵌入侧边栏 | `interaction_display: panel` 时 chatbot 嵌入工作流页面侧边栏，不弹 Modal | E2E: 验证 Panel 渲染位置 |
| 7 | max_rounds 安全网 | 达到 `interaction_max_rounds` 后节点自动完成，输出当前对话摘要 | 集成测试: 模拟超限 |
| 8 | 下游节点引用交互结果 | 下游节点可通过 `$nodeId.output` 和 VarPool 变量引用交互产出 | 集成测试: 验证变量解析 |
| 9 | 工作流模拟器支持 | test.yaml 中可为 interaction 节点配置 mock 对话序列 | 模拟器测试: 通过 test fixture |
| 10 | 向后兼容 | 现有 approval 节点和工作流行为不变 | 回归测试: 运行现有 test.yaml |

## Verification Strategy

### Global Config
- Environment: local dev (`pnpm dev`, server:3001, web:3000)
- Test user: 默认开发用户
- Data prefix: `E2E_INTERACTION_`

### Per-layer Methods

#### Unit Tests
- `InteractionExecutor` 创建和配置解析
- `interaction_exit_when` 表达式评估（true/false/边界）
- `complete_interaction` 工具拦截和参数提取
- `interaction_max_rounds` 计数器逻辑
- VarPool 更新正确性
- NodeDef schema 验证（新增字段）

#### Integration Tests (Simulator)
- 编写 `interaction.test.yaml` 测试工作流：
  - Happy path: 1 轮对话 → complete_interaction → 工作流继续
  - Multi-round: 3 轮对话（2 次 AskUserQuestion + 1 次 complete）
  - exit_when: Agent 设置变量 → interaction_exit_when 表达式触发退出
  - max_rounds: 超过 interaction_max_rounds 自动完成
  - timeout: 超过 interaction_timeout 自动完成
- 使用现有工作流模拟器运行

#### Browser E2E (Playwright)
- 启动工作流 → 验证 Modal 弹出 → 回答 QuestionCard → 验证多轮 → 验证节点完成 → 检查工作流继续
- Panel 模式: 验证侧边栏嵌入渲染
- 超时场景: 验证超时 UI 提示

#### Manual Checklist
- 手动运行包含 interaction 节点的 xzf-dev 变体工作流
- 实际在浏览器中完成多轮对话
- 验证 QuestionCard 各种类型（单选/多选/Other）
- 验证 VarPool 变量在下游节点正确解析
- 验证文件写入（.scratch/ 目录下的 decision 文件）

### Prerequisites
- [ ] 工作流模拟器支持 interaction 节点类型
- [ ] Playwright 测试环境就绪
- [ ] 开发环境可正常启动 (server + web-app)

## Risks & Notes

- R1: **Chat Bridge 状态管理** — 需要确保 workflow engine 重启后（如 server 重启），interaction session 能正确恢复。方案：interaction_status 持久化到 DB。
- R2: **SDK session resume 限制** — Claude Agent SDK 的 `resume` 参数有 session 有效期限制，长时间未活动的 session 可能过期。方案：设置合理的 `interaction_timeout`。
- R3: **并发** — 一个工作流同一时刻只有一个 interaction 节点活跃，但多个工作流可能同时有 interaction 节点。方案：每个 interaction session 独立，Chat Service 已支持多 session。
- R4: **前端改动范围** — web-app 需要感知 interaction 节点类型并渲染对应 UI。方案：扩展现有的 execution event handler，新增 interaction 事件类型。
- R5: **向后兼容** — `complete_interaction` 工具需要在 Agent 的 system prompt 中注册，但不影响现有 Agent 节点。方案：仅在 interaction 节点的 Agent 配置中注入该工具。

## Glossary (new domain terms)

| Term | Meaning |
|------|---------|
| Interaction Node | 新增的工作流节点类型，提供基于 chatbot 的多轮人机交互 |
| Chat Bridge | Server 层组件，连接 WorkflowEngine 执行上下文与 ChatService session |
| `complete_interaction` | 注册给 interaction 节点的 Agent 的特殊工具，Agent 调用表示"信息已充足" |
| Interaction Session | 与工作流执行关联的 chat session，有 `linked_execution_id` 和 `linked_node_id` |
| `pending_interaction` | interaction 节点的状态，表示正在等待用户通过 chatbot 完成对话 |
