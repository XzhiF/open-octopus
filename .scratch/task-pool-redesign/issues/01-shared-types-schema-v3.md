# 01 — shared 类型 + schema v3.0

## What to build
shared 包加全部新类型与 schema：`TaskSpec`、`SubunitSpec`、`ScheduleStatus` 加 `failed`/`aborted`、`task_dispatch` NodeDef type + 字段（subunit/workflow_ref/input_mapping/output_mapping/await）、`TaskDispatchPort` interface（dispatchChildSchedule→ScheduleHandle；resumeOnCompletion）、`workflowConfigSchema` v3.0（加可选 task_spec，v2.0 兼容：无 task_spec=简单 workflow_chain 任务）、`projectSpecSchema` source_path 注释修正（删谎话）+ group 读取或删。

## Blocked by
None

## Status
done

## Acceptance Criteria
- [x] Zod workflowConfigSchema v3.0 parse 含 task_spec 的 config 通过
- [x] ScheduleStatus 类型含 failed/aborted
- [x] task_dispatch 在 NodeDef.type union + NodeSchema enum
- [x] TaskDispatchPort interface 定义（engine 仅依赖 shared+providers）
- [x] v2.0 config（无 task_spec）仍兼容
- [x] projectSpecSchema source_path 注释与代码一致

## Verification Method
**Type**: unit + contract
**Steps**: `pnpm --filter @octopus/shared test`（Zod schema tests）；`pnpm build`（tsc 跨 shared/engine/server/web-app 一致）。
**Pass**: tests PASS + build 绿。**Fail**: max 3 attempts then SKIP。

## Exploration

### Analog studied
- Zod schema + derived-type pattern: `packages/shared/src/types/scheduler-job.ts` (`workflowConfigSchema`/`WorkflowConfig`, `workflowChainItemSchema`, `projectSpecSchema`, `workspaceSpecSchema`).
- Zod lazy node schema + discriminated union: `packages/shared/src/types/workflow.ts` (`NodeDef` interface, `NodeSchema`, `WorkflowSchema`).
- Test conventions: `packages/shared/src/__tests__/workspace-schemas.test.ts` + `status-schemas.test.ts` (`safeParse` + `expectTypeOf` patterns).

### Files needing modification (ticket 01 scope only — shared package)
- `packages/shared/src/types/scheduler-job.ts` — ScheduleStatus (+failed/aborted); add `integrationGoalSchema`/`subunitSpecSchema`/`taskSpecSchema`; bump `workflowConfigSchema` to accept v3.0 + optional `task_spec`; fix `projectSpecSchema` source_path comment (honest: server-side `initWorktreesFromSpec` resolves via repos/index.md by `group`); retain `group`.
- `packages/shared/src/types/workflow.ts` — add `"task_dispatch"` to `NodeDef.type` union + `NodeSchema` z.enum; add task_dispatch fields (`subunit?`, `workflow_ref?`, `await?`). `input_mapping`/`output_mapping` already exist on NodeDef — reused, NOT re-declared.
- `packages/shared/src/types/task-dispatch-port.ts` (NEW) — `ScheduleHandle` + `TaskDispatchPort` interface (engine→scheduler boundary; impl is server's job, injected via `ExecutorFactoryContext` per `createSessionFn` precedent at `executor-config.ts:147`).
- `packages/shared/src/index.ts` — export new types/schemas.

### Functions/symbols chosen
- `WorkflowRef.zodSchema()` — for `subunitSpecSchema.workflow_ref` (same precedent as `workflowChainItemSchema`).
- `workspaceSpecSchema` — reused for `subunitSpecSchema.workspace_spec` (single source of truth for WorkspaceSpec).
- `z.enum(['2.0','3.0'])` for `schema_version` (NOT `z.literal('3.0')`) — keeps v2.0 fallback configs in `scheduler-engine.ts:625` + `scheduler-service.ts:808` type-safe (`'2.0'` stays assignable to `WorkflowConfig.schema_version`), satisfying "tsc green across all packages" + AC5 (v2.0 compat).
- `executor-factory.ts` switch has a non-exhaustive `default: throw` (line 342) → adding `task_dispatch` to the union does NOT break the build (falls to default at runtime; executor is a later ticket).

### Out of scope (later tickets)
- `TaskDispatchExecutor`/`TaskDispatchConfig` (engine ticket), `TaskDispatchPort` impl + abort/SSE/source_path (server ticket), CloneDef `task-author` builtin (server/core-pack), web-app board.
