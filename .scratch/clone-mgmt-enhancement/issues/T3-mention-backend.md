# T3: @@mention Backend — delegate_to in Agent Chat

## Status: pending

## Summary

Add `delegate_to` field support to `POST /api/agent/chat`. When present, skip LLM routing and directly invoke CloneRuntime for the target clone. Handle self-reference (no-op) and validate clone existence.

## Scope

### Server changes

1. **Update `main-agent-route.ts`** POST `/api/agent/chat`:
   - Accept new optional field `delegate_to: string` in request body
   - When `delegate_to` is present and non-empty:
     - Resolve clone definition from filesystem (using unified `resolveCloneDef()`)
     - If clone not found → return error via SSE event
     - If `delegate_to` matches current session's clone_name → self-reference → treat as normal message (no delegation)
     - Otherwise: skip LLM routing, call `CloneRuntime.chat()` directly
     - Stream response with `source: cloneName` in SSE events
   - When `delegate_to` is absent: existing LLM routing behavior unchanged

2. **Session handling for delegation**:
   - Store user message with `delegate_to` metadata
   - Store delegate response as assistant message with `source` metadata
   - Session remains the same (delegation is inline within the session)

3. **SSE event format**:
   - Existing events: text_delta, tool_call, status, done, error
   - Add `source` field to text_delta events when delegation is active: `{ delta, content, source: "scheduler" }`
   - Add `delegation_start` event: `{ clone_name, display_name }`
   - Add `delegation_end` event: `{ clone_name }`

## Verification

### Integration tests (`packages/server/src/__tests__/delegate-mention.test.ts`)

- POST `/api/agent/chat` with `delegate_to: "scheduler"` → streams response from CloneRuntime
- POST `/api/agent/chat` with `delegate_to: "nonexistent"` → error event
- POST `/api/agent/chat` with `delegate_to` matching session clone_name → normal response (no delegation)
- POST `/api/agent/chat` without `delegate_to` → existing behavior unchanged

## Dependencies

- T1 (filesystem-based clone resolution)

## Files to modify

- `packages/server/src/routes/agent/main-agent-route.ts` — add delegate_to handling
- `packages/server/src/__tests__/delegate-mention.test.ts` — new test file
