# Issue 2: Backend — agentService.getAssembleDetail returns budget/degraded/skill_sources

**Status:** done
**Priority:** high
**Depends on:** Issue 1
**Files:** `packages/server/src/services/agent/agent-service.ts`

## Problem

`getAssembleDetail()` (line 685) returns raw segments without calling `truncateToBudget()`. The response is missing:
- `budget` and `degraded` per segment (B3)
- `skill_sources` field (B1 — frontend crashes without it)
- `decisions` field

## Acceptance Criteria

1. Each segment in the response includes `budget: number` and `degraded: boolean`
2. Response includes `skill_sources: Record<string, string>` (at minimum `{}`)
3. Response includes `decisions: string[]` (at minimum `[]`)
4. `truncateToBudget()` is called to compute budget-aware segment data
5. The `DebugSegment` type from `@octopus/shared` is respected (budget + degraded fields)

## Verification Method

```bash
cd packages/server && pnpm vitest run src/services/agent/

# API test:
curl -H "Authorization: Bearer agent" http://localhost:3001/api/agent/debug/assemble/test-id
# Each segment should have: { index, name, token_count, budget, degraded, content_preview }
# Response should have: { chat_id, segments, total_tokens, skill_sources, decisions }
```
