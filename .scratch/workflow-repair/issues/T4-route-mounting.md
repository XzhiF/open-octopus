# T4: Route Mounting — Wire Repair into Server

> **Ticket**: T4
> **Status**: ✅ DONE
> **Feature**: workflow-repair
> **Depends on**: T3
> **Blocks**: T6

## Scope

Wire the repair routes into the server's execution route tree so they are accessible at `/api/workspaces/:id/executions/:executionId/repair/*`.

## Files

| File | Action |
|------|--------|
| `packages/server/src/routes/execution.ts` | Modify (import + mount repair sub-router) |

## Acceptance Criteria

- [x] Repair routes accessible at the correct URL path
- [x] RepairService is properly instantiated with required dependencies (DAO, EnginePool, SSEService)
- [x] Server starts without errors (`pnpm dev` succeeds)

## Verification

```bash
pnpm build  # from root
```
