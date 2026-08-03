# Spec — Dynamic Sub-Workflow Node

> Branch: `feat/dynamic-sub-workflow`
> Origin: `.scratch/dynamic-sub-workflow/brief.md`
> Status: Ready for implementation

## 1. Summary

Add a `dynamic_sub_workflow` node type that lets an LLM agent generate a DAG of parallel/serial `agent` nodes at runtime, validates the output through a three-layer harness with auto-correction, persists the result as a YAML + meta.json, and executes it through the existing sub-workflow pipeline.

## 2. Affected Packages

| Package | Changes |
|---------|---------|
| `shared` | `NodeDef.type` enum, `NodeSchema` Zod, `NodeTypeSchema` (workspace) |
| `engine` | New `DynamicSubWorkflowExecutor`, validation harness, factory wiring, index export |
| `server` | `NodeTypeSchema` propagation (auto), no new endpoints |
| `web-app` | `nodeTypes` map entry, "Dynamic" badge rendering, flow-viewer-with-status dynamic detection |
| `core-pack` | `octo-workflow-dev` node-schema.md + node-patterns.md update |

## 3. Detailed Design

### 3.1 Schema Layer (shared)

**NodeDef union extension:**
- Add `"dynamic_sub_workflow"` to the `type` union in `NodeDef` interface.
- Add `"dynamic_sub_workflow"` to the `z.enum([...])` in `NodeSchema`.
- Add `"dynamic_sub_workflow"` to `NodeTypeSchema` in `workspace.ts`.

**New fields on NodeDef** (all optional, reusing existing field slots):
- `prompt?: string` — DAG generation instruction (already exists for agent nodes)
- `model?: string` — model override (already exists)
- `skills?: string[]` — skills for the generation agent (already exists)
- `workflow?: string` — optional pre-defined output file name (already exists for sub_workflow)
- `on_error?: "fail" | "continue"` — error behavior (already exists for sub_workflow)

No new TypeScript fields needed — all fields already exist in the `NodeDef` interface and `NodeSchema`. The `dynamic_sub_workflow` type simply reinterprets the existing fields in a new context.

### 3.2 Engine Layer

#### 3.2.1 New File: `packages/engine/src/executors/dynamic-sub-workflow.ts`

**Class:** `DynamicSubWorkflowExecutor implements NodeExecutor`

**Constructor:** `(node: NodeDef, pool: VarPool, config: DynamicSubWorkflowConfig)`

**Execute flow:**
1. **File name resolution:**
   - If `node.workflow` is set → use it as base name
   - Else → `{parentWorkflow}__{node.id}`
   - If inside a loop (config.iterationIndex != null) → append `-iter{N}`
   - Result: `{baseName}.yaml` and `{baseName}.meta.json`

2. **Input hash computation:**
   - Collect upstream node outputs based on `node.depends_on`
   - SHA-256 hash of the JSON-serialized input snapshot
   - Compare against existing meta.json `input_hash`

3. **Context-aware rerun check:**
   - If meta.json exists AND `input_hash` matches → skip generation, load existing YAML
   - If meta.json doesn't exist OR hash differs → proceed to generation

4. **DAG Generation via Agent:**
   - Build a generation prompt using:
     - `node.prompt` (user instruction)
     - Upstream data context (from VarPool/node outputs)
     - DAG JSON schema contract (inline in the prompt)
   - Call the agent provider (reuse `AgentNodeRunner` pattern)
   - Parse the agent response as JSON

5. **Three-Layer Validation Harness:**
   - **L1 (Structure):** Valid JSON, has `nodes` array, each node has `id`, `type`, `prompt`
   - **L2 (Graph):** No circular dependencies (reuse `detectCycles`), all `depends_on` references valid node IDs
   - **L3 (Semantic):** All node types are `"agent"` (whitelist), prompts are non-empty strings
   - On validation failure → invoke correction agent with error details → re-validate
   - Max 3 correction rounds. After 3 failures → node status = "failed"

6. **DAG Persistence:**
   - Convert validated JSON to YAML (WorkflowDef format)
   - Write `{baseName}.yaml` to `{cwd}/workflows/`
   - Write `{baseName}.meta.json` with: `{ generated_at, input_hash, input_snapshot, validation_rounds, execution_status: "pending", node_count }`

7. **DAG Execution:**
   - Parse the generated YAML into a WorkflowDef
   - Delegate to `SubWorkflowExecutor`-like execution pattern:
     - Create child VarPool
     - Register child nodes via `ensureNodeExecution` (scoped IDs)
     - Create child WorkflowEngine
     - Execute and collect results
   - Update meta.json `execution_status` to "completed" or "failed"

8. **Output:**
   - `outputs.generated_workflow` = workflow name (for DB/UI association)
   - `outputs.node_count` = number of generated nodes
   - `outputs.validation_rounds` = number of validation rounds used
   - Standard status/durationMs/logLines

#### 3.2.2 New File: `packages/engine/src/executors/dynamic-sub-workflow-validation.ts`

Pure functions for the three validation layers:

```typescript
export interface ValidationResult {
  valid: boolean
  errors: string[]
}

export function validateL1Structure(json: unknown): ValidationResult
export function validateL2Graph(nodes: NodeDef[]): ValidationResult
export function validateL3Semantics(nodes: NodeDef[]): ValidationResult
export function runValidationPipeline(json: unknown): { result: ValidationResult; rounds: number }
```

#### 3.2.3 Config: `DynamicSubWorkflowConfig`

Added to `executor-config.ts`:

```typescript
export interface DynamicSubWorkflowConfig extends CoreConfig {
  globalSessionId?: string
  branchSessionIds?: Map<string, string>
  inputs?: Record<string, any>
  engineNodeResults?: Record<string, NodeExecutionResult>
  workflowResolver?: (name: string) => { parsed: WorkflowDef; content: string } | undefined
  visitedWorkflows?: Set<string>
  ensureNodeExecution?: (scopedNodeId: string, nodeType: string, meta?: RuntimeNodeMeta) => void
  iterationIndex?: number
  /** Write generated YAML to this directory (defaults to {cwd}/workflows/) */
  outputDir?: string
}
```

#### 3.2.4 Factory Wiring

In `executor-factory.ts`, add case `"dynamic_sub_workflow"`:
- Instantiate `DynamicSubWorkflowExecutor` with the config
- Pass the same providers/callbacks/logger as sub_workflow
- Pass `outputDir` derived from `cwd + "/workflows"`

#### 3.2.5 Index Export

Add to `packages/engine/src/index.ts`:
```typescript
export { DynamicSubWorkflowExecutor } from "./executors/dynamic-sub-workflow"
export type { DynamicSubWorkflowConfig } from "./executors/executor-config"
```

### 3.3 Server Layer

No new API endpoints. The existing `workflowResolver` in `EngineFactory.ts` already resolves generated workflow files from the `workflows/` directory — generated YAMLs are automatically discoverable.

The `NodeTypeSchema` update in shared propagates to server via the `@octopus/shared` dependency.

SSE events: child nodes use scoped IDs (`parentId:childId`) — identical to existing `sub_workflow` behavior. No changes needed.

### 3.4 Web-App Layer

#### 3.4.1 Node Type Registration

In `workflow-flow-viewer.tsx` and `workflow-flow-viewer-with-status.tsx`:
- Add `dynamic_sub_workflow: SubWorkflowContainerNode` to `nodeTypes` map

#### 3.4.2 Dynamic Badge Rendering

In `sub-workflow-container-node.tsx`:
- Extend `SubWorkflowContainerData` with `is_dynamic?: boolean` and `generated_workflow?: string`
- When `is_dynamic` is true and no child nodes are loaded:
  - Show "Dynamic" badge (amber/yellow) + "⚡ 运行时生成"
- When child nodes are loaded (post-generation or history):
  - Render normally, same as static sub_workflow

#### 3.4.3 Flow Viewer with Status

In `workflow-flow-viewer-with-status.tsx`:
- When building node data, detect `type === "dynamic_sub_workflow"` and set `is_dynamic: true`
- When collecting sub_workflow refs for child loading, also check `dynamic_sub_workflow` nodes that have `outputs.generated_workflow`

### 3.5 Core-Pack Skills

#### `octo-workflow-dev` Updates:
- `references/node-schema.md`: Add `dynamic_sub_workflow` section with field reference
- `references/node-patterns.md`: Add dynamic sub_workflow pattern example
- `references/composition-rules.md`: Add note about dynamic_sub_workflow constraints (agent-only nodes)

## 4. Test Plan

### Unit Tests (`packages/engine/src/__tests__/dynamic-sub-workflow.test.ts`)

1. **L1 validation:** valid/invalid JSON structure
2. **L2 validation:** circular dependency detection, invalid depends_on references
3. **L3 validation:** non-agent type rejection, empty prompt rejection
4. **File name generation:** plain / loop / custom workflow name
5. **Input hash comparison:** same input → same hash, different input → different hash
6. **Validation pipeline:** end-to-end validation with correction rounds

### Integration Tests (`packages/engine/src/__tests__/dynamic-sub-workflow-e2e.test.ts`)

1. **Happy path:** Mock agent produces valid DAG → validates → persists → executes
2. **Auto-correction:** Mock agent first output has cycle → correction produces valid DAG
3. **3-round failure:** Mock agent always produces invalid → node fails with error
4. **Loop execution:** 3 iterations → 3 separate YAML files with iter suffixes
5. **Rerun (same context):** Same input hash → reuse existing DAG, no agent call
6. **Rerun (changed context):** Different input hash → regenerate

## 5. Non-Goals (Explicitly Excluded)

- Template/inline generation strategies
- Non-agent node types in generated DAGs
- Cross-workspace dynamic sub-workflows
- Pause/resume for dynamic sub-workflows
- DAG cleanup/retention policies

## 6. Data Model Impact

- **No DDL changes** — `node_executions.outputs` JSON field stores `generated_workflow`
- **No migration** — existing tables accommodate the new data
