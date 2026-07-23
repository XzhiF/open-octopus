# T6: Unit Tests — Repair Service

> **Ticket**: T6
> **Status**: ✅ DONE
> **Feature**: workflow-repair
> **Depends on**: T2, T4
> **Blocks**: —

## Scope

Write unit tests for the RepairService covering:
- DiagnoseReport generation with various anomaly scenarios
- VarPool patch logic (partial update, full snapshot)
- Node state transition validation
- RestorePoint downstream node computation
- ClearRetry selective vs. global clearing

## Files

| File | Action |
|------|--------|
| `packages/server/src/__tests__/repair.test.ts` | Create |

## Acceptance Criteria

- [x] Tests for all 6 anomaly types
- [x] Tests for VarPool patch (merge, not overwrite)
- [x] Tests for node state transitions (valid and invalid)
- [x] Tests for restore point downstream computation
- [x] `pnpm test` passes

## Verification

```bash
pnpm test -- packages/server/src/__tests__/repair.test.ts
```
