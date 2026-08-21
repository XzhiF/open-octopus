# ADR-0008: 复合任务编排层 = workflow layer + `task_dispatch` 节点

Date: 2026-08-17
Status: Accepted
Related: task-pool-redesign map.md, decision ticket 05; ADR-0006 (plugin-skill-discovery)

## Context

任务池需支持**复合任务**：一个任务 fan-out 到 N 个 subunit，每个 subunit = 独立 workspace（多仓库 worktree）+ 自己的 `workflow_ref` + vars + skills，编排 + 整合。场景：大型项目不愿一个 workspace 装下所有；不同 project 用定制 workflow + 不同 skills；同一 workflow 不同 vars。

PR #50 现有 `workflow_chain` 是**严格顺序、单工作空间**（A→B→C 在同一 ws 内，engine-execution 级 parent/child，`executions.parent_id`/`child_index`）。`sub_workflow` 节点**同工作空间-only**（用 `ctx.cwd` + 同 ws `workflowResolver`，无 `WorkspaceService` 访问，`executor-factory.ts:259,269`）。`dynamic_sub_workflow` 生成节点**仅 agent 型**。三者均不能作 N-ws 编排载体。

研究（tickets 01/02，primary-source cited）发现：
- **Engine 已有并行编排+整合原语**：`computeExecutionLevels`（Kahn 拓扑，`graph-utils.ts:93-122`）、`executeNodesParallel`（per-level `Promise.allSettled` + `maxConcurrent` 批，`engine.ts:1370`）、`DispatchStrategy/buildDAG`（parallel-within-level + dep 失败传播）、`MoaStrategy`（fan-out `Promise.all` + aggregator `runHost` + 多轮精炼 = 字面意义的"并行调度+整合"）。
- **Scheduler 无任何编排/整合原语**；且 `idx_sched_execs_unique_active`（`schema.sql:565`）禁止一个 `schedule_id` 下多个 active 子项 → fan-out 无论在哪层都必须创建 **N 个独立子 schedule**（不是 N 个同-schedule 子 execution）。
- `createFromSpec` 每调用无状态（随机 UUID + fs 按 name + DB insert + 每 project 一 worktree）→ N 次调用结构上可行；环境阻塞：distinct name/branch_prefix、同步 `spawnSync` git I/O 阻塞 event loop、`MAX_PARALLEL_WORKSPACES=3`。

## Decision

**复合任务的编排放 workflow 层。**

任务 pin 一个 **composition workflow**（跑在一个轻量 coordinator workspace，无 projects）。该 workflow 用**新节点 `task_dispatch`** fan-out：每节点声明一个 subunit（`WorkspaceSpec` + `workflow_ref` + vars + skills）→ 通过注入的 `TaskDispatchPort` 创建独立子 schedule + `createFromSpec` 独立 ws；engine 节点跨边界 await 子 schedule 完成。

编排复用 engine 的 **DAG / Loop**（同一 workflow 不同 vars = loop over var-sets）/ **Swarm**；整合复用 engine **swarm/moa** 聚合节点。

Task 模型不变：**spec (WHAT) + workflow_ref (HOW)**。`workflow_ref` 指向 composition workflow 时自然复合；指向普通 workflow 时 1 ws。一个模型兜住简单与复合两端，不分支。

## Consequences

- **新增**：engine 节点类型 `task_dispatch` + 注入的 `TaskDispatchPort`（engine→scheduler 边界；engine 仅依赖 `@octopus/shared`+`@octopus/providers`，注入约定见 `executor-config.ts:146`）。
- **新机制**：cross-boundary await bridge — engine `task_dispatch` 节点必须阻塞至子 schedule 链完成（取 output mapping / 喂聚合节点）；现 `handleChainComplete` 是 fire-and-forget，需补同步等待语义。
- **整合**：composition workflow 末尾 `swarm`/`moa` 节点（复用，无新原语）。
- **复合 = N 个独立子 schedule**，受 `MAX_PARALLEL_WORKSPACES` 并发上限 + `idx_sched_execs_unique_active` 约束，须在 `task_dispatch` 层处理（每 subunit 一个 schedule_id）。
- **现有 `workflow_chain`**（顺序、1-ws）的命运由 ticket 13 定（倾向 fold 进 composition 或 deprecate）。

## Alternatives considered

- **(A) Scheduler 层 `composition_plan`**：scheduler 直接编排 DAG（泛化 `workflow_chain`）。否决：需在 scheduler 重建 DAG 拓扑 / fan-out / join-barrier / integration（4+ 新机制）= DRY 违反（engine 已有）；且 `idx_sched_execs_unique_active` 仍要求 N 个独立子 schedule，(A) 不省事。
- **(C) 混合**：subunits 声明式（默认 scheduler 执行）+ 可 pin composition workflow 覆盖。否决（v1）：两套执行路径长期维护成本高；先做 (B)，subunits 声明式数据可作为 (B) 的语法糖后续叠加。
