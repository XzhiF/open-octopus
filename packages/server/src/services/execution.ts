// packages/server/src/services/execution.ts
// Pure Facade — ZERO control flow in method bodies; all logic lives in ExecutionLifecycle and RecoveryManager
import Database from "better-sqlite3"
import { SSEService } from "./sse"
import { WorkflowService } from "./workflow"
import { BuiltInWorkflowService } from "./builtin-workflow"
import { ObservabilityService } from "./observability"
import { PrivacyFilter } from "./privacy-filter"
import { ExecutionDAO } from "../db/dao/execution-dao"
import { KnowledgeEffectivenessDAO } from "../db/dao/knowledge-effectiveness-dao"
import { PendingReviewDAO } from "../db/dao/pending-review-dao"
import { createKnowledgeService } from "./knowledge"
import { ExecutionLifecycle } from "./execution/ExecutionLifecycle"
import { RecoveryManager } from "./execution/RecoveryManager"
import { globalErrorTracker } from "./error-tracker"
import { RepairService } from "./repair"
import { getResourceRegistry } from "./resource-registry"
import type { EngineCallbacks } from "@octopus/engine"
import type { ExecutionRow, NodeExecutionRow, BranchExecutionRow } from "./execution/types"

interface TokenUsageEntry {
  stepId?: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  costUsd?: number | null
}

export class ExecutionService {
  private dao: ExecutionDAO
  private lifecycle: ExecutionLifecycle

  static readonly ALLOWED_EXECUTION_COLUMNS = new Set([
    "status", "started_at", "completed_at", "duration", "progress", "var_pool",
    "gate_status", "input_values", "start_commit_id", "end_commit_id",
    "pipeline_config", "global_session_id", "approval_metadata", "interaction_metadata", "pending_hooks", "retry_count",
  ])

  constructor(
    private db: Database.Database,
    private sse: SSEService,
    private workflowService: WorkflowService,
    private builtInWorkflowService: BuiltInWorkflowService,
    private org: string,
    private workspacePath: string,
    workspaceDbId: string,
    observability?: ObservabilityService,
    execDAO?: ExecutionDAO,
  ) {
    this.dao = execDAO ?? new ExecutionDAO(db)
    const obs = observability ?? new ObservabilityService(db, new PrivacyFilter(), this.dao)
    const workspaceId = org + ":" + workspacePath

    this.lifecycle = new ExecutionLifecycle(
      db, this.dao, sse, workflowService, builtInWorkflowService,
      org, workspacePath, workspaceDbId, workspaceId, obs, globalErrorTracker,
    )

    // Wire up knowledge injection pipeline
    try {
      const effectivenessDAO = new KnowledgeEffectivenessDAO(db)
      const pendingReviewDAO = new PendingReviewDAO(db)
      const knowledgeService = createKnowledgeService(effectivenessDAO, pendingReviewDAO, org)
      this.lifecycle.setKnowledgeService(knowledgeService)
    } catch (err) {
      console.warn("[ExecutionService] Knowledge service initialization failed:", err)
    }

    // Wire up repair service for harness inject_message actions
    try {
      const resourceManager = getResourceRegistry().get()
      const repairService = new RepairService(
        this.dao,
        sse,
        this,
        workflowService,
        new BuiltInWorkflowService(resourceManager),
        workspacePath,
        workspaceId,
      )
      this.lifecycle.setRepairService(repairService)
    } catch (err) {
      console.warn("[ExecutionService] Repair service initialization failed:", err)
    }

    this.lifecycle.setupResumeListener()
  }

  destroy(): void {
    this.lifecycle.destroyResumeListener()
  }

  getEnginePool() {
    return this.lifecycle.getEnginePool()
  }

  registerExternalCallbacks(callbacks: Partial<EngineCallbacks>, executionId?: string): void {
    this.lifecycle.registerExternalCallbacks(callbacks, executionId)
  }

  clearExternalCallbacks(executionId: string): void {
    this.lifecycle.clearExternalCallbacks(executionId)
  }

  // ==================== CRUD ====================

  list(workspaceId: string): ExecutionRow[] {
    return this.dao.listByWorkspace(workspaceId)
  }

  create(workspaceId: string, input: {
    workflow_ref: string; name?: string; parent_id?: string | null;
    child_index?: number; node_type?: string; input_values?: Record<string, unknown>;
    triggered_by?: string; initial_var_pool?: Record<string, string>;
  }): ExecutionRow {
    return this.lifecycle.create(workspaceId, input, this.org) as ExecutionRow
  }

  getById(id: string): ExecutionRow | undefined {
    const row = this.dao.findById(id)
    return row ? row as ExecutionRow : undefined
  }

  getByIdWithSteps(id: string): (ExecutionRow & { steps: NodeExecutionRow[] }) | undefined {
    const exec = this.dao.findById(id)
    return exec ? { ...exec, steps: this.dao.findNodeExecutions(id) } as ExecutionRow & { steps: NodeExecutionRow[] } : undefined
  }

  getTokenUsagesForExecution(executionId: string): TokenUsageEntry[] {
    return this.lifecycle.getTokenUsagesForExecution(executionId)
  }

  getTokenUsagesPerStep(executionId: string): TokenUsageEntry[] {
    return this.lifecycle.getTokenUsagesPerStep(executionId)
  }

  /** 每节点 LLM 请求次数（供节点主行「总请求次数」）。 */
  llmCallCountsByNode(executionId: string): Record<string, number> {
    return this.lifecycle.llmCallCountsByNode(executionId)
  }

  // ==================== Lifecycle ====================

  async start(id: string, inputValues?: Record<string, string>, syncMainBranch?: boolean): Promise<ExecutionRow> {
    return this.lifecycle.start(id, inputValues, syncMainBranch)
  }

  async cancel(id: string): Promise<ExecutionRow> {
    return this.lifecycle.cancel(id)
  }

  async retry(id: string, failedNodeId: string, inputValues?: Record<string, string>, intervention?: string): Promise<ExecutionRow> {
    return this.lifecycle.retry(id, failedNodeId, inputValues, intervention)
  }

  async approve(id: string, nodeId: string, answer: string, comment?: string): Promise<ExecutionRow> {
    return this.lifecycle.approve(id, nodeId, answer, comment)
  }

  async startInteraction(id: string, nodeId: string, workspaceId: string): Promise<{ sessionId: string; display: string }> {
    return this.lifecycle.startInteraction(id, nodeId, workspaceId)
  }

  async completeInteraction(id: string, nodeId: string, summary: string, varsUpdate?: Record<string, any>): Promise<ExecutionRow> {
    return this.lifecycle.completeInteraction(id, nodeId, summary, varsUpdate)
  }

  /**
   * G1 task_dispatch resume: thread a completed child schedule's output back into
   * the paused parent composition-wf execution. Called by the scheduler's
   * child-complete callback (workflow-executor.ts) when a child schedule dispatched
   * by a task_dispatch node finishes. Delegates to ExecutionLifecycle.resumeTaskDispatch
   * → engine.retryFrom({ taskDispatchChildOutput }).
   */
  async resumeTaskDispatch(id: string, nodeId: string, childOutput: Record<string, unknown>): Promise<ExecutionRow> {
    return this.lifecycle.resumeTaskDispatch(id, nodeId, childOutput)
  }

  async pause(executionId: string): Promise<{ success: boolean; error?: string }> {
    return this.lifecycle.pause(executionId)
  }

  async resume(executionId: string, intervention?: string): Promise<{ success: boolean; error?: string }> {
    return this.lifecycle.resume(executionId, intervention)
  }

  skip(id: string): boolean {
    return this.lifecycle.skip(id)
  }

  /**
   * Harness intervention: apply an abort or pause directive to a running execution.
   * v1: both operations are execution-level (not node-level).
   */
  async harnessIntervene(
    executionId: string,
    input: { nodeId: string; directive: { type: "abort" | "pause"; reason: string; issued_by: string } },
  ): Promise<{ success: boolean; directive_applied?: string; error?: string }> {
    const exec = this.dao.findById(executionId)
    if (!exec) return { success: false, error: "Execution not found" }

    const intervenableStatuses = ["running", "paused", "pending_approval", "pending_interaction", "pending_resume"]
    if (!intervenableStatuses.includes(exec.status)) {
      return { success: false, error: `Cannot intervene in status "${exec.status}"` }
    }

    if (input.directive.type === "abort") {
      await this.lifecycle.cancel(executionId)
      return { success: true, directive_applied: "abort" }
    }

    if (input.directive.type === "pause") {
      const pauseResult = await this.lifecycle.pause(executionId)
      if (!pauseResult.success) return { success: false, error: pauseResult.error }
      return { success: true, directive_applied: "pause" }
    }

    return { success: false, error: `Unknown directive type: ${(input.directive as any).type}` }
  }

  delete(id: string): boolean {
    return this.lifecycle.delete(id)
  }

  // ==================== Logs / Branches ====================

  getLogEvents(executionId: string): { type: string; timestamp: string; data: Record<string, unknown> }[] {
    return this.lifecycle.getLogEvents(executionId)
  }

  getAgentEvents(executionId: string, nodeId?: string, loopId?: string, iteration?: number): any[] {
    return this.lifecycle.getAgentEvents(executionId, nodeId, loopId, iteration)
  }

  getLoopIterationSummary(executionId: string): Record<string, any> {
    return this.lifecycle.getLoopIterationSummary(executionId)
  }

  getBranches(executionId: string): BranchExecutionRow[] {
    return this.dao.findBranchExecutions(executionId)
  }

  getWorkflowContent(executionId: string): string | null {
    return this.lifecycle.getWorkflowContent(executionId)
  }

  getStateJson(executionId: string): Record<string, unknown> | null {
    return this.lifecycle.getStateJson(executionId)
  }

  streamEvents(req: Request): Response {
    return this.lifecycle.streamEvents(req)
  }

  async drainPendingHooks(): Promise<void> {
    await this.lifecycle.drainPendingHooks()
  }

  // ==================== Backward-compat helpers ====================

  syncStateJson(): void {
    this.lifecycle.syncStateJson()
  }

  createRefResolver(): (refPath: string) => any {
    return this.lifecycle.createRefResolver()
  }

  buildCallbacks(executionId: string): EngineCallbacks {
    return this.lifecycle.buildCallbacks(executionId)
  }

  // ==================== Static backward-compat ====================

  static async consumePendingHooks(db: Database.Database): Promise<void> {
    const dao = new ExecutionDAO(db)
    await RecoveryManager.consumePendingHooks(dao)
  }

  static recoverInterruptedExecutions(db: Database.Database): void {
    const dao = new ExecutionDAO(db)
    RecoveryManager.recoverInterruptedExecutions(dao)
  }

  static async resumePendingExecutions(db: Database.Database): Promise<void> {
    const dao = new ExecutionDAO(db)
    await RecoveryManager.resumePendingExecutions(dao)
  }
}
