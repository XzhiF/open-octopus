# Issue 05: Memory Refine Server

**Status:** pending
**Scope:** web-app
**Files:** `packages/web-app/components/agent/memory/RefineModal.tsx`, `packages/web-app/lib/agent/api.ts`

## Description
Replace client-side dedup logic in RefineModal with a call to `POST /memory/refine`. The server endpoint already exists and handles actual refinement.

## Acceptance Criteria
- RefineModal calls server `/memory/refine` endpoint
- Shows before/after token counts from server response
- Client-side dedup logic removed

## Verification
- `pnpm build` succeeds
