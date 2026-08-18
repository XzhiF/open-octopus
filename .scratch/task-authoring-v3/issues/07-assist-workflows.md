# 07 — core-pack 内置辅助工作流 ×3 + AssistWorkflowService + routes

## What to build
编写期辅助工作流全链路（US9/10/11）：3 个内置 YAML（moa-requirements-review / spec-review-swarm / clarify-debate，复用 swarm executor mode=moa/review/debate）；AssistWorkflowService 以**临时 workspace**（workspaces.source='task-assist'，workspacePath=任务家目录，D16）为执行宿主触发运行；触发/查询路由返回状态、过程日志、结构化产出（聚合 JSON 解析失败 → output_raw + output_parse_error 兜底）。

## Blocked by
02 — TaskHomeService（workspacePath = 家目录）

## Status
done

## Acceptance Criteria
- [x] AC1: `core-pack/workflows/` 新增 3 个 YAML：moa（≥2 experts + aggregator，聚合器 prompt 要求输出 `{ac_candidates[], suggestions[], risks[]}` JSON）、swarm review、debate clarify；各配 `.test.yaml` 最小场景（沿用 composition-task.test.yaml 模式）
- [x] AC2: workspaces 表 source 枚举增 `'task-assist'`；AssistWorkflowService.trigger(taskId, template) 建临时 workspace 行 + 经 ExecutionService 启动执行；task_id+template 记入 executions.pipeline_config
- [x] AC3: POST /api/tasks/:id/assist-workflows `{template}` → 200 `{run_id, execution_id, workspace_id}`；非 3 个白名单 template → 400
- [x] AC4: GET .../assist-workflows/:runId → `{status, logs[{t,icon,text}], output?}`；logs 来自 execution 节点日志（含各专家启动/完成行）；运行完成后 output 为解析后的三段式结构
- [x] AC5: 聚合器输出非法 JSON → `output_raw` 保留原文 + `output_parse_error: true`，不抛错（SW-BP10）
- [x] AC6: run 终态（done/failed）后临时 workspace 行 reap（家目录保留）
- [x] AC7: input 注入：task_spec 的 goal/ac/projects 经 `$vars` 进入工作流输入

## Verification Method
**Verification type**: integration test（真 DB + 真 engine，simulator 或最小 LLM 配置）

**Verification steps**:
```bash
cd packages/server && pnpm vitest run src/__tests__/tasks-v3-assist.test.ts
cd packages/engine && pnpm vitest run src/executors/__tests__/  # 回归：swarm moa 不受影响
```
触发合法模板 → SELECT executions 按 task_id（pipeline_config LIKE）可解析 ∧ workspaces 行 source='task-assist'；非法模板 → 400；mock 聚合输出合法 JSON → output 三段式断言；注入 `{broken` → output_parse_error=true ∧ output_raw 非空；run 完成后 workspace 行消失。LLM 真跑路径走 `.test.yaml` simulator 场景（E2E 阶段再真跑最小配置）。

**Pass criteria**: All verification steps PASS
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason

## Exploration

### Analog studied
`WorkflowExecutor` (scheduler/executors/workflow-executor.ts) — closest "trigger a workflow execution against a fresh workspace" path. Traced: create workspace (WorkspaceService.createFromSpec / WorkspaceDAO.insert) → `getExecutionService(ws.id)` → `service.create(ws.id, { workflow_ref, input_values, triggered_by, initial_var_pool })` → `service.registerExternalCallbacks({ onComplete })` → `service.start(execId, inputValues)` fire-and-forget. Also studied `composite-dispatch.test.ts` + `tasks-v3-dispatch.test.ts` — both mock `getExecutionService` so create/start/registerExternalCallbacks are spies (the engine doesn't really run); this is the testable seam for the trigger path.

### Files to modify/create
- NEW `packages/core-pack/workflows/moa-requirements-review.yaml` + `.test.yaml`
- NEW `packages/core-pack/workflows/spec-review-swarm.yaml` + `.test.yaml`
- NEW `packages/core-pack/workflows/clarify-debate.yaml` + `.test.yaml`
- NEW `packages/server/src/services/tasks/assist-workflow-service.ts` — AssistWorkflowService (trigger + getRun + output parsing + log reading + workspace reap)
- MODIFIED `packages/server/src/routes/tasks.ts` — POST /:id/assist-workflows + GET /:id/assist-workflows/:runId (registered before /:id to avoid shadow; actually after /:id spec-field/ready since they're literal sub-paths — Hono matches /:id/assist-workflows fine as it's more specific than /:id only when registered in order; will register assist-workflows routes before the bare /:id GET to be safe, mirroring how /events is registered first)
- MODIFIED `packages/server/src/index.ts` — construct AssistWorkflowService + pass to createTasksRoutes

### Functions chosen
- `getExecutionService(workspaceId)` from `execution-service-registry.ts` — to obtain an ExecutionService bound to the temp workspace. DO NOT construct `new ExecutionService(...)` directly (registry caches + wires knowledge/repair services).
- `ExecutionService.create()` + `ExecutionService.start()` + `ExecutionService.registerExternalCallbacks()` — the trigger triplet (mirrors WorkflowExecutor lines 266/295/339).
- `ExecutionDAO.updateExecution(id, { pipeline_config })` — pipeline_config is in the allowed set (line 72); create() does NOT set it, so a follow-up updateExecution records `{task_id, template}` (AC2).
- `ExecutionDAO.findById()` + `findNodeOutputs(executionId, nodeId)` — for getRun: status from exec row, aggregator synthesis from swarm node outputs.
- `WorkspaceDAO.insert({ source: 'task-assist', ... })` — temp workspace row. `source` is free-form TEXT (schema.sql line 23), no enum constraint to alter; just pass the string.
- `TaskDAO.getById()` — to read task.org + task_spec for input injection (AC7) without coupling to TasksService.
- `TaskHomeService.homePath()` — workspacePath for the temp workspace (D16: workspacePath = 任务家目录).
- `assistWorkflowOutputSchema` (shared, ticket 01) — parse the aggregator synthesis JSON into {ac_candidates, suggestions, risks}; on parse failure fall back to `output_raw` + `output_parse_error` (SW-BP10).
- JSONL log reading: entries `{timestamp, nodeId, event, ...data}` at `{home}/logs/{executionId}/{nodeId}.jsonl` (mirrors `ExecutionQueryService.getAgentEvents`); mapped to `{t, icon, text}`.

### run_id ↔ execution_id mapping
No new table (spec: no DB schema change). `run_id === execution_id`. GET /:runId resolves runId as execution_id, validates `pipeline_config.task_id === :id`, returns run shape. Finding runs by task = `SELECT executions WHERE pipeline_config LIKE '%"task_id":"<id>"%'` (AC verification).

### Out of lane (not touched)
- scheduler-service.ts input_mapping (ticket 08)
- plugin-materializer + getPlugins task extension (ticket 03)
- shared types (ticket 01, DONE) — assistWorkflowRunSchema/assistWorkflowOutputSchema already exist; ASSIST_RUN_UPDATE_EVENT const defined locally in the service file, not added to shared
