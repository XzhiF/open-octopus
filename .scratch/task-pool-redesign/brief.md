# Brief: Task Pool Redesign — Project-Bound Authoring + Composite Dispatch

## Overview
重设计任务池：project-bound task-author clone 产结构化 spec → 手动入队（confirm gate）→ scheduler dispatch。简单 = createFromSpec 1 ws；复合 = composition workflow + 新 `task_dispatch` 节点 fan-out N 子 schedule（各独立 ws），engine DAG/Loop/Swarm 编排 + swarm/moa 聚合。统一弹窗 UI 上下文感知。xzf-dev = opt-in。

## Summary
- **16 决策**（D1-D16）+ **11 断点修复**（G1-G10，story-walkthrough user-confirmed "都要"）→ [spec.md](./spec.md)
- **ADR-0008**：composite 编排层 = workflow + `task_dispatch`（[docs/adr/0008](../../../docs/adr/0008-composition-layer-workflow-task-dispatch.md)）
- **14 implementation tickets**（[issues/](./issues/)，DAG：shared→engine→server→core-pack→web-app→E2E，带 blocked-by + 验证）
- **3 闭环故事**已 trace（A 简单 / B 复合 / C crash+abort）
- 决策地图 [map.md](./map.md) · UI 原型 [decisions/14](./decisions/14-prototype-authoring-panel-ux.md)

## Risks
- R1(G1) **pause-resume 跨边界桥**：复用 interaction/approall 基建（非新原语），但需验证 resume API 支持 server-内部触发（child-complete，非仅人 SSE）。最大技术风险。
- per-task skills 注入（ADR-006 下 `getPlugins` 不过滤 `CloneDef.skills`）需实测 SDK。
- composite N>3 排队（MAX_PARALLEL_WORKSPACES=3 + unique_active）。

## Next
两种执行路径（任选）：
1. **matt-dev-pipeline** — 全流水线：DAG 并发开发 → code review → deploy → E2E → PR。
2. **matt-pipeline-loop** — 迭代式 + 验证循环（confidence <85 自动 gap-fix 重跑）。
