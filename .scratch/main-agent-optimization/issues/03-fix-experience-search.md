# Issue 03: Fix Experience Search

**Status:** pending
**Scope:** server
**Files:** `packages/server/src/routes/agent/evolution-routes.ts`

## Description
`GET /evolution/experiences` ignores the `q` query parameter. Wire it to `EvolutionDAO.searchExperiences(q)` which already exists with FTS5 support.

## Acceptance Criteria
- When `q` is provided, use `searchExperiences(q)` instead of `listExperiences()`
- Response format consistent with existing list

## Verification
- `pnpm build` succeeds
- curl with `?q=test` returns FTS matches
