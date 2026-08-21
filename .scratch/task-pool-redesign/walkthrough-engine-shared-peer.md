# Engine/Shared Walk-Through — Peer Report (Explore)

> Source: teammate session "Explore". Rigorous file:line verification of the engine/shared layer against spec.md. Preserved here for consolidation with the spawned story-walkthrough agent's report.

## Legend
EXISTS ✅ · MISSING ❌ · PARTIAL ⚠️ · MAGIC BRIDGE 🔮

## Findings

1. **NodeDef types** EXISTS ✅ (`shared/types/workflow.ts:209-322`, 11 types). `task_dispatch` MISSING ❌ (zero grep) — mechanical addition to type union + NodeSchema + executor-factory switch + new executor file. Low risk.
2. **Executor registry + DI** EXISTS ✅ (`executor-factory.ts:66-346`). Injection convention (`createSessionFn` at `executor-config.ts:147`) is the exact precedent for `TaskDispatchPort`. Engine depends only on shared+providers → port interface in shared, impl in server. FEASIBLE ✅.
3. **TaskDispatchPort + TaskDispatchExecutor** MISSING ❌ — needs build (interface in shared, executor in engine, config, factory case). Medium.
4. **Cross-boundary await bridge** 🔮 **MAGIC BRIDGE #1 (R1, HIGHEST)** — `handleChainComplete` (`workflow-executor.ts:317-379`) is server-side, fire-and-forget (`:266`). NO mechanism for an engine node to synchronously await an external schedule. Architecturally novel — nothing like it exists. `interaction`/`approval` pause/resume via SSE, not via awaiting external schedules.
5. **MoaStrategy** EXISTS ✅ (`moa-strategy.ts:17-294`: parallel fan-out + aggregation + multi-round). PARTIAL ⚠️ for task_dispatch: MoA aggregates in-process `ExpertResult[]`, not external schedule outputs. BUT — if task_dispatch nodes are DAG peers (in `depends_on`), their outputs are available via `$nodeId.output` (substitute.ts:79-86) to ANY downstream node incl. swarm/moa. **Viable** once task_dispatch publishes outputs.
6. **DAG execution** EXISTS ✅ production-ready (graph-utils.ts computeExecutionLevels/Kahn, engine.ts executeNodesParallel per-level, dep failure cascade). Low.
7. **LoopExecutor** EXISTS ✅ (same wf diff vars via $vars + iteration scoping). Low.
8. **workflowConfigSchema** ⚠️ v2.0 literal (`scheduler-job.ts:63-69`), `task_spec` MISSING, `SubunitSpec` MISSING. Medium (field addition + schema bump).
9. **WorkspaceSpec/WorkflowRef** EXISTS ✅ well-defined. Low.
10. **Variable substitution** EXISTS ✅ generic — `$nodeId.output.key` works for task_dispatch IF it produces NodeExecutionResult with outputs. Low.

## Critical Magic Bridges
- **#1 R1 Cross-boundary await** — engine node can't block on external schedule; fire-and-forget; no reverse-await. Build: Promise registry resolved by server child-completion callback. Novel.
- **#2 TaskDispatchPort injection** — feasible (createSessionFn precedent), needs explicit design.
- **#3 MoA aggregation of task_dispatch outputs** — viable via `$nodeId.output` IF task_dispatch brings child outputs back into parent nodeResults (depends on #1).
