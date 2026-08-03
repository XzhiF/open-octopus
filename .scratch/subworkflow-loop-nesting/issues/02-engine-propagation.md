# Ticket 2: Engine — Propagate parent_node_id and iteration_index through callbacks

## Status: DONE

## Scope

Extend the engine callback interfaces and executor implementations to pass `parentNodeId` and `iterationIndex` metadata when creating/processing nested nodes.

## Files to Change

| File | Change |
|------|--------|
| `packages/engine/src/engine.ts` | Extend `EngineCallbacks.onRuntimeNodeAdded` signature with optional `meta` param |
| `packages/engine/src/executors/executor-config.ts` | Extend `SubWorkflowConfig.ensureNodeExecution` signature with optional `meta` param. Add `ensureNodeExecution` to `LoopConfig`. |
| `packages/engine/src/executors/sub-workflow.ts` | Pass `parentNodeId: this.node.id` when calling `ensureNodeExecution` for child nodes |
| `packages/engine/src/executors/loop.ts` | Pass `ensureNodeExecution` (with `iterationIndex: this.iterations - 1`) to SubWorkflowExecutor in `createExecutor()`. Also pass it to nested LoopExecutor. |
| `packages/engine/src/executor-factory.ts` | Forward `meta` parameter in `ensureNodeExecution` to `onRuntimeNodeAdded` callback. Pass `ensureNodeExecution` to LoopConfig. |

## Implementation Details

### engine.ts — Extend callback interface
```ts
export interface RuntimeNodeMeta {
  parentNodeId?: string
  iterationIndex?: number
}

export interface EngineCallbacks {
  // ... existing ...
  onRuntimeNodeAdded?: (nodeId: string, nodeType: string, meta?: RuntimeNodeMeta) => void
}
```

### executor-config.ts
```ts
// In SubWorkflowConfig, change:
ensureNodeExecution?: (scopedNodeId: string, nodeType: string, meta?: { parentNodeId?: string; iterationIndex?: number }) => void

// In LoopConfig, add:
ensureNodeExecution?: (scopedNodeId: string, nodeType: string, meta?: { parentNodeId?: string; iterationIndex?: number }) => void
```

### sub-workflow.ts — Pass parentNodeId
In `execute()`, change:
```ts
// Before:
this.config.ensureNodeExecution(`${this.node.id}:${childNode.id}`, childNode.type)

// After:
this.config.ensureNodeExecution?.(`${this.node.id}:${childNode.id}`, childNode.type, { parentNodeId: this.node.id })
```

### loop.ts — Pass ensureNodeExecution to inner sub-workflow and loop executors
In `createExecutor()`, case `"sub_workflow"`:
```ts
case "sub_workflow":
  return new SubWorkflowExecutor(node, p, {
    ...existingConfig,
    ensureNodeExecution: (scopedNodeId, nodeType, meta) => {
      // Inject iteration context from this loop
      this.config.ensureNodeExecution?.(scopedNodeId, nodeType, {
        ...meta,
        iterationIndex: meta?.iterationIndex ?? (this.iterations - 1),
      })
    },
  })
```

Case `"loop"` (nested loops):
```ts
case "loop":
  return new LoopExecutor(node, p, {
    ...this.config,
    ensureNodeExecution: (scopedNodeId, nodeType, meta) => {
      // Outer loop passes through; inner loop will override iterationIndex
      this.config.ensureNodeExecution?.(scopedNodeId, nodeType, meta)
    },
  }, { engineNodeResults: this.resume?.engineNodeResults })
```

### executor-factory.ts — Forward meta to onRuntimeNodeAdded
```ts
// In the sub_workflow case:
ensureNodeExecution: (scopedNodeId, nodeType, meta) => {
  this.ctx.callbacks?.onRuntimeNodeAdded?.(scopedNodeId, nodeType, meta)
}
```

Also add `ensureNodeExecution` to the LoopConfig in executor-factory:
```ts
// In the loop case:
case "loop":
  return new LoopExecutor(node, p, {
    ...existingConfig,
    ensureNodeExecution: (scopedNodeId, nodeType, meta) => {
      this.ctx.callbacks?.onRuntimeNodeAdded?.(scopedNodeId, nodeType, meta)
    },
  })
```

## Verification Method

```bash
cd packages/engine && pnpm tsc --noEmit
cd ../.. && pnpm test -- packages/engine
```

## Acceptance Criteria

- [ ] `onRuntimeNodeAdded` callback accepts optional `meta` with `parentNodeId` and `iterationIndex`
- [ ] SubWorkflowExecutor passes `parentNodeId` when creating child nodes
- [ ] LoopExecutor passes `iterationIndex` (0-based) when inner sub-workflow creates child nodes
- [ ] Nested loops correctly override `iterationIndex` (innermost loop wins)
- [ ] ExecutorFactory forwards `meta` to callbacks
- [ ] TypeScript compiles cleanly
- [ ] Existing engine tests pass
