# 05 — server: spec-field tool + reverse context msg（SPIKE S1 gated）

## What to build
`update_task_spec_field` 工具 handler（agent 调 `{task_id,field,value}`→tasks DAO 局部合并 task_spec/resources/authoring_resources→emit spec_field_update SSE）。field∈{projects,skills,goal,ac,subunits,integration_goal,resources,authoring_resources}。冲突 stale version→409→agent re-GET+retry。反向 context msg：[保存草稿]后注入 `@@spec_updated` 到 task-author session（机制=prepend 到下条 user msg，**SPIKE S1 验证**；不可行→回退 agent 工具 re-GET，回来 persuade 改 v2-D7）。

## Blocked by
03 (tasks service)

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: update_task_spec_field 写 tasks 字段 + emit spec_field_update SSE
- [ ] AC2: stale version→409
- [ ] AC3: [保存草稿]→`CloneRuntime.chat` `specUpdateNotice?` 参→system-prompt append（SPIKE S1 验，v2-D7 PUSH；非 prepend-to-user-msg）

## Verification Method
**integration**: curl POST /spec-field → DB 断字段+SSE 收到；stale version→409；[保存]→session 含 @@spec_updated（或回退机制可验证）。Pass: 字段+SSE+409+反向可达。
**SPIKE S1 — RESOLVED**：机制=system-prompt append（`CloneRuntime.chat` 加 `specUpdateNotice?` 参→`sendWithProvider.append` concat，clone-runtime.ts:310-329；`assembleContext` 每 turn fresh :261）；非 prepend-to-user-msg（避免 DB 污染）；v2-D7 保持 PUSH。
