# Ticket T1: Server SSE Event Forwarding in Delegation Paths

**Status**: DONE
**Package**: `packages/server`
**Files**: `src/routes/agent/main-agent-route.ts`
**Verification**: Unit test + build

## Description

Fix the Server delegation paths to forward `tool_call_start`, `tool_call`, and `tool_result` SSE events (currently only forwards `text_delta` + `error`). This enables CLI and web consumers to see tool invocations during delegation.

## Requirements

1. Add `shouldForwardEvent()` helper function that returns `true` for: `text_delta`, `tool_call_start`, `tool_call`, `tool_result`, `error`
2. In the **deterministic delegation path** (inside `if (body.delegate_to)`, the `for await` loop around line ~198-213): add forwarding for `tool_call_start`, `tool_call`, and `tool_result` chunk types
3. In the **tool-based delegation path** (`executeDelegation()` function, `for await` loop around line ~730-740): add the same forwarding
4. Events that should NOT be forwarded: `thinking`, `thinking_start`, `thinking_done`, `message_start`, `message_stop`, `text_done`, `tool_progress`, `tool_summary`, `status`, `result`
5. Unit test for `shouldForwardEvent()` function

## SSE Event Format

```typescript
// tool_call_start → event: 'tool_call'
{ event: 'tool_call', data: { type: 'start', tool_call_id: string, tool_name: string } }

// tool_call → event: 'tool_call'  
{ event: 'tool_call', data: { type: 'input', tool_call_id: string, tool_name: string, input: unknown } }

// tool_result → event: 'tool_result'
{ event: 'tool_result', data: { tool_call_id: string, tool_name: string, content: string, is_error?: boolean } }
```

## Acceptance Criteria

- [ ] `shouldForwardEvent('text_delta')` returns `true`
- [ ] `shouldForwardEvent('tool_call_start')` returns `true`
- [ ] `shouldForwardEvent('tool_call')` returns `true`
- [ ] `shouldForwardEvent('tool_result')` returns `true`
- [ ] `shouldForwardEvent('error')` returns `true`
- [ ] `shouldForwardEvent('thinking')` returns `false`
- [ ] `shouldForwardEvent('message_start')` returns `false`
- [ ] Both delegation paths forward tool events
- [ ] `pnpm build` succeeds

## Verification Method

```bash
cd packages/server && npx vitest run src/__tests__/routes/main-agent-route-sse.test.ts
pnpm build
```
