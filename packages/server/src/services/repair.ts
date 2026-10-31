// packages/server/src/services/repair.ts
// RepairService — diagnosis and state mutation for stuck/failed workflow executions.
// Used by the repair routes to implement the octo-workflow-repair skill's backend.

import type { ExecutionDAO } from "../db/dao/execution-dao"
import type { SSEService } from "./sse"
import type { ExecutionService } from "./execution"
import type { WorkflowService } from "./workflow"
import type { BuiltInWorkflowService } from "./builtin-workflow"
import type {
  DiagnoseReport, DiagnoseNodeReport, Anomaly, CheckpointSummary, RecentError,
  VarPoolUpdateResponse, NodeResetResponse, RestorePointResponse,
  ReloadWorkflowResponse, InterveneResponse, ClearRetryResponse,
} from "@octopus/shared"
import type { NodeType, NodeExecutionStatus } from "@octopus/shared"
import { parseWorkflow, WorkflowRef } from "@octopus/shared"
import type { NodeDef } from "@octopus/shared"
import { existsSync, readFileSync, readdirSync } from "fs"
import { join } from "path"

const STUCK_THRESHOLD_MS = 10 * 60 * 1000 // 10 minutes
const EXHAUSTED_RETRY_THRESHOLD = 3
const INFINITE_RETRY_THRESHOLD = 5
const FALSE_COMPLETION_MIN_OUTPUT_LENGTH = 10
const RECENT_EVENTS_LIMIT = 5

export class RepairService {
  constructor(
    private dao: ExecutionDAO,
    private sse: SSEService,
    private executionService: ExecutionService,
    private workflowService: WorkflowService,
    private builtInWorkflowService: BuiltInWorkflowService,
    private workspacePath: string,
    private workspaceId: string,
  ) {}

  // ── Diagnose ─────────────────────────────────────────────────────

  diagnose(executionId: string): DiagnoseReport {
    const exec = this.dao.findById(executionId)
    if (!exec) throw new RepairError("Execution not found", 404)

    const nodeExecutions = this.dao.findNodeExecutions(executionId)
    const varPool = this.parseJson(exec.var_pool, {})
    const nodes = nodeExecutions.map(ne => this.buildNodeReport(ne, executionId))
    const anomalies = this.detectAnomalies(exec, nodeExecutions, nodes)
    const checkpoints = this.loadCheckpoints(executionId)
    const recentErrors = this.collectRecentErrors(nodeExecutions)

    const duration = exec.duration ?? (
      exec.started_at
        ? Date.now() - new Date(exec.started_at).getTime()
        : 0
    )

    const report: DiagnoseReport = {
      execution: {
        id: exec.id,
        status: exec.status as DiagnoseReport["execution"]["status"],
        workflowRef: exec.workflow_ref,
        startedAt: exec.started_at ?? exec.created_at,
        duration,
        retryCount: exec.retry_count,
        resumeAttempts: exec.resume_attempts,
      },
      nodes,
      varPool,
      anomalies,
      checkpoints,
      recentErrors,
    }

    this.emitSSE("repair_diagnose", { executionId, report })
    return report
  }

  // ── VarPool Patch ────────────────────────────────────────────────

  patchVarPool(
    executionId: string,
    updates: Record<string, unknown>,
  ): VarPoolUpdateResponse {
    const exec = this.dao.findById(executionId)
    if (!exec) throw new RepairError("Execution not found", 404)

    const current = this.parseJson(exec.var_pool, {})
    const merged = { ...current, ...updates }
    const updated = Object.keys(updates).length

    this.dao.updateExecution(executionId, {
      var_pool: JSON.stringify(merged),
    })

    // If engine is live, update in-memory VarPool too
    const enginePool = this.executionService.getEnginePool()
    const inst = enginePool.get(executionId)
    if (inst) {
      inst.engine.updateVarPool(updates as Record<string, string>)
    }

    this.emitSSE("repair_varpool", { executionId, updated, snapshot: merged })
    return { updated, snapshot: merged }
  }

  // ── Node Reset ───────────────────────────────────────────────────

  resetNode(
    executionId: string,
    nodeId: string,
    targetStatus: "pending" | "completed",
    outputs?: Record<string, unknown>,
  ): NodeResetResponse {
    const exec = this.dao.findById(executionId)
    if (!exec) throw new RepairError("Execution not found", 404)

    const nodeExecutions = this.dao.findNodeExecutions(executionId)
    const nodeExec = nodeExecutions.find(ne => ne.node_id === nodeId)
    if (!nodeExec) throw new RepairError(`Node not found: ${nodeId}`, 404)

    const previousStatus = nodeExec.status

    // Validate state transition
    this.validateNodeTransition(previousStatus as NodeExecutionStatus, targetStatus)

    const updateFields: Record<string, unknown> = { status: targetStatus }
    if (targetStatus === "pending") {
      updateFields.completed_at = null
      updateFields.duration = null
      updateFields.error = null
      updateFields.exit_code = null
    }
    if (targetStatus === "completed" && outputs) {
      const existingOutputs = this.parseJson(nodeExec.outputs ?? "{}", {})
      const mergedOutputs = {
        ...existingOutputs,
        ...outputs,
        manual_override: true,
      }
      updateFields.outputs = JSON.stringify(mergedOutputs)
    }

    this.dao.updateNodeExecution(nodeExec.id, updateFields as any)

    // If engine is live, update in-memory nodeResults
    const enginePool = this.executionService.getEnginePool()
    const inst = enginePool.get(executionId)
    if (inst && targetStatus === "pending") {
      inst.engine.setNodeResult(nodeId, {
        outputs: outputs ?? {},
        status: "pending" as any,
        durationMs: 0,
        logLines: [],
      })
    }

    this.emitSSE("repair_node_reset", {
      executionId,
      nodeId,
      previousStatus,
      newStatus: targetStatus,
    })

    return { nodeId, previousStatus, newStatus: targetStatus }
  }

  // ── Restore Point ────────────────────────────────────────────────

  restorePoint(
    executionId: string,
    nodeId: string,
    resetVarPool?: boolean,
  ): RestorePointResponse {
    const exec = this.dao.findById(executionId)
    if (!exec) throw new RepairError("Execution not found", 404)

    // Load workflow definition to compute topological order
    const workflowContent = this.getWorkflowContent(executionId)
    if (!workflowContent) throw new RepairError("Workflow definition not found", 404)

    const workflow = parseWorkflow(workflowContent)
    const sorted = this.topologicalSort(workflow.nodes)
    const targetIdx = sorted.findIndex(n => n.id === nodeId)

    if (targetIdx < 0) throw new RepairError(`Node not found in workflow: ${nodeId}`, 404)

    // All nodes after the target → reset to pending
    const downstreamNodes = sorted.slice(targetIdx)
    const resetNodeIds: string[] = []

    const nodeExecutions = this.dao.findNodeExecutions(executionId)

    for (const node of downstreamNodes) {
      const ne = nodeExecutions.find(n => n.node_id === node.id)
      if (ne && ne.status !== "pending") {
        this.dao.updateNodeExecution(ne.id, {
          status: "pending",
          completed_at: null,
          duration: null,
          error: null,
          exit_code: null,
        })
        resetNodeIds.push(node.id)
      }
    }

    // Also reset the target node itself
    const targetNe = nodeExecutions.find(n => n.node_id === nodeId)
    if (targetNe && targetNe.status !== "pending" && !resetNodeIds.includes(nodeId)) {
      this.dao.updateNodeExecution(targetNe.id, {
        status: "pending",
        completed_at: null,
        duration: null,
        error: null,
        exit_code: null,
      })
      resetNodeIds.push(nodeId)
    }

    // Reset VarPool if requested
    if (resetVarPool) {
      // Load the closest checkpoint's pool snapshot, or reset to initial
      const checkpoint = this.findClosestCheckpoint(executionId, nodeId)
      if (checkpoint) {
        this.dao.updateExecution(executionId, {
          var_pool: JSON.stringify(checkpoint.poolSnapshot ?? {}),
        })
      }
    }

    // Clear engine state if live
    const enginePool = this.executionService.getEnginePool()
    const inst = enginePool.get(executionId)
    if (inst) {
      for (const rid of resetNodeIds) {
        inst.engine.setNodeResult(rid, {
          outputs: {},
          status: "pending" as any,
          durationMs: 0,
          logLines: [],
        })
      }
    }

    // Update execution status back to running if it was failed/completed
    //（aborted 也在列：reconcile 回收过的行仍应可经 repair 通道复活 2026-10-29）
    if (["failed", "completed", "completed_with_failures", "cancelled", "aborted"].includes(exec.status)) {
      this.dao.updateExecution(executionId, { status: "running" })
    }

    this.emitSSE("repair_restore_point", {
      executionId,
      resetNodes: resetNodeIds,
      restoredFrom: nodeId,
    })

    return { resetNodes: resetNodeIds, restoredFrom: nodeId }
  }

  // ── Rerun（终态重跑：UI「⚡ 重跑」按钮与 octopus-workflow.rerun_execution 的单一实现）──
  //
  // 场景：执行已进终态（failed/cancelled/…），retry_node 无路（那是 running 内单节点）。
  // 恢复点自动 = 拓扑序上第一个 failed 业务节点；纯合成失败（__engine_init__ 秒死，
  // 业务节点全是连坐 failed）等价于从头重跑。合成节点（不在 YAML 拓扑里，restorePoint
  // 触达不到）一并洗回 pending，引擎重新初始化。execution 被 restorePoint 拉回
  // running 后：live 引擎继续消化 pending；进程重启场景由 RecoveryManager 接管。
  async rerun(
    executionId: string,
    opts: { resetVarPool?: boolean } = {},
  ): Promise<RestorePointResponse & { engine_restarted: boolean }> {
    const exec = this.dao.findById(executionId)
    if (!exec) throw new RepairError("Execution not found", 404)
    if (exec.status === "running" || exec.status === "pending") {
      throw new RepairError(
        `Cannot rerun in status '${exec.status}' — running executions retry single nodes via retry_node/clear-retry`,
        409,
      )
    }
    const workflowContent = this.getWorkflowContent(executionId)
    if (!workflowContent) throw new RepairError("Workflow definition not found", 404)
    const workflow = parseWorkflow(workflowContent)
    const sorted = this.topologicalSort(workflow.nodes)
    if (sorted.length === 0) throw new RepairError("Workflow has no nodes", 400)

    const nodeExecutions = this.dao.findNodeExecutions(executionId)
    const firstFailed = sorted.find(n => {
      const ne = nodeExecutions.find(x => x.node_id === n.id)
      return ne?.status === "failed"
    })
    const target = firstFailed ?? sorted[0]

    const result = this.restorePoint(executionId, target.id, opts.resetVarPool)

    // 合成节点（engine_init 等）：restorePoint 只扫 YAML 拓扑，这里补洗。
    const fresh = this.dao.findNodeExecutions(executionId)
    for (const ne of fresh) {
      const synthetic = !sorted.some(n => n.id === ne.node_id)
      if (synthetic && ne.status !== "pending" && ne.status !== "completed") {
        this.dao.updateNodeExecution(ne.id, {
          status: "pending",
          completed_at: null,
          duration: null,
          error: null,
          exit_code: null,
        })
        if (!result.resetNodes.includes(ne.node_id)) result.resetNodes.push(ne.node_id)
      }
    }

    // 引擎即时接管（2026-10-29 二次修正，rerun 事故轮 00:24）：曾走 resume 通道，
    // 但 resume 的语义是「从暂停点续跑」—— triage 会把 rerun 刚洗成 pending 的
    // 全部节点再刷成 paused，而 reconstructEngine 的 backfill 集合含
    // paused/cancelled 残行，脏残态被喂回 nodeResults 后依赖级联把主链打成
    // cancelled，伪完成判定又被单个 bash 路由节点骗过。rerun 的正确语义是
    // **全新启动**：行重置 pending（started_at/completed_at/progress 清零），
    // 走和人工触发同一的 start() —— fresh engine、started_at=now，reaper 的
    // 陈旧度钟也重新起算。start 拒绝（并发叶子占用等）则退回 running 等重启
    // 恢复，并以 engine_restarted=false 如实告知调用方。
    let engineRestarted = false
    try {
      this.dao.updateExecution(executionId, {
        status: "pending",
        started_at: null,
        completed_at: null,
        progress: 0,
      })
      await this.executionService.start(executionId)
      engineRestarted = true
    } catch (err: unknown) {
      this.dao.updateExecution(executionId, { status: "running" })
      console.warn(`[repair] rerun ${executionId}: start refused (${err instanceof Error ? err.message : err}) — fallback to running, restart recovery will pick it up`)
    }

    return { ...result, engine_restarted: engineRestarted }
  }

  // ── Reload Workflow ──────────────────────────────────────────────

  reloadWorkflow(
    executionId: string,
    content: string,
  ): ReloadWorkflowResponse {
    const exec = this.dao.findById(executionId)
    if (!exec) throw new RepairError("Execution not found", 404)

    // Validate YAML parses correctly
    const newWorkflow = parseWorkflow(content)
    const diff: string[] = []

    // Compare with current definition
    const currentContent = this.getWorkflowContent(executionId)
    if (currentContent) {
      try {
        const currentWorkflow = parseWorkflow(currentContent)
        // Find changed nodes
        const currentNodes = new Map(currentWorkflow.nodes.map(n => [n.id, n]))
        const newNodes = new Map(newWorkflow.nodes.map(n => [n.id, n]))

        for (const [id, newNode] of newNodes) {
          const oldNode = currentNodes.get(id)
          if (!oldNode) {
            diff.push(`+ node added: ${id}`)
          } else if (JSON.stringify(oldNode) !== JSON.stringify(newNode)) {
            diff.push(`~ node modified: ${id}`)
          }
        }
        for (const [id] of currentNodes) {
          if (!newNodes.has(id)) {
            diff.push(`- node removed: ${id}`)
          }
        }
      } catch {
        // If current content can't be parsed, just report full reload
        diff.push("full reload (previous content unparseable)")
      }
    }

    // Write snapshot to workspace state directory for this execution
    const snapshotPath = join(
      this.workspacePath,
      "state",
      `${executionId}-${WorkflowRef.sanitize(exec.workflow_ref)}`,
    )
    try {
      const { writeFileSync: writeFileSyncImport } = require("fs")
      writeFileSyncImport(snapshotPath, content)
    } catch {
      // Non-fatal: engine will fall back to the original workflow file
    }

    this.emitSSE("repair_workflow_reloaded", { executionId, diff })
    return { reloaded: true, diff }
  }

  // ── Intervene ────────────────────────────────────────────────────

  async intervene(
    executionId: string,
    nodeId: string,
    message: string,
  ): Promise<InterveneResponse> {
    const exec = this.dao.findById(executionId)
    if (!exec) throw new RepairError("Execution not found", 404)

    const enginePool = this.executionService.getEnginePool()
    const inst = enginePool.get(executionId)

    if (inst) {
      // Engine is live — use retryFrom with intervention
      try {
        // Fire-and-forget: the intervention runs in the background
        void inst.engine.retryFrom(nodeId, { intervention: message })
        this.emitSSE("repair_intervention", { executionId, nodeId, injected: true })
        return { injected: true }
      } catch {
        // If retryFrom fails, fall through to DB-only path
      }
    }

    // Engine not live — store as a note (the skill can handle this case)
    this.emitSSE("repair_intervention", {
      executionId,
      nodeId,
      injected: false,
      reason: "engine not live — server may need restart",
    })
    return { injected: false }
  }

  // ── Clear Retry ──────────────────────────────────────────────────

  clearRetry(
    executionId: string,
    nodeIds?: string[],
  ): ClearRetryResponse {
    const exec = this.dao.findById(executionId)
    if (!exec) throw new RepairError("Execution not found", 404)

    const cleared: string[] = []

    if (nodeIds && nodeIds.length > 0) {
      // Clear specific nodes
      const nodeExecutions = this.dao.findNodeExecutions(executionId)
      for (const nodeId of nodeIds) {
        const ne = nodeExecutions.find(n => n.node_id === nodeId)
        if (ne && ne.retry_count > 0) {
          this.dao.updateNodeExecution(ne.id, { retry_count: 0 })
          cleared.push(nodeId)
        }
      }
    } else {
      // Clear all nodes
      const nodeExecutions = this.dao.findNodeExecutions(executionId)
      for (const ne of nodeExecutions) {
        if (ne.retry_count > 0) {
          this.dao.updateNodeExecution(ne.id, { retry_count: 0 })
          cleared.push(ne.node_id)
        }
      }
      // Also reset execution-level retry count
      if (exec.retry_count > 0) {
        this.dao.updateExecution(executionId, { retry_count: 0 })
      }
    }

    this.emitSSE("repair_retry_cleared", { executionId, cleared })
    return { cleared }
  }

  // ── Private Helpers ──────────────────────────────────────────────

  private buildNodeReport(
    ne: { node_id: string; node_type: string; status: string; duration: number | null; retry_count: number; error: string | null; outputs: string | null; session_id: string | null },
    executionId: string,
  ): DiagnoseNodeReport {
    const events = this.getNodeEvents(ne, executionId)
    let lastOutput: string | undefined
    if (ne.outputs) {
      try {
        const parsed = JSON.parse(ne.outputs)
        lastOutput = parsed.last_output ?? parsed.output ?? parsed.decision ?? undefined
        if (lastOutput && typeof lastOutput === "string" && lastOutput.length > 200) {
          lastOutput = lastOutput.slice(0, 200) + "…"
        }
      } catch {
        // ignore
      }
    }

    return {
      nodeId: ne.node_id,
      nodeType: ne.node_type as NodeType,
      status: ne.status as NodeExecutionStatus,
      duration: ne.duration ?? 0,
      retryCount: ne.retry_count ?? 0,
      error: ne.error ?? undefined,
      lastOutput,
      eventCount: events.total,
      recentEvents: events.recent,
    }
  }

  private getNodeEvents(
    ne: { node_id: string },
    executionId: string,
  ): { total: number; recent: Array<{ type: string; content: string; timestamp: string }> } {
    try {
      const nodeExecutionId = `${executionId}-${ne.node_id}`
      const events = this.dao.findAgentEvents(nodeExecutionId)
      const recent = events
        .slice(-RECENT_EVENTS_LIMIT)
        .map(e => ({
          type: e.event_type,
          content: (e.content ?? "").slice(0, 200),
          timestamp: String(e.timestamp),
        }))
      return { total: events.length, recent }
    } catch {
      return { total: 0, recent: [] }
    }
  }

  private detectAnomalies(
    exec: { id: string; status: string; retry_count: number; pending_hooks: string; updated_at: string },
    nodeExecutions: Array<{
      node_id: string; node_type: string; status: string;
      duration: number | null; retry_count: number;
      error: string | null; outputs: string | null;
    }>,
    nodeReports: DiagnoseNodeReport[],
  ): Anomaly[] {
    const anomalies: Anomaly[] = []

    for (const ne of nodeExecutions) {
      const report = nodeReports.find(n => n.nodeId === ne.node_id)

      // Stuck node: running but no recent updates and high event count
      if (ne.status === "running" && report) {
        if (report.eventCount > 100) {
          anomalies.push({
            type: "stuck_node",
            nodeId: ne.node_id,
            description: `Node "${ne.node_id}" is running with ${report.eventCount} events — possible infinite loop`,
            severity: "critical",
            suggestion: `Analyze recent events for ${ne.node_id}. Consider intervention or reset.`,
          })
        }
        // Also check if execution updated_at is stale
        const updatedAt = new Date(exec.updated_at).getTime()
        if (Date.now() - updatedAt > STUCK_THRESHOLD_MS) {
          anomalies.push({
            type: "stuck_node",
            nodeId: ne.node_id,
            description: `Node "${ne.node_id}" running but execution not updated for ${Math.round((Date.now() - updatedAt) / 60000)} minutes`,
            severity: "warning",
            suggestion: `Server may have restarted. Check if engine is still live.`,
          })
        }
      }

      // Exhausted retry: failed with high retry count
      if (ne.status === "failed" && ne.retry_count >= EXHAUSTED_RETRY_THRESHOLD) {
        anomalies.push({
          type: "exhausted_retry",
          nodeId: ne.node_id,
          description: `Node "${ne.node_id}" failed after ${ne.retry_count} retries: ${ne.error ?? "unknown error"}`,
          severity: "critical",
          suggestion: `Clear retry count, fix root cause, then retry from this node.`,
        })
      }

      // False completion: completed but output is empty or very short
      if (ne.status === "completed" && report?.lastOutput) {
        if (report.lastOutput.length < FALSE_COMPLETION_MIN_OUTPUT_LENGTH) {
          anomalies.push({
            type: "false_completion",
            nodeId: ne.node_id,
            description: `Node "${ne.node_id}" completed but output is suspiciously short (${report.lastOutput.length} chars)`,
            severity: "warning",
            suggestion: `Verify the agent actually completed its work. Consider resetting to pending with improved prompt.`,
          })
        }
      }
      if (ne.status === "completed" && !report?.lastOutput && ne.node_type === "agent") {
        anomalies.push({
          type: "false_completion",
          nodeId: ne.node_id,
          description: `Agent node "${ne.node_id}" completed but has no output`,
          severity: "warning",
          suggestion: `Verify the agent actually completed its work. Consider resetting to pending.`,
        })
      }
    }

    // Infinite retry: execution-level retry count too high
    if (exec.retry_count >= INFINITE_RETRY_THRESHOLD) {
      anomalies.push({
        type: "infinite_retry",
        description: `Execution has been retried ${exec.retry_count} times — possible infinite retry loop`,
        severity: "critical",
        suggestion: `Pause execution, diagnose root cause, fix before retrying again.`,
      })
    }

    // Orphaned node: node running but execution not running
    if (!["running", "pending", "pending_approval", "paused"].includes(exec.status)) {
      const orphanedNodes = nodeExecutions.filter(ne => ne.status === "running")
      for (const ne of orphanedNodes) {
        anomalies.push({
          type: "orphaned_node",
          nodeId: ne.node_id,
          description: `Node "${ne.node_id}" still running but execution status is "${exec.status}"`,
          severity: "warning",
          suggestion: `Server likely restarted. Reset node to pending or failed.`,
        })
      }
    }

    // Pending hooks
    if (exec.pending_hooks && exec.pending_hooks !== "[]") {
      try {
        const hooks = JSON.parse(exec.pending_hooks)
        if (hooks.length > 0) {
          anomalies.push({
            type: "pending_hooks",
            description: `${hooks.length} hooks pending execution (not yet drained)`,
            severity: "info",
            suggestion: `Resume the execution to drain pending hooks.`,
          })
        }
      } catch {
        // ignore
      }
    }

    return anomalies
  }

  private loadCheckpoints(executionId: string): CheckpointSummary[] {
    const checkpointDir = join(this.workspacePath, "checkpoints", executionId)
    if (!existsSync(checkpointDir)) return []

    try {
      const files = readdirSync(checkpointDir)
        .filter(f => f.endsWith(".json"))
        .sort()
        .slice(-10) // Last 10 checkpoints

      return files.map(f => {
        try {
          const content = JSON.parse(readFileSync(join(checkpointDir, f), "utf-8"))
          return {
            id: f.replace(".json", ""),
            timestamp: content.timestamp ?? "",
            completedNodes: Object.keys(content.completedNodes ?? {}),
            size: JSON.stringify(content).length,
          }
        } catch {
          return { id: f, timestamp: "", completedNodes: [], size: 0 }
        }
      })
    } catch {
      return []
    }
  }

  private findClosestCheckpoint(
    executionId: string,
    nodeId: string,
  ): { poolSnapshot?: Record<string, unknown> } | null {
    const checkpointDir = join(this.workspacePath, "checkpoints", executionId)
    if (!existsSync(checkpointDir)) return null

    try {
      const files = readdirSync(checkpointDir)
        .filter(f => f.endsWith(".json"))
        .sort()
        .reverse()

      for (const f of files) {
        try {
          const content = JSON.parse(readFileSync(join(checkpointDir, f), "utf-8"))
          if (content.completedNodes && nodeId in content.completedNodes) {
            return { poolSnapshot: content.poolSnapshot }
          }
        } catch {
          continue
        }
      }
    } catch {
      // ignore
    }
    return null
  }

  private collectRecentErrors(
    nodeExecutions: Array<{
      node_id: string; status: string; error: string | null; completed_at: string | null;
    }>,
  ): RecentError[] {
    return nodeExecutions
      .filter(ne => ne.status === "failed" && ne.error)
      .map(ne => ({
        timestamp: ne.completed_at ?? "",
        nodeId: ne.node_id,
        error: ne.error!,
        category: this.classifyError(ne.error!),
      }))
      .slice(-20)
  }

  private classifyError(error: string): string {
    const lower = error.toLowerCase()
    if (lower.includes("timeout")) return "timeout"
    if (lower.includes("abort")) return "abort"
    if (lower.includes("permission") || lower.includes("eacces")) return "permission"
    if (lower.includes("not found") || lower.includes("enoent")) return "file_not_found"
    if (lower.includes("api") || lower.includes("rate limit") || lower.includes("429")) return "api_error"
    if (lower.includes("syntax")) return "syntax_error"
    return "unknown"
  }

  private validateNodeTransition(
    currentStatus: NodeExecutionStatus,
    targetStatus: "pending" | "completed",
  ): void {
    if (targetStatus === "pending") {
      const allowed = new Set<NodeExecutionStatus>([
        "completed", "failed", "skipped", "skipped_failed",
        "paused", "cancelled", "rejected", "pending_approval",
      ])
      if (!allowed.has(currentStatus)) {
        throw new RepairError(
          `Invalid transition: ${currentStatus} → pending (allowed from: ${[...allowed].join(", ")})`,
          400,
        )
      }
    }
    if (targetStatus === "completed") {
      const allowed = new Set<NodeExecutionStatus>([
        "failed", "pending", "paused", "cancelled", "skipped",
      ])
      if (!allowed.has(currentStatus)) {
        throw new RepairError(
          `Invalid transition: ${currentStatus} → completed (allowed from: ${[...allowed].join(", ")})`,
          400,
        )
      }
    }
  }

  private getWorkflowContent(executionId: string): string | null {
    return this.executionService.getWorkflowContent(executionId)
  }

  private topologicalSort(nodes: NodeDef[]): NodeDef[] {
    const nodeMap = new Map(nodes.map(n => [n.id, n]))
    const sorted: NodeDef[] = []
    const visited = new Set<string>()
    const visiting = new Set<string>()

    const visit = (id: string) => {
      if (visited.has(id)) return
      if (visiting.has(id)) throw new RepairError(`Circular dependency: ${id}`, 400)
      visiting.add(id)
      const node = nodeMap.get(id)
      if (!node) throw new RepairError(`Node not found in workflow: ${id}`, 404)
      for (const dep of node.depends_on ?? []) visit(dep)
      visiting.delete(id)
      visited.add(id)
      sorted.push(node)
    }

    for (const node of nodes) visit(node.id)
    return sorted
  }

  private parseJson<T>(str: string | null | undefined, fallback: T): T {
    if (!str) return fallback
    try { return JSON.parse(str) } catch { return fallback }
  }

  private emitSSE(event: string, data: Record<string, unknown>): void {
    this.sse.emit(this.workspaceId, { event, data })
  }
}

export class RepairError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message)
    this.name = "RepairError"
  }
}
