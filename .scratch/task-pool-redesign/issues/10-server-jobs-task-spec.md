# 10 — POST/PUT /jobs task_spec + JobDetail + task_spec→WorkflowConfig 物化

## What to build
server：`CreateJobInput` + `createJobSchema`（scheduler-service.ts:72-97）加 `task_spec`/`project_ids`/`skills`；`PUT /jobs/:id` 编辑 task_spec（If-Match 乐观锁）；`GET /jobs/:id` JobDetail 含 `children[]`+`dag`（composite）。**task_spec→WorkflowConfig 物化**（G9）：enqueue/build 把 task_spec 转 executor 读的 WorkflowConfig（简单=workflow_chain 单项；复合=workflow_ref 指向 composition wf）。

## Blocked by
01, 04

## Status
done

## Acceptance Criteria
- [x] POST /jobs 带 task_spec → draft（config v3.0）
- [x] PUT /jobs/:id 编辑 task_spec（If-Match）
- [x] GET /jobs/:id composite 返回 children[]+dag
- [x] enqueue 把 task_spec 物化为 WorkflowConfig（executor 读到 workflow_chain）

## Verification Method
**Type**: integration
**Steps**: POST /jobs（task_spec）→ SELECT config 含 task_spec；PUT 编辑 → assert 更新；GET /jobs/:id composite → assert children[]+dag；enqueue → SELECT config.workflow_chain 已物化。
**Pass**: assert PASS。**Fail**: max 3 then SKIP。

## Exploration

**Analog studied:** existing `createJob`/`updateJob`/`getJob`/`enqueueJob` in scheduler-service.ts; ticket 04's composite dispatch (workflow-executor.ts `isCompositeTask`/`buildCompositeInputValues`/`findFailedChildSchedules`); ticket 01's shared types (`taskSpecSchema`, `subunitSpecSchema`, `workflowConfigSchema` v3.0 with `task_spec?`, `SubunitSpec.skills`, `IntegrationGoal`).

**Files needing modification:**
1. `packages/server/src/services/scheduler/scheduler-service.ts` — add task_spec/project_ids/skills/workflow_ref to `createJobSchema` + `updateJobSchema`; add `materializeTaskSpec` helper; add `JobDetail` type + composite children/dag in `getJob`.
2. `packages/server/src/db/dao/schedule-config-dao.ts` — add `findChildSchedules(parentExecutionId)` (mirrors existing `findFailedChildSchedules` but returns ALL children by `parent_task_dispatch.execution_id` marker, not just failed).
3. `packages/server/src/routes/scheduler.ts` — no logic change needed (already delegates to service); GET /jobs/:id returns JobDetail from service as-is.

**Functions chosen:**
- `validateConfig(jobType, config)` (config-validator.ts) — re-use to validate the materialized WorkflowConfig. Zod strips unknown keys, so `skills` re-attached post-validation before JSON.stringify.
- `findFailedChildSchedules(parentExecutionId)` (schedule-config-dao.ts:30) — exists; sibling `findChildSchedules` added for all-status child lookup.
- `runDAO.listExecutions(scheduleId)` → `ScheduleExecutionRow.execution_id` — the composition-wf execution_id that child configs' `parent_task_dispatch.execution_id` points at. For draft composites: no executions → children=[].

**Materialization decision (G9):** materialize at `createJob` (POST /jobs path) per ticket text — build full v3.0 WorkflowConfig from task_spec+project_ids+workflow_ref. Simple: `workflow_chain=[{workflow_ref, input_values:{}}]`; composite: `workflow_chain=[{workflow_ref:'composition-task', input_values:{}}]` + task_spec.subunits (executor reads via buildCompositeInputValues). Re-materialize on PUT. Enqueue confirms end-state (workflow_chain already present).

**JobDetail shape:** extends SchedulerJob with optional `children[]` (child schedule summaries from DB via parent_task_dispatch marker) + `dag` (derived from task_spec.subunits + integration_goal). Returned for composite tasks; undefined for simple.
