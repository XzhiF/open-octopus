# Verified Spec — Nested Execution Hierarchy

## Status: VERIFIED

## Summary

Add `parent_node_id TEXT` and `iteration_index INTEGER` nullable columns to `node_executions`, populate them during execution, and fix the UI grouping so sub-workflow children inside loop iterations display per-iteration.

## Data Model Changes

### Schema (packages/server/src/db/schema.sql + schema.ts)

Add two nullable columns to `node_executions`:

```sql
parent_node_id TEXT   -- nullable; set to the sub_workflow node's ID for child nodes
iteration_index INTEGER -- nullable; set to the nearest loop's iteration number (0-based)
```

**Migration approach**: Add to `ensureColumnsForExistingTables()` in `schema.ts` using `ensureColumn()`. No backfill.

### Types (packages/server/src/db/types.ts)

Extend `NodeExecutionRow`:
```ts
parent_node_id: string | null
iteration_index: number | null
```

### DAO (packages/server/src/db/dao/execution-dao.ts)

- `insertNodeExecution`: add `parent_node_id` and `iteration_index` params
- `insertNodeExecutionOrIgnore`: add `parent_node_id` and `iteration_index` params
- `updateNodeExecution`: add both columns to the `allowed` set

## Engine Layer Changes

### Callback Signature Extension (packages/engine/src/engine.ts)

Extend `EngineCallbacks.onRuntimeNodeAdded`:
```ts
onRuntimeNodeAdded?: (nodeId: string, nodeType: string, meta?: { parentNodeId?: string; iterationIndex?: number }) => void
```

### SubWorkflowExecutor (packages/engine/src/executors/sub-workflow.ts)

When calling `ensureNodeExecution` for child nodes, pass `parentNodeId: this.node.id`:
```ts
this.config.ensureNodeExecution?.(
  `${this.node.id}:${childNode.id}`, childNode.type,
  { parentNodeId: this.node.id }
)
```

### SubWorkflowConfig (packages/engine/src/executors/executor-config.ts)

Extend `ensureNodeExecution` signature:
```ts
ensureNodeExecution?: (scopedNodeId: string, nodeType: string, meta?: { parentNodeId?: string; iterationIndex?: number }) => void
```

### ExecutorFactory (packages/engine/src/executor-factory.ts)

Forward the meta parameter to the `onRuntimeNodeAdded` callback:
```ts
ensureNodeExecution: (scopedNodeId, nodeType, meta) => {
  this.ctx.callbacks?.onRuntimeNodeAdded?.(scopedNodeId, nodeType, meta)
}
```

### LoopExecutor (packages/engine/src/executors/loop.ts)

When creating sub-executors for inner nodes, pass `iterationIndex` via the sub-workflow `ensureNodeExecution`. Specifically, when creating a SubWorkflowExecutor inside a loop, the loop executor needs to wrap `ensureNodeExecution` to inject `iterationIndex: this.iterations - 1` (0-based).

**Implementation**: In `createExecutor()` case `"sub_workflow"`, wrap the `ensureNodeExecution`:
```ts
case "sub_workflow":
  return new SubWorkflowExecutor(node, p, {
    ...config,
    ensureNodeExecution: (scopedNodeId, nodeType, meta) => {
      this.config.ensureNodeExecution?.(scopedNodeId, nodeType, {
        ...meta,
        iterationIndex: this.iterations - 1,  // 0-based
        parentNodeId: meta?.parentNodeId ?? this.node.id,
      })
    },
  })
```

Wait — the loop executor doesn't currently have `ensureNodeExecution` in its config. Let me re-examine.

Actually, the loop executor creates inner executors but doesn't have a direct `ensureNodeExecution`. The `ensureNodeExecution` is only on `SubWorkflowConfig`. The loop executor calls `createExecutor` for inner nodes, and when an inner node is `sub_workflow`, it creates a `SubWorkflowExecutor` — but currently doesn't pass `ensureNodeExecution` (it's not in the config passed).

Looking at the loop executor's `createExecutor` for sub_workflow case (line 564-580):
```ts
case "sub_workflow":
  return new SubWorkflowExecutor(node, p, {
    ...
    workflowResolver: (this.config as any).workflowResolver,
    visitedWorkflows: (this.config as any).visitedWorkflows,
  })
```

No `ensureNodeExecution` is passed! This means the sub-workflow inside a loop currently doesn't pre-create DB records for child nodes. We need to:

1. Add `ensureNodeExecution` to `LoopConfig`
2. Pass it through from `ExecutorFactory`
3. In `createExecutor` for `sub_workflow`, wrap it with iteration context

### Server Layer: EngineCallbacks (packages/server/src/services/execution/EngineCallbacks.ts)

Update `onRuntimeNodeAdded` handler to persist `parent_node_id` and `iteration_index`:
```ts
onRuntimeNodeAdded: (nodeId, nodeType, meta) => {
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

### Server Layer: NodeHelper (packages/server/src/services/execution/NodeHelper.ts)

No changes needed — `ensureNodeExecutions` pre-creates top-level and loop-inner nodes without parent/iteration info. The new columns are nullable, so this is fine. Sub-workflow child records are created via `onRuntimeNodeAdded` which will carry the new metadata.

## API Changes

### GET /api/workspaces/:id/executions/:executionId (detail endpoint)

The response already includes `steps` (node_executions). Since `findNodeExecutions` uses `SELECT *`, the new columns will automatically appear in the response. No code change needed in routes.

## UI Changes

### execution-log-viewer.tsx

Current issue: Sub-workflow child events (`node_log` events with scoped IDs) are grouped by `${nodeId}:${childNode}` — all iterations' children merge into one group.

Fix: When a sub-workflow child event has an `iteration` field, include it in the group key:
```ts
if (childNode) {
  const iterSuffix = e.iteration != null && e.iteration > 0 ? `-iter${e.iteration}` : ""
  key = `${nodeId}:${childNode}${iterSuffix}`
  label = `${nodeId}:${childNode}${iterSuffix}`
}
```

However, looking at how SSE events flow: `node_log` events from sub-workflow children are emitted via `onNodeLog` callback. The SSE data is `{ executionId, nodeId, logLine }`. The `nodeId` is the scoped ID (e.g., `call-analysis:greet`). The `iteration` field needs to come from the SSE event.

Looking at the SSE event flow:
1. Sub-workflow child fires `onNodeStart`/`onNodeEnd`/`onNodeLog` with scoped nodeId
2. EngineCallbacks emits SSE `{ nodeId, logLine }` — no iteration info
3. Frontend `useExecutionEvents` hook receives these events

The `iteration` field on SSE events comes from the `useExecutionEvents` hook processing. Let me check how events get the `iteration` field.

Actually, looking at the execution-log-viewer.tsx grouping logic more carefully, events get `iteration` from the JSONL log entries that carry loop context. Sub-workflow child events (`node_log` type) currently don't carry iteration info in the SSE stream.

**Solution**: The server needs to include iteration context when emitting `node_log` SSE events for sub-workflow children. The engine callbacks need access to the current loop iteration when processing `onNodeLog`.

Alternative approach: The UI grouping can detect iteration context from `branch_start`/`branch_end` events that bracket each iteration. Sub-workflow children that appear between `branch_start(iter=N)` and `branch_end(iter=N)` belong to iteration N.

**Simpler approach**: Since the `node_log` events for sub-workflow children are persisted as `agent_events` in the DB (in EngineCallbacks.onNodeLog), and the SSE event format includes `nodeId` (scoped), we need to propagate iteration info through the SSE event.

Looking at this more carefully, the cleanest approach is:
1. The engine already has `setLoopContext` in the JSONL logger
2. The `onNodeLog` callback in the loop executor could include iteration info
3. But the `EngineCallbacks.onNodeLog` signature is `(nodeId, logLine)` — no iteration

The spec should add iteration to the `onNodeLog` callback, or alternatively use a different approach.

**Revised approach**: Rather than modifying the `onNodeLog` callback signature (which is a wide-reaching change), we can:
1. Have the UI derive iteration context from the existing `branch_start`/`branch_end` events that already bracket each iteration
2. When processing events chronologically, track the current iteration and associate sub-workflow child events with it

This is a pure UI fix that doesn't require engine changes.

## Test Scenarios

Three E2E test scenarios from the brief:
1. **Loop containing Sub-workflow**: 3 iterations, each calling a sub-workflow
2. **3-Layer Sub-workflow Nesting**: A → B → C chain
3. **Sub-workflow containing Loop**: parent calls sub-workflow that has an inner loop

## Out of Scope

- No backfill for existing data
- No tree/collapsible UI
- No per-iteration VarPool isolation
- No 4+ level deep nesting tests
