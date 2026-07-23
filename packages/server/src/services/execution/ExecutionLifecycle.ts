// packages/server/src/services/execution/ExecutionLifecycle.ts
import type { ExecutionDAO } from "../../db/dao/execution-dao"
import type { ExecutionRow, NodeExecutionRow } from "../../db/types"
import type Database from "better-sqlite3"
import { EnginePool } from "./EnginePool"
import { EngineFactory } from "./EngineFactory"
import { EngineCallbacks as EngineCallbacksBuilder } from "./EngineCallbacks"
import { HookExecutor } from "./HookExecutor"
import { GitOperations } from "./GitOperations"
import { StateFileManager } from "./StateFileManager"
import { ExecutionQueryService } from "./ExecutionQueryService"
import { ExecutionRunner } from "./ExecutionRunner"
import { collectAllNodes, findNodeDef, findPausedNode, findFailedNode, findFailedNodeError, isWorkflowNodeId, ensureNodeExecutions, ensureNodeEdges } from "./NodeHelper"
import type { SSEService } from "../sse"
import type { WorkflowService } from "../workflow"
import type { BuiltInWorkflowService } from "../builtin-workflow"
import type { ObservabilityService } from "../observability"
import type { ErrorTracker } from "../error-tracker"
import type { KnowledgeService } from "../knowledge"
import type { HookDef, WorkflowDef, WorkflowHooks, PipelineConfig, ExecutionLookup } from "@octopus/shared"
import type { EngineCallbacks } from "@octopus/engine"
import { WorkflowEngine, FilesystemCheckpointStore, EngineInitPhase } from "@octopus/engine"
import { parseWorkflow, VarPool, parsePipelineConfig, CrossExecResolver, WorkflowRef } from "@octopus/shared"
import { gitOps } from "../git-ops"
import { ObservabilityService as ObsSvc } from "../observability"
import { PrivacyFilter } from "../privacy-filter"
import { getFlag } from "../../config/feature-flags"
import { generateSummary, formatDuration } from "../execution-summary"
import { getOrchestratorService } from "../agent/orchestrator-service"
import { resolveAllProjectNames } from "../knowledge/repo-resolver"
import { join } from "path"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { randomUUID } from "crypto"
import { ResourcePreFlight } from "../resource-preflight"
import { ResourceProvisioner } from "../resource-provisioner"
import { getResourceRegistry } from "../resource-registry"
import { PipelineConfigLoader } from "../pipeline-config"

export class ExecutionLifecycle {
  private enginePool: EnginePool
  private engineFactory: EngineFactory
  private callbacksBuilder: EngineCallbacksBuilder
  private hookExecutor: HookExecutor
  private gitOps: GitOperations
  private stateManager: StateFileManager
  private queryService: ExecutionQueryService
  private runner: ExecutionRunner
  private _externalCallbacks = new Map<string, Partial<EngineCallbacks>>()
  private knowledgeService?: KnowledgeService
  // Throttle retireStaleRules — only run at most once per RETIRE_INTERVAL_MS
  // across all executions. retireStaleRules scans the DB and rewrites
  // knowledge files for every stale rule, so calling it on every on_complete
  // is wasteful under high execution throughput.
  private lastRetireAt = 0
  private static readonly RETIRE_INTERVAL_MS = Number(
    process.env.OCTOPUS_KNOWLEDGE_RETIRE_INTERVAL_MS ?? 60 * 60 * 1000, // 1 hour
  )

  constructor(
    private db: Database.Database,
    private dao: ExecutionDAO,
    private sse: SSEService,
    private workflowService: WorkflowService,
    private builtInWorkflowService: BuiltInWorkflowService,
    private org: string,
    private workspacePath: string,
    private workspaceDbId: string,
    private workspaceId: string,
    private observability: ObservabilityService,
    private errorTracker?: ErrorTracker,
  ) {
    this.enginePool = new EnginePool()
    this.engineFactory = new EngineFactory(
      { db, sse, workflowService, builtInWorkflowService, org, workspacePath, workspaceDbId },
      dao,
      new PipelineConfigLoader(workspacePath),
      workspacePath,
    )
    this.gitOps = new GitOperations(workspacePath)
    this.stateManager = new StateFileManager(workspacePath, workspaceDbId, dao)
    this.queryService = new ExecutionQueryService({
      dao, sse, workflowService, builtInWorkflowService, workspacePath, workspaceId,
    })
    this.callbacksBuilder = new EngineCallbacksBuilder({
      ctx: { db, sse, workflowService, builtInWorkflowService, org, workspacePath, workspaceDbId },
      dao,
      enginePool: this.enginePool,
      observability,
      workspaceId,
      org,
      workspaceDbId,
      externalCallbacks: this._externalCallbacks,
      syncStateJson: () => this.syncStateJson(),
    })
    this.hookExecutor = new HookExecutor(
      { db, sse, workflowService, builtInWorkflowService, org, workspacePath, workspaceDbId },
      dao,
    )
    this.gitOps = new GitOperations(workspacePath)
    this.runner = new ExecutionRunner({
      dao, enginePool: this.enginePool, sse, workspaceId,
      updateStatus: (id, status, extra) => this.updateStatus(id, status, extra),
      cleanupOrphanedNodes: (id, fs) => this.cleanupOrphanedNodes(id, fs),
      executeWorkflowHooks: (event, ctx, wf, eid) => this.executeWorkflowHooks(event, ctx, wf, eid),
      getWorkflow: (ref) => this.getWorkflow(ref),
      findFailedNode: (eid) => this.findFailedNode(eid),
      findFailedNodeError: (eid) => this.findFailedNodeError(eid),
      findNodeDef: (nodes, nid) => this.findNodeDef(nodes, nid),
      syncStateJson: () => this.syncStateJson(),
      approve: (id, nid, ans, cmt) => this.approve(id, nid, ans, cmt),
      recordEndCommits: () => this.recordEndCommits(),
      abortAndWait: (ac, eid, t) => this.abortAndWait(ac, eid, t),
    })
  }

  /**
   * Set the knowledge service for injection and effectiveness tracking.
   */
  setKnowledgeService(service: KnowledgeService): void {
    this.knowledgeService = service
  }

  getEnginePool(): EnginePool { return this.enginePool }

  registerExternalCallbacks(callbacks: Partial<EngineCallbacks>, executionId?: string): void {
    if (executionId) {
      this._externalCallbacks.set(executionId, callbacks)
    } else {
      this._externalCallbacks.clear()
      this._externalCallbacks.set("__default__", callbacks)
    }
  }

  clearExternalCallbacks(executionId: string): void {
    this._externalCallbacks.delete(executionId)
  }

  // ==================== Start ====================

  async start(id: string, inputValues?: Record<string, string>, syncMainBranch?: boolean): Promise<ExecutionRow> {
    const exec = this.dao.findById(id)
    if (!exec) throw Object.assign(new Error("Execution not found"), { status: 404 })
    if (exec.status !== "pending") throw Object.assign(new Error("Execution is not pending"), { status: 400 })

    try { await this.drainPendingHooks() } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[start()] drainPendingHooks failed (non-fatal): ${msg}\n`)
    }

    const runningLeaf = this.dao.findFirstRunningLeaf(exec.workspace_id)
    if (runningLeaf && runningLeaf.id !== id) {
      throw Object.assign(new Error("已有叶子节点正在执行，请等待其完成"), { status: 409 })
    }

    const now = new Date().toISOString()
    this.updateStatus(id, "running", { started_at: now })

    if (inputValues) {
      this.dao.updateExecution(id, { input_values: JSON.stringify(inputValues) })
    }

    const wf = this.getWorkflow(exec.workflow_ref)
    if (!wf) throw Object.assign(new Error("Workflow not found"), { status: 404 })

    const stateDir = join(this.workspacePath, "state")
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true })
    const snapshotName = `${id}-${WorkflowRef.sanitize(exec.workflow_ref)}`
    writeFileSync(join(stateDir, snapshotName), wf.content, "utf-8")

    ensureNodeExecutions(this.dao, id, wf.parsed)
    ensureNodeEdges(this.dao, id, wf.parsed)

    const abortController = new AbortController()

    let resolvedInputValues = inputValues
    if (exec.parent_id && exec.parent_id !== "0") {
      const lookup: ExecutionLookup = {
        getById: (eid: string) => {
          const row = this.dao.findExecutionForLookup(eid)
          return row ? { parent_id: row.parent_id ?? undefined, var_pool: row.var_pool ?? undefined, input_values: row.input_values ?? undefined } : null
        },
        getNodeOutputs: (executionId: string, nodeId: string) => this.dao.findNodeOutputs(executionId, nodeId),
      }
      const resolver = new CrossExecResolver(lookup)

      const yamlInputDefaults: Record<string, string> = {}
      if (wf.parsed.inputs) {
        for (const [key, def] of Object.entries(wf.parsed.inputs)) {
          const inputDef = def as { default?: string; description?: string; required?: boolean }
          if (inputDef.default !== undefined && inputDef.default !== "") {
            yamlInputDefaults[key] = String(inputDef.default)
          }
        }
      }

      const mergedValues: Record<string, string> = { ...yamlInputDefaults, ...(inputValues ?? {}) }

      resolvedInputValues = {}
      for (const [key, value] of Object.entries(mergedValues)) {
        if (typeof value === "string" && (value.includes("$parent.") || value.includes("$ancestor["))) {
          resolvedInputValues[key] = resolver.resolve(value, id)
        } else {
          resolvedInputValues[key] = value
        }
      }
    }

    // Resolve project repo names for knowledge scope filtering
    const repoNames = resolveAllProjectNames(this.workspacePath)
    this.knowledgeService?.setExecutionContext(repoNames, wf.parsed.name)

    // Update input_values in DB before creating engine (factory reads from exec row)
    if (resolvedInputValues) {
      this.dao.updateExecution(id, { input_values: JSON.stringify(resolvedInputValues) })
    }
    const updatedExec = this.dao.findById(id)!

    const engine = this.engineFactory.createEngine(
      updatedExec as any, wf.parsed, this.buildCallbacks(id), abortController.signal,
    )

    this.enginePool.create(id, engine, abortController)

    let startCommitId = ""
    try {
      if (exec.node_type === "fork" && exec.branch) {
        await this.ensureCleanWorkspace()
        const parent = this.dao.findParentEndCommit(exec.parent_id)
        const baseCommit = parent?.end_commit_id ? JSON.parse(parent.end_commit_id) : {}
        await this.createForkBranch(exec.branch, baseCommit)
      }

      if (exec.branch) {
        await this.switchToExecutionBranch(exec.branch)
      }

      startCommitId = await this.recordStartCommits()
      this.dao.updateExecution(id, { start_commit_id: startCommitId })

      const pipelineConfig = this.loadPipelineConfig()
      this.dao.updateExecution(id, { pipeline_config: JSON.stringify(pipelineConfig) })
      const checkpointDir = join(this.workspacePath, ".octopus", "checkpoints")
      const checkpointStore = new FilesystemCheckpointStore(checkpointDir, pipelineConfig.checkpoint)
      const pipelinePath = join(this.workspacePath, "pipeline.yaml")
      engine.setPipelineConfig(pipelineConfig, checkpointStore, pipelinePath)

      try {
        const recentSummaries = this.dao.findRecentSummariesForInjection(exec.workflow_ref, this.workspaceDbId)
        if (recentSummaries.length > 0) {
          const historyText = recentSummaries.map((s, i) =>
            `### Run ${i + 1} (${s.created_at}, ${s.status}, ${formatDuration(s.duration_ms)})\n${s.summary}`
          ).join("\n\n")
          engine.updateVarPool({ _execution_history: historyText })
        }
      } catch { /* best-effort */ }

      engine.setRefResolver(this.createRefResolver())

      // ── engine_init virtual phase ──────────────────────────
      // Injects a virtual node that copies skills/agents and optionally syncs git
      // before the real workflow nodes execute. Reuses existing EngineCallbacks.
      const initNodeExecutionId = `${id}-__engine_init__`
      this.dao.insertNodeExecutionOrIgnore({
        id: initNodeExecutionId,
        execution_id: id,
        node_id: "__engine_init__",
        node_type: "bash",
        status: "pending",
      })

      const initPhase = new EngineInitPhase()
      const initResult = await initPhase.run({
        workspacePath: this.workspacePath,
        workflow: wf.parsed,
        callbacks: this.buildCallbacks(id),
        syncMainBranch: syncMainBranch ?? true,
        gitOps,
        resourcePreflight: new ResourcePreFlight(),
        resourceProvisioner: new ResourceProvisioner(getResourceRegistry().get()),
      })

      if (initResult.status === "failed") {
        this.updateStatus(id, "failed", { completed_at: new Date().toISOString() })
        this.syncStateJson()
        this.sse.emit(this.workspaceId, {
          event: "error",
          data: { executionId: id, nodeId: "__engine_init__", error: "engine_init phase failed" },
        })
        this.enginePool.remove(id)
        return this.dao.findById(id)!
      }

      // Track the in-flight run so pause/abort can wait for it to actually settle
      // (prevents resume from racing a still-running engine — see pause/resume bug).
      const settleRun = this.enginePool.startRun(id)
      let result
      try {
        result = await engine.run()
      } finally {
        settleRun()
      }

      if (result.status === "completed" || result.status === "completed_with_failures" || result.status === "cancelled" || result.status === "rejected") {
        this.enginePool.remove(id)
      }

      if (result.status === "pending_approval") {
        this.dao.updateExecution(id, { var_pool: JSON.stringify(result.poolSnapshot) })
        const pausedNodeId = this.findPausedNode(id)
        if (pausedNodeId) {
          const nodeDef = this.findNodeDef(wf.parsed.nodes, pausedNodeId)
          const timeout = nodeDef?.approval_timeout
          if (timeout && timeout > 0) {
            const timer = setTimeout(async () => {
              console.log(`[ExecutionLifecycle] Approval timeout for ${id}/${pausedNodeId}`)
              try { await this.approve(id, pausedNodeId, "timeout", "Auto-rejected by timeout") } catch (e) {
                console.error(`[ExecutionLifecycle] Timeout approval failed for ${id}`, e)
              }
            }, timeout * 1000)
            this.enginePool.setApprovalTimer(id, timer)
          }
        }
      }

      if (abortController.signal.aborted) {
        return this.dao.findById(id)!
      }

      if (result.status === "paused") {
        this.updateStatus(id, result.status, { progress: result.progress ?? 0, var_pool: JSON.stringify(result.poolSnapshot) })
        this.syncStateJson()
        this.sse.emit(this.workspaceId, { event: "execution_paused", data: { executionId: id } })
        this.enginePool.remove(id)
        return this.dao.findById(id)!
      }

      if (result.status === "pending_approval") {
        this.updateStatus(id, result.status, { progress: result.progress ?? 0, var_pool: JSON.stringify(result.poolSnapshot) })
        this.syncStateJson()
        const pausedNode = Object.values(result.nodeResults).find(r => r.status === "pending_approval" || r.status === "paused")
        const approval = pausedNode?.approvalMetadata ?? undefined
        this.sse.emit(this.workspaceId, { event: "execution_pending_approval", data: { executionId: id, approval } })
        this.enginePool.remove(id)
        return this.dao.findById(id)!
      }

      const currentExec = this.dao.findById(id)
      if (currentExec?.status === "paused") {
        const nodeStats = this.dao.findNodeStatsForExecution(id)
        if (nodeStats.running_or_pending === 0) {
          console.log(`[ExecutionLifecycle] Execution ${id} was paused but all nodes completed, updating to ${result.status}`)
        } else {
          console.log(`[ExecutionLifecycle] Execution ${id} was paused and ${nodeStats.running_or_pending} nodes still running/pending, keeping paused status`)
          this.syncStateJson()
          return this.dao.findById(id)!
        }
      }

      const endCommitId = await this.recordEndCommits()
      this.dao.updateExecution(id, { end_commit_id: endCommitId })

      this.updateStatus(id, result.status, {
        completed_at: new Date().toISOString(),
        duration: result.durationMs,
        progress: 100,
        var_pool: JSON.stringify(result.poolSnapshot),
        gate_status: result.status === "completed" ? "open" : "closed",
      })

      this.cleanupOrphanedNodes(id, result.status)

      if (result.status === "failed") {
        this.errorTracker?.capture('execution', this.findFailedNodeError(id) ?? 'workflow execution failed', {
          execution_id: id, node_id: this.findFailedNode(id) ?? undefined, workflow_name: wf.parsed.name,
        })
        await this.executeWorkflowHooks("on_workflow_failure", {
          failed_node_id: this.findFailedNode(id),
          error: this.findFailedNodeError(id),
          duration_ms: result.durationMs,
        }, wf, id)
      }
      if (result.status === "completed") {
        await this.executeWorkflowHooks("on_success", { duration_ms: result.durationMs }, wf, id)
      }
      await this.executeWorkflowHooks("on_complete", { final_status: result.status, duration_ms: result.durationMs }, wf, id)

      // Track knowledge effectiveness after execution completes
      if (this.knowledgeService) {
        try {
          const execResult = {
            id,
            status: result.status,
            nodes: Object.fromEntries(
              Object.entries(result.nodeResults).map(([nodeId, r]) => [nodeId, {
                status: r.status,
                exitCode: r.exitCode ?? null,
                lastOutput: r.lastOutput ?? null,
              }])
            ),
            poolSnapshot: result.poolSnapshot,
          }
          const tracked = this.knowledgeService.trackExecutionEffectiveness(execResult)
          if (tracked > 0) {
            console.log(`[ExecutionLifecycle] Tracked effectiveness for ${tracked} rules in execution ${id}`)
          }
          // Throttled retire: run at most once per RETIRE_INTERVAL_MS.
          // Effectiveness tracking runs on every execution (cheap DB write);
          // retireStaleRules does DB scan + file rewrites and should not.
          const now = Date.now()
          if (now - this.lastRetireAt >= ExecutionLifecycle.RETIRE_INTERVAL_MS) {
            this.lastRetireAt = now
            try {
              const retired = this.knowledgeService.retireStaleRules()
              if (retired > 0) {
                console.log(`[ExecutionLifecycle] Retired ${retired} stale rules`)
              }
            } catch (retireErr) {
              console.warn(`[ExecutionLifecycle] retireStaleRules failed:`, retireErr)
            }
          }
        } catch (err) {
          console.warn(`[ExecutionLifecycle] Knowledge effectiveness tracking failed:`, err)
        }
      }

      try {
        const summary = generateSummary(wf.parsed.name, result.status, result.nodeResults, result.durationMs)
        const failedNodeIds = Object.entries(result.nodeResults).filter(([_, r]) => r.status === "failed").map(([nodeId]) => nodeId)
        this.dao.insertSummary({
          id: randomUUID(), execution_id: id, workflow_ref: exec.workflow_ref,
          workspace_id: this.workspaceDbId, summary, status: result.status,
          duration_ms: result.durationMs, failed_nodes: JSON.stringify(failedNodeIds),
        })
      } catch (summaryErr: unknown) {
        const msg = summaryErr instanceof Error ? summaryErr.message : String(summaryErr)
        console.error(`[ExecutionLifecycle] Summary generation failed for ${id}: ${msg}`)
      }

      this.syncStateJson()
      this.sse.emit(this.workspaceId, { event: "complete", data: { executionId: id, finalStatus: result.status } })
    } catch (err: any) {
      this.errorTracker?.capture('execution', err.message ?? 'execution error', {
        execution_id: id, node_id: this.findFailedNode(id) ?? undefined, workflow_name: exec.workflow_name,
      })
      this.clearExternalCallbacks(id)

      if (abortController.signal.aborted) {
        this.enginePool.remove(id)
        return this.dao.findById(id)!
      }

      await this.abortAndWait(abortController, id)

      if (exec.rollback_on_error === 1) {
        try { await this.rollbackToStart(startCommitId) } catch (rollbackErr: any) {
          this.errorTracker?.capture('execution', `rollback failed: ${rollbackErr.message}`, {
            execution_id: id, workflow_name: exec.workflow_name,
          })
          console.error(`[ExecutionLifecycle] Rollback failed for ${id}:`, rollbackErr.message)
        }
        this.dao.updateExecution(id, { end_commit_id: startCommitId })
      } else {
        const endCommitId = await this.recordEndCommits()
        this.dao.updateExecution(id, { end_commit_id: endCommitId })
      }

      this.updateStatus(id, "failed", { completed_at: new Date().toISOString() })
      this.dao.updateNodeExecutionsByStatus(id, "failed", ["running", "pending"], { error: err.message })
      this.syncStateJson()
      this.sse.emit(this.workspaceId, { event: "error", data: { executionId: id, error: err.message } })

      try {
        await this.executeWorkflowHooks("on_workflow_failure", {
          failed_node_id: this.findFailedNode(id), error: err.message, duration_ms: 0,
        }, wf, id)
        await this.executeWorkflowHooks("on_complete", { final_status: "failed" }, wf, id)
      } catch { /* hook errors silently ignored */ }
    }

    return this.dao.findById(id)!
  }

  // ==================== Cancel ====================

  async cancel(id: string): Promise<ExecutionRow> {
    const exec = this.dao.findById(id)
    if (!exec) throw Object.assign(new Error("Execution not found"), { status: 404 })
    if (!["running", "paused", "pending_approval", "pending_resume"].includes(exec.status))
      throw Object.assign(new Error("Cannot cancel in current status"), { status: 400 })

    const now = new Date().toISOString()
    this.enginePool.cancel(id)
    this.updateStatus(id, "cancelled", { completed_at: now })
    this.clearExternalCallbacks(id)
    this.syncStateJson()

    const runningNodes = this.dao.findRunningNodeExecutionsByStatus(id, ["running", "pending", "paused"])
    for (const ne of runningNodes) {
      this.updateNodeStatus(ne.id, "cancelled")
    }

    const wf = this.getWorkflow(exec.workflow_ref)
    if (wf) {
      try {
        await this.executeWorkflowHooks("on_cancel", {}, wf, id)
        await this.executeWorkflowHooks("on_complete", { final_status: "cancelled" }, wf, id)
      } catch { /* non-fatal */ }
    }

    const children = this.dao.findChildren(id).filter(
      (c) => ["pending", "running", "paused", "pending_approval"].includes(c.status)
    )
    for (const child of children) {
      try { await this.cancel(child.id) } catch { /* may already be cancelled */ }
    }

    return this.dao.findById(id)!
  }

  // ==================== Retry ====================

  async retry(id: string, failedNodeId: string, inputValues?: Record<string, string>, intervention?: string): Promise<ExecutionRow> {
    const exec = this.dao.findById(id)
    if (!exec) throw Object.assign(new Error("Execution not found"), { status: 404 })
    if (exec.status !== "failed") throw Object.assign(new Error("Only failed executions can be retried"), { status: 400 })

    if (!failedNodeId || !this.isWorkflowNodeId(exec.workflow_ref, failedNodeId)) {
      const failedNode = this.dao.findFirstNodeByStatus(id, "failed")
      if (failedNode) failedNodeId = failedNode.node_id
    }
    console.log(`[ExecutionLifecycle] Retry ${id}: failedNodeId="${failedNodeId}"`)

    let inst = this.enginePool.get(id)
    let retryStartCommitId = ""

    try {
      if (!inst) {
        inst = this.reconstructEngine(exec)
        this.enginePool.create(id, inst.engine, inst.abortController)
      }

      this.updateStatus(id, "running", { started_at: new Date().toISOString() })

      // Clean up orphaned node_executions (stuck "running"/"pending" from crash)
      this.dao.updateNodeExecutionsByStatus(id, "failed", ["running", "pending"], { error: "重试前清理: 孤立节点" })

      if (inputValues) {
        this.dao.updateExecution(id, { input_values: JSON.stringify(inputValues) })
        inst.engine.updateVarPool(inputValues)
      }

      retryStartCommitId = await this.recordStartCommits()
      this.dao.updateExecution(id, { start_commit_id: retryStartCommitId })

      this.dao.incrementRetryCount(id)
      const retryCount = this.dao.getRetryCount(id)

      const wfForHook = this.getWorkflow(exec.workflow_ref)
      if (wfForHook) {
        try {
          await this.executeWorkflowHooks("on_retry", { retry_node_id: failedNodeId, retry_count: retryCount }, wfForHook, id)
        } catch { /* non-fatal */ }
      }

      const settleRun = this.enginePool.startRun(id)
      let result
      try {
        result = await inst.engine.retryFrom(failedNodeId, { signal: inst.abortController.signal, intervention })
      } finally {
        settleRun()
      }

      if (result.status === "completed" || result.status === "completed_with_failures" || result.status === "cancelled" || result.status === "rejected") {
        this.enginePool.remove(id)
      }

      if (result.status === "pending_approval") {
        this.updateStatus(id, result.status, { var_pool: JSON.stringify(result.poolSnapshot) })
        this.syncStateJson()
        this.sse.emit(this.workspaceId, { event: "complete", data: { executionId: id, finalStatus: result.status } })
      } else {
        const currentExec = this.dao.findById(id)
        if (currentExec?.status === "paused") {
          const nodeStats = this.dao.findNodeStatsForExecution(id)
          if (nodeStats.running_or_pending === 0) {
            console.log(`[ExecutionLifecycle] Execution ${id} was paused but all nodes completed during retry, updating to ${result.status}`)
          } else {
            console.log(`[ExecutionLifecycle] Execution ${id} was paused and ${nodeStats.running_or_pending} nodes still running/pending during retry, keeping paused status`)
            this.syncStateJson()
            return this.dao.findById(id)!
          }
        }

        const endCommitId = await this.recordEndCommits()
        this.dao.updateExecution(id, { end_commit_id: endCommitId })

        this.updateStatus(id, result.status, {
          completed_at: new Date().toISOString(), duration: result.durationMs, progress: 100,
          var_pool: JSON.stringify(result.poolSnapshot),
          gate_status: result.status === "completed" ? "open" : "closed",
        })

        this.cleanupOrphanedNodes(id, result.status)

        if (wfForHook) {
          if (result.status === "failed") {
            await this.executeWorkflowHooks("on_workflow_failure", {
              failed_node_id: this.findFailedNode(id), error: this.findFailedNodeError(id), duration_ms: result.durationMs,
            }, wfForHook, id)
          }
          if (result.status === "completed") {
            await this.executeWorkflowHooks("on_success", { duration_ms: result.durationMs }, wfForHook, id)
          }
          await this.executeWorkflowHooks("on_complete", { final_status: result.status, duration_ms: result.durationMs }, wfForHook, id)
        }

        this.syncStateJson()
        this.sse.emit(this.workspaceId, { event: "complete", data: { executionId: id, finalStatus: result.status } })
      }
    } catch (err: any) {
      this.enginePool.remove(id)
      if (inst) await this.abortAndWait(inst.abortController, id)

      if (exec.rollback_on_error === 1) {
        try { await this.rollbackToStart(retryStartCommitId) } catch (rollbackErr: any) {
          console.error(`[ExecutionLifecycle] Rollback failed for ${id}:`, rollbackErr.message)
        }
        this.dao.updateExecution(id, { end_commit_id: retryStartCommitId || exec.start_commit_id || "{}" })
      } else {
        try {
          const endCommitId = await this.recordEndCommits()
          this.dao.updateExecution(id, { end_commit_id: endCommitId })
        } catch (commitErr: any) {
          console.error(`[ExecutionLifecycle] recordEndCommits failed for ${id}:`, commitErr.message)
        }
      }

      this.updateStatus(id, "failed", { completed_at: new Date().toISOString() })
      this.dao.updateNodeExecutionsByStatus(id, "failed", ["running", "pending"], { error: `Retry failed: ${err.message}` })
      this.syncStateJson()
      console.error(`[ExecutionLifecycle] Retry failed for ${id}:`, err.message)
      this.sse.emit(this.workspaceId, { event: "error", data: { executionId: id, error: err.message } })

      try {
        const wfForHook = this.getWorkflow(exec.workflow_ref)
        if (wfForHook) {
          await this.executeWorkflowHooks("on_workflow_failure", { failed_node_id: this.findFailedNode(id), error: err.message }, wfForHook, id)
          await this.executeWorkflowHooks("on_complete", { final_status: "failed" }, wfForHook, id)
        }
      } catch { /* non-fatal */ }
    }

    return this.dao.findById(id)!
  }

  // ==================== Approve ====================

  async approve(id: string, nodeId: string, answer: string, comment?: string): Promise<ExecutionRow> {
    const exec = this.dao.findById(id)
    if (!exec) throw Object.assign(new Error("Execution not found"), { status: 404 })
    if (exec.status !== "pending_approval") throw Object.assign(new Error("执行不在待审批状态"), { status: 400 })

    const neId = `${id}-${nodeId}`
    const ne = this.dao.findNodeExecutionById(neId)
    if (!ne) throw Object.assign(new Error("Node execution not found"), { status: 404 })

    if (answer === "reject") {
      const wf = this.getWorkflow(exec.workflow_ref)
      const nodeDef = this.findNodeDef(wf?.parsed.nodes ?? [], nodeId)
      const onRejectNodeId = nodeDef?.on_reject

      if (onRejectNodeId) {
        console.log(`[ExecutionLifecycle] Approval rejected, executing on_reject handler: ${onRejectNodeId}`)
        this.enginePool.clearApprovalTimer(id)

        let inst = this.enginePool.get(id)
        if (!inst) {
          inst = this.reconstructEngine(exec)
          this.enginePool.create(id, inst.engine, inst.abortController)
        }

        this.updateNodeStatus(neId, "rejected", { completed_at: new Date().toISOString() })
        this.updateStatus(id, "running")
        this.dao.updateExecution(id, { approval_metadata: null as any })

        if (comment) inst.engine.updateVarPool({ APPROVAL_COMMENT: comment })

        this.runRejectInBackground(id, nodeId, onRejectNodeId, inst.abortController.signal, comment, exec.workflow_ref)
        return this.dao.findById(id)!
      } else {
        this.updateNodeStatus(neId, "rejected", { error: "Rejected by user" })
        this.updateStatus(id, "rejected", { completed_at: new Date().toISOString() })
        this.dao.updateExecution(id, { approval_metadata: null as any })
        this.dao.updateNodeExecutionsByStatus(id, "skipped", ["pending"])
        this.dao.updateNodeExecutionsByStatus(id, "cancelled", ["paused"])
        if (wf) {
          try { await this.executeWorkflowHooks("on_complete", { final_status: "rejected" }, wf, id) } catch { /* non-fatal */ }
        }
        this.syncStateJson()
        this.sse.emit(this.workspaceId, { event: "complete", data: { executionId: id, finalStatus: "rejected" } })
        this.enginePool.remove(id)
        return this.dao.findById(id)!
      }
    }

    this.enginePool.clearApprovalTimer(id)

    let inst = this.enginePool.get(id)
    if (!inst) {
      inst = this.reconstructEngine(exec)
      this.enginePool.create(id, inst.engine, inst.abortController)
    }

    this.updateNodeStatus(neId, "completed", { completed_at: new Date().toISOString() })
    this.updateStatus(id, "running")
    this.dao.updateExecution(id, { approval_metadata: null as any })

    this.sse.emit(this.workspaceId, { event: "execution_status", data: { executionId: id, status: "running" } })

    this.runApproveInBackground(id, nodeId, inst.abortController.signal, answer, comment, exec.workflow_ref)

    return this.dao.findById(id)!
  }

  // ==================== Pause / Resume ====================

  async pause(executionId: string): Promise<{ success: boolean; error?: string }> {
    const exec = this.dao.findById(executionId)
    if (!exec) return { success: false, error: "执行不存在" }
    if (exec.status !== "running") return { success: false, error: "执行未在运行中" }

    const runningNode = this.dao.findFirstRunningNode(executionId)

    if (runningNode) {
      this.dao.updateNodeExecution(runningNode.id, { status: "paused" })
    }

    this.dao.updateExecution(executionId, { status: "paused" })

    const inst = this.enginePool.get(executionId)
    if (inst && runningNode) {
      inst.engine.pauseAtNode(runningNode.node_id)
      await this.abortAndWait(inst.abortController, executionId)
    }

    this.sse.emit(this.workspaceId, { event: "execution_paused", data: { executionId, nodeId: runningNode?.node_id } })
    return { success: true }
  }

  async resume(executionId: string, intervention?: string): Promise<{ success: boolean; error?: string }> {
    const exec = this.dao.findById(executionId)
    if (!exec) return { success: false, error: "执行不存在" }

    // pending_resume → triage interrupted nodes to paused, then fall through to normal resume
    if (exec.status === "pending_resume") {
      this.dao.updateNodeExecutionsByStatus(executionId, "paused", ["running", "pending", "failed"])
      this.dao.updateExecution(executionId, { status: "paused" })
    }

    if (exec.status !== "paused" && exec.status !== "pending_resume") return { success: false, error: "执行未处于暂停状态" }

    const pausedNodes = this.dao.findRunningNodeExecutionsByStatus(executionId, ["paused"])
    const pausedNode = pausedNodes.length > 0 ? pausedNodes[0] : null
    if (!pausedNode) return { success: false, error: "未找到暂停节点" }

    let inst = this.enginePool.get(executionId)
    if (!inst) {
      inst = this.reconstructEngine(exec)
      this.enginePool.create(executionId, inst.engine, inst.abortController)
    } else {
      inst.abortController = new AbortController()
      inst.engine.updateSignal(inst.abortController.signal)
    }

    this.dao.updateExecution(executionId, { status: "running" })
    this.dao.updateNodeExecution(pausedNode.id, { status: "running" })

    this.sse.emit(this.workspaceId, { event: "execution_status", data: { executionId, status: "running" } })

    const nodeId = pausedNode.node_id
    const signal = inst.abortController.signal
    const workflowRef = exec.workflow_ref

    this.runResumeInBackground(executionId, nodeId, signal, intervention, workflowRef)

    return { success: true }
  }

  // ==================== Skip ====================

  skip(id: string): boolean {
    const exec = this.dao.findById(id)
    if (!exec) throw Object.assign(new Error("Execution not found"), { status: 404 })
    this.dao.updateExecution(id, { gate_status: "bypassed" })
    this.syncStateJson()
    return true
  }

  // ==================== Branch computation ====================

  computeBranch(workspaceId: string, parentId: string | null | undefined, nodeType: string, newExecId: string): string | null {
    const isRoot = !parentId || parentId === "0"
    if (isRoot) {
      const configPath = join(this.workspacePath, "config.json")
      try {
        const config = JSON.parse(readFileSync(configPath, "utf-8"))
        return config.init_branch_name || config.branch || "main"
      } catch {
        return "main"
      }
    }
    const parent = this.dao.findById(parentId!)
    if (!parent || parent.workspace_id !== workspaceId) {
      throw new Error(`parent_id "${parentId}" not found in workspace "${workspaceId}".`)
    }
    if (nodeType === "fork") {
      return `${parent.branch}-fork-${newExecId.substring(0, 8)}`
    }
    return parent.branch
  }

  resolveWorkflowName(workflowRef: string): string {
    const local = this.workflowService.get(this.workspacePath, workflowRef)
    if (local?.parsed?.name) return local.parsed.name
    const builtIn = this.builtInWorkflowService.get(workflowRef)
    if (builtIn?.parsed?.name) return builtIn.parsed.name
    return workflowRef
  }

  // ==================== Pending Hooks / Auto-resume ====================

  async drainPendingHooks(): Promise<void> {
    const pendingRows = this.dao.findPendingHooksForWorkspace(this.workspaceDbId)
    if (pendingRows.length === 0) return

    for (const row of pendingRows) {
      let hooks: HookDef[] = []
      try { hooks = JSON.parse(row.pending_hooks) as HookDef[] } catch {
        this.dao.updateExecution(row.id, { pending_hooks: "[]" })
        continue
      }

      if (!Array.isArray(hooks) || hooks.length === 0) {
        this.dao.updateExecution(row.id, { pending_hooks: "[]" })
        continue
      }

      const wf = this.getWorkflow(row.workflow_ref)
      if (!wf) {
        process.stderr.write(`[DrainPendingHooks] Workflow not found for ${row.id}: ${row.workflow_ref}, discarding ${hooks.length} deferred hooks\n`)
        this.dao.updateExecution(row.id, { pending_hooks: "[]" })
        continue
      }

      // Construct a synthetic workflow with the pending hooks as on_interrupt handlers
      const syntheticWf = { parsed: { ...wf.parsed, hooks: { on_interrupt: hooks } as any } }
      try {
        await this.hookExecutor.executeWorkflowHooks(
          "on_interrupt", {
            last_status: "running", interrupt_reason: "服务重启中断",
          }, syntheticWf, row.id,
        )
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`[DrainPendingHooks] Hook execution failed for ${row.id}: ${msg}\n`)
      }

      this.dao.updateExecution(row.id, { pending_hooks: "[]" })
    }
  }

  async autoResume(execId: string): Promise<void> {
    const exec = this.dao.findById(execId)
    if (!exec || exec.status !== "pending_resume") return

    const lastFailed = this.dao.findFirstNodeByStatus(execId, "failed")

    if (lastFailed) {
      this.dao.updateExecution(execId, { status: "running" })
      const inst = this.reconstructEngine(exec)
      this.enginePool.create(execId, inst.engine, inst.abortController)

      const wfForHook = this.getWorkflow(exec.workflow_ref)
      try {
        const settleRun = this.enginePool.startRun(execId)
        let result
        try {
          result = await inst.engine.retryFrom(lastFailed.node_id, { signal: inst.abortController.signal })
        } finally {
          settleRun()
        }

        if (result.status === "completed" || result.status === "completed_with_failures" || result.status === "cancelled" || result.status === "rejected") {
          this.enginePool.remove(execId)
        }

        try {
          const endCommitId = await this.recordEndCommits()
          this.dao.updateExecution(execId, { end_commit_id: endCommitId })
        } catch { /* non-fatal */ }

        this.updateStatus(execId, result.status, {
          completed_at: new Date().toISOString(), duration: result.durationMs, progress: 100,
          var_pool: JSON.stringify(result.poolSnapshot),
          gate_status: result.status === "completed" ? "open" : "closed",
        })

        this.cleanupOrphanedNodes(execId, result.status)

        if (wfForHook) {
          if (result.status === "completed") {
            await this.executeWorkflowHooks("on_success", { duration_ms: result.durationMs }, wfForHook, execId)
          }
          await this.executeWorkflowHooks("on_complete", { final_status: result.status, duration_ms: result.durationMs }, wfForHook, execId)
        }

        this.syncStateJson()
        this.sse.emit(this.workspaceId, { event: "complete", data: { executionId: execId, finalStatus: result.status } })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        this.enginePool.remove(execId)
        this.dao.updateExecution(execId, { status: "failed" })
        this.dao.updateNodeExecutionsByStatus(execId, "failed", ["running", "pending"], { error: `Auto-resume failed: ${msg}` })
        console.error(`[Recovery] Auto-resume execution failed for ${execId}: ${msg}`)
      }
    } else {
      const lastRunning = this.dao.findFirstNodeByStatus(execId, "running") ||
        this.dao.findFirstNodeByStatus(execId, "pending")
      if (lastRunning) {
        const pausedNodes = this.dao.findRunningNodeExecutionsByStatus(execId, ["running", "pending"])
        for (const n of pausedNodes) {
          this.dao.updateNodeExecution(n.id, { status: "paused" })
        }
        this.dao.updateExecution(execId, { status: "paused" })
        await this.resume(execId)
      } else {
        this.dao.updateExecution(execId, { status: "failed" })
        console.log(`[Recovery] ${execId} has no resumable nodes → failed`)
      }
    }
  }

  private async runResumeInBackground(
    executionId: string, nodeId: string, signal: AbortSignal,
    intervention: string | undefined, workflowRef: string,
  ): Promise<void> {
    return this.runner.runResumeInBackground(executionId, nodeId, signal, intervention, workflowRef)
  }

  private async runApproveInBackground(
    executionId: string, nodeId: string, signal: AbortSignal,
    answer: string, comment: string | undefined, workflowRef: string,
  ): Promise<void> {
    return this.runner.runApproveInBackground(executionId, nodeId, signal, answer, comment, workflowRef)
  }

  private async runRejectInBackground(
    executionId: string, approvalNodeId: string, onRejectNodeId: string,
    signal: AbortSignal, comment: string | undefined, workflowRef: string,
  ): Promise<void> {
    return this.runner.runRejectInBackground(executionId, approvalNodeId, onRejectNodeId, signal, comment, workflowRef)
  }

  // ==================== Helpers ====================

  private updateStatus(id: string, status: string, extra: Record<string, unknown> = {}): void {
    try {
      const fields: Record<string, unknown> = { status, ...extra }
      this.dao.updateExecution(id, fields)
      this.sse.emit(this.workspaceId, { event: "execution_status", data: { executionId: id, status } })
    } catch (err: any) {
      console.error(`[ExecutionLifecycle] updateStatus failed: ${id} → ${status}:`, err.message)
      throw err
    }
  }

  private updateNodeStatus(neId: string, status: string, extra: Record<string, unknown> = {}): void {
    const fields: Record<string, unknown> = { status, ...extra }
    this.dao.updateNodeExecution(neId, fields)
  }

  private cleanupOrphanedNodes(id: string, finalStatus: string): void {
    if (finalStatus === "failed") {
      this.dao.updateNodeExecutionsByStatus(id, "failed", ["running", "pending", "paused"])
    } else if (finalStatus === "completed" || finalStatus === "completed_with_failures" || finalStatus === "rejected") {
      this.dao.updateNodeExecutionsByStatus(id, "skipped", ["pending"])
      this.dao.updateNodeExecutionsByStatus(id, "cancelled", ["paused"])
    } else if (finalStatus === "cancelled") {
      this.dao.updateNodeExecutionsByStatus(id, "cancelled", ["running", "pending", "paused"])
    }
  }

  private getWorkflow(ref: string): { ref: string; content: string; parsed: any } | undefined {
    const local = this.workflowService.get(this.workspacePath, ref)
    if (local) return local
    const builtIn = this.builtInWorkflowService.get(ref)
    if (builtIn) return builtIn
    return undefined
  }

  private loadPipelineConfig(): PipelineConfig {
    const pipelinePath = join(this.workspacePath, "pipeline.yaml")
    if (!existsSync(pipelinePath)) {
      return parsePipelineConfig({ apiVersion: "octopus/v1", kind: "Pipeline" })
    }
    const content = readFileSync(pipelinePath, "utf8")
    return parsePipelineConfig(content)
  }

  private async abortAndWait(abortController: AbortController, executionId?: string, timeoutMs = 300000): Promise<void> {
    return this.runner.abortAndWait(abortController, executionId, timeoutMs)
  }

  private findPausedNode(executionId: string): string | null {
    return findPausedNode(this.dao, executionId)
  }

  private findFailedNode(executionId: string): string {
    return findFailedNode(this.dao, executionId)
  }

  private findFailedNodeError(executionId: string): string {
    return findFailedNodeError(this.dao, executionId)
  }

  private findNodeDef(nodes: any[], nodeId: string): any | null {
    return findNodeDef(nodes, nodeId)
  }

  private isWorkflowNodeId(workflowRef: string, nodeId: string): boolean {
    return isWorkflowNodeId((ref) => this.getWorkflow(ref), workflowRef, nodeId)
  }

  syncStateJson(): void {
    this.stateManager.syncStateJson()
  }

  // ==================== CRUD delegation (from Facade) ====================

  create(
    workspaceId: string,
    input: {
      workflow_ref: string; name?: string; parent_id?: string | null;
      child_index?: number; node_type?: string; input_values?: Record<string, unknown>;
      triggered_by?: string; initial_var_pool?: Record<string, string>;
    },
    org: string,
  ): ExecutionRow {
    const id = randomUUID()
    const now = new Date().toISOString()
    const isRootRequest = !input.parent_id || input.parent_id === "0"
    const nodeType = input.node_type ?? "normal"

    if (isRootRequest) {
      const existingRoot = this.dao.findRootExecutionId(workspaceId)
      if (existingRoot) throw new Error(`Workspace already has a root execution (${existingRoot.id}).`)
    }

    const branch = this.computeBranch(workspaceId, input.parent_id, nodeType, id)
    const workflowName = this.resolveWorkflowName(input.workflow_ref)

    const varPoolJson = input.initial_var_pool ? JSON.stringify(input.initial_var_pool) : "{}"
    const inputValuesJson = JSON.stringify(input.input_values ?? {})

    this.dao.insertExecution({
      id, workspace_id: workspaceId, parent_id: input.parent_id ?? "0",
      child_index: input.child_index ?? 0, workflow_ref: input.workflow_ref,
      workflow_name: workflowName, name: input.name || workflowName,
      status: "pending", input_values: inputValuesJson, var_pool: varPoolJson,
      triggered_by: input.triggered_by ?? "manual",
      node_type: nodeType, branch, org,
      created_at: now, updated_at: now,
    })

    const exec = this.dao.findById(id)!
    this.sse.emit(workspaceId, { event: "execution_created", data: { executionId: id, treeNodeId: id } })
    this.syncStateJson()
    return exec as ExecutionRow
  }

  delete(executionId: string): boolean {
    this.dao.cascadeDeleteExecution(executionId)
    this.sse.emit(this.workspaceId, {
      event: "execution_deleted", data: { executionId },
    })
    return true
  }

  // ==================== Logs / Events delegation (from Facade) ====================

  getLogEvents(executionId: string): { type: string; timestamp: string; data: Record<string, unknown> }[] {
    return this.queryService.getLogEvents(executionId)
  }

  getAgentEvents(executionId: string, nodeId?: string, loopId?: string, iteration?: number): any[] {
    return this.queryService.getAgentEvents(executionId, nodeId, loopId, iteration)
  }

  getLoopIterationSummary(executionId: string): Record<string, any> {
    return this.queryService.getLoopIterationSummary(executionId)
  }

  getWorkflowContent(executionId: string): string | null {
    return this.queryService.getWorkflowContent(executionId)
  }

  getStateJson(executionId: string): Record<string, unknown> | null {
    return this.stateManager.getStateJson(executionId)
  }

  streamEvents(req: Request): Response {
    return this.queryService.streamEvents(req)
  }

  // ==================== Resume listener ====================

  private _resumeListener: ((execId: string) => Promise<void>) | null = null

  setupResumeListener(): void {
    this._resumeListener = async (execId: string) => {
      const exec = this.dao.findById(execId)
      if (!exec || exec.status !== "pending_resume") return
      if (exec.workspace_id !== this.workspaceDbId) return
      await this.autoResume(execId)
    }
    process.on("octopus:resume-execution" as any, this._resumeListener as any)
  }

  destroyResumeListener(): void {
    if (this._resumeListener) {
      process.removeListener("octopus:resume-execution" as any, this._resumeListener as any)
      this._resumeListener = null
    }
  }

  // ==================== Git operations ====================

  private async ensureCleanWorkspace(): Promise<Record<string, string>> {
    return this.gitOps.ensureCleanWorkspace()
  }

  private async createForkBranch(branchName: string, baseCommit: Record<string, string>): Promise<void> {
    return this.gitOps.createForkBranch(branchName, baseCommit)
  }

  private async switchToExecutionBranch(branch: string): Promise<void> {
    return this.gitOps.switchToExecutionBranch(branch)
  }

  private async recordStartCommits(): Promise<string> {
    return this.gitOps.recordStartCommits()
  }

  private async recordEndCommits(): Promise<string> {
    return this.gitOps.recordEndCommits()
  }

  private async rollbackToStart(startCommitId: string): Promise<void> {
    return this.gitOps.rollbackToStart(startCommitId)
  }

  // ==================== Engine reconstruction ====================

  private reconstructEngine(exec: ExecutionRow): { engine: WorkflowEngine; abortController: AbortController } {
    const abortController = new AbortController()
    const callbacks = this.buildCallbacks(exec.id)
    const engine = this.engineFactory.reconstructEngine(exec, callbacks, abortController.signal)

    const wf = this.engineFactory.resolveWorkflowWithSnapshot(exec.id, exec.workflow_ref)
    if (!wf) throw new Error(`Workflow not found: ${exec.workflow_ref}`)

    const completedNodes = this.dao.findCompletedNodeExecutions(exec.id)
    for (const node of completedNodes) {
      // Restore skippedByCondition: skipped nodes with execute_when were intentional skips,
      // downstream dependents should NOT cascade-skip from them.
      const nodeDef = node.status === "skipped" ? this.findNodeDef(wf.parsed.nodes, node.node_id) : null
      engine.setNodeResult(node.node_id, {
        status: node.status,
        outputs: JSON.parse(node.outputs || "{}"),
        durationMs: node.duration ?? 0,
        logLines: [], error: node.error ?? undefined,
        sessionId: node.session_id ?? undefined,
        skippedByCondition: !!(nodeDef?.execute_when),
      })
    }

    const sessionNodes = this.dao.findSessionNodes(exec.id)
    let globalSessionId: string | undefined
    const branchSessionIds = new Map<string, string>()

    if (sessionNodes.length > 0) {
      const nodeContextMap = new Map<string, "continue" | "new">()
      for (const n of collectAllNodes(wf.parsed.nodes)) {
        const nodeDef = this.findNodeDef(wf.parsed.nodes, n.id)
        if (nodeDef && nodeDef.type === "agent") {
          nodeContextMap.set(n.id, nodeDef.context ?? "continue")
        }
      }

      for (const sn of sessionNodes) {
        const context = nodeContextMap.get(sn.node_id)
        if (context === "new") {
          if (!branchSessionIds.has(sn.node_id)) branchSessionIds.set(sn.node_id, sn.session_id)
        } else if (!globalSessionId) {
          globalSessionId = sn.session_id
        }
      }
    }

    if (!globalSessionId && exec.global_session_id) {
      globalSessionId = exec.global_session_id
    }

    engine.restoreSessionContext(globalSessionId, branchSessionIds)
    engine.setRefResolver(this.createRefResolver())

    return { engine, abortController }
  }

  // ==================== Cross-execution resolver ====================

  createRefResolver(): (refPath: string) => any {
    const cache = new Map<string, Record<string, any>>()

    return (refPath: string): any => {
      const lastDot = refPath.lastIndexOf(".")
      if (lastDot === -1) return undefined
      const outputKey = refPath.slice(lastDot + 1)
      const rest = refPath.slice(0, lastDot)
      const secondLastDot = rest.lastIndexOf(".")
      if (secondLastDot === -1) return undefined
      const nodeId = rest.slice(secondLastDot + 1)
      const workflowRef = rest.slice(0, secondLastDot)

      if (!workflowRef || !nodeId || !outputKey) return undefined

      const cacheKey = `${workflowRef}.${nodeId}`
      let outputs = cache.get(cacheKey)

      if (!outputs) {
        const row = this.dao.findCrossExecOutputs(workflowRef, nodeId, this.workspaceDbId)
        if (!row?.outputs) return undefined
        try { outputs = JSON.parse(row.outputs) } catch { return undefined }
        cache.set(cacheKey, outputs!)
      }

      return outputs![outputKey]
    }
  }

  // ==================== Engine callbacks ====================

  buildCallbacks(executionId: string): EngineCallbacks {
    return this.callbacksBuilder.buildCallbacks(executionId)
  }

  // ==================== Token usages ====================

  getTokenUsagesPerStep(executionId: string) {
    return this.queryService.getTokenUsagesPerStep(executionId)
  }

  getTokenUsagesForExecution(executionId: string) {
    return this.queryService.getTokenUsagesForExecution(executionId)
  }

  // ==================== Lifecycle hooks ====================

  private async executeWorkflowHooks(
    event: keyof WorkflowHooks, context: Record<string, unknown>,
    wf: { parsed: WorkflowDef }, executionId: string,
  ): Promise<void> {
    return this.hookExecutor.executeWorkflowHooks(event, context, wf, executionId)
  }
}
