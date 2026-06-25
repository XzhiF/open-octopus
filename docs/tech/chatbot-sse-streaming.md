# Chatbot SSE 流式对话系统

> 基于 SSE (Server-Sent Events) 的实时流式对话方案，支持思考块、工具调用、多会话管理，前后端完整数据闭环

## 目录

- [核心概念](#核心概念)
- [架构设计](#架构设计)
- [数据库设计](#数据库设计)
- [类设计与接口](#类设计与接口)
- [前后端数据类型映射](#前后端数据类型映射)
- [完整数据流程](#完整数据流程)
- [SSE Chunk 类型与处理](#sse-chunk-类型与处理)
- [服务端持久化策略](#服务端持久化策略)
- [客户端 Hook 设计](#客户端-hook-设计)
- [多会话管理](#多会话管理)
- [踩坑记录与关键决策](#踩坑记录与关键决策)

---

## 核心概念

### 为什么用 SSE 而不是 WebSocket？

LLM 响应是单向流（服务端 → 客户端），SSE 天然适合这种场景：协议简单、自动重连、HTTP 兼容性好。WebSocket 适合双向交互，但对单向流式响应是过度设计。

| 对比维度 | SSE | WebSocket |
|----------|-----|-----------|
| 方向 | 服务端 → 客户端（单向） | 双向 |
| 重连 | 自动 | 需手动实现 |
| 协议 | 标准 HTTP | 独立协议 |
| 适合场景 | LLM 流式响应 | 双向实时协同 |

同时，workspace 级别的 SSE 连接（`/api/workspaces/:id/events`）用于跨 Tab 通知（session_updated、session_created），与消息流式通道解耦。

---

## 架构设计

### 整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│  Next.js 前端 (web-app)                                         │
│                                                                 │
│  ┌──────────────┐  ┌───────────────────┐  ┌─────────────────┐ │
│  │ SessionTabs  │  │ useChatStream hook│  │ ChatPanel       │ │
│  │ (会话切换UI) │  │ (SSE解析+状态管理)│  │ (消息列表+输入) │ │
│  └──────────────┘  └───────────────────┘  └─────────────────┘ │
│         │                  │                     │              │
│         │    ┌─────────────┴──────────────┐     │              │
│         │    │  page.tsx (activeSessionId │     │              │
│         │    │  + localStorage 持久化)    │     │              │
│         │    └────────────────────────────┘     │              │
└─────────┼──────────────────────────────────────────────────────┘
          │ API calls (fetch + SSE)
          │
┌─────────┼──────────────────────────────────────────────────────┌
│  Hono 后端 (server)                                            │
│                                                                 │
│  ┌──────────────┐  ┌───────────────┐  ┌─────────────────────┐ │
│  │ chat.ts      │  │ ChatService   │  │ ClaudeSDKProvider   │ │
│  │ (REST+SSE    │  │ (DB读写+      │  │ (sendQuery →        │ │
│  │  路由层)     │  │  消息持久化)  │  │  async MessageChunk) │ │
│  └──────────────┘  └───────────────┘  └─────────────────────┘ │
│         │                  │                  │                 │
│  ┌──────────────┐  ┌───────────────┐                           │
│  │ SSEService   │  │ SQLite DB     │                           │
│  │ (workspace   │  │ (chat_sessions│                           │
│  │  事件广播)   │  │  chat_messages)│                           │
│  └──────────────┘  └───────────────┘                           │
└─────────────────────────────────────────────────────────────────┘
```

### 三层通信通道

| 通道 | 方向 | 用途 | 路径 |
|------|------|------|------|
| **消息流** | 请求: POST → 响应: SSE stream | 发送消息、接收流式响应 | `/sessions/:id/messages` |
| **会话通知** | SSE 推送 | 跨 Tab 同步（session_updated/created） | `/workspaces/:id/events` |
| **CRUD API** | REST | 创建/查询/删除/重命名会话 | `/sessions` 系列 |

---

## 数据库设计

### chat_sessions 表

```sql
CREATE TABLE chat_sessions (
  id TEXT PRIMARY KEY,              -- UUID
  workspace_id TEXT NOT NULL,       -- 所属 workspace
  title TEXT,                       -- 会话标题（null=未命名）
  is_active INTEGER DEFAULT 1,     -- 是否活跃
  provider TEXT DEFAULT 'claude',   -- LLM provider (v4 migration)
  provider_session_id TEXT,         -- provider SDK 会话 ID（用于多轮续接）
  created_at TEXT NOT NULL,         -- ISO timestamp
  updated_at TEXT NOT NULL          -- ISO timestamp（每次 addMessage 自动更新）
);

CREATE INDEX idx_chat_sessions_workspace ON chat_sessions(workspace_id);
```

### chat_messages 表

```sql
CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,              -- UUID
  session_id TEXT NOT NULL,         -- FK → chat_sessions.id
  role TEXT NOT NULL,               -- "user" | "assistant" | "system"
  type TEXT DEFAULT 'text',         -- "text" | "thinking" | "tool_call" | "command" | "execution" | "error" | "file"
  content TEXT NOT NULL,            -- 文本内容（thinking/tool_call 行此字段为空）
  metadata TEXT,                    -- JSON 字符串，承载所有富显示字段
  created_at TEXT NOT NULL          -- ISO timestamp（用于消息排序）
);

CREATE INDEX idx_chat_messages_session ON chat_messages(session_id);
```

**关键设计决策：** `metadata` 是一个 TEXT 列存储 JSON 字符串，而非多个独立列。原因：
1. SQLite TEXT 无枚举约束，`type` 可以存 `"thinking"` / `"tool_call"` 等任意值
2. 不同消息类型的 metadata 结构差异大（thinking 有 `thinkingContent`，tool_call 有 `toolCallId/toolResult`），独立列会导致大量空值
3. 前端 `fromDBMessage` 已完整支持从 metadata JSON 反序列化所有字段

### metadata JSON 结构

| 消息 type | metadata 内容 |
|-----------|--------------|
| **user** | `{ displayType: "user" }` |
| **thinking** | `{ displayType: "thinking", thinkingContent: "...", thinkingDone: true }` |
| **tool_call** | `{ displayType: "tool_call", toolCallId, toolName, toolInput, toolStatus, toolResult, toolDuration }` |
| **text** (assistant) | `{ displayType: "text", tokens: {input, output}, costUsd }` |

### Schema 版本历史

| 版本 | 变更 |
|------|------|
| v1 | 初始 chat_sessions + chat_messages |
| v2 | 表重建（无列变化） |
| v3 | 添加 orgs 表 |
| v4 | chat_sessions 添加 `provider` + `provider_session_id` 列 |

**当前版本：4。** thinking/tool_call 类型无需 schema migration — SQLite TEXT 列无枚举约束。

---

## 类设计与接口

### 服务端 — ChatService

```typescript
// packages/server/src/services/chat.ts

interface ChatSessionRow {        // DB 行形状
  id, workspace_id, title, is_active, provider,
  provider_session_id, created_at, updated_at
}

interface ChatMessageRow {        // DB 行形状
  id, session_id, role, type, content, metadata, created_at
}

export interface ChatSession {    // API 返回形状（camelCase）
  id, workspaceId, title, isActive, provider,
  providerSessionId, createdAt, updatedAt, messages
}

export interface ChatMessage {    // API 返回形状（metadata 为原始 JSON 字符串）
  id, sessionId, role, type, content, metadata, createdAt
}

class ChatService {
  constructor(db: Database, sse: SSEService)

  // Session CRUD
  createSession(workspaceId, title?)   → ChatSession
  getSession(sessionId)                → ChatSession | undefined   // 含 messages
  listSessions(workspaceId)            → ChatSession[]             // 按 updated_at DESC
  deleteSession(sessionId)             → void                      // 级联删 messages
  updateSessionTitle(sessionId, title) → void
  updateProviderSession(sessionId, pid)→ void

  // Message CRUD
  addMessage(sessionId, {role, type?, content, metadata?}) → ChatMessage
  getMessages(sessionId)                                   → ChatMessage[]  // 按 created_at ASC
  updateMessageMetadata(messageId, metadata)               → void           // 不更新 created_at
}
```

**设计要点：**
- `addMessage` 同时更新 `chat_sessions.updated_at`，保证 listSessions 排序正确
- `updateMessageMetadata` 只更新 metadata，不更新 `created_at` — 保持 tool_call 行在流中的原始时序位置
- `deleteSession` 先删 messages 再删 session（SQLite 无外键约束，需手动级联）

### 服务端 — SSEService

```typescript
// packages/server/src/services/sse.ts

class SSEService {
  subscribe(workspaceId, listener)  → unsubscribe function
  emit(workspaceId, {event, data})  → void   // 广播给该 workspace 所有 SSE 监听者
  emitToAll({event, data})          → void
}
```

### 前端 — ChatMessage（显示层）

```typescript
// packages/web-app/lib/types.ts

type MessageRole = "user" | "assistant" | "system"
type MessageDisplayType = "user" | "thinking" | "tool_call" | "text" | "error" | "file"

interface ChatMessage {
  id: string
  sessionId: string
  role: MessageRole
  displayType: MessageDisplayType    // ← 关键：决定渲染哪个组件
  content: string
  timestamp: string
  // thinking 专用字段
  thinkingContent?: string
  thinkingDone?: boolean
  // tool_call 专用字段
  toolCallId?: string
  toolName?: string
  toolInput?: unknown
  toolStatus?: "running" | "done" | "error"
  toolResult?: string
  toolDuration?: string
  // token/cost 字段
  tokens?: { input: number; output: number }
  costUsd?: number
}
```

**DB `type` ≠ 前端 `displayType`。** 映射逻辑在 `fromDBMessage` + `mapDBType`：

```
DB type "text"       → displayType "text"
DB type "thinking"   → displayType "thinking"
DB type "tool_call"  → displayType "tool_call"
DB type "tool"       → displayType "tool_call"   // 旧值兼容
DB type "error"      → displayType "error"
DB type "file"       → displayType "file"
metadata.displayType → 直接覆盖（优先级最高）
DB role "user" + 无 displayType → displayType "user"  // 向后兼容
```

### 前端 — useChatStream Hook

```typescript
// packages/web-app/components/workspace/chat/use-chat-stream.ts

function useChatStream(workspaceId, activeSessionId): {
  messages, sessions, isStreaming, status,
  sendMessage, abort, createSession, switchSession,
  deleteSession, renameSession, loadSessionMessages
}
```

状态：
- `messages: ChatMessage[]` — 当前所有消息（跨 session）
- `sessions: ChatSession[]` — workspace 下所有会话
- `isStreaming` — 是否正在流式接收
- `status` — 'compacting' | 'requesting' | null

### 前端 — page.tsx 会话管理

```typescript
// packages/web-app/app/workspaces/[id]/page.tsx

const [activeSessionId, setActiveSessionId] = useState<string | null>(() => {
  const stored = localStorage.getItem(`octopus:ws:${id}:activeSession`)
  return stored || null    // null = 无活跃会话，不用空字符串
})

// Auto-select：只执行一次，选最近会话
const initialSelectDone = useRef(false)
useEffect(() => {
  if (!activeSessionId && !initialSelectDone.current && allSessions.length > 0) {
    initialSelectDone.current = true
    setActiveSessionId(allSessions[0].id)
    switchSession(allSessions[0].id)
  }
}, [activeSessionId, allSessions, switchSession])

// 消息过滤：只显示当前活跃会话的消息
const currentMessages = messages.filter(m => m.sessionId === activeSessionId)
```

---

## 前后端数据类型映射

### DB → API → 前端 三层转换

```
DB Row (snake_case, metadata=string)
  ↓ ChatService.toMessage()
API Response (camelCase, metadata=string)
  ↓ fromDBMessage()
前端 ChatMessage (displayType, metadata 已展开为独立字段)
```

### 字段对照表

| DB 列 | API 字段 | 前端字段 | 说明 |
|--------|----------|----------|------|
| `id` | `id` | `id` | UUID |
| `session_id` | `sessionId` | `sessionId` | |
| `role` | `role` | `role` | "user"/"assistant"/"system" |
| `type` | `type` | `displayType` | DB type ≠ displayType，需映射 |
| `content` | `content` | `content` | |
| `metadata` (JSON string) | `metadata` (JSON string) | 各独立字段 | `fromDBMessage` 展开 |
| `created_at` | `createdAt` | `timestamp` | |

---

## 完整数据流程

### 发送消息流程（最核心）

```
用户输入 → handleSend()
  │
  ├─ 无 activeSessionId? → POST /sessions → 创建新会话 → optimistic setSessions
  │
  ├─ 创建 optimistic messages:
  │   userMsg   { id: "user-{ts}", displayType: "user", content }
  │   thinkingMsg { id: "thinking-{ts}", displayType: "thinking", content: "" }
  │   → setMessages([...prev, userMsg, thinkingMsg])
  │
  ├─ POST /sessions/:id/messages (SSE stream response)
  │   │
  │   │ 服务端同步：
  │   ├─ addMessage(sessionId, {role:"user", content, metadata:{displayType:"user"}})
  │   ├─ agent.sendQuery() → async chunkStream
  │   │   │
  │   │   │ 每个 chunk:
  │   │   ├─ forwarding: stream.writeSSE({event: chunk.type, data: JSON({sessionId, ...chunk})})
  │   │   ├─ persistence:
  │   │   │   thinking_start → reset accumulator
  │   │   │   thinking      → accumulate thinkingContent
  │   │   │   thinking_done → addMessage(type:"thinking", metadata:{thinkingContent, thinkingDone:true})
  │   │   │   tool_call_start → track in toolCallMap
  │   │   │   tool_call      → addMessage(type:"tool_call", metadata:{...toolStatus:"running"})
  │   │   │   tool_result   → updateMessageMetadata(加入 toolResult, toolDuration, toolStatus)
  │   │   │   text_delta    → accumulate fullText
  │   │   │   result        → capture tokens/costUsd
  │   │   │
  │   │   └─ 流结束后:
  │   │      addMessage(role:"assistant", type:"text", metadata:{displayType:"text", tokens, costUsd})
  │   │      sseService.emit("session_updated") → 通知其他 Tab
  │   │
  │   │ 客户端同步（逐 chunk）：
  │   ├─ SSE 解析 → applyChunk(eventData) → setMessages 不可变更新
  │   │   message_start → 替换 optimistic "thinking-{ts}" 的 id 为真实 msgId
  │   │   thinking      → append thinkingContent
  │   │   thinking_done → set thinkingDone=true
  │   │   tool_call_start → 新建 toolMsg
  │   │   tool_call      → update toolInput
  │   │   tool_progress → update toolDuration
  │   │   tool_result   → update toolStatus + toolResult
  │   │   text_delta    → append content 或新建 text msg
  │   │   result        → attach tokens/costUsd
  │   │   error         → toast.error()
  │   │
  │   ├─ 流结束 → isStreaming=false, 生成标题 (POST /generate-title)
  │
  └─ return resolvedSessionId
```

### 刷新/初始加载流程

```
页面 mount
  │
  ├─ activeSessionId 从 localStorage 读取（或 null）
  │
  ├─ useChatStream 初始化:
  │   ├─ useEffect → loadSessions() → fetch GET /sessions → setSessions
  │   ├─ useEffect → activeSessionId? → loadSessionMessages() → fetch GET /sessions/:id
  │   │   → data.messages.map(fromDBMessage) → setMessages
  │   │   → thinking/tool_call/text 行全部从 DB 恢复
  │   ├─ useEffect → EventSource SSE 连接（workspace 级事件通知）
  │
  ├─ page.tsx auto-select:
  │   !activeSessionId && allSessions.length > 0 && !initialSelectDone
  │   → setActiveSessionId(allSessions[0].id) → switchSession
  │
  ├─ 消息过滤:
  │   currentMessages = messages.filter(m => m.sessionId === activeSessionId)
  │   → ChatPanel 渲染
```

---

## SSE Chunk 类型与处理

### Provider 发出的 Chunk 类型（完整）

| Chunk type | 含义 | 服务端处理 | 客户端处理 |
|------------|------|-----------|-----------|
| `message_start` | 新消息开始 | 记录 sdkMessageId | 替换 optimistic id |
| `text_delta` | 文本增量 | accumulate fullText | append content |
| `text_done` | 文本结束 | 无 | 无 |
| `thinking_start` | 思考开始 | reset accumulator | 无 (thinking msg 已存在) |
| `thinking` | 思考增量 | accumulate thinkingContent | append thinkingContent |
| `thinking_done` | 思考结束 | addMessage(type:"thinking") | set thinkingDone=true |
| `tool_call_start` | 工具调用开始 | track in toolCallMap | 新建 toolMsg |
| `tool_call` | 工具输入 | addMessage(type:"tool_call") | update toolInput |
| `tool_progress` | 工具进度 | 无 DB 操作 | update toolDuration |
| `tool_result` | 工具结果 | updateMessageMetadata | update toolStatus+toolResult |
| `tool_summary` | 工具摘要 | 无 | 无 |
| `message_delta` | 消息元数据 | 无 | 无 |
| `message_stop` | 消息结束 | 无 | 无 |
| `status` | 状态变更 | 无 DB 操作 | setStatus |
| `result` | 最终结果 | capture tokens/costUsd | attach tokens/costUsd |
| `error` | 错误 | classify + forward | toast.error |

### SSE Frame 格式

```
event: {chunk.type}
data: JSON.stringify({ sessionId, ...chunk })
```

客户端解析逻辑：
1. 读 `event:` 行 → 记录 currentEventType
2. 读 `data:` 行 → JSON.parse → 如果无 type 字段，用 currentEventType 补充
3. 调用 `applyChunk(eventData)` → setMessages 不可变更新

---

## 服务端持久化策略

### 核心原则：每类消息独立行

一次对话产生多行 DB 记录，而非将所有信息压缩到一行：

| 时机 | DB 操作 | 行 type |
|------|---------|---------|
| 请求开始 | `addMessage(role:"user", type:"text", metadata:{displayType:"user"})` | text |
| thinking_done | `addMessage(role:"assistant", type:"thinking", metadata:{thinkingContent, thinkingDone})` | thinking |
| tool_call | `addMessage(role:"assistant", type:"tool_call", metadata:{...toolStatus:"running"})` | tool_call |
| tool_result | `updateMessageMetadata(metadata:{...toolResult, toolDuration, toolStatus:"done"})` | tool_call (原地更新) |
| 流结束 | `addMessage(role:"assistant", type:"text", metadata:{tokens, costUsd})` | text |

### tool_result 更新策略

`tool_result` 不创建新行，而是 `updateMessageMetadata` 原地更新 tool_call 行的 metadata。**不更新 `created_at`** — 保持行在流中的原始时序位置。

### 全空文本的保护

流结束持久化 assistant text 行的条件从 `if (fullText && !aborted)` 改为 `if (!aborted)`。当模型只使用工具无文本输出时，仍需持久化以保存 tokens/costUsd 元数据。

---

## 客户端 Hook 设计

### Optimistic 消息

用户发送消息后，客户端立即创建两条 optimistic 消息（不等待服务端响应）：

```typescript
const userMsg = { id: `user-${Date.now()}`, displayType: "user", content }
const thinkingMsg = { id: `thinking-${Date.now()}`, displayType: "thinking", content: "" }
setMessages(prev => [...prev, userMsg, thinkingMsg])
```

当 `message_start` chunk 到达时，`applyChunk` 找到这个 optimistic thinking 消息（特征：id 以 `"thinking-"` 开头，无 thinkingContent），将其 id 替换为服务端真实 messageId。这样避免了重复创建消息行。

### 重复 ID 防护

`applyChunk` 中 `message_start` 和 `text_delta` 都加了前置检查：

```typescript
case "message_start": {
  if (prev.some(m => m.id === msgId)) return prev   // ← 已存在则跳过
  // ... 替换 optimistic 或新建
}
case "text_delta": {
  if (prev.some(m => m.id === msgId)) return prev   // ← 已存在则跳过新建
  // ... append 或新建
}
```

防止 SSE `session_updated` 触发的 `loadSessionMessages` 与流式 `applyChunk` 产生同一 ID 的重复消息。

### 流式期间的 loadSessionMessages 保护

```typescript
const loadSessionMessages = useCallback(async (sessionId) => {
  if (isStreaming) return    // ← 流式期间不加载，避免冲掉客户端富消息
  // ... fetch + fromDBMessage + setMessages
}, [workspaceId, isStreaming])
```

---

## 多会话管理

### API 端点

| 方法 | 路径 | 功能 |
|------|------|------|
| POST | `/sessions` | 创建会话 |
| GET | `/sessions` | 列出会话（按 updated_at DESC） |
| GET | `/sessions/:id` | 获取会话+消息 |
| DELETE | `/sessions/:id` | 删除会话+级联删消息 |
| PATCH | `/sessions/:id` | 重命名（body: {title}) |
| POST | `/sessions/:id/messages` | 发送消息（SSE 流式响应） |
| POST | `/sessions/:id/generate-title` | AI 生成标题 |

### SessionTabs UI

- 双击 tab → 进入编辑模式 → onRenameSession
- 右侧 + 按钮 → onCreateSession → 新建会话
- hover 显示 ✏️ 编辑按钮和 ✕ 删除按钮
- **+ 按钮 sticky**：布局为 flex 容器，tabs 区域 `overflow-x-auto flex-1 min-w-0` 可滚动，+ 按钮 `shrink-0` 固定在右侧不随滚动消失

### 删除会话

客户端 `deleteSession` 同时调 DELETE API 和更新 state。页面层额外处理：删除当前活跃会话时，自动切换到剩余最近会话或置 null。

### 重命名会话

客户端 `renameSession` 同时调 PATCH API 和更新 state，刷新后从 DB 加载不会丢失。

---

## 踩坑记录与关键决策

### 1. 流式结束后 thinking/tool 信息消失

**问题：** 服务端只存 2 行（user text + assistant text），thinking 块和 tool call 从不持久化。流结束后 SSE `session_updated` 触发 `loadSessionMessages`，客户端富消息被 DB 扁平行替换。

**解决：** 每类消息独立持久化。thinking_done 时存 thinking 行，tool_call 时存 tool_call 行，tool_result 时原地更新 metadata。前端 `fromDBMessage` 已有完整反序列化路径，只差服务端写入。

### 2. React duplicate key 报错

**问题：** `messages.map(msg => <MessageBubble key={msg.id}>)` 中出现两个同 id 消息，源于 `loadSessionMessages` 和 `applyChunk` 同时操作产生重复。

**解决：** 双重防护：(a) `applyChunk` 中 message_start/text_delta 前置 `prev.some(m => m.id === msgId)` 检查；(b) ChatPanel 渲染时，如果同 id 出现多次，fallback 为 `${msg.id}-${idx}`。

### 3. TDZ (Temporal Dead Zone) 报错

**问题：** `useEffect` 放在 `loadSessions`/`loadSessionMessages` 的 `useCallback` 定义之前，引用了尚未声明的变量，触发 `Cannot access 'loadSessions' before initialization`。

**解决：** 将 mount 时的两个 `useEffect`（调用 `loadSessions` 和 `loadSessionMessages`）移到 `useCallback` 定义之后。

### 4. 页面刷新不显示最近会话

**问题：** `useChatStream` 从不在 mount 时调用 `loadSessions` 或 `loadSessionMessages`，sessions 和 messages 均为空数组。

**解决：** 添加两个 mount `useEffect`：`loadSessions()` 初始化会话列表，`activeSessionId` 变化时 `loadSessionMessages`。页面层 auto-select：`!activeSessionId && allSessions.length > 0` 时选 `allSessions[0]`（按 updated_at DESC 排序的第一个）。

### 5. activeSessionId 空字符串导致循环创建会话

**问题：** `activeSessionId` 用 `""` 空字符串表示"无会话"，`!activeSessionId` 对 `""` 为 true，导致 auto-select effect 在每次 allSessions 更新时反复触发。`sendMessage` 中 `!sessionId` 也触发创建新会话而非复用已有会话。

**解决：** `activeSessionId` 改为 `string | null`，用 `null` 表示"无会话"。auto-select effect 加 `useRef(initialSelectDone)` 只执行一次。

### 6. 删除会话删不掉

**问题：** `deleteSession` 只在客户端 state 移除，没有调 DELETE API，刷新后 `loadSessions` 从 DB 加载又恢复。

**解决：** 服务端新增 `DELETE /sessions/:sessionId` + `ChatService.deleteSession()`（级联删 messages + session）。客户端先调 API 再更新 state。

### 7. 重命名会话刷新丢失

**问题：** 与删除同理 — `renameSession` 只更新客户端 state，刷新后从 DB 加载恢复原名。

**解决：** 服务端新增 `PATCH /sessions/:sessionId` + 客户端先调 PATCH API 再更新 state。

### 8. input value 为 null 报错

**问题：** `session.title` 类型是 `string | null`，`setEditTitle(session.title)` 在 title 为 null 时设 editTitle 为 null，传给 `<input value={null}>` 报错。

**解决：** `setEditTitle(session.title ?? "")` 确保 editTitle 始终是字符串。

### 9. "思考中"误导用户

**问题：** 发消息后客户端创建 optimistic thinking 占位消息，显示"思考中"。但这是等待响应状态，并非 AI 真正思考。

**解决：** ThinkingBlock 根据状态区分：`isActive && !hasThinking` → "响应中"（等待状态）；`isActive && hasThinking` → "思考中"（真正思考）；`!isActive` → "思考"（完成标签）。

### 10. + 按钮随 tab 滚动消失

**问题：** tabs 和 + 按钮在同一个 `overflow-x-auto` 容器内，tab 多了后 + 按钮被滚出视野。

**解决：** 拆为两层：tabs 区域 `overflow-x-auto flex-1 min-w-0`（可滚动），+ 按钮 `shrink-0` 固定在右侧。

### 11. Placeholder 导致输入框换行

**问题：** 13.3寸屏幕上 placeholder "(Enter发送，Shift+Enter换行)" 太长导致 textarea 换行。

**解决：** 用 `ResizeObserver` 监听输入框容器宽度：< 250px 显示短 placeholder "输入消息..."，≥ 250px 显示完整 "输入消息... (Enter发送，Shift+Enter换行)"。`placeholder:text-xs` 让提示文字比输入文字更小。