# T5: Clone Session API Routes (Direct Entry)

**Status:** done ✓
**Depends on:** T1, T2, T3, T4
**Blocks:** T8

## Scope

Create the new clone session API routes for direct entry (Web UI pages connecting directly to specific clones).

## Changes

### `packages/server/src/routes/clone/` (NEW directory)

New route module with 5 endpoints:

| Method | Path | Handler | Notes |
|--------|------|---------|-------|
| `POST` | `/api/clones/:name/sessions` | Create clone session | Inserts into `sessions` with `clone_name` + `scope_id` |
| `GET` | `/api/clones/:name/sessions` | List clone sessions | Filter by `clone_name` |
| `GET` | `/api/clones/:name/sessions/:id` | Get session + messages | Uses extended MessageRow |
| `POST` | `/api/clones/:name/sessions/:id/chat` | Chat SSE stream | Uses CloneRuntime |
| `POST` | `/api/clones/:name/sessions/:id/stop` | Stop generation | Uses active stream registry |

### `packages/server/src/routes/clone/index.ts` (NEW)

```typescript
export function createCloneSessionRoutes(deps: CloneSessionRouteDeps): Hono
```

### `packages/server/src/routes/clone/sessions.ts` (NEW)

Session CRUD routes (create, list, get).

### `packages/server/src/routes/clone/chat.ts` (NEW)

Chat SSE streaming route using CloneRuntime:

```typescript
app.post('/sessions/:id/chat', async (c) => {
  // 1. Verify session exists and belongs to clone
  // 2. Store user message (with type + metadata)
  // 3. Instantiate CloneRuntime for the clone
  // 4. Stream SSE via CloneRuntime.chat()
  // 5. Store assistant message (with type + metadata)
  // 6. Update provider_session_id from result.sessionId
  // 7. Emit done event
})
```

### `packages/server/src/db/dao/agent-session-dao.ts`

Add new methods:

```typescript
/** Update provider_session_id for resume */
updateProviderSession(id: string, providerSessionId: string): RunResult

/** Insert message with type + metadata */
insertCloneMessage(row: {
  id: string; session_id: string; role: string;
  type: string; content: string; metadata: string | null;
  created_at: string;
}): RunResult
```

### SSE Event Format

Must match existing chat-routes.ts format for frontend compatibility:

- `text_delta` — `{ delta, content }`
- `thinking_start` — `{}`
- `thinking` — `{ delta }`
- `thinking_done` — `{}`
- `tool_call` — `{ type: 'start'|'input'|'result', ... }`
- `status` — `{ status }`
- `done` — `{ session_id, message_id, session_title }`
- `error` — `{ code, message }`

## Verification

1. Integration test: Create session → send message → receive SSE stream → verify message stored
2. Integration test: Provider resume — first message (no resume) → second message (with resume)
3. Integration test: Stop generation — start chat → stop → verify stream aborted
4. `pnpm build` passes
5. `pnpm test -- packages/server` passes
