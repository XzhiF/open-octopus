# 04 — server composite dispatch（coordinator-ws + N 子 schedule + 聚合）

## What to build
composite 任务 dispatch：coordinator-ws（createFromSpec 无 projects）run composition wf → task_dispatch fan-out N 子 schedule（各 createFromSpec 独立 ws + sub-workflow_ref，vars/skills 各自）→ engine DAG/Loop 编排 → 末尾 swarm/moa 聚合节点（读 $taskDispatchId.output，integration_goal 驱动 synthesis/merge）。父 schedule 聚合状态：任一子 running→父 running；全 done+聚合→父 done；任一子 failed→父 failed。

## Blocked by
03

## Status
done

## Acceptance Criteria
- [ ] composite dispatch → coordinator-ws + N 独立子 ws + 聚合节点
- [ ] 父卡聚合状态正确（running/done/failed）
- [ ] 同 wf 不同 vars = Loop over var-sets（D7）
- [ ] 聚合节点收到各子 output

## Verification Method
**Type**: integration
**Steps**: composite config（3 subunits，integration_goal=synthesis）→ dispatch → mock 子完成 → assert DAG 顺序 + 聚合 output + 父 status=done；一子失败 → assert 父 failed。
**Pass**: assert PASS。**Fail**: max 3 then SKIP。

## Exploration

### Analog studied
The closest analog is the existing **simple workflow dispatch** path in `workflow-executor.ts:execute()` (createFromSpec → trigger first workflow_chain step → handleChainComplete finalizes schedule status). The G2 failed-writer test (`scheduler-executors.test.ts:162-268`) is the test-pattern precedent: in-memory DB + `applySchema`, seed schedule/executions, call private `handleChainComplete` directly, assert `schedules.status`.

### Files needing modification (all in scope)
- `packages/server/src/services/scheduler/executors/workflow-executor.ts` — composite branch in `execute()` (coordinator-ws with NO projects + composition-task workflow_ref + subunits as input_values) + parent-aggregation in `handleChainComplete` done path (failed-child check).
- `packages/server/src/db/dao/schedule-config-dao.ts` — add `findFailedChildSchedules(parentExecutionId)` read method (json_extract on `config->parent_task_dispatch.execution_id`). Read-only, shared infra (05 added writers here; this is the symmetric reader).

### Specific functions chosen
- `WorkflowExecutor.execute()` — branch after config parse: `isCompositeTask(config)` → coordinator path (createFromSpec `projects: []`, input_values carry `subunits`/`subunit_count`/`goal`/`integration_prompt`). Reuses the SAME handleChainComplete onComplete callback (composition wf completion = parent completion).
- `WorkspaceService.createFromSpec` (`workspace.ts:315`) — called with `projects: []` for the coordinator. Verified `initWorktreesFromSpec` (`workspace-git.ts:150`) iterates `for (const proj of projects)` → empty array is a no-op (no worktrees, no throw). Confirms spec D4 "coordinator-ws createFromSpec 无 projects" works at runtime.
- `ExecutionService.create` (`execution.ts:112`) — accepts `input_values?: Record<string, unknown>` (NOT string-only at runtime), so the subunits array is passed as a real object, not JSON-serialized. The composition wf's Loop consumes `$iteration.subunit` (engine gap — see Flag).
- `TaskDispatchService` (03, `task-dispatch-service.ts`) — already creates distinct child schedule_id + `parent_task_dispatch` marker + child-complete → resume parent. NOT modified (03 owns it). Reused as-is.
- `handleChainComplete` done path (`workflow-executor.ts:355-364`) — existing writer sets `status='done'`. Ticket 04 adds: if composite, query `findFailedChildSchedules(opts.executionId)`; any failed child → `status='failed'` (propagate). Failure path (372-401, 05's writer) already sets `failed` for composition-wf-level failure — unchanged.

### Concurrency
MAX_PARALLEL_WORKSPACES cap is enforced inside `TaskDispatchService.dispatchChildSchedule` (03, `task-dispatch-service.ts:104`): over cap → child created `queued`, parent stays paused (`pending_task_dispatch`). Scheduler-engine's `checkQueuedTasks` claims queued children later. No new concurrency logic in ticket 04 — 03 owns the port.

### Flag (engine gap, NOT in scope)
`LoopExecutor.createExecutor` (`engine/src/executors/loop.ts:475-632`) has NO `task_dispatch` case (default throws `Unknown node type`), and does not populate `loopContext.subunit` from the subunits array — so the real `composition-task.yaml` (Loop over task_dispatch inner nodes) cannot yet run end-to-end through the engine. This is a 02/engine responsibility. Ticket 04 wires the SERVER runtime dispatch + parent aggregation correctly per spec D4/G10; the integration test mocks `getExecutionService` so it verifies server logic without depending on the engine gap. Production end-to-end composition-wf execution requires 02 to add the `task_dispatch` case to `LoopExecutor.createExecutor` + `$iteration.subunit` population.
