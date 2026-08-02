# Implementation Spec — Sub-Workflow Node

## Overview

Add `sub_workflow` node type that references another workflow by name, with scoped VarPool + I/O mapping, dual execution mode (inline/linked), and UI container rendering similar to loop.

## Architecture

### Data Flow

```
Parent Workflow YAML
  └── sub_workflow node (id: run-child, workflow: child-name)
       │
       ├── input_mapping: { child_var: "$vars.parent_var" }
       │
       └── SubWorkflowExecutor.execute()
            ├── Resolve child workflow YAML by name (via WorkflowService)
            ├── Create child VarPool (scoped)
            ├── Apply input_mapping: evaluate expressions → set child pool vars
            ├── Create child WorkflowEngine with child workflow + child pool
            ├── Execute child workflow
            ├── Apply output_mapping: read child pool vars → set parent pool vars
            └── Return NodeExecutionResult with child outputs
```

### Module Responsibility Map

| Package | Module | Responsibility |
|---------|--------|----------------|
| shared | `types/workspace.ts` | Add `"sub_workflow"` to `NodeTypeSchema` enum |
| shared | `types/workflow.ts` | Add sub_workflow fields to `NodeDef` interface + `NodeSchema` Zod schema |
| engine | `executors/sub-workflow.ts` | New `SubWorkflowExecutor` class |
| engine | `executors/executor-config.ts` | New `SubWorkflowConfig` interface |
| engine | `executor-factory.ts` | Register `sub_workflow` case in switch |
| engine | `executors/loop.ts` | Add `sub_workflow` case in inner `createExecutor()` |
| server | `services/execution/EngineFactory.ts` | Pass workflow resolver to engine for sub_workflow resolution |
| engine | `engine.ts` | Accept optional `workflowResolver` callback; pass to ExecutorFactory |
| web-app | `lib/workflow-parser.ts` | Parse sub_workflow nodes, compute container sizes, layout inner nodes |
| web-app | `components/workspace/workflow-nodes/sub-workflow-container-node.tsx` | New container node component |
| web-app | `components/workspace/workflow-flow-viewer.tsx` | Register new node type |
| web-app | `lib/types.ts` | Add sub_workflow types if needed |

## Detailed Design

### 1. Shared Types (`packages/shared`)

**`types/workspace.ts`**: Add `"sub_workflow"` to `NodeTypeSchema`:
```typescript
export const NodeTypeSchema = z.enum([
  "bash", "python", "agent", "condition", "approval", "loop", "swarm", "sub_workflow",
])
```

**`types/workflow.ts`**: Add to `NodeDef` interface:
```typescript
// sub_workflow
workflow?: string
execution_mode?: "inline" | "linked"
input_mapping?: Record<string, string>
output_mapping?: Record<string, string>
on_error?: "fail" | "continue"
```

Add to `NodeSchema` Zod schema and `NodeDef.type` union.

### 2. Engine — SubWorkflowExecutor (`packages/engine`)

**Config** (`executor-config.ts`):
```typescript
export interface SubWorkflowConfig extends CoreConfig {
  globalSessionId?: string
  branchSessionIds?: Map<string, string>
  inputs?: Record<string, any>
  engineNodeResults?: Record<string, NodeExecutionResult>
  workflowResolver?: (name: string) => { parsed: WorkflowDef; content: string } | undefined
}
```

**Executor** (`executors/sub-workflow.ts`):
- Implements `NodeExecutor`
- `execute()`:
  1. Resolve child workflow via `workflowResolver`
  2. Create child VarPool from parent pool snapshot (scoped)
  3. Apply `input_mapping` — evaluate each value expression against parent pool, set into child pool
  4. Create child `WorkflowEngine` with child workflow def + child pool
  5. Execute child workflow
  6. Apply `output_mapping` — read child pool vars, set into parent pool
  7. Return `NodeExecutionResult`

**Error handling**:
- If child workflow not found: return failed result
- If child execution fails: check `on_error` — `fail` (default) returns failed, `continue` returns completed with error info
- Recursion detection: maintain a set of workflow names in the execution chain, reject if child name already in chain

**ExecutorFactory**: Add `case "sub_workflow"` in both:
- `packages/engine/src/executor-factory.ts`
- `packages/engine/src/executors/loop.ts` (inner createExecutor)

**Engine**: Add `workflowResolver` as optional parameter, pass through to ExecutorFactory context.

### 3. Server (`packages/server`)

**EngineFactory**: Pass a `workflowResolver` callback to `WorkflowEngine` constructor that resolves workflows from the workspace's `WorkflowService`:

```typescript
const workflowResolver = (name: string) => {
  const local = this.ctx.workflowService.get(this.workspacePath, name)
  if (local) return { parsed: local.parsed, content: local.content }
  const builtIn = this.ctx.builtInWorkflowService.get(name)
  if (builtIn) return { parsed: builtIn.parsed, content: builtIn.content }
  return undefined
}
```

The existing API routes (`GET /api/workspaces/:id/workflows` and `GET /api/workspaces/:id/workflows/:ref`) already serve the workflow list and detail needed for the UI.

### 4. Web-App (`packages/web-app`)

**workflow-parser.ts**: Handle `sub_workflow` nodes similarly to `loop` nodes:
- Recognize `sub_workflow` as a valid node type
- When a `sub_workflow` node has a `workflow` reference, treat it as a container
- If inner nodes are available (from a preview/fetched child workflow), lay them out inside the container
- For the initial implementation, the container shows without inner nodes (the child workflow would need to be fetched separately)

**sub-workflow-container-node.tsx**: New component modeled after `loop-container-node.tsx`:
- Dashed border container
- `Layers` icon (instead of `Repeat`)
- Header: name + workflow reference + execution mode badge + "子工作流" badge
- Body: empty for now (inner nodes rendered when child workflow is pre-fetched)

**workflow-flow-viewer.tsx**: Register `"sub-workflow-container"` in `nodeTypes`.

## Risk Mitigations

- **R1 (child workflow not found)**: Validate existence during execution, return clear error
- **R4 (recursive references)**: Maintain visited-workflow-name stack, reject on cycle
- **R2 (session isolation)**: Sub_workflow creates its own session context, does not share with parent

## File Change Summary

| File | Action | Lines (est.) |
|------|--------|-------------|
| `packages/shared/src/types/workspace.ts` | Modify | +2 |
| `packages/shared/src/types/workflow.ts` | Modify | +15 |
| `packages/engine/src/executors/sub-workflow.ts` | Create | ~180 |
| `packages/engine/src/executors/executor-config.ts` | Modify | +12 |
| `packages/engine/src/executor-factory.ts` | Modify | +25 |
| `packages/engine/src/executors/loop.ts` | Modify | +15 |
| `packages/engine/src/engine.ts` | Modify | +15 |
| `packages/server/src/services/execution/EngineFactory.ts` | Modify | +15 |
| `packages/web-app/lib/workflow-parser.ts` | Modify | +30 |
| `packages/web-app/components/workspace/workflow-nodes/sub-workflow-container-node.tsx` | Create | ~120 |
| `packages/web-app/components/workspace/workflow-flow-viewer.tsx` | Modify | +3 |

## Verification Plan

- `pnpm build` — all packages compile
- `pnpm test` — existing tests pass
- Manual: create a YAML with sub_workflow node, verify parsing
- Manual: verify flow chart renders container
