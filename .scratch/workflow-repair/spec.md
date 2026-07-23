# Verified Spec: Workflow Repair Mechanism

> **Feature**: `workflow-repair`
> **Branch**: `feat-repiare-workflow`
> **Status**: Verified
> **Last reviewed**: 2026-07-23

## Summary

Add a workflow repair capability that lets developers diagnose and fix stuck, failed, or misbehaving workflow executions. The repair mechanism consists of:

1. **Shared types** (`@octopus/shared`) — DiagnoseReport and repair operation type definitions
2. **Server API** (`@octopus/server`) — 7 new REST endpoints under `/api/workspaces/:id/executions/:executionId/repair/*`
3. **Server repair service** — Business logic layer between routes and DAO/EnginePool
4. **Core-pack skill** (`octo-workflow-repair`) — SKILL.md defining the Claude Code Skill interaction protocol

## Architecture

```
SKILL.md (orchestration, read+write)
    ↓ HTTP
Server repair routes (7 endpoints)
    ↓
RepairService (diagnosis + state mutation)
    ↓                    ↓
ExecutionDAO         EnginePool (live engine instances)
(SQLite state)       (VarPool, nodeResults, workflow def)
```

## Non-goals (MVP)

- No audit logging table
- No new Web UI components (SSE event push only)
- No auto-detection (manual invocation only)
- No cross-execution cascade repair
- No E2E browser tests

## Detailed Design

### 1. Shared Types (`packages/shared/src/types/repair.ts`)

```typescript
// Execution status union (already exists in engine ExecutionResult, formalize here)
export type ExecutionStatus =
  | "pending" | "running" | "completed" | "completed_with_failures"
  | "failed" | "paused" | "cancelled" | "rejected" | "pending_approval"
  | "interrupted" | "pending_resume"

export type NodeExecutionStatus =
  | "pending" | "running" | "completed" | "failed" | "skipped"
  | "skipped_failed" | "paused" | "cancelled" | "rejected"
  | "pending_approval"

export type NodeType = "bash" | "python" | "agent" | "condition" | "approval" | "loop" | "swarm"

// ── Diagnose Report ───────────────────────────────────────────────

export interface DiagnoseReport {
  execution: {
    id: string
    status: ExecutionStatus
    workflowRef: string
    startedAt: string
    duration: number
    retryCount: number
    resumeAttempts: number
  }
  nodes: DiagnoseNodeReport[]
  varPool: Record<string, unknown>
  anomalies: Anomaly[]
  checkpoints: CheckpointSummary[]
  recentErrors: RecentError[]
}

export interface DiagnoseNodeReport {
  nodeId: string
  nodeType: NodeType
  status: NodeExecutionStatus
  duration: number
  retryCount: number
  error?: string
  lastOutput?: string
  eventCount: number
  recentEvents: Array<{ type: string; content: string; timestamp: string }>
}

export interface Anomaly {
  type: "stuck_node" | "exhausted_retry" | "false_completion" | "infinite_retry" | "orphaned_node" | "pending_hooks"
  nodeId?: string
  description: string
  severity: "critical" | "warning" | "info"
  suggestion: string
}

export interface CheckpointSummary {
  id: string
  timestamp: string
  completedNodes: string[]
  size: number
}

export interface RecentError {
  timestamp: string
  nodeId?: string
  error: string
  category: string
}

// ── Repair Operations ─────────────────────────────────────────────

export interface VarPoolUpdateRequest {
  updates: Record<string, unknown>
}

export interface VarPoolUpdateResponse {
  updated: number
  snapshot: Record<string, unknown>
}

export interface NodeResetRequest {
  status: "pending" | "completed"
  outputs?: Record<string, unknown>
}

export interface NodeResetResponse {
  nodeId: string
  previousStatus: string
  newStatus: string
}

export interface RestorePointRequest {
  nodeId: string
  resetVarPool?: boolean
}

export interface RestorePointResponse {
  resetNodes: string[]
  restoredFrom: string
}

export interface ReloadWorkflowRequest {
  content: string
}

export interface ReloadWorkflowResponse {
  reloaded: boolean
  diff: string[]
}

export interface InterveneRequest {
  nodeId: string
  message: string
}

export interface InterveneResponse {
  injected: boolean
}

export interface ClearRetryRequest {
  nodeIds?: string[]
}

export interface ClearRetryResponse {
  cleared: string[]
}
```

### 2. Server Repair Routes

All endpoints under `/api/workspaces/:id/executions/:executionId/repair/`:

| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/diagnose` | `getDiagnose` | Full diagnostic report |
| POST | `/varpool` | `patchVarPool` | Batch update VarPool variables |
| POST | `/node/:nodeId/reset` | `resetNode` | Reset/modify node status + inject outputs |
| POST | `/restore-point` | `restorePoint` | Restore to a node, reset downstream |
| POST | `/reload-workflow` | `reloadWorkflow` | Hot-reload workflow YAML |
| POST | `/intervene` | `intervene` | Inject intervention message to running node |
| POST | `/clear-retry` | `clearRetry` | Clear retry counts |

Routes file: `packages/server/src/routes/repair.ts`
Service file: `packages/server/src/services/repair.ts`

### 3. RepairService Logic

#### `diagnose(executionId)`

1. Load execution row from DAO
2. Load all node_executions for the execution
3. Load agent_events grouped by node (count + last 5 per node)
4. Load VarPool from execution.var_pool JSON
5. Run anomaly detection:
   - **stuck_node**: node status=running but updated_at older than 10 minutes and event count is very high
   - **exhausted_retry**: node status=failed with retry_count >= max (from pipeline config or default 3)
   - **false_completion**: node status=completed but lastOutput is empty or very short
   - **infinite_retry**: execution retry_count > 5
   - **orphaned_node**: node status=running but execution status is not running
   - **pending_hooks**: execution has non-empty pending_hooks
6. Load checkpoint summaries from filesystem checkpoint store (if available)
7. Collect recent errors from node_executions where status=failed

#### `patchVarPool(executionId, updates)`

1. Load current var_pool from execution row
2. Parse JSON, merge updates
3. Write back to execution.var_pool
4. If engine is live in EnginePool, also update the in-memory VarPool
5. Emit SSE event: `{ type: "repair_varpool", data: { updated, snapshot } }`
6. Return updated count and snapshot

#### `resetNode(executionId, nodeId, status, outputs?)`

1. Find node_execution row by execution_id + node_id
2. Validate state transition (allow: completed→pending, failed→pending, any→completed with outputs)
3. Update node_execution status
4. If outputs provided, serialize to JSON and store in outputs column
5. If engine is live, also update engine.nodeResults
6. Emit SSE event: `{ type: "repair_node_reset", data: { nodeId, previousStatus, newStatus } }`

#### `restorePoint(executionId, nodeId, resetVarPool?)`

1. Topological sort all nodes from the workflow definition
2. Find target node index
3. All nodes after the target index → reset to "pending" status
4. If resetVarPool, load var_pool from the checkpoint closest to that node (or clear late entries)
5. If engine is live, clear engine.nodeResults for reset nodes
6. Emit SSE event

#### `reloadWorkflow(executionId, content)`

1. Parse new YAML with `parseWorkflow`
2. If engine is live, replace `engine.workflow` with new definition
3. Compute diff (list of node IDs that changed)
4. Emit SSE event

#### `intervene(executionId, nodeId, message)`

1. Find the live engine instance in EnginePool
2. If engine is running and paused (pending_approval), call `retryFrom(nodeId, { intervention: message })`
3. If engine is running but not paused, inject via the existing intervention mechanism
4. If engine is not live (server restart), store as pending_hooks entry for later recovery
5. Emit SSE event

#### `clearRetry(executionId, nodeIds?)`

1. If nodeIds provided, update retry_count=0 for those specific node_executions
2. If not provided, update retry_count=0 for all node_executions in the execution
3. Also reset execution-level retry_count if applicable
4. Emit SSE event

### 4. DB Schema Changes

For MVP, we avoid schema changes. The repair operations use existing columns:
- VarPool: existing `executions.var_pool` column (JSON text)
- Node status: existing `node_executions.status` column
- Node outputs: existing `node_executions.outputs` column
- Retry count: existing `node_executions.retry_count` column
- Intervention: uses existing `retryFrom()` mechanism

No new columns needed for MVP. The `repair_log` and `manual_override` columns from the brief are deferred.

### 5. Core-pack Skill

File: `packages/core-pack/skills/octo-workflow-repair/SKILL.md`

The skill defines the interaction protocol for Claude Code to follow when invoked:
1. Accept executionId parameter
2. Call GET /repair/diagnose to get the report
3. Present findings to the user
4. Let user choose repair actions
5. Execute repair operations via POST endpoints
6. Verify repair results

### 6. SSE Events

All repair operations emit SSE events through the existing SSEService:
- `repair_diagnose` — diagnostic report generated
- `repair_varpool` — VarPool updated
- `repair_node_reset` — node status changed
- `repair_restore_point` — restore point activated
- `repair_workflow_reloaded` — workflow YAML reloaded
- `repair_intervention` — intervention message injected
- `repair_retry_cleared` — retry counts cleared

### 7. File Inventory

| File | Action | Package |
|------|--------|---------|
| `packages/shared/src/types/repair.ts` | Create | shared |
| `packages/shared/src/index.ts` | Modify (add export) | shared |
| `packages/server/src/routes/repair.ts` | Create | server |
| `packages/server/src/services/repair.ts` | Create | server |
| `packages/server/src/index.ts` | Modify (mount route) | server |
| `packages/server/src/routes/execution.ts` | Modify (import repair) | server |
| `packages/core-pack/skills/octo-workflow-repair/SKILL.md` | Create | core-pack |

### 8. Testing Strategy

- **Unit tests** for RepairService: diagnose logic, anomaly detection, VarPool patching, node reset validation
- **Integration tests** for repair routes: HTTP endpoint → service → DAO round-trip
- **No E2E** (MVP exclusion)
