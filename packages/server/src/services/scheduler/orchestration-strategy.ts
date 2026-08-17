// packages/server/src/services/scheduler/orchestration-strategy.ts
//
// ADR-0009: orchestration-strategy seam between the tasks domain and the
// scheduler/dispatch pipeline.
//
// The tasks domain owns authoring lifecycle (draft→ready→running, ticket 02).
// When a task transitions ready→running, the dispatch seam (routes/tasks.ts
// + scheduler-service.materializeTaskSpecToConfig + TasksService.readyTask)
// builds schedule envelope(s). This module is the STRATEGY that decides the
// SHAPE of that envelope:
//
//   simple (subunits.length < 2)  → 1 primary schedule, DIRECT dispatch
//                                    (no coordinator-ws — ADR-0009 N+1→1 win).
//   composite (subunits.length≥2) → 1 coordinator schedule (projects=[],
//                                    runs composition-task.yaml) + N subunit
//                                    children fanned out via task_dispatch
//                                    (ADR-0008, unchanged).
//
// The default impl delegates to the EXISTING dispatch logic — no behavior
// change. The seam exists so future subunit-level retry / conditional DAG /
// task-native DAG can land incrementally behind a new OrchestrationStrategy
// impl, WITHOUT rebuilding the ~600 LOC tested lifecycle base (ADR-0009
// alternative B deferred).
//
// Layering: this seam is PRE-materialization (works on TaskSpec). The
// WorkflowExecutor.isCompositeTask (post-materialization, config-shape
// detector) is a DIFFERENT layer — it reconstructs the decision from the
// materialized WorkflowConfig. Both must agree on the threshold + composition
// ref; this module exports both as the single source of truth.

import type { SubunitSpec, TaskSpec, OriginRole } from "@octopus/shared"

/** Composition workflow template (core-pack/workflows/composition-task.yaml).
 *  A composite task's coordinator-ws runs this workflow, whose Loop +
 *  task_dispatch nodes fan out N child schedules + a trailing moa aggregates.
 *  Single source of truth — WorkflowExecutor + scheduler-service mirror it. */
export const COMPOSITION_WF_REF = "composition-task"

/** Composite threshold (SG9): subunits.length >= THIS → composite. 1-subunit
 *  tasks take the simple direct-dispatch path (ADR-0009 N+1→1). Single source
 *  of truth — isCompositeTaskSpec (scheduler-service) +
 *  isCompositeTask (workflow-executor) mirror it. */
export const COMPOSITE_SUBUNIT_THRESHOLD = 2

/** The kind of dispatch plan a task gets. */
export type OrchestrationStrategyKind = "simple" | "composite"

/** The dispatch plan returned by {@link OrchestrationStrategy.planDispatch}.
 *  The dispatch seam (routes/tasks + scheduler-service materialize) consumes
 *  this to build the schedule envelope(s). Pure data — no I/O. */
export interface OrchestrationDispatchPlan {
  /** 'simple' = 1 primary schedule, direct (no coordinator-ws).
   *  'composite' = coordinator schedule + N subunit children. */
  strategy: OrchestrationStrategyKind
  /** OriginRole the primary/coordinator schedule carries. 'primary' for
   *  simple, 'coordinator' for composite. */
  primaryOriginRole: OriginRole
  /** For composite: the composition workflow_ref to run in the coordinator-ws.
   *  Undefined for simple (the task's own workflow_ref is used directly). */
  compositionWorkflowRef?: string
  /** The subunits to fan out. Empty for simple; the full array for composite. */
  subunits: SubunitSpec[]
  /** True iff strategy === 'composite'. Convenience for callers. */
  isComposite: boolean
}

/** Input to {@link OrchestrationStrategy.planDispatch}. */
export interface OrchestrationPlanInput {
  taskSpec: TaskSpec
  /** The task's workflow_ref — used directly on the simple path (no
   *  coordinator-ws). Ignored on the composite path (composition-task replaces
   *  it in the coordinator-ws). */
  workflowRef?: string
}

/** ADR-0009 seam: decides the dispatch shape for a task spec.
 *
 *  Pure (no I/O): the dispatch seam calls this to learn what schedule envelope
 *  to build, then builds it. The default impl ({@link DefaultOrchestrationStrategy})
 *  mirrors the existing dispatch logic — no behavior change. Future impls
 *  (subunit-level retry / conditional DAG / task-native DAG) replace this
 *  interface WITHOUT touching the lifecycle base. */
export interface OrchestrationStrategy {
  /** Decide the dispatch shape for a task spec. Pure: no DB, no SSE, no I/O. */
  planDispatch(input: OrchestrationPlanInput): OrchestrationDispatchPlan
}

/** Pure decision predicate: simple vs composite by subunit count. Single source
 *  of truth for the SG9 threshold. Exported so the post-materialization
 *  config-shape detector (WorkflowExecutor.isCompositeTask) + the
 *  pre-materialization planner (DefaultOrchestrationStrategy) share one
 *  constant. */
export function isCompositeBySubunitCount(subunitCount: number): boolean {
  return subunitCount >= COMPOSITE_SUBUNIT_THRESHOLD
}

/** Default strategy: delegates to the existing dispatch logic (ADR-0009:
 *  "no behavior change now, just the seam for future extension").
 *
 *  - simple  → 1 primary schedule, direct dispatch, no coordinator-ws.
 *  - composite → coordinator schedule (composition-task.yaml) + N subunit
 *    children via task_dispatch (ADR-0008, unchanged).
 *
 *  Future variants (subunit-level retry / conditional DAG) implement
 *  {@link OrchestrationStrategy} and replace this default at the injection
 *  site (dispatch seam) — the lifecycle base stays untouched. */
export class DefaultOrchestrationStrategy implements OrchestrationStrategy {
  private readonly compositionWorkflowRef: string

  constructor(opts: { compositionWorkflowRef?: string } = {}) {
    this.compositionWorkflowRef = opts.compositionWorkflowRef ?? COMPOSITION_WF_REF
  }

  planDispatch(input: OrchestrationPlanInput): OrchestrationDispatchPlan {
    const subunits = input.taskSpec.subunits ?? []
    const isComposite = isCompositeBySubunitCount(subunits.length)
    if (!isComposite) {
      return {
        strategy: "simple",
        primaryOriginRole: "primary",
        compositionWorkflowRef: undefined,
        subunits: [],
        isComposite: false,
      }
    }
    return {
      strategy: "composite",
      primaryOriginRole: "coordinator",
      compositionWorkflowRef: this.compositionWorkflowRef,
      subunits,
      isComposite: true,
    }
  }
}

/** Module-level singleton — the default strategy. The dispatch seam
 *  (routes/tasks + scheduler-service) consumes this unless a future variant
 *  is injected. Const so callers can import the decision directly. */
export const defaultOrchestrationStrategy: OrchestrationStrategy =
  new DefaultOrchestrationStrategy()
