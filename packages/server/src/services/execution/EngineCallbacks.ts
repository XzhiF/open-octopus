// packages/server/src/services/execution/EngineCallbacks.ts
import type { IEngineCallbacks, IHookExecutor } from "./interfaces"
import type { IStateFileManager } from "./interfaces"
import type { ServiceContext } from "./types"
import type { ExecutionDAO } from "../../db/dao/execution-dao"
import type { EngineCallbacks as EngineCallbackType } from "@octopus/engine"
import { getArchiveService } from "../archive/archive-service"
import { logError } from "../../file-logger"

export class EngineCallbacks implements IEngineCallbacks {
  constructor(
    private ctx: ServiceContext,
    private dao: ExecutionDAO,
    private stateManager: IStateFileManager,
    private hookExecutor: IHookExecutor,
  ) {}

  buildCallbacks(executionId: string): EngineCallbackType {
    return {
      onNodeStart: (nodeId: string, nodeType: string) => {
        this.dao.insertNodeExecution({
          id: `${executionId}-${nodeId}`,
          execution_id: executionId,
          node_id: nodeId,
          node_type: nodeType,
          status: "running",
          started_at: new Date().toISOString(),
        })

        this.ctx.sse.emit(executionId, {
          type: "node_start",
          nodeId,
          nodeType,
        })
      },

      onNodeEnd: async (nodeId: string, status: string, durationMs: number, result?: any, nodeType?: string) => {
        const nodeExecs = this.dao.findNodeExecutions(executionId)
        const nodeExec = nodeExecs.find(n => n.node_id === nodeId && n.status === "running")
        if (nodeExec) {
          this.dao.updateNodeExecution(nodeExec.id, {
            status,
            duration: durationMs,
            completed_at: new Date().toISOString(),
            outputs: result?.outputs ? JSON.stringify(result.outputs) : null,
            exit_code: result?.exitCode ?? null,
            error: result?.error ?? null,
            session_id: result?.sessionId ?? null,
          })
        }

        this.ctx.sse.emit(executionId, {
          type: "node_end",
          nodeId,
          status,
          durationMs,
          result,
        })

        const execution = this.dao.findById(executionId)
        if (execution) {
          const workflow = this.ctx.workflowService.getWorkflow(execution.workflow_ref)
          if (workflow) {
            const hookEvent = status === "completed" ? "on_node_success" : "on_node_failure"
            const context = {
              node_id: nodeId,
              node_type: nodeType,
              status,
              duration_ms: durationMs,
            }
            await this.hookExecutor.executeWorkflowHooks(hookEvent, context, workflow, executionId)
          }
        }
      },

      onStatusChange: (status: string, progress: number) => {
        this.dao.updateExecution(executionId, { status, progress })

        this.ctx.sse.emit(executionId, {
          type: "status_change",
          status,
          progress,
        })
      },

      onComplete: async (finalStatus: string) => {
        const execution = this.dao.findById(executionId)
        if (!execution) return

        this.stateManager.saveExecutionState(execution as any)

        const workflow = this.ctx.workflowService.getWorkflow(execution.workflow_ref)
        if (workflow) {
          if (finalStatus === "completed") {
            await this.hookExecutor.executeWorkflowHooks("on_success", {}, workflow, executionId)
          } else if (finalStatus === "failed") {
            await this.hookExecutor.executeWorkflowHooks("on_workflow_failure", {}, workflow, executionId)
          }
          await this.hookExecutor.executeWorkflowHooks("on_complete", {}, workflow, executionId)
        }

        this.ctx.sse.emit(executionId, {
          type: "complete",
          status: finalStatus,
        })

        // Archive hook — fire-and-forget, never blocks engine
        const archiveService = getArchiveService()
        if (archiveService) {
          archiveService.archiveExecution(executionId)
            .catch(err => logError("auto-archive failed", err, { executionId }))
        }
      },

      onAgentEvent: (nodeId: string, event: any) => {
        this.ctx.sse.emit(executionId, {
          type: "agent_event",
          nodeId,
          event,
        })
      },
    }
  }
}
