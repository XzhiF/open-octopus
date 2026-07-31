# Ticket 5: Cleanup — Remove ChatBridge, Clean Chat Route, Clean Execution Route

## Summary
Remove the old interaction infrastructure: ChatBridge class, interaction-specific logic from chat route, and old interaction endpoints from execution route. This is the "deletion" phase after the new system is verified working.

## Scope

### 5.1 Delete ChatBridge

- **Delete** `packages/server/src/services/chat-bridge.ts`
- Remove all imports of `ChatBridge` from:
  - `ExecutionLifecycle.ts` — remove `chatBridge` field and all method calls
  - Any service initialization code
- Remove `ChatBridge` from DI container / service registry

### 5.2 Clean Chat Route (`packages/server/src/routes/chat.ts`)

Remove interaction-specific code:
- **Line 95**: `isInteractionSession` detection → remove
- **Lines 98–109**: Workspace clone prompt skip for interaction → remove (always load clone prompt)
- **Lines 112–148**: Hardcoded interaction system prompt → remove
- **Line 182**: `interactionSession: isInteractionSession` → remove (or set to `false`)
- **Lines 285–297**: `ask_user_question` chunk handling → remove
- **Lines 299–317**: `complete_interaction` chunk handling → remove
- **Lines 328–348**: `extractInteractionCompletion` fallback → remove
- Remove import of `extractInteractionCompletion` from `@octopus/engine`

**Keep:**
- All other chat route logic (normal sessions, SSE streaming for chat, etc.)
- The provider's `buildToolCaptureHooks` and `canUseTool` stay in `provider.ts` — they're activated by `interactionSession: true` flag which the interaction route will set

### 5.3 Clean Execution Route (`packages/server/src/routes/execution.ts`)

Remove old interaction endpoints:
- **Lines 367–380**: `POST /:executionId/interaction/:nodeId/start` → remove
- **Lines 382–396**: `POST /:executionId/interaction/:nodeId/complete` → remove
- **Lines 398–417**: `GET /:executionId/interaction/:nodeId/status` → remove

### 5.4 Clean ExecutionLifecycle (`packages/server/src/services/execution/ExecutionLifecycle.ts`)

- Remove `chatBridge` constructor parameter / field
- Remove `ChatBridge.createInteractionSession()` calls in `startInteraction()`
- Remove `ChatBridge.trackSession()` calls
- Remove `ChatBridge.completeSession()` calls
- **Keep** `startInteraction()` and `completeInteraction()` methods — they're still called by the new interaction route
- Refactor `startInteraction()` to not create chat sessions (just validate and return metadata)

### 5.5 Clean ChatDAO (`packages/server/src/db/dao/chat-dao.ts`)

- Remove `findInteractionSession()` method (lines 122–126)
- Remove `updateInteractionStatus()` method (lines 128–132)
- Remove interaction fields from `insertSession()` method:
  - `linked_execution_id`, `linked_node_id`, `interaction_mode`, `interaction_status`

### 5.6 Clean Schema (`packages/server/src/db/schema.sql` + `schema.ts`)

Remove from `chat_sessions` table:
- `linked_execution_id TEXT`
- `linked_node_id TEXT`
- `interaction_mode TEXT`
- `interaction_status TEXT`

Remove corresponding `ensureColumn()` calls from `schema.ts`.

Remove from `ChatSessionRow` type (`types.ts`):
- `linked_execution_id`, `linked_node_id`, `interaction_mode`, `interaction_status`

### 5.7 Clean Execution Route Tree/Detail

In `execution.ts`:
- Keep `interactionMetadata` parsing in tree/detail endpoints — still needed for frontend to detect pending interaction

## Files to Delete
- `packages/server/src/services/chat-bridge.ts`

## Files to Modify
- `packages/server/src/routes/chat.ts` — remove interaction branches
- `packages/server/src/routes/execution.ts` — remove old endpoints
- `packages/server/src/services/execution/ExecutionLifecycle.ts` — remove ChatBridge dependency
- `packages/server/src/db/dao/chat-dao.ts` — remove interaction methods
- `packages/server/src/db/schema.sql` — remove 4 columns from chat_sessions
- `packages/server/src/db/schema.ts` — remove ensureColumn calls
- `packages/server/src/db/types.ts` — remove fields from ChatSessionRow

## Verification
- [ ] `pnpm build` passes
- [ ] `pnpm test` passes
- [ ] No references to `ChatBridge` in codebase
- [ ] No references to `linked_execution_id` in codebase
- [ ] Chat route works for normal (non-interaction) sessions
