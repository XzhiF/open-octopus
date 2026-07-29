# Issue 1: Backend Refactor — misc-routes debug endpoints use agentService

**Status:** done
**Priority:** high
**Depends on:** none
**Files:** `packages/server/src/routes/agent/misc-routes.ts`

## Problem

`misc-routes.ts` lines 463–530 read JSONL files directly and instantiate `SystemPromptAssembler` directly, bypassing `agentService.getDebugLog()` and `agentService.getAssembleDetail()`. This duplicates logic and causes the response to miss fields that agentService provides (id, summary, budget, degraded).

## Acceptance Criteria

1. `GET /debug/log` delegates to `agentService.getDebugLog(org, { limit })` and returns its response shape
2. `GET /debug/assemble/:chat_id` delegates to `agentService.getAssembleDetail(org, chatId)` and returns its response shape
3. `MiscRouteDeps` interface includes agentService (or it's imported via `getAgentService()`)
4. Direct `fs` reads of debug traces and direct `SystemPromptAssembler` instantiation are removed from misc-routes.ts
5. Existing API contract preserved (no breaking changes to response shape — only additions)

## Verification Method

```bash
# Run existing tests to ensure no regressions
cd packages/server && pnpm vitest run --reporter=verbose src/routes/agent/

# Manual API test: start dev server and curl the endpoints
curl -H "Authorization: Bearer agent" http://localhost:3001/api/agent/debug/log?limit=5
# Expect: { items: [...], total: N, has_more: false, next_cursor: null }

curl -H "Authorization: Bearer agent" http://localhost:3001/api/agent/debug/assemble/test-chat-id
# Expect: { chat_id, segments: [...], total_tokens, skill_sources, decisions }
```
