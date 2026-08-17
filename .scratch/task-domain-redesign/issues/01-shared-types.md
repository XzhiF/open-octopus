# 01 — shared types: tasks/origin/spec-field/SSE schemas

## What to build
`@octopus/shared` 新增/扩展类型：`TaskStatus`(draft|ready|running|done|failed|aborted)、`OriginType`(cron|task|agent|manual|api)、`TaskSpec`(+resources[]+authoring_resources[])、`SubunitSpec`(+resources[])、`WorkflowConfig`(+requires?)、`TaskDispatchPort`(+origin_role param)、`spec_field_update` SSE payload、`update_task_spec_field` tool schema、`Task` row type、`ScheduleStatusListener` 接口。

## Blocked by
None — can start immediately.

## Status
done

## Verification Result
- **AC1 (TaskStatus + OriginType enums)**: PASS — `TaskStatusSchema` (6 values) + `OriginTypeSchema` (5 values) parse + type-level union assertions pass; v1 `'requirement'`/`'queued'`/`'claimed'` correctly rejected.
- **AC2 (TaskSpec/SubunitSpec/WorkflowConfig extensions)**: PASS — `resourceRefSchema` `{type,name}` with 4-type `taskResourceTypeSchema` (rejects clone/workflow); `SubunitSpec+resources`, `TaskSpec+resources+authoring_resources`, `WorkflowConfig+requires` (4 keys mirroring `WorkflowDef.requires`, no `clones`) all parse; defaults `[]` keep v1 data backward-compatible (v1 `task-pool-schema.test.ts` 26/26 still green).
- **AC3 (TaskDispatchPort +origin_role)**: PASS — `OriginRole = primary|coordinator|subunit`; `dispatchChildSchedule(subunit, origin_role)` required param; v1-style fewer-arg impl still assignable (backward-compat).
- **AC4 (spec_field_update SSE + update_task_spec_field tool)**: PASS — `SPEC_FIELD_UPDATE_EVENT`/`TASK_STATUS_EVENT`/`UPDATE_TASK_SPEC_FIELD_TOOL_NAME` constants; `specFieldUpdatePayloadSchema {task_id,field,value,version}` + `taskStatusSsePayloadSchema` + `updateTaskSpecFieldToolSchema {task_id,field,value}`; `TaskSpecField` covers 8 fields; value is `unknown` (per-field validation is server's job).
- **AC5 (Task row, no schedule pointers)**: PASS — `Task` interface has NO `schedule_id`/`execution_id`/`claimed_at` (S2, type-level `AssertAbsent` checks); has `task_spec`/`authoring_resources`/`resources`/`skills`/`project_ids`/`version`/`source_chat_session_id?`/`completed_at?`.
- **`ScheduleStatusListener` interface**: PASS — implementable port (server impl injected into SchedulerEngine, SG2).
- Test totals: 35 new (`task-domain-schema.test.ts`) + 26 v1 (`task-pool-schema.test.ts`) = 61 schema tests GREEN. Full shared suite: 799 passed, 4 failed — all 4 failures pre-existing/environmental (model-alias reads dev machine's `~/.octopus/models.yaml`; resource-clone-lifecycle hits agent-sandbox temp-dir path-traversal guard); zero import-intersection with my files.
- `pnpm tsc --noEmit` (shared): 0 new errors vs baseline (baseline 9 pre-existing errors unchanged; all in unrelated test files: cross-exec-resolver/hooks-schema/model-alias/resource-provisioner/task-pool-schema:29,35/yaml-parser).
- `pnpm build` (shared): ESM + CJS + DTS all success; all new symbols present in `dist/index.d.ts` public export list.

## Acceptance Criteria
- [ ] AC1: TaskStatus/OriginType enums 导出
- [ ] AC2: TaskSpec+resources/authoring_resources; SubunitSpec+resources; WorkflowConfig+requires (镜像 WorkflowDef.requires)
- [ ] AC3: TaskDispatchPort 加 origin_role param
- [ ] AC4: spec_field_update payload + update_task_spec_field tool schema 导出
- [ ] AC5: Task row type（无 schedule_id/execution_id，per S2）

## Verification Method
**unit test**: Zod schema parse round-trip；`pnpm test` shared 包。Pass: 全类型 parse+safeParse 通过。

## Exploration

### Analog studied
- `packages/shared/src/types/scheduler-job.ts` — v1 home of `TaskSpec`/`SubunitSpec`/`WorkflowConfig`/`ScheduleStatus`/`TriggerSource`/`SchedulerJob` row. v1 stored `task_spec` inside `schedules.config` (WorkflowConfig v3.0). Ticket says **extend** (not move) these schemas in place so v1 test `__tests__/task-pool-schema.test.ts` imports stay valid and existing parses remain backward-compatible (all new fields optional with defaults).
- `packages/shared/src/types/workflow.ts:509-516` — `WorkflowDef.requires` shape: `{skills?, agent_files?, commands?, rules?, clones?}`. Ticket AC2 explicitly lists `{skills, agent_files, commands, rules}` (4 keys, no `clones`) — mirror that exact subset. `clones` is omitted because task resources propagate to the 4 provisionable buckets only (clones are manual-install per ResourceProvisioner).
- `packages/shared/src/types/task-dispatch-port.ts` — `TaskDispatchPort`/`ScheduleHandle` engine↔server boundary interface pattern (interface in shared, impl in server, injected via context). `ScheduleStatusListener` follows the same port/adapter pattern.
- `packages/shared/src/resource/types.ts:5` + `resource-provisioner.ts:8` — `ResourceType = skill|agent|workflow|rule|command|clone` (registry); `ProvisionableType = agent|skill|command|rule` (4 provisionable). Task `resources[]`/`authoring_resources[]` entries `{type, name}` use the 4-type provisionable subset so they map 1:1 to `WorkflowConfig.requires` keys (skill→skills, agent→agent_files, command→commands, rule→rules) and align with `ResourceProvisioner.provision(missing: {type: ProvisionableType; name})`.
- `packages/server/src/services/sse.ts` + `routes/events.ts` — SSE uses generic `{event: string, data: unknown}`; `"taskpool"` channel already exists. `spec_field_update`/`task_status` are event-name strings + a `data` payload schema (no shared SSE envelope type exists today).

### Files needing modification (this ticket only)
- `packages/shared/src/types/scheduler-job.ts` — EXTEND: add `OriginType` enum (Zod+type, alongside `TriggerSource` which stays to avoid breaking server build — server ticket 02 removes usages); add `taskResourceTypeSchema`+`TaskResourceType`; add `resourceRefSchema`+`ResourceRef` (`{type,name}`); extend `subunitSpecSchema` +`resources`; extend `taskSpecSchema` +`resources`+`authoring_resources`; extend `workflowConfigSchema` +`requires?`.
- `packages/shared/src/types/task-dispatch-port.ts` — EXTEND: add `OriginRole` type (`primary|coordinator|subunit`); add `origin_role: OriginRole` required param to `TaskDispatchPort.dispatchChildSchedule`. (TS permits the v1 test impl `async dispatchChildSchedule(subunit)` to stay assignable — fewer-arg impls satisfy wider-arg interface.)
- `packages/shared/src/types/task.ts` — NEW: first-class task domain — `TaskStatus` enum, `Task` row interface (NO schedule_id/execution_id/claimed_at per S2), `TaskSpecField` union, `specFieldUpdatePayloadSchema`+`SpecFieldUpdatePayload`+`SPEC_FIELD_UPDATE_EVENT`, `taskStatusSsePayloadSchema`+`TaskStatusSsePayload`+`TASK_STATUS_EVENT`, `updateTaskSpecFieldToolSchema`+`UpdateTaskSpecFieldTool`+`UPDATE_TASK_SPEC_FIELD_TOOL_NAME`, `ScheduleStatusListener` interface.
- `packages/shared/src/index.ts` — add barrel `export * from "./types/task"`.
- `packages/shared/src/__tests__/task-domain-schema.test.ts` — NEW test file (Zod parse round-trip + type-level assertions for all new/extended schemas). v1 `task-pool-schema.test.ts` left untouched (new optional fields are backward-compatible).

### Specific functions/types chosen
- Use `z.enum([...])` + `z.infer<typeof X>` for all new enums (mirrors `ScheduleStatus`/`TriggerSource` style which are plain `type` aliases — but new v2 enums use Zod for parse validation per AC "Zod parse round-trip"). For `TaskStatus`/`OriginType`: define BOTH a Zod schema and a TS type (Zod is the source of truth, type via `z.infer`).
- Use `z.object({...}).default([])` / `.optional()` for new resource arrays so v1 data without these fields still parses (backward compat, no migration).
- `Task` row type: plain `interface` (not Zod) — mirrors `SchedulerJob`/`SchedulerExecutionSummary` which are hand-written interfaces (row types aren't parsed via Zod at row boundaries; they're DB-mapped). Includes `task_spec: TaskSpec`, `authoring_resources: ResourceRef[]`, `resources: ResourceRef[]`, `skills: string[]`, `project_ids: string[]`, `workflow_ref?: string`, `version: number`, `deleted_at`, timestamps, `completed_at?`, `source_chat_session_id?`. Explicitly NO `schedule_id`/`execution_id`/`claimed_at` (S2 — schedule link is via `schedules.origin_type='task' AND origin_id=task.id`).
- `ScheduleStatusListener`: interface mirroring `TaskDispatchPort` shape — `onScheduleTransition(scheduleId, originType, originId, status, summary?)` → server impl writes tasks.status + emits `task_status` SSE.

### Time budget
Within budget. Scope is pure type/schema additions — no behavior, no cross-package data flow. Max risk: v1 test backward-compat (mitigated by optional+default fields).
