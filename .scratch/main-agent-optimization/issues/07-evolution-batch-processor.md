# Issue 07: Evolution Batch Processor

**Status:** pending
**Scope:** server
**Files:** `packages/server/src/routes/agent/evolution-routes.ts`

## Description
Add two new routes:
- `POST /evolution/mark-insight` — create an insight mark
- `POST /evolution/process-marks` — batch process all unprocessed marks via EvolutionService.reflect()

## Acceptance Criteria
- mark-insight creates insight_marks row
- process-marks iterates unprocessed marks, calls reflect/recordEvolution, marks processed
- Both routes return proper response shapes

## Verification
- `pnpm build` succeeds
