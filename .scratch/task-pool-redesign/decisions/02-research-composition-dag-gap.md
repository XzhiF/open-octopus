# 02 — composition DAG gap

Type: research
Status: resolved

## Answer

Scope: how `workflow_chain` is stored and executed today at the scheduler layer, and the gap to a composition DAG (parallel subunit-dispatch + final integration/aggregate step). Primary sources only; all citations are `file:line`.

### 1. Is `workflow_chain` strictly sequential (A→B→C)? Any parallel/aggregate?

**Yes — strictly sequential. No parallel or aggregate capability within a chain.**

Evidence (storage shape — the chain is a flat ordered array, not a graph):

- `packages/shared/src/types/scheduler-job.ts:39-42` — `workflowChainItemSchema = { workflow_ref, input_values }`. No `depends_on`, no `parallel`, no `role`/`aggregate` field. A chain item is a single workflow ref + inputs.
- `packages/shared/src/types/scheduler-job.ts:63-69` — `workflowConfigSchema.workflow_chain: z.array(workflowChainItemSchema).min(1).max(20)`. An ordered array of length 1..20. No edge/dependency structure.

Evidence (execution shape — linear recursion, one child per completion):

- `packages/server/src/services/workspace.ts:365` — `createFromSpec` writes `config.json` with `workflow_chain: input.workflow_chain.slice(1)` ("remaining chain (root is triggered immediately)"). Root = index 0; the rest is the "remaining" tail consumed by index.
- `packages/server/src/services/scheduler/executors/workflow-executor.ts:194-214` — root trigger fires `config.workflow_chain[0]` only.
- `workflow-executor.ts:423-439` — `resolveNextChainStep` reads `config.workflow_chain` (the sliced remaining array) and returns `remaining[child_index] ?? null`. **Index-based, single next step.**
- `workflow-executor.ts:446-510` — `triggerChildStep` creates **exactly one** child via `registry.service.create({ parent_id: opts.executionId, child_index: nextChildIndex, ... })`. `nextChildIndex = (completed?.child_index ?? 0) + 1` (`:466`). One parent → one child, always.
- `workflow-executor.ts:317-413` — `handleChainComplete` is the completion callback. On `completed`: `resolveNextChainStep` → if next exists, `triggerChildStep` and `return` (the child's `onComplete` re-enters `handleChainComplete` recursively); else finalize to `done`. This is a linear A→B→C recursion with a single in-flight execution at any time. **No fan-out, no join barrier, no aggregate step type.**

The only "parallel" that exists is **cross-schedule**, not intra-chain:

- `workflow-executor.ts:14-17` — `MAX_PARALLEL_WORKSPACES` (env `OCTOPUS_SCHEDULER_MAX_PARALLEL`, default 3).
- `workflow-executor.ts:99-109` — `countDistinctActiveSchedules(executionId) >= MAX_PARALLEL_WORKSPACES` gates *different schedules* running concurrently. This is parallel schedules, not parallel steps inside one composition.

### 2. Minimal gap to support a DAG of subunit-dispatches + a final integration/aggregate step

Today's model is: flat array + integer `child_index` + 1:1 parent→child recursion. The minimal gap to a composition DAG is four additions:

1. **Graph structure instead of flat array.** `workflow_chain` is `z.array(WorkflowChainItem)` with no edges (`scheduler-job.ts:67`). A composition needs `depends_on` / edge list (or a levels structure) so a node can declare "I depend on {B, C}" — the prerequisite for a diamond (A→{B,C}→D). `WorkflowChainItem` (`scheduler-job.ts:39-42`) has no such field.
2. **Fan-out dispatcher.** `triggerChildStep` (`workflow-executor.ts:446-510`) creates exactly one child. A DAG needs to create N children for a fan-out node and dispatch them (the engine already does this via `Promise.all` over experts — see Q3).
3. **Join/barrier.** `handleChainComplete` (`workflow-executor.ts:317`) fires on each child completion and immediately resolves the next single step. There is no "wait until all N siblings complete, then advance" counter/barrier. A composition needs a per-parent pending-children count + a completion gate before the integration step can run.
4. **Integration step type.** No step role exists today (`scheduler-job.ts:39-42` has only `workflow_ref` + `input_values`). A composition needs a step that says "I am the aggregate; my inputs are the outputs of my dependencies." The engine's moa `aggregator` (`moa-strategy.ts:13,23,173-180`) is the template for this.

Additionally, `resolveNextChainStep` (`workflow-executor.ts:423-439`) keys off `remaining[child_index]` — a single integer index. A DAG node with multiple dependents cannot be addressed by one `child_index`; it needs either a per-child edge row or a "level + position" addressing scheme.

### 3. Engine primitives that already exist and a workflow-layer composition could reuse

The engine already has parallel DAG + fan-out + aggregation. A scheduler-layer composition workflow could reuse these directly rather than rebuilding them:

- **DAG level computation (Kahn's algorithm)** — `packages/engine/src/graph-utils.ts:93-122` `computeExecutionLevels(nodes): NodeDef[][]`. Returns sets of nodes that can run concurrently. `:39-61` `detectCycles` guards against cycles. This is the level primitive a composition DAG needs.
- **Parallel level execution** — `packages/engine/src/engine.ts:1370` `executeNodesParallel`. At `:1374` it calls `computeExecutionLevels`; at `:1522` it runs each level's batch with `Promise.allSettled(batch.map(...))`. `:1514-1515` + `:1755-1762` `splitIntoBatches` respects `max_concurrent` (`engine.ts:124,233`). This is the fan-out + concurrency-limit executor.
- **Dispatch swarm submode (DAG scheduling)** — `packages/engine/src/executors/swarm/dispatch-strategy.ts:1-29`. Uses `buildDAG` from `./dag-builder` (`:7`) to organize experts into levels; "Levels execute sequentially, but experts within a level run in parallel. If an expert's dependency fails, the dependent expert is skipped (or the whole execution fails with fail_fast)." This is literally a composition DAG with dependency resolution and failure propagation — the closest reusable template.
- **MOA swarm submode (parallel + integration)** — `packages/engine/src/executors/swarm/moa-strategy.ts`. Phase 1 fan-out: `:54-122` `Promise.all(experts.map(...))` runs experts concurrently with per-expert timeout. Phase 3 aggregation: `:173-180` `runHost({ expertOutputs, mode: "moa", host: this.aggregator })` synthesizes. Multi-round refinement at `:191-204` feeds the synthesis back. `:231-243` `truncateForAggregator` bounds aggregator input. **This is the exact "parallel dispatch + integration" primitive** a composition-DAG final step wants.
- **Loop executor** — `packages/engine/src/executors/loop.ts` (iteration primitive, reusable if the composition needs iterative refinement).
- **Engine callbacks for external orchestration** — `engine.ts:53-112` `EngineCallbacks` (`onNodeStart`/`onNodeEnd`/`onComplete`/`onSwarmEvent`). The scheduler already uses `registerExternalCallbacks` (`execution.ts:98-100` → `workflow-executor.ts:233-247`) to hook chain completion; the same channel can drive a join barrier.

**Gap note:** these primitives live at the *engine/workflow-node* layer (intra-workflow). The scheduler's `workflow_chain` is an *inter-workflow* layer that does not currently call `computeExecutionLevels`/`executeNodesParallel`/swarm strategies. Reuse path: either (a) express the composition as a single engine workflow whose nodes are `sub_workflow`/`swarm` nodes (then the engine DAG does everything), or (b) lift `computeExecutionLevels` + a join barrier into the scheduler's `triggerChildStep`/`handleChainComplete` so the scheduler can dispatch parallel `executions` children and gate the integration step on all-siblings-complete.

### 4. Does `schedule_executions` have what's needed to express a parent/child DAG? What columns are missing?

**No. `schedule_executions` cannot express a parent/child DAG today — not even the chain parent/child.** The chain parent/child relation lives in a *different* table (`executions`), and `schedule_executions` is a single-row-per-trigger summary.

Current `schedule_executions` schema (`packages/server/src/db/schema.sql:299-324`):

```
id, schedule_id, execution_id, status, trigger_type, triggered_at,
timezone_offset, timezone_iana, duration_ms, skip_reason, missed_reason,
retry_of, error_summary, exit_code, agent_output, model_used, token_usage,
metadata, triggered_by, workspace_id, created_at, completed_at
```

- **No `parent_id`, no `child_index`, no `depends_on`, no `level`/`depth`, no `node_role`.** The parent/child chain columns are on `executions` (`schema.sql:32-33`: `parent_id TEXT NOT NULL DEFAULT '0'`, `child_index INTEGER DEFAULT 0`), not on `schedule_executions`.
- `schedule_executions.execution_id` links to the **root execution only** — `workflow-executor.ts:229` `updateExecutionLinkId(executionId, execution.id)` stores the first/root `execution.id`. All subsequent chain children are rows in `executions` linked via `executions.parent_id`, found by `execution-dao.ts:1076-1083` `findLastChildExecution` (`ORDER BY child_index DESC LIMIT 1`) and `execution-dao.ts:22` `findByParent`.
- **Single-active-per-schedule constraint baked into the schema** — `schema.sql:565`: `CREATE UNIQUE INDEX idx_sched_execs_unique_active ON schedule_executions(schedule_id) WHERE status IN ('triggered','running')`. This enforces "one in-flight execution row per schedule" and is the DB backing for the skip policy (`workflow-executor.ts:84-96`, `schedule-run-dao.ts:82-86`). For a DAG with N parallel in-flight children this index would have to move or be relaxed for child rows.

What `executions` (the table that actually holds the chain) has vs. what a DAG needs:

- `executions` has `parent_id` + `child_index` (`schema.sql:32-33`) — enough for a **tree/list**, but `child_index` is a single integer; a diamond (A→{B,C}→D where D depends on both B and C) cannot be expressed because D has two parents and `parent_id` is single-valued. There is no `depends_on` / edge list on `executions`.
- The repo already has a proper edge table — `node_edges` (`schema.sql:96-104`: `from_node_id`, `to_node_id`, `edge_type`, `label`) — but it is scoped to **intra-workflow nodes** (`execution_id` FK), not inter-workflow/inter-execution chain steps.

**Columns/structures missing for parallel + integration at the scheduler layer:**

On `schedule_executions` (or a new `schedule_execution_children` join table) you would need, at minimum:

| Need | Current state | Gap |
|---|---|---|
| Parent reference | `schedule_executions` has none; `executions.parent_id` exists but single-valued | `parent_execution_id` (and/or a children edge table) |
| Sibling ordering for parallel | `executions.child_index` is one int | `level` + `position` (or `depends_on` edge list) to address a node with multiple dependents |
| Multi-parent dependency (diamond join) | none | `depends_on` / edge rows (mirror `node_edges`) |
| Step role (dispatch vs aggregate) | none — `scheduler-job.ts:39-42` has only `workflow_ref`+`input_values` | `node_role` ('dispatch' \| 'aggregate' \| 'fan-out') on chain item + persisted to execution row |
| Join barrier (wait for N siblings) | none — `handleChainComplete` advances on each single completion (`workflow-executor.ts:317`) | `pending_children_count` / completion gate (per-parent) |
| Multiple concurrent in-flight children per schedule | blocked by `idx_sched_execs_unique_active` (`schema.sql:565`, single active row per schedule_id) | relax/scoped index for child rows, or move the active constraint to the composition-root row only |

**Summary:** The scheduler's `workflow_chain` is a 1-D array walked by `child_index` with 1:1 parent→child recursion (`triggerChildStep`/`handleChainComplete`); it has no fan-out, no join, no aggregate step. The engine already implements every primitive a composition DAG needs (`computeExecutionLevels` + `executeNodesParallel` for leveled parallel dispatch; `dispatch-strategy.ts` for DAG-with-dependencies; `moa-strategy.ts` for parallel fan-out + aggregator integration). The DB gap is that `schedule_executions` is a single-row-per-trigger summary with no parent/child/dependency columns (those live one table over, on `executions`, and even there only as a single-valued `parent_id`+`child_index` tree — insufficient for diamonds), plus a unique-active-per-schedule index that forbids multiple concurrent children.
