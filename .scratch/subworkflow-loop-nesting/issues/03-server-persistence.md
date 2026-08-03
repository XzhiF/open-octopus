# Ticket 3: Server — Persist parent_node_id and iteration_index in EngineCallbacks

## Status: DONE

## Scope

Update `EngineCallbacks.onRuntimeNodeAdded` to read the new `meta` parameter and persist `parent_node_id` and `iteration_index` when inserting node_execution records.

## Dependencies

- Ticket 1 (schema migration) must be complete
- Ticket 2 (engine callback signature) must be complete

## Files to Change

| File | Change |
|------|--------|
| `packages/server/src/services/execution/EngineCallbacks.ts` | Update `onRuntimeNodeAdded` to accept and persist `meta.parentNodeId` and `meta.iterationIndex` |

## Implementation Details

### EngineCallbacks.ts

Current:
```ts
onRuntimeNodeAdded: (nodeId: string, nodeType: string) => {
  const neId = `${id}-${nodeId}`
  dao.insertNodeExecutionOrIgnore({
    id: neId, execution_id: id, node_id: nodeId, node_type: nodeType,
    status: "pending", started_at: new Date().toISOString(),
  })
  sse.emit(wsId, { event: "runtime_node_added", data: { executionId: id, nodeId, nodeType } })
},
```

Updated:
```ts
onRuntimeNodeAdded: (nodeId: string, nodeType: string, meta?: { parentNodeId?: string; iterationIndex?: number }) => {
  const neId = `${id}-${nodeId}`
  dao.insertNodeExecutionOrIgnore({
    id: neId, execution_id: id, node_id: nodeId, node_type: nodeType,
    status: "pending", started_at: new Date().toISOString(),
    parent_node_id: meta?.parentNodeId ?? null,
    iteration_index: meta?.iterationIndex ?? null,
  })
  sse.emit(wsId, { event: "runtime_node_added", data: { executionId: id, nodeId, nodeType } })
},
```

## Verification Method

```bash
cd packages/server && pnpm tsc --noEmit
cd ../.. && pnpm test -- packages/server
```

## Acceptance Criteria

- [ ] `onRuntimeNodeAdded` handler accepts optional `meta` parameter
- [ ] `parent_node_id` persisted when `meta.parentNodeId` provided
- [ ] `iteration_index` persisted when `meta.iterationIndex` provided
- [ ] Both columns remain `null` when meta not provided (backward compat)
- [ ] TypeScript compiles cleanly
- [ ] Existing tests pass
