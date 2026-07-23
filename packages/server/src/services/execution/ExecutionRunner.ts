// packages/server/src/services/execution/ExecutionRunner.ts
//
// Background async runners for engine execution: resume, approve, reject.
// Each wraps async engine execution with error handling, status updates, and cleanup.
//
import type { ExecutionDAO } from "../../db/dao/execution-dao"
import type { EnginePool } from "./EnginePool"
import type { SSEService } from "../sse"
import type { WorkflowHooks } from "@octopus/shared"

export interface RunnerDeps {
  dao: ExecutionDAO
  enginePool: EnginePool
  sse: SSEService
  workspaceId: string
  // Callbacks to the lifecycle for cross-cutting concerns
  updateStatus: (id: string, status: string, extra?: Record<string, unknown>) => void
  cleanupOrphanedNodes: (id: string, finalStatus: string) => void
  executeWorkflowHooks: (event: keyof WorkflowHooks, context: Record<string, unknown>, wf: { parsed: any }, executionId: string) => Promise<void>
  getWorkflow: (ref: string) => { ref: string; content: string; parsed: any } | undefined
  findFailedNode: (executionId: string) => string
  findFailedNodeError: (executionId: string) => string
  findNodeDef: (nodes: any[], nodeId: string) => any | null
  syncStateJson: () => void
  approve: (id: string, nodeId: string, answer: string, comment?: string) => Promise<any>
  recordEndCommits: () => Promise<string>
  abortAndWait: (abortController: AbortController, executionId?: string, timeoutMs?: number) => Promise<void>
}

export class ExecutionRunner {
  private deps: RunnerDeps

  constructor(deps: RunnerDeps) {
    this.deps = deps
  }

  async abortAndWait(abortController: AbortController, executionId?: string, timeoutMs = 300000): Promise<void> {
    if (abortController.signal.aborted) return
    abortController.abort()
    if (!executionId) return
    await this.deps.enginePool.waitForSettled(executionId, timeoutMs)
  }

  async runResumeInBackground(
    executionId: string, nodeId: string, signal: AbortSignal,
    intervention: string | undefined, workflowRef: string,
  ): Promise<void> {
    const { dao, enginePool, sse, workspaceId } = this.deps
    try {
      const inst = enginePool.get(executionId)
      if (!inst) return

      const settleRun = enginePool.startRun(executionId)
      let result
      try {
        result = await inst.engine.retryFrom(nodeId, { signal, intervention })
      } finally {
        settleRun()
      }

      if (["completed", "completed_with_failures", "cancelled", "rejected"].includes(result.status)) {
        enginePool.remove(executionId)
      }

      if (result.status === "pending_approval") {
        dao.updateExecution(executionId, { var_pool: JSON.stringify(result.poolSnapshot) })
        const nextPausedNodeId = Object.entries(result.nodeResults).find(([, r]: [string, any]) => r.status === "paused")?.[0]
        if (nextPausedNodeId) {
          const wf = this.deps.getWorkflow(workflowRef)
          const nodeDef = this.deps.findNodeDef(wf?.parsed.nodes ?? [], nextPausedNodeId)
          const timeout = nodeDef?.approval_timeout
          if (timeout && timeout > 0) {
            const timer = setTimeout(async () => {
              try { await this.deps.approve(executionId, nextPausedNodeId, "timeout", "Auto-rejected by timeout") } catch (e) {
                console.error(`[ExecutionRunner] Timeout approval failed for ${executionId}`, e)
              }
            }, timeout * 1000)
            enginePool.setApprovalTimer(executionId, timer)
          }
        }
      }

      this.deps.updateStatus(executionId, result.status, {
        completed_at: new Date().toISOString(), duration: result.durationMs, progress: 100,
        var_pool: JSON.stringify(result.poolSnapshot),
        gate_status: result.status === "pending_approval" ? "pending" : (result.status === "completed" ? "open" : "closed"),
      })

      this.deps.cleanupOrphanedNodes(executionId, result.status)

      const wfForHook = this.deps.getWorkflow(workflowRef)
      if (wfForHook) {
        if (result.status === "failed") {
          await this.deps.executeWorkflowHooks("on_workflow_failure", {
            failed_node_id: this.deps.findFailedNode(executionId), error: this.deps.findFailedNodeError(executionId), duration_ms: result.durationMs,
          }, wfForHook, executionId)
        }
        if (result.status === "completed") {
          await this.deps.executeWorkflowHooks("on_complete", { final_status: "completed" }, wfForHook, executionId)
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[ExecutionRunner] Resume failed for ${executionId}:`, msg)
      dao.updateExecution(executionId, { status: "failed", var_pool: JSON.stringify({ error: msg }) })
      enginePool.remove(executionId)
    }
  }

  async runApproveInBackground(
    executionId: string, nodeId: string, signal: AbortSignal,
    answer: string, comment: string | undefined, workflowRef: string,
  ): Promise<void> {
    const { dao, enginePool, sse, workspaceId } = this.deps
    try {
      const inst = enginePool.get(executionId)
      if (!inst) return

      const settleRun = enginePool.startRun(executionId)
      let result
      try {
        result = await inst.engine.retryFrom(nodeId, {
          userChoice: answer, userComment: comment, signal,
        })
      } finally {
        settleRun()
      }

      if (["completed", "completed_with_failures", "cancelled", "rejected"].includes(result.status)) {
        enginePool.remove(executionId)
      }

      if (result.status === "pending_approval") {
        dao.updateExecution(executionId, { var_pool: JSON.stringify(result.poolSnapshot) })
        const nextPausedEntry = Object.entries(result.nodeResults).find(([, r]: [string, any]) => r.status === "paused" || r.status === "pending_approval")
        const nextPausedNodeId = nextPausedEntry?.[0]
        if (nextPausedNodeId) {
          const wf = this.deps.getWorkflow(workflowRef)
          const nodeDef = this.deps.findNodeDef(wf?.parsed.nodes ?? [], nextPausedNodeId)
          const timeout = nodeDef?.approval_timeout
          if (timeout && timeout > 0) {
            const timer = setTimeout(async () => {
              try { await this.deps.approve(executionId, nextPausedNodeId, "timeout", "Auto-rejected by timeout") } catch (e) {
                console.error(`[ExecutionRunner] Timeout approval failed for ${executionId}`, e)
              }
            }, timeout * 1000)
            enginePool.setApprovalTimer(executionId, timer)
          }
        }
      }

      const currentExec = dao.findById(executionId)
      if (currentExec?.status === "paused") {
        const nodeStats = dao.findNodeStatsForExecution(executionId)
        if (nodeStats.running_or_pending === 0) {
          console.log(`[ExecutionRunner] Execution ${executionId} was paused but all nodes completed during approve`)
        } else {
          console.log(`[ExecutionRunner] Execution ${executionId} paused, ${nodeStats.running_or_pending} nodes still running`)
          this.deps.syncStateJson()
          return
        }
      }

      const endCommitId = await this.deps.recordEndCommits()
      dao.updateExecution(executionId, { end_commit_id: endCommitId })

      this.deps.updateStatus(executionId, result.status, {
        completed_at: new Date().toISOString(), duration: result.durationMs, progress: 100,
        var_pool: JSON.stringify(result.poolSnapshot),
        gate_status: result.status === "completed" ? "open" : "closed",
      })

      this.deps.cleanupOrphanedNodes(executionId, result.status)

      const wfForHook = this.deps.getWorkflow(workflowRef)
      if (wfForHook) {
        if (result.status === "failed") {
          await this.deps.executeWorkflowHooks("on_workflow_failure", {
            failed_node_id: this.deps.findFailedNode(executionId), error: this.deps.findFailedNodeError(executionId), duration_ms: result.durationMs,
          }, wfForHook, executionId)
        }
        if (result.status === "completed") {
          await this.deps.executeWorkflowHooks("on_success", { duration_ms: result.durationMs }, wfForHook, executionId)
        }
        await this.deps.executeWorkflowHooks("on_complete", { final_status: result.status, duration_ms: result.durationMs }, wfForHook, executionId)
      }

      this.deps.syncStateJson()
      sse.emit(workspaceId, { event: "complete", data: { executionId, finalStatus: result.status } })
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[ExecutionRunner] Approve continuation failed for ${executionId}:`, msg)
      enginePool.remove(executionId)

      this.deps.updateStatus(executionId, "failed", { completed_at: new Date().toISOString() })
      dao.updateNodeExecutionsByStatus(executionId, "failed", ["running", "pending"], { error: `Approve failed: ${msg}` })
      this.deps.syncStateJson()

      try {
        const wfForHook = this.deps.getWorkflow(workflowRef)
        if (wfForHook) {
          await this.deps.executeWorkflowHooks("on_workflow_failure", { failed_node_id: this.deps.findFailedNode(executionId), error: msg }, wfForHook, executionId)
          await this.deps.executeWorkflowHooks("on_complete", { final_status: "failed" }, wfForHook, executionId)
        }
      } catch { /* non-fatal */ }

      sse.emit(workspaceId, { event: "complete", data: { executionId, finalStatus: "failed", error: msg } })
    }
  }

  async runRejectInBackground(
    executionId: string, approvalNodeId: string, onRejectNodeId: string,
    signal: AbortSignal, comment: string | undefined, workflowRef: string,
  ): Promise<void> {
    const { dao, enginePool, sse, workspaceId } = this.deps
    const wf = this.deps.getWorkflow(workflowRef)
    try {
      const inst = enginePool.get(executionId)
      if (!inst) return

      const settleRun = enginePool.startRun(executionId)
      let result
      try {
        result = await inst.engine.retryFrom(onRejectNodeId, {
          userChoice: "reject", userComment: comment, signal,
        })
      } finally {
        settleRun()
      }

      if (["completed", "completed_with_failures", "cancelled", "rejected"].includes(result.status)) {
        enginePool.remove(executionId)
      }

      const endCommitId = await this.deps.recordEndCommits()
      dao.updateExecution(executionId, { end_commit_id: endCommitId })

      const finalStatus = result.status === "failed" ? "failed" : "rejected"

      this.deps.updateStatus(executionId, finalStatus, {
        completed_at: new Date().toISOString(), duration: result.durationMs, progress: 100,
        var_pool: JSON.stringify(result.poolSnapshot),
        gate_status: finalStatus === "completed" ? "open" : "closed",
      })

      this.deps.cleanupOrphanedNodes(executionId, result.status)

      if (wf) {
        try {
          if (finalStatus === "failed") {
            await this.deps.executeWorkflowHooks("on_workflow_failure", {
              failed_node_id: approvalNodeId, error: "Rejected by user (on_reject handler failed)", duration_ms: result.durationMs ?? 0,
            }, wf, executionId)
          }
          await this.deps.executeWorkflowHooks("on_complete", { final_status: finalStatus }, wf, executionId)
        } catch { /* non-fatal */ }
      }

      this.deps.syncStateJson()
      sse.emit(workspaceId, { event: "complete", data: { executionId, finalStatus } })
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[ExecutionRunner] on_reject handler failed for ${executionId}:`, msg)
      enginePool.remove(executionId)
      this.deps.updateStatus(executionId, "failed", { completed_at: new Date().toISOString() })
      dao.updateNodeExecutionsByStatus(executionId, "failed", ["running", "pending", "paused"])
      if (wf) {
        try {
          await this.deps.executeWorkflowHooks("on_workflow_failure", { failed_node_id: approvalNodeId, error: msg, duration_ms: 0 }, wf, executionId)
          await this.deps.executeWorkflowHooks("on_complete", { final_status: "failed" }, wf, executionId)
        } catch { /* non-fatal */ }
      }
      this.deps.syncStateJson()
      sse.emit(workspaceId, { event: "complete", data: { executionId, finalStatus: "failed", error: msg } })
    }
  }
}
