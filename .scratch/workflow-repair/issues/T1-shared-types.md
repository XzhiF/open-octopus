# T1: Shared Types — Repair Type Definitions

> **Ticket**: T1
> **Status**: ✅ DONE
> **Feature**: workflow-repair
> **Depends on**: —
> **Blocks**: T2, T3

## Scope

Create `packages/shared/src/types/repair.ts` with all repair-related type definitions and update `packages/shared/src/index.ts` to export them.

## Files

| File | Action |
|------|--------|
| `packages/shared/src/types/repair.ts` | Create |
| `packages/shared/src/index.ts` | Modify (add export line) |

## Acceptance Criteria

- [x] `DiagnoseReport`, `DiagnoseNodeReport`, `Anomaly`, `CheckpointSummary`, `RecentError` interfaces defined
- [x] `ExecutionStatus` and `NodeExecutionStatus` type unions defined
- [x] All repair request/response interfaces defined (VarPool, NodeReset, RestorePoint, ReloadWorkflow, Intervene, ClearRetry)
- [x] Types exported from `packages/shared/src/index.ts`
- [x] `pnpm build` succeeds for `@octopus/shared`

## Verification

```bash
cd packages/shared && pnpm build
```
