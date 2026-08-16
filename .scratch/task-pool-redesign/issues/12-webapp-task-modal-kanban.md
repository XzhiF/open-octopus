# 12 — web-app 统一 TaskModal + 看板 failed/aborted 列

## What to build
web-app：/tasks 全宽看板（task-pool.ts 加 failed/aborted 列）+ 统一 `TaskModal`（status+type 上下文切 authoring/simple/done）。authoring 模式：spec 左/对话 右（task-author clone chat）+ project/skill 选择器 + spec/subunit 编辑器 + [入队] 按钮→`POST /jobs/:id/enqueue`。simple/done 模式：执行流程图 + 结果。替换 tasks/page.tsx:112 placeholder toast。

## Blocked by
10, 05

## Status
ready-for-agent

## Acceptance Criteria
- [ ] 点 [+新建] → authoring modal（spec 左/对话 右）
- [ ] project/skill 选择 + task-author chatbot 产 spec
- [ ] [入队] → draft→queued
- [ ] 点简单卡 → modal 简单执行视图
- [ ] 看板 failed/aborted 列显示对应任务
- [ ] 无 placeholder toast

## Verification Method
**Type**: E2E (Playwright)
**Steps**: 截图 320/768/1024/1440：/tasks 看板 7 列；点 [+新建] → authoring modal；选 project/skill；[入队] → 看板卡移到 queued；failed 任务 → failed 列。
**Pass**: 截图 + assert PASS。**Fail**: max 3 then SKIP。
