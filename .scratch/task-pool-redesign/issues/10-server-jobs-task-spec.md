# 10 — POST/PUT /jobs task_spec + JobDetail + task_spec→WorkflowConfig 物化

## What to build
server：`CreateJobInput` + `createJobSchema`（scheduler-service.ts:72-97）加 `task_spec`/`project_ids`/`skills`；`PUT /jobs/:id` 编辑 task_spec（If-Match 乐观锁）；`GET /jobs/:id` JobDetail 含 `children[]`+`dag`（composite）。**task_spec→WorkflowConfig 物化**（G9）：enqueue/build 把 task_spec 转 executor 读的 WorkflowConfig（简单=workflow_chain 单项；复合=workflow_ref 指向 composition wf）。

## Blocked by
01, 04

## Status
ready-for-agent

## Acceptance Criteria
- [ ] POST /jobs 带 task_spec → draft（config v3.0）
- [ ] PUT /jobs/:id 编辑 task_spec（If-Match）
- [ ] GET /jobs/:id composite 返回 children[]+dag
- [ ] enqueue 把 task_spec 物化为 WorkflowConfig（executor 读到 workflow_chain）

## Verification Method
**Type**: integration
**Steps**: POST /jobs（task_spec）→ SELECT config 含 task_spec；PUT 编辑 → assert 更新；GET /jobs/:id composite → assert children[]+dag；enqueue → SELECT config.workflow_chain 已物化。
**Pass**: assert PASS。**Fail**: max 3 then SKIP。
