# Technical Spec — Interaction 节点架构重设计

## Executive Summary

将 Interaction 节点从"借用 chatbot session"重构为"workflow-native 对话系统"。对话数据归 workflow 所有（`interaction_messages` 表），通过独立的 interaction route 处理 SSE streaming，chatbot 通过 skill 获得 workflow 感知能力。

## Architecture Overview

### Current Flow (AS-IS)

```
Engine → pending_interaction → ChatBridge.createInteractionSession()
  → chat_sessions row (linked_execution_id, linked_node_id)
  → Frontend polls → opens InteractionModal
  → useChatStream → POST /chat/sessions/:id/messages (SSE)
  → Chat route: isInteractionSession=true, system prompt swap, canUseTool
  → complete_interaction detected → ExecutionLifecycle.completeInteraction()
  → engine.retryFrom(nodeId, { interactionCompletion })
```

### Target Flow (TO-BE)

```
Engine → pending_interaction → SSE: execution_interaction_started
  → Frontend receives SSE → opens InteractionModal
  → useInteractionStream → POST /interactions/:execId/:nodeId/messages (SSE)
  → Interaction route: InteractionService, own SDK session, system prompt, canUseTool
  → Messages stored in interaction_messages (not chat_messages)
  → complete_interaction detected → ExecutionLifecycle.completeInteraction()
  → engine.retryFrom(nodeId, { interactionCompletion })
```

### Key Change: Data Ownership

| Concern | AS-IS | TO-BE |
|---------|-------|-------|
| Message storage | `chat_messages` table | `interaction_messages` table |
| Session link | `chat_sessions.linked_*` fields | In-memory tracking in InteractionService |
| SSE streaming | Chat route (`/chat/sessions/:id/messages`) | Interaction route (`/interactions/:execId/:nodeId/messages`) |
| System prompt | Hardcoded in chat route | InteractionService (extracted) |
| Tool interception | Provider's `canUseTool` (shared) | Provider's `canUseTool` (shared, no change) |
| Token/cost tracking | Chat route → `node_token_usages` | Interaction route → `node_token_usages` (natural) |
| Chatbot access | Direct DB query | Workflow Ops API via skill |

## Component Specifications

### 1. Data Layer (`@octopus/server` + `@octopus/shared`)

#### 1.1 New Table: `interaction_messages`

```sql
CREATE TABLE IF NOT EXISTS interaction_messages (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  role TEXT NOT NULL,           -- 'user' | 'assistant' | 'system'
  type TEXT NOT NULL DEFAULT 'text',  -- 'text' | 'thinking' | 'tool_call' | 'ask_user_question'
  content TEXT NOT NULL,
  metadata TEXT,                 -- JSON: tokens, cost, tool info, displayType
  created_at TEXT NOT NULL,
  FOREIGN KEY (execution_id) REFERENCES executions(id)
);

CREATE INDEX IF NOT EXISTS idx_interaction_msgs_exec_node
  ON interaction_messages(execution_id, node_id, created_at ASC);
```

#### 1.2 InteractionMessageRow Type

```typescript
// packages/server/src/db/types.ts
export interface InteractionMessageRow {
  id: string
  execution_id: string
  node_id: string
  role: "user" | "assistant" | "system"
  type: "text" | "thinking" | "tool_call" | "ask_user_question"
  content: string
  metadata: string | null  // JSON string
  created_at: string
}
```

#### 1.3 InteractionMessageDAO

```typescript
// packages/server/src/db/dao/interaction-message-dao.ts
export class InteractionMessageDAO extends BaseDAO {
  insertMessage(row: InteractionMessageRow): RunResult
  findMessages(executionId: string, nodeId: string, opts?: {
    limit?: number; before?: string
  }): InteractionMessageRow[]
  findMessageById(id: string): InteractionMessageRow | null
  countMessages(executionId: string, nodeId: string): number
  updateMessageMetadata(id: string, metadata: string): RunResult
  deleteMessagesByExecution(executionId: string): RunResult
}
```

#### 1.4 Chat Sessions Cleanup

Remove from `chat_sessions` table definition:
- `linked_execution_id`
- `linked_node_id`
- `interaction_mode`
- `interaction_status`

Remove from `ChatDAO`:
- `findInteractionSession()`
- `updateInteractionStatus()`

Remove from `ChatSessionRow` type:
- Same 4 fields

### 2. InteractionService (`@octopus/server`)

#### 2.1 Responsibilities

- Manage in-memory interaction sessions (replacing ChatBridge)
- Create and manage Claude SDK sessions for interaction conversations
- Inject interaction system prompt
- Configure `canUseTool` callback for AskUserQuestion and complete_interaction interception
- Stream SSE events to frontend
- Store messages in `interaction_messages` table
- Write key events to `agent_events` table
- Write token/cost to `node_token_usages` and `llm_calls`
- Detect completion and call `ExecutionLifecycle.completeInteraction()`

#### 2.2 Interface

```typescript
// packages/server/src/services/interaction/InteractionService.ts
export class InteractionService {
  constructor(
    private messageDao: InteractionMessageDAO,
    private provider: ClaudeSDKProvider,
    private execLifecycle: ExecutionLifecycle,
    private sseService: SSEService,
  ) {}

  /**
   * Start an interaction session for a pending interaction node.
   * Called when frontend receives execution_interaction_started SSE.
   */
  async startInteraction(params: {
    workspaceId: string
    executionId: string
    nodeId: string
    display?: "modal" | "panel"
    title?: string
    initialPrompt?: string
    maxRounds?: number
    timeout?: number
  }): Promise<{ sessionId: string }>

  /**
   * Send a user message and stream SSE response.
   * Returns an async generator of SSE events.
   */
  async *sendMessage(params: {
    executionId: string
    nodeId: string
    content: string
  }): AsyncGenerator<SSEEvent>

  /**
   * Get message history for an interaction.
   */
  async getMessages(params: {
    executionId: string
    nodeId: string
    limit?: number
    before?: string
  }): Promise<InteractionMessageRow[]>

  /**
   * Force complete an interaction (admin/timeout).
   */
  async forceComplete(params: {
    executionId: string
    nodeId: string
    summary: string
    varsUpdate?: Record<string, any>
  }): Promise<{ ok: boolean }>

  /**
   * Get interaction session status.
   */
  getSessionStatus(executionId: string, nodeId: string): InteractionSessionInfo | null
}
```

#### 2.3 In-Memory Session Tracking

```typescript
interface InteractionSessionInfo {
  sessionId: string          // Internal UUID for this interaction
  executionId: string
  nodeId: string
  workspaceId: string
  display: "modal" | "panel"
  maxRounds: number
  currentRound: number
  providerSessionId?: string  // Claude SDK session ID for resume
  startedAt: number
  timeout?: number
}
```

Sessions tracked in `Map<string, InteractionSessionInfo>` keyed by `${executionId}:${nodeId}`.

#### 2.4 System Prompt

Extracted from chat route lines 112–148 into a dedicated constant:

```typescript
const INTERACTION_SYSTEM_PROMPT = `You are an interactive workflow agent...`
```

#### 2.5 SSE Event Flow

The `sendMessage` method:
1. Look up session by `${executionId}:${nodeId}`
2. Save user message to `interaction_messages`
3. Call `provider.sendQuery()` with:
   - `interactionSession: true`
   - System prompt: `INTERACTION_SYSTEM_PROMPT`
   - `providerSessionId` from session (for SDK resume)
4. Stream chunks from provider:
   - Save assistant messages to `interaction_messages`
   - Write token/cost to `node_token_usages` and `llm_calls`
   - Write key events to `agent_events`
   - Yield SSE events to caller
5. On `complete_interaction` chunk:
   - Call `execLifecycle.completeInteraction()`
   - Clean up in-memory session
6. On `ask_user_question` chunk:
   - Save with `displayType: "ask_user_question"` metadata
   - Yield to frontend

#### 2.6 Agent Events (Key Events Double-Write)

```typescript
// On interaction start
insertAgentEvent(nodeExecutionId, {
  event_type: "interaction_started",
  content: JSON.stringify({ display, maxRounds })
})

// On ask_user_question
insertAgentEvent(nodeExecutionId, {
  event_type: "interaction_ask_user_question",
  content: JSON.stringify({ questions })
})

// On complete
insertAgentEvent(nodeExecutionId, {
  event_type: "interaction_completed",
  content: JSON.stringify({ summary, vars_update })
})
```

### 3. Interaction Route (`@octopus/server`)

#### 3.1 Route Definitions

All routes under `/api/workspaces/:id/interactions/`:

| Method | Path | Handler | Response |
|--------|------|---------|----------|
| POST | `/:execId/:nodeId/start` | `startInteraction` | `{ sessionId }` |
| POST | `/:execId/:nodeId/messages` | `sendMessage` | SSE stream |
| GET | `/:execId/:nodeId/messages` | `getMessages` | `InteractionMessageRow[]` |
| POST | `/:execId/:nodeId/complete` | `forceComplete` | `{ ok: true }` |
| GET | `/:execId/:nodeId/status` | `getStatus` | `{ status, round, ... }` |

#### 3.2 Route File

```typescript
// packages/server/src/routes/interaction.ts
import { Hono } from "hono"
import { streamSSE } from "hono/streaming"

const interaction = new Hono()

// POST /:execId/:nodeId/start
interaction.post("/:execId/:nodeId/start", async (c) => { ... })

// POST /:execId/:nodeId/messages (SSE)
interaction.post("/:execId/:nodeId/messages", async (c) => {
  return streamSSE(c, async (stream) => {
    for await (const event of interactionService.sendMessage(params)) {
      await stream.writeSSE({ event: event.type, data: JSON.stringify(event) })
    }
  })
})

// GET /:execId/:nodeId/messages
interaction.get("/:execId/:nodeId/messages", async (c) => { ... })

// POST /:execId/:nodeId/complete
interaction.post("/:execId/:nodeId/complete", async (c) => { ... })
```

#### 3.3 Route Registration

```typescript
// packages/server/src/routes/workspace.ts (or chain-routes.ts)
app.route("/api/workspaces/:id/interactions", interaction)
```

### 4. Workflow Ops API (`@octopus/server`)

#### 4.1 Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/workspaces/:id/workflows/executions` | List executions (?status=running) |
| GET | `/api/workspaces/:id/workflows/executions/:execId/status` | Execution status overview |
| POST | `/api/workspaces/:id/workflows/executions/:execId/abort` | Abort execution |
| GET | `/api/workspaces/:id/workflows/executions/:execId/nodes/:nodeId/events` | Node events |

#### 4.2 Route File

```typescript
// packages/server/src/routes/workflow-ops.ts
const workflowOps = new Hono()
// ... handlers delegating to existing ExecutionDAO + AgentEventDAO
```

### 5. Frontend Changes (`@octopus/web-app`)

#### 5.1 `useInteractionStream` Hook

```typescript
// packages/web-app/src/hooks/useInteractionStream.ts
export function useInteractionStream(params: {
  workspaceId: string
  executionId: string
  nodeId: string
}) {
  // Similar to useChatStream but targets interaction API
  // POST /api/workspaces/:wsId/interactions/:execId/:nodeId/messages
  // Returns: { messages, sendMessage, isStreaming, error }
}
```

#### 5.2 InteractionModal Refactor

- Remove: chat session creation/polling logic
- Add: use `useInteractionStream` hook
- Keep: ChatPanel component for rendering (reuse MessageBubble, etc.)
- Change: data source from chat API to interaction API

#### 5.3 InteractionDetailTabs Component

```typescript
// packages/web-app/src/components/execution/InteractionDetailTabs.tsx
interface InteractionDetailTabsProps {
  executionId: string
  nodeId: string
  workspaceId: string
}

// Three tabs:
// 1. Conversation — loads from GET /interactions/:execId/:nodeId/messages
// 2. Trace — loads from llm_calls + node_token_usages
// 3. Result — loads from node_executions.outputs + vars_snapshot
```

### 6. octo-workflow-ops Skill (`@octopus/core-pack`)

```yaml
# packages/core-pack/skills/octo-workflow-ops/SKILL.md
name: octo-workflow-ops
description: Query and control workflow executions via API
api_calls:
  - list_executions: GET /api/workspaces/:wsId/workflows/executions
  - get_status: GET /api/workspaces/:wsId/workflows/executions/:id/status
  - abort: POST /api/workspaces/:wsId/workflows/executions/:id/abort
  - node_events: GET /api/workspaces/:wsId/workflows/executions/:id/nodes/:nodeId/events
```

### 7. Cleanup (`@octopus/server`)

#### 7.1 Delete ChatBridge

- Delete `packages/server/src/services/chat-bridge.ts`
- Remove imports from all files that reference it
- Migrate `COMPLETE_INTERACTION_TOOL` to `InteractionService`
- Migrate round tracking to `InteractionService` in-memory map

#### 7.2 Clean Chat Route

Remove from `packages/server/src/routes/chat.ts`:
- `isInteractionSession` detection (line 95)
- Interaction system prompt injection (lines 98–148)
- `ask_user_question` special handling (lines 285–297)
- `complete_interaction` handling (lines 299–317)
- `extractInteractionCompletion` fallback (lines 328–348)
- `interactionSession: true` provider flag (line 182)

Keep in provider.ts:
- `buildToolCaptureHooks` — still needed, but `interactionSession` flag now set by interaction route
- `canUseTool` callback — same, activated by `interactionSession: true`

#### 7.3 Clean Execution Route

Remove from `packages/server/src/routes/execution.ts`:
- `POST /:executionId/interaction/:nodeId/start` (lines 367–380)
- `POST /:executionId/interaction/:nodeId/complete` (lines 382–396)
- `GET /:executionId/interaction/:nodeId/status` (lines 398–417)

These are replaced by the interaction route.

## Implementation Order

1. **Data layer** (schema + DAO + types) — foundation
2. **InteractionService** — core business logic
3. **Interaction route** — HTTP API
4. **Frontend** (hook + modal refactor) — UI
5. **Cleanup** (ChatBridge + chat route + execution route) — remove old code
6. **Workflow Ops API** — new endpoints
7. **octo-workflow-ops skill** — chatbot integration
8. **InteractionDetailTabs** — detail UI

## Risk Mitigations

| Risk | Mitigation |
|------|------------|
| R1: Migration complexity | Build new route first, delete old code after verified |
| R2: ChatPanel adaptation | Create `useInteractionStream` with same interface as `useChatStream` |
| R3: SDK session resume | Store `providerSessionId` in in-memory session tracking |
| R4: AskUserQuestion interception | Reuse existing `buildToolCaptureHooks` from provider.ts |
| R5: InteractionDetailTabs | Extract `MessageList` from ChatPanel for reuse |
| R6: agent_events double-write | Direct `dao.insertAgentEvent()` calls in InteractionService |

## Non-Goals

- No changes to InteractionExecutor's execute/processCompletion logic
- No changes to WorkflowEngine's retryFrom mechanism
- No changes to the Claude SDK provider's core interception hooks
- No slash command system for chatbot (skill + natural language only)
