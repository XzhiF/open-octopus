# ADR-0009: 任务编排 = 混合（tasks 拥有生命周期，编排委托现有 task_dispatch pipeline）

Date: 2026-08-17
Status: Accepted
Related: **amends** ADR-0008 (composition-layer-workflow-task-dispatch); task-domain-redesign map.md v2-D9, decision ticket 01; ADR-0006 (plugin-skill-discovery)

## Context

ADR-0008 决定复合任务编排放 **workflow 层**（新 `task_dispatch` 节点 + `TaskDispatchPort`），其论证前提是 v1 的 **D9："不建新表，task_spec 塞进 schedules.config JSON v3.0"**。

v2（task-domain-redesign）**推翻 D9**：建立一等 `tasks` 表，拥有完整生命周期（draft→ready→running）+ task_spec + 资源/技能绑定，并把 `schedules` 表的 task-pool hack（status/trigger_source/source_chat_session_id/claimed_at + cron-nullable + config.task_spec）清掉（无历史包袱）。在此前提下，用户重评编排层：是否还需要独立任务引擎？

研究（research ②，post-refactor 代码）确认：
- `task_dispatch` 全链路已**生产级建成**：`TaskDispatchExecutor`（`task-dispatch.ts`）+ `composition-task.yaml`（Loop + task_dispatch + moa）+ `TaskDispatchService`（server port）。pause-resume（G1）、`checkQueuedTasks` 认领、`MAX_PARALLEL_WORKSPACES` 并发上限、`checkStaleClaimed` 恢复、`ConsecutiveFailureTracker` + terminal `failed` 提升、SSE 全转换点、retention——全有且经测试。
- **编排仍需 workspace**：复合任务 = 1 coordinator-ws（projects=[]，纯编排）+ N 子 ws。即 **N+1 workspace** 开销。
- **独立任务引擎会重复 ~600 LOC tested 生命周期基建**；其独有价值 = 消除 coordinator-ws / task-native DAG 无 YAML / subunit 级重试 / 跨 subunit 资源共享。

## Decision

**混合方案（C）。** ADR-0008 的核心论据在 tasks 表下仍成立，不推翻，只修订：

1. **`tasks` 表拥有**：authoring 生命周期（draft→ready→running + 终态）+ task_spec（WHAT）+ 资源/技能绑定 + 草稿↔agent 联动。这是 v2 的轴心，与编排正交。
2. **编排委托现有 pipeline**：dispatch（ready→running）走现有 `task_dispatch`/`WorkflowExecutor`/`SchedulerEngine`，复用全部 600 LOC tested 生命周期基建（认领/并发/stale/重试/SSE/retention）。`tasks.schedule_id`/`execution_id` 在 dispatch 时回写。
3. **coordinator-ws 条件化**：简单/单 subunit 任务跳过 coordinator-ws，直接 ws 分发（N+1→1，去掉最痛开销）；仅复合 N≥2 subunit（需 engine DAG/Loop/moa）才建 coordinator-ws + composition-task.yaml。
4. **抽 orchestration-strategy seam**：在 `tasks` 与 scheduler 之间放一层策略接口，使未来 task-native DAG / subunit 级重试可**增量落地**而不重建生命周期基建。

**ADR-0008 修订点**：0008 的"复合编排放 workflow 层 + task_dispatch 节点"原则**对真正复合任务仍成立**；本 ADR 补充"简单任务不必走 coordinator-ws"与"tasks 表拥有 lifecycle/spec/资源"，并明确 dispatch envelope 由 tasks 在 ready→running 时创建。

## Consequences

- **新增**：`tasks` 表（详见 ticket 02 的精确形状）；orchestration-strategy 接口；coordinator-ws 条件化逻辑（`WorkflowExecutor` 的 `isCompositeTask` 分支增加 simple-direct-dispatch 路径）。
- **保留**：`task_dispatch` 节点 + `TaskDispatchPort` + `composition-task.yaml` + 全部生命周期基建不变（0008 的产出）。
- **清理**：`schedules` 表的 task-pool hack 列移除/迁移到 tasks（精确形状见 ticket 02）；`scheduler-service.ts` 的 `trigger_source==='requirement'` 分支收缩（draft/ready 逻辑迁出）。
- **简单任务收益**：跳过 coordinator-ws，单 subunit 任务从 N+1→1 workspace。
- **未来增量**：subunit 级重试 / 条件 DAG 可经 orchestration-strategy seam 增量加，无需 600 LOC 重建。

## Alternatives considered

- **(A) 复用 task_dispatch 原样（0008 不动）**：否决。coordinator-ws 恒建致 N+1 开销、YAML 刚性、schedules 仍带 dispatch 耦合——未解决 v2 核心痛点（cron 耦合、ws 开销）。
- **(B) 独立任务引擎**：否决（当前）。重复 ~600 LOC tested 基建、tasks 与 workflows 双执行模型（feature-drift）、测试从零、仍需与 SchedulerEngine 协调并发上限。其独有价值（subunit 级重试 / task-native DAG）先经 orchestration-strategy seam 增量获取，不赌一次性重建。**若未来证明 subunit 级重试是硬需求**，B 可在 seam 内渐进替换，届时另起 ADR。

## Relationship to ADR-0008

**Amends, not supersedes.** 0008 仍管"真正复合任务的 workflow 层编排"；0009 补"tasks 表拥有 lifecycle/spec/资源 + coordinator-ws 条件化 + 简单任务直分发"。两者并存。
