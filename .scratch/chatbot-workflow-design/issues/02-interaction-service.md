# Ticket 2: InteractionService — Core Business Logic

## Summary
Create the `InteractionService` class that manages interaction sessions, handles SSE streaming via the Claude SDK provider, stores messages in `interaction_messages`, and triggers workflow completion. This replaces `ChatBridge` for session management.

## Scope

### 2.1 InteractionService Class

Create `packages/server/src/services/interaction/InteractionService.ts`:

**Responsibilities:**
- In-memory session tracking (replacing ChatBridge's `activeSessions` map)
- Start interaction sessions
- Stream messages via Claude SDK provider with SSE
- Store messages in `interaction_messages` table
- Write key events to `agent_events`
- Detect completion (tool call + text fallback)
- Call `ExecutionLifecycle.completeInteraction()` on completion

**Key design decisions:**
- Uses `ClaudeSDKProvider.sendQuery()` directly (same as chat route)
- Passes `interactionSession: true` to enable `canUseTool` interception
- Injects interaction system prompt (extracted from chat route)
- Tracks `providerSessionId` for SDK session resume across messages
- Round counting and timeout detection (migrated from ChatBridge)

**Dependencies:** `InteractionMessageDAO`, `ClaudeSDKProvider`, `ExecutionLifecycle`, `SSEService`, `TokenUsageDAO`

### 2.2 System Prompt Extraction

Extract the interaction system prompt from `chat.ts` lines 112–148 into a shared constant:

```typescript
// packages/server/src/services/interaction/prompts.ts
export const INTERACTION_SYSTEM_PROMPT = `You are an interactive workflow agent...`
```

### 2.3 Session Tracking Interface

```typescript
interface InteractionSessionInfo {
  sessionId: string           // Internal UUID
  executionId: string
  nodeId: string
  workspaceId: string
  display: "modal" | "panel"
  maxRounds: number
  currentRound: number
  providerSessionId?: string  // Claude SDK session for resume
  nodeExecutionId: string     // For agent_events + token tracking
  startedAt: number
  timeout?: number
}
```

Keyed by `${executionId}:${nodeId}` in `Map<string, InteractionSessionInfo>`.

### 2.4 Message Streaming

The `sendMessage` method returns an `AsyncGenerator<SSEEvent>`:

1. Look up session by `${execId}:${nodeId}`
2. Save user message to `interaction_messages`
3. Call `provider.sendQuery(content, cwd, providerSessionId, { systemPrompt, interactionSession: true })`
4. For each chunk from provider:
   - Save assistant messages to `interaction_messages`
   - Write token/cost to `node_token_usages` and `llm_calls`
   - Write key events to `agent_events` (interaction_started, ask_user_question, interaction_completed)
   - Yield SSE event to caller
5. On `complete_interaction` chunk → call `execLifecycle.completeInteraction()`
6. On `result` chunk with text → try `extractInteractionCompletion()` fallback
7. Update `providerSessionId` from result chunk for next turn

### 2.5 COMPLETE_INTERACTION_TOOL Migration

Move `COMPLETE_INTERACTION_TOOL` constant from `chat-bridge.ts` to `InteractionService`.

## Files to Create
- `packages/server/src/services/interaction/InteractionService.ts`
- `packages/server/src/services/interaction/prompts.ts`
- `packages/server/src/services/interaction/index.ts`

## Files to Modify
- None (ChatBridge cleanup is Ticket 5)

## Verification
- [ ] `pnpm build` passes
- [ ] `pnpm test` passes
- [ ] InteractionService compiles with correct imports
