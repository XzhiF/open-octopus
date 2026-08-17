# 08 — engine: orchestration-strategy seam + simple-direct-dispatch

## What to build
ADR-0009 hybrid 落地：`WorkflowExecutor.isCompositeTask`（:490-497, call :142）加 simple-direct-dispatch 路径——简单/1-subunit 跳 coordinator-ws 直分发（N+1→1）；复合 N≥2 建 coordinator-ws+composition-task.yaml。orchestration-strategy seam 接口（tasks↔scheduler 边界，未来 subunit 级重试/条件 DAG 增量入口）。复用 task_dispatch/WorkflowExecutor/SchedulerEngine 全生命周期基建（不改 runner 核心）。

## Blocked by
06 (schedules origin/materialize)

## Status
done

## Acceptance Criteria
- [x] AC1: 简单任务跳 coordinator-ws（1 schedule 直分发，无 coordinator 行）
- [x] AC2: 复合 N≥2 建 coordinator-ws + composition-task.yaml + N 子 task_dispatch
- [x] AC3: orchestration-strategy seam 接口定义（未来扩展点）

## Verification Method
**integration**: 简单 task dispatch→无 coordinator schedule；复合 3-subunit→coordinator+3 子 schedule。Pass: 简单 1 ws / 复合 1+N ws。

## Exploration

### Analog studied
ADR-0008 `task_dispatch` pipeline — the closest existing feature (composite orchestration via workflow layer). Traced data flow: `materializeTaskSpecToConfig` (scheduler-service, PRE-materialization decision) → schedules.config → runner claims → `WorkflowExecutor.execute` → `createFromSpec` (coordinator-ws vs real-ws via `isComposite` ternary) → composition-task.yaml Loop× task_dispatch → `TaskDispatchService.dispatchChildSchedule` (N child schedules + child workspaces).

### Files needing modification (boundary-respecting)
- **NEW** `packages/server/src/services/scheduler/orchestration-strategy.ts` — the ADR-0009 seam: `OrchestrationStrategy` interface + `DefaultOrchestrationStrategy` (delegates to existing logic, no behavior change) + shared constants (`COMPOSITION_WF_REF`, `COMPOSITE_SUBUNIT_THRESHOLD`) + pure `planOrchestration`/`isCompositeBySubunitCount` (single source of truth for the threshold).
- `packages/server/src/services/scheduler/executors/workflow-executor.ts` — simple-direct-dispatch path made explicit: import `COMPOSITION_WF_REF` from the seam (remove local duplicate at :26), add ADR-0009 N+1→1 comment on the `projects: isComposite ? [] : ...` decision (:175). Keep `isCompositeTask(config)` as the POST-materialization config-shape detector (different layer from the PRE-materialization seam — executor sees materialized config, not TaskSpec).
- `packages/server/src/services/scheduler/index.ts` — re-export the seam (SG16 precedent).
- **NEW** `packages/server/src/__tests__/orchestration-strategy.test.ts` — unit tests for the seam (pure decision: 0/1 subunits→simple, 2/3→composite; primaryOriginRole primary vs coordinator).
- **NEW** `packages/server/src/__tests__/workflow-executor-dispatch.test.ts` — integration tests: simple task→1 ws (real projects, NO coordinator projects=[]); composite 3-subunit→1 coordinator ws (projects=[] + composition-task wf + subunit_count=3 input_values).

### Specific functions chosen
- `isCompositeBySubunitCount(n)` (NEW, seam) — single source of truth for the SG9 threshold `n >= 2`. Chosen so `DefaultOrchestrationStrategy.planDispatch` (pre-materialization) + the existing `isCompositeTaskSpec`/`isCompositeTask` (06/scheduler-service, off-limits to edit) share ONE constant.
- `DefaultOrchestrationStrategy.planDispatch({taskSpec, workflowRef})` (NEW, seam) — pure decision → `{strategy, primaryOriginRole, compositionWorkflowRef, subunits, isComposite}`. NO I/O, NO DB — the dispatch seam (03/06/07, future) consumes this.
- `WorkflowExecutor.isCompositeTask(config)` (EXISTING, kept) — POST-materialization config-shape detector. NOT replaced by the seam (different layer). Only DRY'd: uses shared `COMPOSITION_WF_REF`.
- DO NOT touch `scheduler-service.ts:isCompositeTaskSpec`/`materializeTaskSpecToConfig` (06+07 boundary — 06 set the same `>=2` threshold there).

### Boundary confirmation
- 07 (scheduler-service materialize + engine-init): NOT touched. My seam is a NEW file; workflow-executor.ts only imports a constant + adds a comment.
- 09 (core-pack): NOT touched. `composition-task.yaml` stays as-is (referenced by name in the seam constant).
- 03 (routes/tasks): NOT touched. The dispatch seam (ready→running) is 03's; my seam is the strategy it WILL call, not the wiring.
