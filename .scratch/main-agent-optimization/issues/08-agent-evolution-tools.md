# Issue 08: Agent Evolution Tools

**Status:** pending
**Scope:** server
**Files:** `packages/server/src/routes/agent/main-agent-route.ts`

## Description
Register evolution tools in the main agent system prompt: `mark_insight`, `evolve_skill`, `create_experience`, `merge_skills`, `archive_skill`. Detect tool calls and execute via EvolutionService.

## Acceptance Criteria
- System prompt includes evolution tool descriptions
- Tool calls for evolution tools are detected and handled
- mark_insight calls POST /evolution/mark-insight internally

## Verification
- `pnpm build` succeeds
