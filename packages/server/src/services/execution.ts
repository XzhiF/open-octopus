// packages/server/src/services/execution.ts
// Pure Facade — ZERO control flow in method bodies; all logic lives in ExecutionLifecycle and RecoveryManager
import Database from "better-sqlite3"
import { SSEService } from "./sse"
import { WorkflowService } from "./workflow"
import { BuiltInWorkflowService } from "./builtin-workflow"
import { ObservabilityService } from "./observability"
import { PrivacyFilter } from "./privacy-filter"
import { ExecutionDAO } from "../db/dao/execution-dao"
import { ExecutionLifecycle } from "./execution/ExecutionLifecycle"
import { RecoveryManager } from "./execution/RecoveryManager"
import { globalErrorTracker } from "./error-tracker"
import type { EngineCallbacks } from "@octopus/engine"
import type { ExecutionRow, NodeExecutionRow, BranchExecutionRow } from "./execution/types"

interface TokenUsageEntry {
  stepId?: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
}

export class ExecutionService {
  private dao: ExecutionDAO
  private lifecycle: ExecutionLifecycle

  static readonly ALLOWED_EXECUTION_COLUMNS = new Set([
    "status", "started_at", "completed_at", "duration", "progress", "var_pool",
    "gate_status", "input_values", "start_commit_id", "end_commit_id",
    "pipeline_config", "global_session_id", "approval_metadata", "pending_hooks", "retry_count",
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
      this.dao, sse, workflowService, builtInWorkflowService,
      org, workspacePath, workspaceDbId, workspaceId, obs, globalErrorTracker,
    )

    this.lifecycle.setupResumeListener()
  }

  destroy(): void {
    this.lifecycle.destroyResumeListener()
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

  // ==================== Lifecycle ====================

  async start(id: string, inputValues?: Record<string, string>): Promise<ExecutionRow> {
    return this.lifecycle.start(id, inputValues)
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

  async pause(executionId: string): Promise<{ success: boolean; error?: string }> {
    return this.lifecycle.pause(executionId)
  }

  async resume(executionId: string, intervention?: string): Promise<{ success: boolean; error?: string }> {
    return this.lifecycle.resume(executionId, intervention)
  }

  skip(id: string): boolean {
    return this.lifecycle.skip(id)
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

  getLoopIterationSummary(executionId: string): Record<string, any[]> {
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
