# Issue 02: Fix Diff Text

**Status:** pending
**Scope:** server
**Files:** `packages/server/src/routes/agent/skill-routes.ts`

## Description
`GET /skills/:name/diff-builtin` returns `{ has_diff: boolean }` but NOT the actual diff text. The frontend `DiffViewer.tsx` expects `res.diff`. Fix the route to compute and return a unified diff string.

## Acceptance Criteria
- Response includes `diff: string` field with unified diff output
- Uses a JS diff library or `diff` command
- Returns null when no diff exists

## Verification
- `pnpm build` succeeds
- curl test returns diff field
