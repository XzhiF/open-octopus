# T5: Server DB Schema + DAO Extension

## Status: done

## Scope
Extend the database schema for interaction sessions:

1. **Schema** (`packages/server/src/db/schema.sql`):
   - Add 4 columns to `chat_sessions`:
     ```sql
     ALTER TABLE chat_sessions ADD COLUMN linked_execution_id TEXT;
     ALTER TABLE chat_sessions ADD COLUMN linked_node_id TEXT;
     ALTER TABLE chat_sessions ADD COLUMN interaction_mode TEXT;
     ALTER TABLE chat_sessions ADD COLUMN interaction_status TEXT;
     ```
   - Add to CREATE TABLE for idempotent init

2. **Row types** (`packages/server/src/db/types.ts`):
   - Extend `ChatSessionRow` with the 4 new nullable fields

3. **ChatDAO** (`packages/server/src/db/dao/chat-dao.ts`):
   - Update insert/update/select to include new columns
   - Add method: `findInteractionSession(executionId, nodeId)`
   - Add method: `updateInteractionStatus(sessionId, status)`

4. **ChatService** (`packages/server/src/services/chat.ts`):
   - Extend `createSession` to accept optional interaction fields
   - Add `createInteractionSession(workspaceId, opts)` method
   - Add `getInteractionStatus(executionId, nodeId)` method
   - Add `completeInteractionSession(sessionId, status)` method

## Files
- Modify: `packages/server/src/db/schema.sql`
- Modify: `packages/server/src/db/types.ts`
- Modify: `packages/server/src/db/dao/chat-dao.ts`
- Modify: `packages/server/src/services/chat.ts`

## Verification Method
- DB migration applies cleanly
- `pnpm build` passes for @octopus/server
- Existing chat tests still pass
