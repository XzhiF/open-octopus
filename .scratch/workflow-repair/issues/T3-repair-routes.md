# T3: Repair Routes — HTTP Endpoints

> **Ticket**: T3
> **Status**: ✅ DONE
> **Feature**: workflow-repair
> **Depends on**: T1, T2
> **Blocks**: T4

## Scope

Create `packages/server/src/routes/repair.ts` with Hono route handlers for the 7 repair endpoints. Mount them as a sub-router under the execution routes.

## API Contracts

| Method | Path | Params | Response |
|--------|------|--------|----------|
| GET | `/diagnose` | — | `DiagnoseReport` |
| POST | `/varpool` | `{ updates }` | `{ updated, snapshot }` |
| POST | `/node/:nodeId/reset` | `{ status, outputs? }` | `{ nodeId, previousStatus, newStatus }` |
| POST | `/restore-point` | `{ nodeId, resetVarPool? }` | `{ resetNodes, restoredFrom }` |
| POST | `/reload-workflow` | `{ content }` | `{ reloaded, diff }` |
| POST | `/intervene` | `{ nodeId, message }` | `{ injected }` |
| POST | `/clear-retry` | `{ nodeIds? }` | `{ cleared }` |

## Files

| File | Action |
|------|--------|
| `packages/server/src/routes/repair.ts` | Create |
| `packages/server/src/routes/execution.ts` | Modify (mount repair sub-router) |

## Acceptance Criteria

- [x] All 7 route handlers implemented with input validation
- [x] Error handling returns appropriate HTTP status codes (400, 404, 500)
- [x] RepairService dependency injection via constructor or factory
- [x] Mounted as sub-router at `/:executionId/repair`
- [x] `pnpm build` succeeds for `@octopus/server`

## Verification

```bash
cd packages/server && pnpm build
```
