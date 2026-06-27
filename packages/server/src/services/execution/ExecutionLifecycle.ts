// packages/server/src/services/execution/ExecutionLifecycle.ts
import type { ExecutionDAO } from "../../db/dao/execution-dao"
import type { ExecutionRow, NodeExecutionRow } from "../../db/types"
import { EnginePool } from "./EnginePool"
import type { SSEService } from "../sse"
import type { WorkflowService } from "../workflow"
import type { BuiltInWorkflowService } from "../builtin-workflow"
import type { ObservabilityService } from "../observability"
import type { ErrorTracker } from "../error-tracker"
import type { HookDef, NodeDef, WorkflowDef, WorkflowHooks, PipelineConfig, ExecutionLookup } from "@octopus/shared"
import type { EngineCallbacks } from "@octopus/engine"
import { WorkflowEngine, BashExecutor, AgentExecutor, AgentNodeRunner, FilesystemCheckpointStore } from "@octopus/engine"
import { getProvider } from "@octopus/providers"
import { parseWorkflow, VarPool, evaluateExpression, parsePipelineConfig, CrossExecResolver } from "@octopus/shared"
import { gitOps } from "../git-ops"
import { ObservabilityService as ObsSvc } from "../observability"
import { PrivacyFilter } from "../privacy-filter"
import { getFlag } from "../../config/feature-flags"
import { generateSummary, formatDuration } from "../execution-summary"
import { join } from "path"
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { randomUUID } from "crypto"

export class ExecutionLifecycle {
  private enginePool: EnginePool
  private _externalCallbacks = new Map<string, Partial<EngineCallbacks>>()

  constructor(
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

  async start(id: string, inputValues?: Record<string, string>): Promise<ExecutionRow> {
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
    const snapshotName = `${id}-${exec.workflow_ref}`
    writeFileSync(join(stateDir, snapshotName), wf.content, "utf-8")

    this.ensureNodeExecutions(id, wf.parsed)
    this.ensureNodeEdges(id, wf.parsed)

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

    const engine = new WorkflowEngine(
      wf.parsed,
      { "claude": getProvider("claude") },
      this.workspacePath,
      this.workspacePath,
      this.buildCallbacks(id),
      abortController.signal,
      id,
      resolvedInputValues,
      exec.name,
    )

    this.enginePool.create(id, engine, abortController)

    // Wire experience injection resolver (if ExperienceInjector available and flag enabled)
    // EXPERIENCE_INJECTION env flag: default true, set to "false" to disable
    const experienceInjectionEnabled = process.env.EXPERIENCE_INJECTION !== 'false'
    const expInjector = (global as any).__octopus_experienceInjector
    if (expInjector && experienceInjectionEnabled) {
      engine.setExperienceResolver(async (scope, poolSnapshot) => {
        return expInjector.injectExperience(scope, poolSnapshot)
      })
    }

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

      // ── Register archive + chain trigger onComplete callbacks ──
      // Archive first, then chain trigger (sequential to avoid race condition
      // where chain trigger reads archive data before it's written).
      const archiveService = (global as any).__octopus_archiveService
      const chainTrigger = (global as any).__octopus_chainTrigger
      this.registerExternalCallbacks({
        onComplete: async () => {
          // 1. Archive execution (await to ensure data is persisted)
          if (archiveService) {
            try { archiveService.archiveExecution(id) } catch (err) {
              console.error("[ExecutionLifecycle] Archive callback failed:", err)
            }
            // Brief yield to allow fire-and-forget _archiveWithRetry to complete insert
            await new Promise(r => setTimeout(r, 100))
          }
          // 2. Chain trigger (runs after archive data is available)
          if (chainTrigger) {
            try { await chainTrigger.onExecutionComplete(id) } catch (err) {
              console.error("[ExecutionLifecycle] Chain trigger failed:", err)
            }
          }
        },
      }, id)

      const result = await engine.run()

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
        this.sse.emit(this.workspaceId, { event: "execution_pending_approval", data: { executionId: id } })
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
    if (!["running", "paused", "pending_approval"].includes(exec.status))
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

      const result = await inst.engine.retryFrom(failedNodeId, { signal: inst.abortController.signal, intervention })

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

        try {
          const result = await inst.engine.retryFrom(onRejectNodeId, {
            userChoice: "reject", userComment: comment, signal: inst.abortController.signal,
          })

          if (result.status === "completed" || result.status === "completed_with_failures" || result.status === "cancelled" || result.status === "rejected") {
            this.enginePool.remove(id)
          }

          const endCommitId = await this.recordEndCommits()
          this.dao.updateExecution(id, { end_commit_id: endCommitId })

          const finalStatus = result.status === "failed" ? "failed" : "rejected"

          this.updateStatus(id, finalStatus, {
            completed_at: new Date().toISOString(), duration: result.durationMs, progress: 100,
            var_pool: JSON.stringify(result.poolSnapshot),
            gate_status: finalStatus === "completed" ? "open" : "closed",
          })

          this.cleanupOrphanedNodes(id, result.status)

          if (wf) {
            try {
              if (finalStatus === "failed") {
                await this.executeWorkflowHooks("on_workflow_failure", {
                  failed_node_id: nodeId, error: "Rejected by user (on_reject handler failed)", duration_ms: result.durationMs ?? 0,
                }, wf, id)
              }
              await this.executeWorkflowHooks("on_complete", { final_status: finalStatus }, wf, id)
            } catch { /* non-fatal */ }
          }

          this.syncStateJson()
          this.sse.emit(this.workspaceId, { event: "complete", data: { executionId: id, finalStatus } })
          return this.dao.findById(id)!
        } catch (err: any) {
          console.error(`[ExecutionLifecycle] on_reject handler failed:`, err)
          this.enginePool.remove(id)
          this.updateStatus(id, "failed", { completed_at: new Date().toISOString() })
          this.dao.updateNodeExecutionsByStatus(id, "failed", ["running", "pending", "paused"])
          if (wf) {
            try {
              await this.executeWorkflowHooks("on_workflow_failure", { failed_node_id: nodeId, error: err.message ?? "on_reject handler failed", duration_ms: 0 }, wf, id)
              await this.executeWorkflowHooks("on_complete", { final_status: "failed" }, wf, id)
            } catch { /* non-fatal */ }
          }
          this.syncStateJson()
          this.sse.emit(this.workspaceId, { event: "complete", data: { executionId: id, finalStatus: "failed", error: err.message } })
          return this.dao.findById(id)!
        }
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

    try {
      const result = await inst.engine.retryFrom(nodeId, {
        userChoice: answer, userComment: comment, signal: inst.abortController.signal,
      })

      if (result.status === "completed" || result.status === "completed_with_failures" || result.status === "cancelled" || result.status === "rejected") {
        this.enginePool.remove(id)
      }

      if (result.status === "pending_approval") {
        this.dao.updateExecution(id, { var_pool: JSON.stringify(result.poolSnapshot) })
        const nextPausedNodeId = Object.entries(result.nodeResults).find(([, r]) => r.status === "paused")?.[0]
        if (nextPausedNodeId) {
          const wf = this.getWorkflow(exec.workflow_ref)
          const nodeDef = this.findNodeDef(wf?.parsed.nodes ?? [], nextPausedNodeId)
          const timeout = nodeDef?.approval_timeout
          if (timeout && timeout > 0) {
            const timer = setTimeout(async () => {
              console.log(`[ExecutionLifecycle] Approval timeout for ${id}/${nextPausedNodeId}`)
              try { await this.approve(id, nextPausedNodeId, "timeout", "Auto-rejected by timeout") } catch (e) {
                console.error(`[ExecutionLifecycle] Timeout approval failed for ${id}`, e)
              }
            }, timeout * 1000)
            this.enginePool.setApprovalTimer(id, timer)
          }
        }
      }

      const currentExec = this.dao.findById(id)
      if (currentExec?.status === "paused") {
        const nodeStats = this.dao.findNodeStatsForExecution(id)
        if (nodeStats.running_or_pending === 0) {
          console.log(`[ExecutionLifecycle] Execution ${id} was paused but all nodes completed during approve, updating to ${result.status}`)
        } else {
          console.log(`[ExecutionLifecycle] Execution ${id} was paused and ${nodeStats.running_or_pending} nodes still running/pending during approve, keeping paused status`)
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

      const wfForHook = this.getWorkflow(exec.workflow_ref)
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
    } catch (err: any) {
      this.enginePool.remove(id)
      if (inst) await this.abortAndWait(inst.abortController, id)

      this.updateStatus(id, "failed", { completed_at: new Date().toISOString() })
      this.dao.updateNodeExecutionsByStatus(id, "failed", ["running", "pending"], { error: `Approve failed: ${err.message}` })
      this.syncStateJson()

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
    if (exec.status !== "paused") return { success: false, error: "执行未处于暂停状态" }

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

      const contextVars: Record<string, string> = {
        "hook.event": "interrupt", "hook.workflow_name": wf.parsed.name,
        "hook.execution_id": row.id, "hook.timestamp": new Date().toISOString(),
        "hook.last_status": "running", "hook.interrupt_reason": "服务重启中断",
      }

      for (const hook of hooks) {
        try { await this.executeAgentHookServer(hook, wf.parsed, {}, contextVars) } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          process.stderr.write(`[DrainPendingHooks] Hook ${hook.id ?? "anonymous"} failed for ${row.id}: ${msg}\n`)
        }
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
        const result = await inst.engine.retryFrom(lastFailed.node_id, { signal: inst.abortController.signal })

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
    try {
      const inst = this.enginePool.get(executionId)
      if (!inst) return

      const result = await inst.engine.retryFrom(nodeId, { signal, intervention })

      if (result.status === "completed" || result.status === "completed_with_failures" || result.status === "cancelled" || result.status === "rejected") {
        this.enginePool.remove(executionId)
      }

      if (result.status === "pending_approval") {
        this.dao.updateExecution(executionId, { var_pool: JSON.stringify(result.poolSnapshot) })
        const nextPausedNodeId = Object.entries(result.nodeResults).find(([, r]) => r.status === "paused")?.[0]
        if (nextPausedNodeId) {
          const wf = this.getWorkflow(workflowRef)
          const nodeDef = this.findNodeDef(wf?.parsed.nodes ?? [], nextPausedNodeId)
          const timeout = nodeDef?.approval_timeout
          if (timeout && timeout > 0) {
            const timer = setTimeout(async () => {
              console.log(`[ExecutionLifecycle] Approval timeout for ${executionId}/${nextPausedNodeId}`)
              try { await this.approve(executionId, nextPausedNodeId, "timeout", "Auto-rejected by timeout") } catch (e) {
                console.error(`[ExecutionLifecycle] Timeout approval failed for ${executionId}`, e)
              }
            }, timeout * 1000)
            this.enginePool.setApprovalTimer(executionId, timer)
          }
        }
      }

      this.updateStatus(executionId, result.status, {
        completed_at: new Date().toISOString(), duration: result.durationMs, progress: 100,
        var_pool: JSON.stringify(result.poolSnapshot),
        gate_status: result.status === "pending_approval" ? "pending" : (result.status === "completed" ? "open" : "closed"),
      })

      this.cleanupOrphanedNodes(executionId, result.status)

      const wfForHook = this.getWorkflow(workflowRef)
      if (wfForHook) {
        if (result.status === "failed") {
          await this.executeWorkflowHooks("on_workflow_failure", {
            failed_node_id: this.findFailedNode(executionId), error: this.findFailedNodeError(executionId), duration_ms: result.durationMs,
          }, wfForHook, executionId)
        }
        if (result.status === "completed") {
          await this.executeWorkflowHooks("on_complete", { final_status: "completed" }, wfForHook, executionId)
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[ExecutionLifecycle] Resume failed for ${executionId}:`, msg)
      this.dao.updateExecution(executionId, { status: "failed", var_pool: JSON.stringify({ error: msg }) })
      this.enginePool.remove(executionId)
    }
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

  private async abortAndWait(abortController: AbortController, executionId?: string, timeoutMs = 60000): Promise<void> {
    if (abortController.signal.aborted) return
    abortController.abort()

    if (!executionId) return

    const startTime = Date.now()
    const interval = 200
    while (Date.now() - startTime < timeoutMs) {
      await new Promise(resolve => setTimeout(resolve, interval))
      const status = this.dao.findExecutionStatus(executionId)
      if (!status || status.status !== "running") return
    }
  }

  private collectAllNodes(nodes: { id: string; type: string; nodes?: any[] }[]): { id: string; type: string }[] {
    const result: { id: string; type: string }[] = []
    for (const node of nodes) {
      result.push({ id: node.id, type: node.type })
      if (node.nodes) result.push(...this.collectAllNodes(node.nodes))
    }
    return result
  }

  private ensureNodeExecutions(executionId: string, wf: { nodes: any[] }): void {
    for (const node of this.collectAllNodes(wf.nodes)) {
      this.dao.insertNodeExecutionOrIgnore({
        id: `${executionId}-${node.id}`, execution_id: executionId,
        node_id: node.id, node_type: node.type, status: "pending",
      })
    }
  }

  private ensureNodeEdges(
    executionId: string,
    wf: { nodes: { id: string; type: string; depends_on?: string[]; cases?: { when: string; then: string }[] }[] }
  ): void {
    for (const node of wf.nodes) {
      if (node.depends_on) {
        for (const dep of node.depends_on) {
          this.dao.insertNodeEdgeOrIgnore({
            id: randomUUID(), execution_id: executionId,
            from_node_id: dep, to_node_id: node.id, edge_type: "dependency",
          })
        }
      }
      if (node.type === "condition" && node.cases) {
        for (const c of node.cases) {
          this.dao.insertNodeEdgeOrIgnore({
            id: randomUUID(), execution_id: executionId,
            from_node_id: node.id, to_node_id: c.then, edge_type: "condition_true", label: c.then,
          })
        }
      }
    }
  }

  private findPausedNode(executionId: string): string | null {
    const row = this.dao.findFirstNodeByStatus(executionId, "paused")
    return row?.node_id ?? null
  }

  private findFailedNode(executionId: string): string {
    const row = this.dao.findFirstNodeByStatus(executionId, "failed")
    return row?.node_id ?? "unknown"
  }

  private findFailedNodeError(executionId: string): string {
    const row = this.dao.findFirstNodeErrorByStatus(executionId, "failed")
    return row?.error ?? "Unknown error"
  }

  private findNodeDef(nodes: any[], nodeId: string): any | null {
    for (const node of nodes) {
      if (node.id === nodeId) return node
      if (node.nodes) {
        const found = this.findNodeDef(node.nodes, nodeId)
        if (found) return found
      }
    }
    return null
  }

  private isWorkflowNodeId(workflowRef: string, nodeId: string): boolean {
    const wf = this.getWorkflow(workflowRef)
    if (!wf) return false
    const allNodeIds = this.collectAllNodes(wf.parsed.nodes).map(n => n.id)
    return allNodeIds.includes(nodeId)
  }

  syncStateJson(): void {
    const stateDir = join(this.workspacePath, "state")
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true })

    const rows = this.dao.findExecutionsForStateSync(this.workspaceDbId)

    const safeJsonParse = (v: string | null | undefined): Record<string, string> | null => {
      if (!v) return null
      try { return JSON.parse(v) } catch { return null }
    }

    const state = {
      workspace_id: this.workspaceDbId,
      updated_at: new Date().toISOString(),
      executions: rows.map(r => ({
        execution_id: r.id, parent_id: r.parent_id,
        node_type: r.node_type ?? "normal", branch: r.branch,
        status: r.status, workflow_ref: r.workflow_ref, workflow_name: r.workflow_name,
        input_values: safeJsonParse(r.input_values),
        start_commit_id: safeJsonParse(r.start_commit_id),
        end_commit_id: safeJsonParse(r.end_commit_id),
        started_at: r.started_at, completed_at: r.completed_at,
      })),
    }

    writeFileSync(join(stateDir, "executions.json"), JSON.stringify(state, null, 2), "utf-8")
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
    const nodeExecs = this.dao.findNodeExecutions(executionId)
    return nodeExecs.map(ne => ({
      type: ne.status === "completed" ? "node_end" : "node_start",
      timestamp: ne.started_at ?? "",
      data: { nodeId: ne.node_id, nodeType: ne.node_type, status: ne.status, exitCode: ne.exit_code },
    }))
  }

  getAgentEvents(executionId: string, nodeId?: string): any[] {
    const logDir = join(this.workspacePath, "logs", executionId)
    if (!existsSync(logDir)) return []

    const events: any[] = []
    const files = readdirSync(logDir).filter(f => f.endsWith(".jsonl"))
    for (const file of files) {
      const fileNodeId = file.replace(".jsonl", "")
      if (nodeId && fileNodeId !== nodeId) continue
      const content = readFileSync(join(logDir, file), "utf-8")
      for (const line of content.split("\n")) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line)
          events.push({ ...entry, nodeId: entry.nodeId ?? fileNodeId })
        } catch { /* skip malformed lines */ }
      }
    }
    return events.sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? ""))
  }

  getWorkflowContent(executionId: string): string | null {
    const exec = this.dao.findById(executionId)
    if (!exec) return null

    const snapshotPath = join(this.workspacePath, "state", `${executionId}-${exec.workflow_ref}`)
    if (existsSync(snapshotPath)) return readFileSync(snapshotPath, "utf-8")

    const local = this.workflowService.get(this.workspacePath, exec.workflow_ref)
    if (local) return local.content
    const builtIn = this.builtInWorkflowService.get(exec.workflow_ref)
    return builtIn?.content ?? null
  }

  getStateJson(executionId: string): Record<string, unknown> | null {
    const stateFile = join(this.workspacePath, "state", `${executionId}.json`)
    if (!existsSync(stateFile)) return null
    try { return JSON.parse(readFileSync(stateFile, "utf-8")) } catch { return null }
  }

  streamEvents(req: Request): Response {
    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()
    const encoder = new TextEncoder()

    const unsubscribe = this.sse.subscribe(this.workspaceId, (event) => {
      writer.write(encoder.encode(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`))
    })

    req.signal.addEventListener("abort", () => {
      unsubscribe()
      writer.close()
    })

    return new Response(readable, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
    })
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
    const commits: Record<string, string> = {}
    await gitOps.allProjectsAction(this.workspacePath, async (projectPath, projectName) => {
      const hasChanges = await gitOps.hasUncommittedChanges(projectPath)
      if (hasChanges) {
        const sha = await gitOps.autoCommit(projectPath, "chore: fork前自动提交")
        commits[projectName] = sha
      }
    })
    return commits
  }

  private async createForkBranch(branchName: string, baseCommit: Record<string, string>): Promise<void> {
    await gitOps.allProjectsAction(this.workspacePath, async (projectPath, projectName) => {
      const base = baseCommit[projectName]
      if (base) await gitOps.createBranch(projectPath, branchName, base)
    })
  }

  private async switchToExecutionBranch(branch: string): Promise<void> {
    await gitOps.allProjectsAction(this.workspacePath, async (projectPath) => {
      await gitOps.createOrSwitchBranch(projectPath, branch)
    })
  }

  private async recordStartCommits(): Promise<string> {
    const commits: Record<string, string> = {}
    await gitOps.allProjectsAction(this.workspacePath, async (projectPath, projectName) => {
      commits[projectName] = await gitOps.getHeadCommit(projectPath)
    })
    return JSON.stringify(commits)
  }

  private async recordEndCommits(): Promise<string> {
    return this.recordStartCommits()
  }

  private async rollbackToStart(startCommitId: string): Promise<void> {
    const commits: Record<string, string> = JSON.parse(startCommitId)
    await gitOps.allProjectsAction(this.workspacePath, async (projectPath, projectName) => {
      const commit = commits[projectName]
      if (commit) {
        await gitOps.resetHard(projectPath, commit)
        await gitOps.cleanForce(projectPath)
      }
    })
  }

  // ==================== Engine reconstruction ====================

  private reconstructEngine(exec: ExecutionRow): { engine: WorkflowEngine; abortController: AbortController } {
    const snapshotPath = join(this.workspacePath, "state", `${exec.id}-${exec.workflow_ref}`)
    let wf: { ref: string; content: string; parsed: any } | undefined
    if (existsSync(snapshotPath)) {
      const content = readFileSync(snapshotPath, "utf-8")
      try {
        const parsed = parseWorkflow(content)
        wf = { ref: exec.workflow_ref, content, parsed }
      } catch (e: any) {
        console.error(`[ExecutionLifecycle] reconstructEngine: snapshot parse failed: ${e.message}`)
      }
    }
    if (!wf) {
      wf = this.getWorkflow(exec.workflow_ref)
    }
    if (!wf) throw new Error(`Workflow not found: ${exec.workflow_ref}`)

    const inputValues = JSON.parse(exec.input_values || "{}")
    const poolSnapshot = JSON.parse(exec.var_pool || "{}")
    const abortController = new AbortController()

    const engine = new WorkflowEngine(
      wf.parsed,
      { "claude": getProvider("claude") },
      this.workspacePath, this.workspacePath,
      this.buildCallbacks(exec.id),
      abortController.signal, exec.id, inputValues,
    )

    engine.updateVarPool(poolSnapshot)

    // Wire experience injection resolver for resume/retry
    const expInjector = (global as any).__octopus_experienceInjector
    if (expInjector) {
      engine.setExperienceResolver(async (scope, poolSnap) => {
        return expInjector.injectExperience(scope, poolSnap)
      })
    }

    const completedNodes = this.dao.findCompletedNodeExecutions(exec.id)
    for (const node of completedNodes) {
      engine.setNodeResult(node.node_id, {
        status: node.status,
        outputs: JSON.parse(node.outputs || "{}"),
        durationMs: node.duration ?? 0,
        logLines: [], error: node.error ?? undefined,
        sessionId: node.session_id ?? undefined,
      })
    }

    const sessionNodes = this.dao.findSessionNodes(exec.id)
    let globalSessionId: string | undefined
    const branchSessionIds = new Map<string, string>()

    if (sessionNodes.length > 0) {
      const nodeContextMap = new Map<string, "continue" | "new">()
      for (const n of this.collectAllNodes(wf.parsed.nodes)) {
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
    const id = executionId
    return {
      onNodeStart: (nodeId, nodeType) => {
        const neId = `${id}-${nodeId}`
        // Clear old agent events for this node to prevent PRIMARY KEY collision
        // on event_order when retrying/restarting a node (e.g. after server restart).
        try { this.dao.deleteAgentEventsByNode(neId) } catch { /* non-fatal */ }
        // Reset degraded state so the observability buffer resumes writing
        this.observability.resetDegraded()
        this.updateNodeStatus(neId, "running", { started_at: new Date().toISOString() })
        this.sse.emit(this.workspaceId, {
          event: "node_start", data: { executionId: id, nodeId, nodeType, executorType: nodeType },
        })
        this.syncStateJson()
      },
      onNodeEnd: (nodeId, status, durationMs, result, nodeType) => {
        this.updateNodeStatus(`${id}-${nodeId}`, status, {
          completed_at: new Date().toISOString(), duration: durationMs,
          ...(result?.sessionId ? { session_id: result.sessionId } : {}),
          ...(status === "completed" ? { error: null } : {}),
          ...(result?.outputs ? { outputs: JSON.stringify(result.outputs) } : {}),
        })
        const inst = this.enginePool.get(id)
        const globalSid = inst?.engine.getGlobalSessionId()
        if (globalSid) this.dao.updateExecution(id, { global_session_id: globalSid })

        if (result?.modelUsages && result.modelUsages.length > 0) {
          const neId = `${id}-${nodeId}`
          const now = new Date().toISOString()
          for (const mu of result.modelUsages) {
            this.dao.insertNodeTokenUsage(
              `${neId}-token-${mu.model}`, neId, mu.model,
              mu.inputTokens, mu.outputTokens, mu.costUsd ?? null,
              mu.cacheReadInputTokens ?? 0, mu.cacheCreationInputTokens ?? 0, now,
            )
          }
        }

        if (status === "pending_approval" && result?.approvalMetadata) {
          this.dao.updateExecution(id, { approval_metadata: JSON.stringify(result.approvalMetadata) })
          this.sse.emit(this.workspaceId, {
            event: "execution_pending_approval",
            data: { executionId: id, nodeId, approval: result.approvalMetadata },
          })
        }

        const finalInput = result?.tokens?.input ?? 0
        const finalOutput = result?.tokens?.output ?? 0
        const hasTokens = finalInput > 0 || finalOutput > 0

        const neId = `${id}-${nodeId}`
        this.observability.flushNode(neId)

        const llmCalls = result?.llmCalls ?? []
        const modelUsages = result?.modelUsages ?? []
        // Compute cost from llmCalls (agent) or modelUsages (swarm/dispatch)
        const costUsd = llmCalls.length > 0
          ? llmCalls.reduce((sum: number, c: any) => sum + (c.costUsd ?? 0), 0)
          : modelUsages.reduce((sum: number, mu: any) => sum + (mu.costUsd ?? 0), 0)
        const turnCount = new Set(llmCalls.map((c: any) => c.turnIndex ?? 1)).size
        const toolCount = new Set(llmCalls.filter((c: any) => c.stopReason === "tool_use").map((c: any) => c.toolName)).size

        if (getFlag("llm_calls_persist") && result?.llmCalls && result.llmCalls.length > 0) {
          try {
            const exec = this.dao.findById(id)
            const calls = result.llmCalls.map((call: any, i: number) => ({ ...call, turnIndex: call.turnIndex || 1 }))
            this.observability.persistLLMCalls(neId, id, calls, exec?.instance_id ?? `inst-${process.env.PORT ?? "3001"}-${exec?.branch ?? "main"}`)
          } catch { /* silent */ }
        }

        this.sse.emit(this.workspaceId, {
          event: "node_end",
          data: {
            executionId: id, nodeId, status, durationMs, executorType: nodeType,
            costUsd: costUsd > 0 ? costUsd : undefined,
            turnCount: turnCount > 0 ? turnCount : undefined,
            toolCount: toolCount > 0 ? toolCount : undefined,
            ...(hasTokens ? { tokens: { input: finalInput, output: finalOutput } } : {}),
            ...(result?.modelUsages?.length ? {
              tokenUsages: result.modelUsages.map((mu: any) => ({
                model: mu.model,
                inputTokens: mu.inputTokens,
                outputTokens: mu.outputTokens,
                cacheReadTokens: mu.cacheReadInputTokens ?? 0,
                cacheCreationTokens: mu.cacheCreationInputTokens ?? 0,
              })),
            } : {}),
          },
        })
        this.syncStateJson()
      },
      onNodeLog: (nodeId, logLine) => {
        this.sse.emit(this.workspaceId, { event: "node_log", data: { executionId: id, nodeId, logLine } })
      },
      onStatusChange: (status, progress) => {
        this.dao.updateExecutionProgress(id, progress)
        this.sse.emit(this.workspaceId, { event: "execution_progress", data: { executionId: id, progress } })
        this.syncStateJson()
      },
      onError: (nodeId, error) => {
        this.updateNodeStatus(`${id}-${nodeId}`, "failed", { error })
        this.sse.emit(this.workspaceId, { event: "error", data: { executionId: id, nodeId, error } })
        this.syncStateJson()
      },
      onComplete: () => {
        const ext = this._externalCallbacks.get(id) ?? this._externalCallbacks.get("__default__")
        if (ext?.onComplete) {
          try { ext.onComplete() } catch (err) {
            console.error("[ExecutionLifecycle] External onComplete failed:", err)
          }
          this._externalCallbacks.delete(id)
        }
      },
      onBranchStart: (neId, iteration) => {
        this.sse.emit(this.workspaceId, { event: "branch_start", data: { executionId: id, nodeExecutionId: neId, iteration } })
      },
      onBranchEnd: (neId, iteration, status) => {
        this.sse.emit(this.workspaceId, { event: "branch_end", data: { executionId: id, nodeExecutionId: neId, iteration, status } })
      },
      onAgentEvent: (nodeId, event) => {
        this.sse.emit(this.workspaceId, { event: "agent_event", data: { executionId: id, nodeId, event } })
        if (getFlag("agent_events_persist")) {
          try {
            const neId = `${id}-${nodeId}`
            const exec = this.dao.findById(id)
            this.observability.bufferEvent(neId, event, {
              executionId: id, nodeId, org: this.org,
              workspaceId: this.workspaceDbId, workflowRef: exec?.workflow_ref ?? "unknown",
            })
          } catch { /* silent */ }
        }
      },
      onSwarmEvent: (nodeId, event) => {
        this.sse.emit(this.workspaceId, {
          event: event.type,
          data: { executionId: id, nodeId, ...(event.data ?? {}) },
        })
      },
      onNodeRetry: (nodeId: string, attempt: number, maxAttempts: number, delayMs: number) => {
        this.dao.updateNodeRetryInfo(id, nodeId, attempt, new Date().toISOString())
        this.sse.emit(this.workspaceId, {
          event: "node_retry", data: { executionId: id, nodeId, attempt, maxAttempts, delayMs },
        })
      },
      onPipelineReloaded: (config: PipelineConfig) => {
        this.sse.emit(this.workspaceId, { event: "pipeline_reloaded", data: { executionId: id, config } })
      },
      onRuntimeNodeAdded: (nodeId: string, nodeType: string) => {
        const neId = `${id}-${nodeId}`
        this.dao.insertNodeExecutionOrIgnore({
          id: neId, execution_id: id, node_id: nodeId, node_type: nodeType,
          status: "pending", started_at: new Date().toISOString(),
        })
        this.sse.emit(this.workspaceId, { event: "runtime_node_added", data: { executionId: id, nodeId, nodeType } })
      },
    }
  }

  // ==================== Token usages ====================

  getTokenUsagesPerStep(executionId: string): Array<{ stepId?: string; model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }> {
    const dbRows = this.dao.findNodeTokenUsages(executionId)
    return dbRows.map(r => ({
      stepId: r.node_id, model: r.model,
      inputTokens: r.input_tokens, outputTokens: r.output_tokens,
      cacheReadTokens: r.cache_read_tokens ?? 0, cacheCreationTokens: r.cache_creation_tokens ?? 0,
    }))
  }

  getTokenUsagesForExecution(executionId: string): Array<{ model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }> {
    const perStep = this.getTokenUsagesPerStep(executionId)
    const modelTotals = new Map<string, { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }>()
    for (const entry of perStep) {
      const existing = modelTotals.get(entry.model)
      if (existing) {
        modelTotals.set(entry.model, {
          inputTokens: existing.inputTokens + entry.inputTokens,
          outputTokens: existing.outputTokens + entry.outputTokens,
          cacheReadTokens: existing.cacheReadTokens + (entry.cacheReadTokens ?? 0),
          cacheCreationTokens: existing.cacheCreationTokens + (entry.cacheCreationTokens ?? 0),
        })
      } else {
        modelTotals.set(entry.model, {
          inputTokens: entry.inputTokens, outputTokens: entry.outputTokens,
          cacheReadTokens: entry.cacheReadTokens ?? 0, cacheCreationTokens: entry.cacheCreationTokens ?? 0,
        })
      }
    }
    return Array.from(modelTotals.entries())
      .map(([model, totals]) => ({ model, ...totals }))
      .filter(u => u.inputTokens > 0 || u.outputTokens > 0)
  }

  // ==================== Lifecycle hooks ====================

  private async executeWorkflowHooks(
    event: keyof WorkflowHooks, context: Record<string, unknown>,
    wf: { parsed: WorkflowDef }, executionId: string,
  ): Promise<void> {
    const hooks = wf.parsed.hooks?.[event]
    if (!hooks || hooks.length === 0) return

    const exec = this.dao.findById(executionId)
    let poolSnapshot: Record<string, string> = {}
    if (exec?.var_pool) {
      try { poolSnapshot = JSON.parse(exec.var_pool) } catch { /* use empty pool */ }
    }

    for (const hook of hooks) {
      if (hook.condition) {
        const tempPool = new VarPool({ ...poolSnapshot })
        const shouldRun = evaluateExpression(hook.condition, tempPool, {})
        if (!shouldRun) continue
      }

      const hookVars: Record<string, string> = {
        "hook.event": event.replace("on_", ""),
        "hook.workflow_name": wf.parsed.name,
        "hook.execution_id": executionId,
        "hook.timestamp": new Date().toISOString(),
        ...Object.fromEntries(Object.entries(context).map(([k, v]) => [`hook.${k}`, String(v ?? "")])),
      }

      try {
        if (hook.type === "bash" || hook.bash) {
          await this.executeBashHookServer(hook, poolSnapshot, hookVars)
        } else {
          await this.executeAgentHookServer(hook, wf.parsed, poolSnapshot, hookVars)
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`[Hook] ${event}/${hook.id ?? "anonymous"} failed: ${msg}\n`)
      }
    }
  }

  private async executeBashHookServer(hook: HookDef, poolSnapshot: Record<string, string>, hookVars: Record<string, string>): Promise<void> {
    const pool = new VarPool({ ...poolSnapshot })
    pool.update(hookVars)
    const bashNode: NodeDef = {
      id: hook.id ?? `hook-bash-${Date.now()}`, type: "bash",
      bash: hook.bash!, timeout: hook.timeout ?? 60,
    }
    const executor = new BashExecutor(bashNode, pool, undefined,
      (line, stream) => {
        const label = `[Hook:${hook.id ?? "bash"}${stream === "stderr" ? ":err" : ""}]`
        process.stderr.write(`${label} ${line}\n`)
      }, this.workspacePath)
    await executor.execute()
  }

  private async executeAgentHookServer(hook: HookDef, wf: WorkflowDef, poolSnapshot: Record<string, string>, hookVars: Record<string, string>): Promise<void> {
    const pool = new VarPool({ ...poolSnapshot })
    pool.update(hookVars)
    const providerKey = hook.engine ?? wf.engine ?? "claude"
    const provider = getProvider(providerKey)
    const agentNode: NodeDef = {
      id: hook.id ?? `hook-agent-${Date.now()}`, type: "agent",
      prompt: hook.prompt!, model: hook.model ?? wf.model,
      timeout: hook.timeout ?? 120, context: "new",
    }
    const runner = new AgentNodeRunner(provider, this.workspacePath, () => {})
    const executor = new AgentExecutor(agentNode, pool, runner, undefined, wf.auto_answers, undefined)
    await executor.execute()
  }
}
