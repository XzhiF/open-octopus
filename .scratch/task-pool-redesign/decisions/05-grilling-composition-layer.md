# 05 — 复合任务（N workspace）的编排放在哪一层？

Type: grilling
Status: resolved
Blocked by: None (architectural; research 01/02 informed implementation details)

## Question

复合任务 = 一个任务 fan-out 到 N 个 subunit，每个 subunit = 自己的 workspace（多仓库 worktree）+ 自己的 workflow_ref + vars + skills，编排 + 整合。sub_workflow 节点已被 inheritance 排除（同工作空间-only）。三选一：(A) scheduler 层 composition_plan / (B) workflow 层 composition workflow + new `task_dispatch` 节点 / (C) 混合。

## Answer

**(B) — workflow-layer composition workflow + new `task_dispatch` node.** User chose B.

Rationale (evidence-backed via research 01/02):
- Engine already has the orchestration+integration primitives (D10: `computeExecutionLevels`, `executeNodesParallel`, `DispatchStrategy/buildDAG`, `MoaStrategy` = fan-out + aggregator). Scheduler has none — (A) would rebuild them = DRY violation.
- Fan-out must create **N distinct child schedules either way** (`idx_sched_execs_unique_active` blocks multiple active children under one schedule_id, D12) — so (A) gains nothing by staying in the scheduler.
- `sub_workflow` is same-ws-only (D12) — can't be the vehicle; `task_dispatch` fills exactly that gap (dispatches a child **schedule** + own ws, not an in-workspace sub-flow).
- (B)'s unique cost = `task_dispatch` node + injected `TaskDispatchPort` (engine→scheduler boundary) + **cross-boundary await bridge** (engine node blocks until child schedule completes — today `handleChainComplete` is fire-and-forget). Integration reuses engine `swarm`/`moa` (no new primitive).

**ADR**: `docs/adr/0008-composition-layer-workflow-task-dispatch.md`

## Unblocks
- 06 (integration output) — now answerable (swarm/moa aggregate node shape)
- 11 (composite kanban UX) — how N child schedules render
- 13 (workflow_chain fate) — sequential 1-ws chain vs new composition

## Recommendation (was, pre-answer)
**(B)** — same reasons as the Answer above.
