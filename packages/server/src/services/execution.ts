// packages/server/src/services/execution.ts
// Pure Facade — ZERO control flow in method bodies; all logic lives in ExecutionLifecycle and RecoveryManager
import Database from "better-sqlite3"
import { SSEService } from "./sse"
import { WorkflowService } from "./workflow"
import { BuiltInWorkflowService } from "./builtin-workflow"
import { ObservabilityService } from "./observability"
import { PrivacyFilter } from "./privacy-filter"
import { ExecutionDAO } from "../db/dao/execution-dao"
import { TokenUsageDAO } from "../db/dao/token-usage-dao"
import { KnowledgeEffectivenessDAO } from "../db/dao/knowledge-effectiveness-dao"
import { PendingReviewDAO } from "../db/dao/pending-review-dao"
import { pgSql } from "../db/dao/registry"
import { createKnowledgeService } from "./knowledge"
import { ExecutionLifecycle } from "./execution/ExecutionLifecycle"
import { RecoveryManager } from "./execution/RecoveryManager"
import { globalErrorTracker } from "./error-tracker"
import { RepairService } from "./repair"
import { getResourceRegistry } from "./resource-registry"
import type { EngineCallbacks } from "@octopus/engine"
import type { TokenUsage } from "@octopus/shared"
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
    // P1 B4 票2B-3：账本写侧（EngineCallbacks.onNodeEnd → TokenUsageDAO）已迁 PG，
    // 测试侧可在 DI 点注入桩（ExecutionLifecycle 第 12 参透传），避免跨引擎空 join
    // 在 fire-and-forget 里升级成 unhandled rejection —— execution-lifecycle 样板。
    tokenUsageDao?: TokenUsageDAO,
  ) {
    // [P1 B5 票5B] ExecutionDAO 已迁 PG：直构位点走池句柄（db 参数保留给混簇 SQLite 消费者）。
    this.dao = execDAO ?? new ExecutionDAO(pgSql())
    const obs = observability ?? new ObservabilityService(this.dao, tokenUsageDao ?? new TokenUsageDAO(pgSql()), new PrivacyFilter())
    const workspaceId = org + ":" + workspacePath

    this.lifecycle = new ExecutionLifecycle(
      db, this.dao, sse, workflowService, builtInWorkflowService,
      org, workspacePath, workspaceDbId, workspaceId, obs, globalErrorTracker,
      tokenUsageDao,
    )

    // Wire up knowledge injection pipeline
    try {
      // P1 B2: knowledge 两 DAO 已迁 postgres.js —— 走注册池，不再吃 SQLite 句柄。
      const effectivenessDAO = new KnowledgeEffectivenessDAO(pgSql())
      const pendingReviewDAO = new PendingReviewDAO(pgSql())
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

  async list(workspaceId: string): Promise<ExecutionRow[]> {
    return this.dao.listByWorkspace(workspaceId)
  }

  create(workspaceId: string, input: {
    workflow_ref: string; name?: string; parent_id?: string | null;
    child_index?: number; node_type?: string; input_values?: Record<string, unknown>;
    triggered_by?: string; initial_var_pool?: Record<string, string>;
    // task-phase-redesign (K4/K5) + task-exec-tree (v44): the FIRST round of a task is a
    // root on the reused bound ws (later rounds chain under it via parent_id) — see
    // ExecutionLifecycle.create for the rationale.
    allow_existing_root?: boolean;
    // ADR-0021 票03: task launch identity, written AT INSERT so the row is a task
    // instance from the moment it exists. A later UPDATE would leave a window where
    // ux_exec_task_active does not apply to it — the latch only protects rows that
    // already carry task_id, so the arming side must never insert it in two steps.
    task_id?: string | null; phase_index?: number | null; round_index?: number | null;
  }): Promise<ExecutionRow> {
    return this.lifecycle.create(workspaceId, input, this.org)
  }

  async getById(id: string): Promise<ExecutionRow | undefined> {
    const row = await this.dao.findById(id)
    return row ? row as ExecutionRow : undefined
  }

  async getByIdWithSteps(id: string): Promise<(ExecutionRow & { steps: NodeExecutionRow[] }) | undefined> {
    const exec = await this.dao.findById(id)
    return exec ? { ...exec, steps: await this.dao.findNodeExecutions(id) } as ExecutionRow & { steps: NodeExecutionRow[] } : undefined
  }

  /** F1（2026-09-21）: 该执行 running 节点的 turn_usage 实时累计（内存活投影，
   *  易失；node_end 后由 node_token_usages 接管）。GET /:executionId 用它给
   *  running 步骤附 liveUsage，刷新/重连的客户端从快照即可恢复卡片。 */
  getLiveUsage(executionId: string): Map<string, { usage: TokenUsage; turn: number; ts: number }> | undefined {
    return this.lifecycle.liveUsageFor(executionId)
  }

  async getTokenUsagesForExecution(executionId: string): Promise<TokenUsageEntry[]> {
    return this.lifecycle.getTokenUsagesForExecution(executionId)
  }

  async getTokenUsagesPerStep(executionId: string): Promise<TokenUsageEntry[]> {
    return this.lifecycle.getTokenUsagesPerStep(executionId)
  }

  /** 每节点 LLM 请求次数（供节点主行「总请求次数」）。 */
  async llmCallCountsByNode(executionId: string): Promise<Record<string, number>> {
    return this.lifecycle.llmCallCountsByNode(executionId)
  }

  // ==================== Lifecycle ====================

  async start(
    id: string,
    inputValues?: Record<string, string>,
    syncMainBranch?: boolean,
    claimedLease?: string,
  ): Promise<ExecutionRow> {
    // claimedLease — see ExecutionLifecycle.start: the task-lifecycle job claims the row
    // under a guarded UPDATE and hands its lease back here instead of re-asserting
    // 'pending', which its own claim already consumed.
    return this.lifecycle.start(id, inputValues, syncMainBranch, claimedLease)
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

  async startInteraction(id: string, nodeId: string, workspaceId: string): Promise<{ sessionId: string; initialPrompt?: string }> {
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

  /** Engine alive in this process for this execution (see ExecutionLifecycle.hasLiveEngine). */
  hasLiveEngine(executionId: string): boolean {
    return this.lifecycle.hasLiveEngine(executionId)
  }

  async skip(id: string): Promise<boolean> {
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
    const exec = await this.dao.findById(executionId)
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

  async delete(id: string): Promise<boolean> {
    return this.lifecycle.delete(id)
  }

  // ==================== Logs / Branches ====================

  async getLogEvents(executionId: string): Promise<{ type: string; timestamp: string; data: Record<string, unknown> }[]> {
    return this.lifecycle.getLogEvents(executionId)
  }

  getAgentEvents(executionId: string, nodeId?: string, loopId?: string, iteration?: number): any[] {
    return this.lifecycle.getAgentEvents(executionId, nodeId, loopId, iteration)
  }

  getLoopIterationSummary(executionId: string): Record<string, any> {
    return this.lifecycle.getLoopIterationSummary(executionId)
  }

  async getBranches(executionId: string): Promise<BranchExecutionRow[]> {
    return this.dao.findBranchExecutions(executionId)
  }

  async getWorkflowContent(executionId: string): Promise<string | null> {
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

  async syncStateJson(): Promise<void> {
    await this.lifecycle.syncStateJson()
  }

  async createRefResolver(workflowContent: string): Promise<(refPath: string) => any> {
    return this.lifecycle.createRefResolver(workflowContent)
  }

  buildCallbacks(executionId: string): EngineCallbacks {
    return this.lifecycle.buildCallbacks(executionId)
  }

  // ==================== Static backward-compat ====================

  static async consumePendingHooks(db: Database.Database): Promise<void> {
    const dao = new ExecutionDAO(pgSql())
    await RecoveryManager.consumePendingHooks(dao)
  }

  static async recoverInterruptedExecutions(db: Database.Database): Promise<void> {
    const dao = new ExecutionDAO(pgSql())
    await RecoveryManager.recoverInterruptedExecutions(dao)
    // 票6a 启动清扫兜底（判据：running 孤儿 → interrupted）。必须排在
    // RecoveryManager 之后：先按其规则翻面（failed/pending_resume 语义优先），
    // 剩余仍 running 的（updated_at IS NULL 两支都抓不到的行）统一 interrupted。
    const swept = await dao.sweepRunningToInterrupted(new Date().toISOString())
    if (swept > 0) {
      console.log(`[Recovery] startup sweep: ${swept} residual running execution(s) → interrupted`)
    }
  }

  static async resumePendingExecutions(db: Database.Database): Promise<void> {
    const dao = new ExecutionDAO(pgSql())
    await RecoveryManager.resumePendingExecutions(dao)
  }
}
