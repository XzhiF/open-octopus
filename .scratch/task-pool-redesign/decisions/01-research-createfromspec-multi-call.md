# 01 — createFromSpec multi-call feasibility

Type: research
Status: resolved

## Answer

### 0. Premise correction — parent_id/child_index are on `executions`, NOT on `schedule_executions`

The question assumes `parent_id`/`child_index` on `schedule_executions`. They are not there. The scheduler's `schedule_executions` table (`packages/server/src/db/schema.sql:299-324`) has columns: `id, schedule_id, execution_id, status, trigger_type, triggered_at, timezone_offset, timezone_iana, duration_ms, skip_reason, missed_reason, retry_of, error_summary, exit_code, agent_output, model_used, token_usage, metadata, triggered_by, workspace_id, created_at, completed_at`. No `parent_id`, no `child_index`.

`parent_id` / `child_index` live on the **engine's** `executions` table (`schema.sql:32-33`):

```sql
parent_id TEXT NOT NULL DEFAULT '0',
child_index INTEGER DEFAULT 0,
```

PR #50's chain-child mechanism uses these engine-layer columns via `ExecutionService.create(workspace_id, { parent_id, child_index, workflow_ref, input_values, triggered_by })` (`workflow-executor.ts:470-476`). The parent/child relation is therefore purely at the **engine execution layer within one workspace** — there is no parent/child relation between `schedule_executions` rows. `schedule_executions.execution_id` is a FK to `executions.id` (`schema.sql:323`), the only structural link.

This matters: the scheduler has no native parent/child schedule_execution concept to fan out on.

### 1. End-to-end sequential chain dispatch (claim → dispatch root → handleChainComplete → triggerChildStep → child createFromSpec)

Trace (all line numbers are the post-PR-#50 state on `test-task-board`/`main`):

**Claim** — `scheduler-engine.ts:416-454` `checkQueuedTasks()`:
- `findQueuedSchedules()` returns `status='queued'` rows ordered by `created_at` (`schedule-config-dao.ts:144-148`).
- Only `trigger_source==='requirement'` rows are dispatched (`scheduler-engine.ts:420`); cron jobs are cron-driven, not queued.
- Global concurrency cap: `countDistinctActiveSchedules() >= MAX_PARALLEL_WORKSPACES` (default 3) → `break`, remaining stay queued (`scheduler-engine.ts:424-425`; constant at `:23-26`, mirrored in `workflow-executor.ts:14-17`).
- Claim: `updateSchedule({status:'claimed', claimed_at})` (`:431-434`).
- `insertTriggeredExecution(schedExecId, scheduleId, 'scheduled', ...)` creates the `schedule_executions` row with `status='triggered'` (`:437-439`; DAO at `schedule-run-dao.ts:311-318`).
- `dispatchExecution(schedule, schedExecId)` (`:442`).

**Dispatch root** — `scheduler-engine.ts:233-252` `dispatchExecution` → `executeWorkflow` (`:316-343`) calls `executor.execute(job, schedExecId)` fire-and-forget (`.then`/`.catch`).

`WorkflowExecutor.execute()` (`workflow-executor.ts:67-313`):
- Parse `config` from `schedule.config` JSON as `WorkflowConfig` (`:112`, type assertion not Zod parse).
- Same-schedule concurrency skip (`:84-97`) + cross-schedule cap (`:99-109`).
- Generate `branchSuffix` (`:128`, timestamp+rand) and, for requirement-type, deterministic `branchPrefix = taskpool-${schedule.id}` (`:133-135`).
- **`createFromSpec` called exactly ONCE** (`:140-149`) → one workspace. Inputs: `org, name=workspaceName, projects, branch_prefix, branch_suffix, source:'scheduler', source_schedule_id, workflow_chain`.
- `insertScheduleWorkspace` (`:167-174`) records the schedule↔workspace row; `updateExecutionWorkspace` (`:177`) sets `schedule_executions.workspace_id`.
- `getExecutionService(workspace.id)` (`:180`) → per-workspace ExecutionService registry.
- `registry.service.create(workspace.id, { workflow_ref: firstStep.workflow_ref, input_values, initial_var_pool: scheduleVars })` (`:209-214`) → root engine `executions` row (parent_id default '0', child_index 0).
- `registerExternalCallbacks({ onComplete: handleChainComplete(...) })` on the root execution id (`:233-247`).
- `registry.service.start(execution.id, ...)` fire-and-forget (`:266`); `execute()` returns `status:'running'` immediately (`:307-312`).

**handleChainComplete** — `workflow-executor.ts:317-413`:
- Reads root execution final status (`:331`) and last child execution (`:334`).
- `resolveNextChainStep(schedWsId, executionId)` (`:344`).
  - Reads `config.json` from the workspace dir (`:429`); `workflow_chain` field = **`slice(1)`** of the full chain (stored that way by `createFromSpec` at `workspace.ts:365` — root already triggered, so remaining = chain[1..]).
  - `child_index` of the just-completed engine execution (`:434`) indexes into `remaining` → returns `remaining[child_index]` or null (`:435`).
- If `nextStep` exists → `triggerChildStep(opts, nextStep)` and **`return`** (do not finalize; `:345-348`). The chain is not done.
- If `nextStep` is null → chain complete → finalize `schedule_executions` + `schedule_workspaces` + (for requirement-type) `schedules.status='done'` (`:351-371`).

**triggerChildStep** — `workflow-executor.ts:446-510`:
- `findScheduleWorkspaceById(opts.schedWsId)` → **same workspace** the root used (`:460-462`).
- `registry = getExecutionService(wsRow.workspace_id)` → **same registry** (`:462-463`).
- `nextChildIndex = (completed.child_index ?? 0) + 1` (`:466`).
- `registry.service.create(wsRow.workspace_id, { workflow_ref, parent_id: opts.executionId, child_index: nextChildIndex, input_values, triggered_by:'scheduler' })` (`:470-476`) → **engine child `executions` row in the SAME workspace** (parent_id = prior execution; child_index increments). This is where `parent_id`/`child_index` are written — engine layer, not scheduler.
- Register child `onComplete: handleChainComplete({...opts, executionId: child.id})` (`:495-499`) → **recursion**: child completion re-enters `handleChainComplete` with the child's id, which resolves the next step, and so on until `remaining[child_index]` is null.
- `registry.service.start(child.id, ...)` fire-and-forget (`:502`).

**Net end-to-end**: claim → one `createFromSpec` (root) → root engine exec → on root complete → `resolveNextChainStep` → `triggerChildStep` creates a child engine exec **in the same workspace** → child runs → child complete re-enters `handleChainComplete` → repeat until `workflow_chain` slice is exhausted → finalize. **Strictly sequential, strictly single-workspace, `createFromSpec` called exactly once per dispatch.**

### 2. Can `createFromSpec` be called N times (one per subunit) within one task dispatch?

**YES, structurally — each call is independent and materializes a fresh workspace.** `createFromSpec` (`packages/server/src/services/workspace.ts:315-387`) is effectively stateless per call:

- `id = randomUUID()` (`:325`) — unique per call.
- `wsDir = ~/.octopus/{org}/workspaces/{name}` (`:329`); if it exists, `fs.rmSync(wsDir, {recursive:true, force:true})` (`:330-332`) — keyed by `name`. N calls with distinct `name` coexist; N calls with the same `name` clobber each other.
- Subdir + `pipeline.yaml` + `config.json` + `CLAUDE.md` writes (`:336-372`) — all scoped to `wsDir`.
- `dao.insert({id, name, org, ..., source:'scheduler', source_schedule_id})` (`:375-381`) — random id; no UNIQUE constraint on `(org,name)` in `workspaces` (`schema.sql:8-26`), so DB inserts never collide.
- `git.initWorktreesFromSpec(wsDir, projects, branch_prefix, branch_suffix, name)` (`:384`) — per project: `spawnSync("git",["worktree","add","-f",wtDir,"--detach"])` then `git checkout -b ${branchPrefix}-${branchSuffix}` (`workspace-git.ts:99-166`). Branch name = `${branchPrefix}-${branchSuffix}` — N calls need distinct `branch_prefix`/`branch_suffix` or git branch creation collides.

No shared mutable state inside `createFromSpec`. No locks, no module-level caches, no global registry mutation beyond the DB insert.

**Constraints / blockers for N calls within one composite dispatch:**

1. **Naming uniqueness** — distinct `name` (else fs clobber at `workspace.ts:330-332`) and distinct `branch_prefix`+`branch_suffix` (else git branch collision at `workspace-git.ts:99-166`) per subunit. Solvable by deriving from subunit id.
2. **Blocking I/O on the event loop** — `initWorktreesFromSpec` uses `spawnSync` (synchronous) per project (`workspace-git.ts:107,121,129`). N subunits × M projects = N·M serial blocking git calls. Not parallelizable inside the current sync implementation; a fan-out of any size will stall the server's event loop. (Pre-existing issue, not introduced by multi-call.)
3. **Global concurrency cap** — `MAX_PARALLEL_WORKSPACES` (default 3, `workflow-executor.ts:14-17`, `scheduler-engine.ts:23-26`) is enforced via `countDistinctActiveSchedules()` (`schedule-run-dao.ts:178-191`), which counts DISTINCT `schedule_id` with active `schedule_executions`. If N children are N distinct child **schedules**, they compete for the same 3-slot global cap and N−3 will be skipped/queued. If children are N `schedule_executions` under one parent `schedule_id`, they are blocked outright by (4).
4. **Partial UNIQUE index** `idx_sched_execs_unique_active ON schedule_executions(schedule_id) WHERE status IN ('triggered','running')` (`schema.sql:565`). **One active `schedule_execution` per `schedule_id`** — so N parallel children **cannot** share a parent `schedule_id`. Fan-out must create N distinct child **schedule** rows (each its own `schedule_id`), not N child `schedule_executions` under one schedule. This is the hard shared-state blocker for "N child executions under one composite task" if "one composite task" = one `schedule_id`.

**Conclusion for Q2:** `createFromSpec` itself admits N independent calls with no internal shared state. The blockers are environmental: (a) naming/branch uniqueness (easy), (b) synchronous git I/O (performance, not correctness), (c) the global concurrency cap, and (d) the per-`schedule_id` unique-active index — which forces a fan-out to model each subunit as its own child **schedule**, not a child execution of one schedule.

### 3. Gap from "sequential chain" to "DAG/parallel + integration" at the scheduler layer (option A in `decisions/05`)

Current chain is bounded in five ways; each is a gap option A must close:

1. **Topology is a flat array, not a DAG.** `workflow_chain` is `z.array(workflowChainItemSchema).min(1).max(20)` (`shared/src/types/scheduler-job.ts:67`); `createFromSpec` stores `slice(1)` as the remaining chain (`workspace.ts:365`); `resolveNextChainStep` indexes it by `child_index` (`workflow-executor.ts:432-435`). There are no edges, no parallel branches, no join. A DAG needs an explicit `composition_plan` (edges/dependencies) — new config shape, new resolver.
2. **Single workspace.** `execute()` calls `createFromSpec` exactly once (`workflow-executor.ts:140-149`); `triggerChildStep` reuses `wsRow.workspace_id` for every child (`:460-463`). Fan-out needs N `createFromSpec` calls — `execute()` has no loop for this today.
3. **Strictly sequential dispatch.** `handleChainComplete` → `resolveNextChainStep` returns exactly one next step or null (`:423-439`); `triggerChildStep` runs it; the child's `onComplete` re-enters `handleChainComplete` (`:495-499`). There is no mechanism to dispatch sibling children concurrently and no barrier/join. Parallel + integration needs N concurrent child dispatches + a wait-all/wait-any barrier before the integration step.
4. **No integration/merge primitive at the scheduler layer.** Finalization happens on single-chain exhaustion (`:351-371`). There is no merge/swarm-moa equivalent in the scheduler; the engine has `swarm.ts` / `moa` (CLAUDE.md lists swarm submodes). Option A would have to re-implement DAG + Loop + Swarm + aggregation in the scheduler — the DRY-violation callout in `decisions/05` (A's "缺点").
5. **No parent/child schedule relation.** `schedule_executions` has no `parent_id`/`child_index` (§0). The scheduler cannot today express "child execution of schedule X". Option A needs a new parent/child relation on `schedule_executions` (or a child-schedule table) AND must contend with the unique-active index (`schema.sql:565`) that forbids multiple active children under one `schedule_id`.

Additionally the concurrency model is per-`schedule_id`, not per-parent-composite-task: `countDistinctActiveSchedules` and `MAX_PARALLEL_WORKSPACES` (`schedule-run-dao.ts:178-191`) have no notion of "N children count as 1 parent slot". Option A must redefine the cap or risk children saturating the global pool.

### 4. NEW `task_dispatch` node vs reusing `sub_workflow`

**`sub_workflow` is structurally same-workspace-only — confirmed, cannot be the carrier.**

`SubWorkflowExecutor` (`packages/engine/src/executors/sub-workflow.ts`):
- Constructed with `cwd: this.ctx.cwd` and `workflowResolver: this.ctx.workflowResolver` (`executor-factory.ts:259,269`) — both scoped to the **current workspace**.
- `execute()` resolves the child workflow via `this.config.workflowResolver(workflowName)` (`sub-workflow.ts:65`) — the same-workspace resolver; builds a child `VarPool` in-process (`:96`); constructs a `WorkflowEngine` with `this.config.cwd` as both `cwd` and `orgDir` (`:161-176`); runs inline (or "linked" = a child `executions` row, still same workspace, `:80-93`).
- It has **no access to `WorkspaceService` or `ScheduleConfigDAO`** — it cannot `createFromSpec` or insert a child schedule. It can only run a YAML that already exists in the current workspace.

So `sub_workflow` runs a child workflow **in the same workspace, in-process**. Composite multi-workspace fan-out is out of reach. Exclusion in `decisions/05` is correct.

**A NEW `task_dispatch` (a.k.a. `workspace_dispatch`) node requires:**

1. **New node type + executor.** Register a `case "task_dispatch"` in `executor-factory.ts` (alongside `sub_workflow` at `:253` and `dynamic_sub_workflow` at `:273`).
2. **An injected scheduler-dispatch port — engine cannot import server.** `packages/engine/package.json` depends only on `@octopus/shared` and `@octopus/providers` (verified — no `@octopus/server`). Engine already cannot import `WorkspaceService`/`ScheduleConfigDAO`. The established pattern is injection: `executor-config.ts:146` comment "The ExecutorFactory should inject this from the server's SessionService"; `octopus-agent/session.ts:23` "The engine injects this via OctopusAgentConfig to decouple from server package." So `task_dispatch` needs a new injected interface, e.g.:
   ```
   TaskDispatchPort {
     createChildWorkspace(spec: WorkspaceSpec, vars): WorkspaceHandle      // → WorkspaceService.createFromSpec
     dispatchChildWorkflow(handle, workflow_ref, input_values): ChildExecHandle
     awaitChild(handle): ChildResult                                         // blocks until child chain completes
   }
   ```
   implemented server-side and wired through `ExecutorFactory` ctx.
3. **Per-node WorkspaceSpec + workflow_ref + vars + skills declaration.** A node schema so each `task_dispatch` node occurrence declares one subunit; Loop over the node = N children with var-sets (engine `loop.ts` already iterates). The node crosses the engine→server boundary via the port, not by direct import.
4. **A sync-await bridge from engine node to scheduler child-completion.** Engine node executors are async (`NodeExecutor.execute(): Promise<NodeExecutionResult>`). Today the scheduler's `handleChainComplete` is fire-and-forget via `registerExternalCallbacks` (`workflow-executor.ts:233-247`); there is no path for an engine node to `await` a child schedule's chain completion. The port's `awaitChild` must block the node until the child `schedule_execution` reaches a terminal status — new plumbing (a promise that resolves on the child's `handleChainComplete`).
5. **Integration node at the end** — reuse existing engine `swarm` / `swarm-moa` (`packages/engine/src/executors/swarm.ts`) as the merge step. This is "free" in option B and is the core DRY argument for B over A.

**Difference from `sub_workflow`:** `task_dispatch` (a) crosses the engine→server boundary via a new injected port; (b) creates a **new workspace** per child via `createFromSpec`; (c) dispatches a **child schedule** (independent lifecycle, its own `schedule_id`/`schedule_executions`) rather than an in-process child workflow; (d) must block on child completion across the boundary. `sub_workflow` stays in-process, same-workspace, no port, no new workspace.

**Net:** Option B (`task_dispatch`) is feasible via the repo's existing injection pattern, but is not a trivial node — it requires a new injected `TaskDispatchPort`, a cross-boundary await bridge, a node schema for per-subunit `WorkspaceSpec`+`workflow_ref`+`vars`, and careful handling of the global concurrency cap + unique-active index (each child must be its own `schedule_id`). `sub_workflow` cannot serve this role; reusing it is a dead end for multi-workspace fan-out.

### Evidence index (file:line)

- `packages/server/src/db/schema.sql:32-33` — `executions.parent_id`/`child_index` (engine layer)
- `packages/server/src/db/schema.sql:299-324` — `schedule_executions` DDL (no parent_id/child_index)
- `packages/server/src/db/schema.sql:565` — `idx_sched_execs_unique_active` (one active per schedule_id)
- `packages/shared/src/types/scheduler-job.ts:33-69` — `WorkspaceSpec`, `WorkflowChainItem`, `WorkflowConfig` schemas
- `packages/server/src/services/workspace.ts:315-387` — `createFromSpec` (single-call behavior)
- `packages/server/src/services/workspace.ts:329-332,365,384` — name-keyed dir, slice(1) chain, git init
- `packages/server/src/services/workspace-git.ts:99-166` — `initWorktreesFromSpec` (spawnSync per project, branch name)
- `packages/server/src/services/scheduler/executors/workflow-executor.ts:67-313` — `execute()` (createFromSpec once)
- `packages/server/src/services/scheduler/executors/workflow-executor.ts:140-149,233-247,266` — root dispatch
- `packages/server/src/services/scheduler/executors/workflow-executor.ts:317-413` — `handleChainComplete`
- `packages/server/src/services/scheduler/executors/workflow-executor.ts:423-439,446-510` — `resolveNextChainStep` / `triggerChildStep` (same-ws child)
- `packages/server/src/services/scheduler/scheduler-engine.ts:23-26,416-454` — concurrency cap + `checkQueuedTasks`
- `packages/server/src/db/dao/schedule-run-dao.ts:178-191` — `countDistinctActiveSchedules`
- `packages/engine/src/executors/sub-workflow.ts:65,96,161-176` — same-workspace child workflow
- `packages/engine/src/executor-factory.ts:253-274` — sub_workflow / dynamic_sub_workflow construction + injection pattern
- `packages/engine/src/executors/executor-config.ts:146` — "inject from server's SessionService" (injection convention)
- `packages/engine/package.json` — engine deps: only `@octopus/shared` + `@octopus/providers` (no server)
- `.scratch/task-pool-redesign/decisions/05-grilling-composition-layer.md` — option A/B/C framing
