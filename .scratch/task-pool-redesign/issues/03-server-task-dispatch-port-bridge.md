# 03 — server TaskDispatchPort impl + 跨边界 pause-resume 桥

## What to build
server：TaskDispatchPort 具体 impl，注入 ExecutorFactoryContext（createSessionFn 先例，executor-config.ts:147）。`dispatchChildSchedule(subunit)` → 创建子 schedule（distinct schedule_id 避 idx_sched_execs_unique_active）+ createFromSpec 独立 ws + 跑 sub-workflow_ref。子 schedule 完成（handleChainComplete 或新 child-complete 回调）→ resume 父 task_dispatch 节点 + 传 output_mapping。concurrency cap（MAX_PARALLEL_WORKSPACES）在 port 层处理。

## Blocked by
02

## Status
done

## Acceptance Criteria
- [x] port.dispatchChildSchedule 创建独立子 schedule + ws（不撞 unique_active）
- [x] 子完成 → resume 父节点 + output 流入
- [x] 并发超 cap → 子 schedule 排队（不 fatal）
- [x] 无 in-memory Promise 泄漏（pause-resume 持久化，进程重启可恢复）

## Verification Method
**Type**: integration
**Steps**: composition wf 含 1 task_dispatch → mock 子 schedule 立即完成 → assert 父 resume + 下游聚合节点收到 $taskDispatchId.output；模拟进程重启 → assert 恢复。
**Pass**: assert PASS。**Fail**: max 3 then SKIP。

**Result**: PASS.
- Engine bridge (G1 core): `packages/engine/src/__tests__/task-dispatch-bridge.test.ts` — 3 tests pass (pause → resume → downstream `$dispatch.output.synthesis` flows; simulated process restart recovers; no re-dispatch on resume).
- Server port correlation: `packages/server/src/__tests__/task-dispatch-service.test.ts` — 5 tests pass (distinct child schedule + parent_task_dispatch marker; restart-safe resume reads marker from DB; throws on missing marker / unwired callback).
- Gates: `pnpm --filter @octopus/engine test` (814 pass; 4 pre-existing failures confirmed on clean Stage-1, unrelated), `pnpm --filter @octopus/server test` (1467 pass; my 5 new tests pass; 44 failures pre-existing on clean Stage-1 / concurrent other-ticket edits, none from ticket 03), `pnpm build` exit 0.

## Exploration

### Analog studied
`pending_interaction` pause-resume (the closest cross-boundary pause precedent). Traced end-to-end:
- **Server trigger**: `ExecutionLifecycle.runInteractionCompleteInBackground` (~1036) calls `inst.engine.retryFrom(nodeId, { signal, interactionCompletion })`.
- **Engine resume**: `engine.ts` retryFrom 路径 A2 (~618-661) constructs `new InteractionExecutor(pauseNode, pool, { completionData, nodeOutputs, ... })` DIRECTLY (bypasses factory), calls `execute()`, stores result, fires `onNodeEnd`, then runs remaining nodes via `executeNodes`.
- **Engine pause checks**: sequential `executeNodesSequential` (~1330-1338) + parallel `executeNodesParallel` (~1710-1725) match `pending_approval`/`pending_interaction` → set `pendingApprovalNodeId`/`pendingInteractionNodeId` + return status.
- **Lifecycle pause handling** (~400-462): on `pending_interaction`, persists `var_pool`, finds paused node, emits SSE, removes from enginePool.
- **Restart**: `reconstructEngine` (~1542) rebuilds engine from `var_pool` snapshot + completed node rows; `findPausedNode` (NodeHelper:34) only finds status `"paused"` — approval/interaction rely on the execution row's `status` column, not node status, for restart detection.

### Files needing modification (all in ticket 03 scope)
- `packages/engine/src/engine.ts` — ExecutionResult status union (+`pending_task_dispatch`); two pause-check sites; retryFrom opts (+`taskDispatchChildOutput`) + 路径 A3; `setTaskDispatchPort` setter (mirrors `setVersionResolver` rebuild pattern, threads port into ExecutorFactoryContext at runtime so the FIRST dispatch has the port); `pendingTaskDispatchNodeId` field + `isPendingTaskDispatch` accessor.
- `packages/engine/src/executor-factory.ts` — NO change needed (Stage 1 already threads `taskDispatchPort`/`taskDispatchChildOutput` from context into `TaskDispatchConfig` at lines 258-267).
- `packages/server/src/services/execution/ExecutionLifecycle.ts` — add `pending_task_dispatch` branch in the run-completion handler (mirror pending_interaction: persist var_pool, find paused node, SSE, remove from pool); add `resumeTaskDispatch(executionId, nodeId, childOutput)` mirroring `completeInteraction`/`runInteractionCompleteInBackground` → `engine.retryFrom(nodeId, { taskDispatchChildOutput })`.
- `packages/server/src/services/scheduler/executors/workflow-executor.ts` — add `handleChildDispatchComplete` (distinct from `handleChainComplete`): when a child schedule dispatched by task_dispatch completes, derive child output + call `port.resumeOnCompletion(handle, output)`. Registered as the child execution's `onComplete` by the port (not the same-ws chain).
- `packages/server/src/services/scheduler/task-dispatch-service.ts` (NEW) — `TaskDispatchPort` impl: `dispatchChildSchedule(subunit)` → `configDAO.insertSchedule` (distinct schedule_id, sidesteps `idx_sched_execs_unique_active`) + `workspaceService.createFromSpec` + `runDAO.insertExecution` + register child-complete `onComplete` + start sub-workflow; concurrency cap via `countDistinctActiveSchedules` (at cap → schedule created `queued`, not fatal). `resumeOnCompletion(handle, output)` → look up parent composition execution paused on this child (child schedule `config.parent_task_dispatch = { executionId, nodeId }` marker) → `lifecycle.resumeTaskDispatch(parentExecId, nodeId, output)`.
- `packages/server/src/index.ts` + `EngineFactory.ts` — wire `TaskDispatchService` into `ExecutorFactoryContext` at boot (like `setKnowledgeService`): `EngineFactory.setTaskDispatchPort(port)` → `engine.setTaskDispatchPort(port)` in `createEngine`/`reconstructEngine`.

### Specific functions chosen
- **Resume entry (server)**: mirror `ExecutionLifecycle.runInteractionCompleteInBackground` (~1036) → call `inst.engine.retryFrom(nodeId, { taskDispatchChildOutput })`. Do NOT use `runInteractionCompleteInBackground` itself (wrong payload shape); add a sibling `resumeTaskDispatch`.
- **Resume entry (engine)**: mirror retryFrom 路径 A2 (construct executor directly with resume payload). Do NOT thread `taskDispatchChildOutput` through the shared factory context for the resume call — that would leak a one-shot payload into the singleton factory affecting other task_dispatch nodes. The factory-context threading (Stage 1, executor-config + factory case) remains for the port injection on the FIRST dispatch; resume uses direct construction exactly like interaction/approval.
- **Pause detection**: `pendingApprovalNodeId`/`pendingInteractionNodeId` precedent → add `pendingTaskDispatchNodeId`.
- **Port injection**: `setVersionResolver` rebuild-factory precedent (engine.ts:342-345) → add `setTaskDispatchPort` calling the same rebuild with `taskDispatchPort` set.
