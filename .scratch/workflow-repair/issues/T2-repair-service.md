# T2: RepairService — Core Business Logic

> **Ticket**: T2
> **Status**: ✅ DONE
> **Feature**: workflow-repair
> **Depends on**: T1
> **Blocks**: T3

## Scope

Create `packages/server/src/services/repair.ts` implementing the `RepairService` class with all 7 operations:
- `diagnose(executionId)` — build DiagnoseReport from DB + engine state
- `patchVarPool(executionId, updates)` — update VarPool in DB + live engine
- `resetNode(executionId, nodeId, status, outputs?)` — reset node state
- `restorePoint(executionId, nodeId, resetVarPool?)` — restore to checkpoint
- `reloadWorkflow(executionId, content)` — hot-reload YAML definition
- `intervene(executionId, nodeId, message)` — inject intervention message
- `clearRetry(executionId, nodeIds?)` — clear retry counts

## Files

| File | Action |
|------|--------|
| `packages/server/src/services/repair.ts` | Create |

## Acceptance Criteria

- [x] All 7 methods implemented with proper error handling
- [x] Anomaly detection covers all 6 types: stuck_node, exhausted_retry, false_completion, infinite_retry, orphaned_node, pending_hooks
- [x] Node reset validates state transitions
- [x] RestorePoint computes downstream nodes via topological ordering
- [x] Live engine integration via EnginePool (when engine instance exists)
- [x] SSE event emission for all repair operations

## Verification

```bash
pnpm build  # from root — server must compile
```
