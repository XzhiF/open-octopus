# 10 — web-app: /tasks 看板 + TaskModal 联动 + 资源 picker

## What to build
`/tasks` 看板（tasks 状态列：draft/ready/running/done/failed/aborted；SG14 全量改读 Task 类型，弃 SchedulerJob）。TaskModal authoring：spec↔agent 联动（SpecPanel 订阅 spec_field_update SSE→实时刷新本地 state+version；[保存草稿]→PUT /tasks+反向通知 agent）；autosave row+title 显示；资源 picker（authoring_resources draft-scope / resources workspace-scope，SG13 SubunitsEditor 加 per-subunit resources picker）；[保存草稿]按钮；router.push 重指 /tasks/:id/children/:scheduleId（SG15）。订阅 /api/tasks/events SSE。

## Blocked by
03 (tasks service), 04 (autosave), 05 (spec-field), 07 (resource loading)

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: /tasks 看板显 tasks 状态列（不 join schedules 即可显 running/failed/aborted）
- [ ] AC2: agent update_task_spec_field→SpecPanel 经 SSE 实时刷新
- [ ] AC3: [保存草稿]→PUT+反向通知；autosave row+title 显
- [ ] AC4: 资源 picker（authoring vs workspace 两 scope）；SubunitsEditor per-subunit resources
- [ ] AC5: router.push 重指；Task 类型替换 SchedulerJob

## Verification Method
**E2E (Playwright)**: /tasks 显状态；agent 绑字段→SpecPanel 刷新；保存→反向；选资源→分流。Pass: 联动+资源+看板。
