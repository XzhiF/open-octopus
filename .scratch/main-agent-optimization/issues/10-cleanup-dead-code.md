# Issue 10: Cleanup Dead Code

**Status:** pending
**Scope:** server
**Files:** `packages/server/src/routes/agent/evolution.ts`

## Description
Delete `packages/server/src/routes/agent/evolution.ts` — a dead file that overlaps with `evolution-routes.ts`. Verified: no imports reference it (index.ts imports evolution-routes.ts, not evolution.ts).

## Acceptance Criteria
- File deleted
- No broken imports
- `pnpm build` succeeds

## Verification
- `pnpm build` succeeds
