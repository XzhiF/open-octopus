# 08 — engine: orchestration-strategy seam + simple-direct-dispatch

## What to build
ADR-0009 hybrid 落地：`WorkflowExecutor.isCompositeTask`（:490-497, call :142）加 simple-direct-dispatch 路径——简单/1-subunit 跳 coordinator-ws 直分发（N+1→1）；复合 N≥2 建 coordinator-ws+composition-task.yaml。orchestration-strategy seam 接口（tasks↔scheduler 边界，未来 subunit 级重试/条件 DAG 增量入口）。复用 task_dispatch/WorkflowExecutor/SchedulerEngine 全生命周期基建（不改 runner 核心）。

## Blocked by
06 (schedules origin/materialize)

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: 简单任务跳 coordinator-ws（1 schedule 直分发，无 coordinator 行）
- [ ] AC2: 复合 N≥2 建 coordinator-ws + composition-task.yaml + N 子 task_dispatch
- [ ] AC3: orchestration-strategy seam 接口定义（未来扩展点）

## Verification Method
**integration**: 简单 task dispatch→无 coordinator schedule；复合 3-subunit→coordinator+3 子 schedule。Pass: 简单 1 ws / 复合 1+N ws。
