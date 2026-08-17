# 11 — web-app: dispatch viewer（复合父卡+drill-down）

## What to build
TaskModal 复合视图：父卡 aggregate status + drill-down（N 子 schedule via `schedules WHERE origin_type='task' AND origin_id=task.id` 查 + dag from buildDagFromTaskSpec + integration node）。SSE 推父+各子 task_status/schedule_status。复用引擎流程图组件画 composition DAG（v1 D15）。简单任务→简单执行视图；done→结果视图。

## Blocked by
10 (web-app kanban/modal)

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: 复合卡显 aggregate status；click→drill-down N 子+dag+integration
- [ ] AC2: SSE 推父+各子状态实时刷新
- [ ] AC3: 简单/done 视图切换

## Verification Method
**E2E (Playwright)**: 复合 task→父卡+drill-down N 子；SSE 刷新。Pass: drill-down+实时。
