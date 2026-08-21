# Brief: Task Domain Redesign — 一等 tasks 表 + 确定性草稿 + spec↔agent 联动

## Overview
v2 重设计任务池：新建一等 `tasks` 域拥有 `draft→ready→running→done/failed/aborted` 全生命周期 + task_spec(WHAT) + 资源/技能绑定；确定性草稿保存（turn-end autosave row+title + [保存草稿] 按钮）；spec↔agent 双向联动（`update_task_spec_field` 工具 + `spec_field_update` SSE + 反向 context msg）；task-author 加载非-cwd 资源（draft prompt-inject / ws workflow.requires，两 scope 持久化）；`schedules` 清 task-pool hack 泛化 `origin_type` 多态关联（S2，无 FK）；编排委托 `task_dispatch` + coordinator-ws 条件化（ADR-0009 混合）。

## Summary
- **14 v2 决策**（v2-D1..D14）+ 继承 v1 11 决策 → [spec.md § Key Decisions](./spec.md)
- **ADR-0009**（修订 ADR-0008：混合编排）→ [docs/adr/0009](../../../docs/adr/0009-task-domain-orchestration-hybrid.md)
- **~12 AC + R-INT** → [spec.md § Verification](./spec.md)
- **3 闭环故事**（A 简单 / B 复合 / C 草稿+联动+资源）→ [spec.md § Appendix](./spec.md)
- 决策地图 [map.md](./map.md) · 7 decision tickets [decisions/](./decisions/)
- 推翻 v1 D9（"不建表"）+ 修订 ADR-0008（tasks 表语境下重评编排）

## Risks
- **R-INT（已接受）**：origin_id 无 FK（S2）→ 孤儿风险；缓解=app 级 cascade-reap + 孤儿 reaper + createJob-rollback
- **R1**：dispatch seam（ready→建 schedules envelope）新代码，须验简单（跳 coordinator）/复合（coordinator+N 子）两路
- **R3**：非-cwd 资源 prompt-inject 依赖 `pi-sdk-adapter.ts:99-112` getSystemPrompt override，须实测 SDK 接受
- **R4**：schedules 清理 dev 无包袱可重建；prod 迁移另议

## Full Spec
[spec.md](./spec.md)

## Next
spec + issues 定稿后两种执行路径：
1. **matt-dev-pipeline** — 全流水线：DAG 并发开发 → code review → deploy → E2E → PR
2. **matt-pipeline-loop** — 迭代 + 验证循环（confidence <85 自动 gap-fix 重跑）
