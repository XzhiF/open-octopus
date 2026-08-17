export * from './config-schema'
export * from './config-validator'
export * from './scheduler-service'
export * from './dashboard-service'
export * from './export-service'

// P3 execution engine
export * from './executors/executor-interface'
export { WorkflowExecutor } from './executors/workflow-executor'
export { AgentExecutor } from './executors/agent-executor'
export { Semaphore } from './semaphore'
export { CircuitBreaker, CircuitBreakerOpenError } from './circuit-breaker'
export type { CircuitState, CircuitBreakerOptions } from './circuit-breaker'
export { ConsecutiveFailureTracker } from './consecutive-failure-tracker'
export { SchedulerEngine } from './scheduler-engine'
// SG16 (ticket 06): barrel re-export TaskDispatchService. The tasks dispatch
// seam + ExecutionLifecycle consume this; re-exporting from the scheduler
// barrel gives callers a single import path for the scheduler service surface.
export { TaskDispatchService } from './task-dispatch-service'
// SG12 (ticket 06): orphan schedule reaper — app-level integrity backstop for
// S2's no-FK origin_id (cascades on task delete/abort; this covers the gap).
export { reapOrphanSchedules } from './orphan-reaper'
// Ticket 08 (ADR-0009): orchestration-strategy seam between the tasks domain
// and the scheduler/dispatch pipeline. The dispatch seam (routes/tasks +
// scheduler-service materialize) consumes this to decide the schedule-envelope
// shape (simple=1 primary direct vs composite=coordinator+N children). The
// default impl delegates to existing logic — no behavior change; the seam
// exists so future subunit-level retry / conditional DAG land incrementally
// WITHOUT rebuilding the tested lifecycle base. Also exports the single source
// of truth for COMPOSITION_WF_REF + COMPOSITE_SUBUNIT_THRESHOLD.
export {
  COMPOSITION_WF_REF,
  COMPOSITE_SUBUNIT_THRESHOLD,
  DefaultOrchestrationStrategy,
  defaultOrchestrationStrategy,
  isCompositeBySubunitCount,
} from './orchestration-strategy'
export type {
  OrchestrationStrategy,
  OrchestrationDispatchPlan,
  OrchestrationPlanInput,
  OrchestrationStrategyKind,
} from './orchestration-strategy'
