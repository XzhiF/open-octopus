import { VarPool, evaluateExpression } from "@octopus/shared"
import type { NodeDef, AutoAnswer } from "@octopus/shared"
import type { IAgentProvider } from "@octopus/providers"
import type { NodeExecutor, NodeExecutionResult } from "./types"
import type { AgentEvent } from "./agent-types"
import { AgentNodeRunner } from "./agent-runner"
import type { EngineCallbacks } from "../engine"
import { JsonlLogger } from "../logger"
import { BashExecutor } from "./bash"
import { PythonExecutor } from "./python"
import { ConditionExecutor } from "./condition"
import { ApprovalExecutor } from "./approval"
import { AgentExecutor } from "./agent"

export class LoopExecutor implements NodeExecutor {
  private iterations = 0

  constructor(
    private node: NodeDef,
    private pool: VarPool,
    private providers: Record<string, IAgentProvider>,
    private cwd: string,
    private globalAutoAnswers?: AutoAnswer[],
    private signal?: AbortSignal,
    private callbacks?: EngineCallbacks,
    private logger?: JsonlLogger,
    private globalSessionId?: string,
    private branchSessionIds?: Map<string, string>,
    private inputs?: Record<string, any>,
    /** Workflow-level engine fallback (node.engine ?? workflow.engine ?? "claude") */
    private workflowEngine?: string,
  ) {}

  async execute(): Promise<NodeExecutionResult> {
    const start = Date.now()
    const maxIterations = this.node.max_iterations ?? 100
    const innerNodes = this.node.nodes ?? []
    const logLines: string[] = []

    while (this.iterations < maxIterations) {
      if (this.signal?.aborted) {
        logLines.push("Loop cancelled by user")
        const durationMs = Date.now() - start
        return {
          outputs: { iterations: this.iterations },
          status: "cancelled",
          durationMs,
          logLines,
          iterations: this.iterations,
        }
      }

      if (!this.checkWhileCondition()) {
        logLines.push(`Loop exited: while condition false at iteration ${this.iterations}`)
        break
      }

      this.iterations++
      logLines.push(`Loop iteration ${this.iterations}`)

      this.logger?.log(this.node.id, 'branch_start', { iteration: this.iterations })
      this.callbacks?.onBranchStart?.(`${this.node.id}-iter-${this.iterations}`, this.iterations)

      let shouldBreak = false
      let shouldContinue = false
      let jumpToIndex = -1
      const iterationNodeResults: { nodeId: string; status: string; durationMs?: number; error?: string }[] = []

      const prevLoopContext = this.logger?.setLoopContext(this.node.id, this.iterations)
      try {
        for (let ni = jumpToIndex >= 0 ? jumpToIndex : 0; ni < innerNodes.length; ni++) {
        jumpToIndex = -1 // reset for this iteration of the for loop
        const innerNode = innerNodes[ni]
        if (shouldContinue) continue

        const executor = this.createExecutor(innerNode)

        // Notify engine about inner node execution (so it records to node_executions)
        this.callbacks?.onNodeStart?.(innerNode.id, innerNode.type)
        const innerStart = Date.now()
        const result = await executor.execute()
        const innerDurationMs = Date.now() - innerStart
        this.callbacks?.onNodeEnd?.(innerNode.id, result.status, innerDurationMs, result, innerNode.type)

        // Compact iteration-scoped JSONL after inner node completes
        if (this.logger) {
          try {
            const mergedEvents = this.logger.compactFile(innerNode.id)
            if (mergedEvents && mergedEvents.length > 0) {
              this.callbacks?.onNodeCompacted?.(innerNode.id, mergedEvents)
            }
          } catch { /* compact failure is non-fatal */ }
        }

        logLines.push(...result.logLines)
        iterationNodeResults.push({
          nodeId: innerNode.id,
          status: result.status,
          durationMs: result.durationMs,
          error: result.error ?? (result.logLines?.length && result.status === "failed" ? result.logLines.join("\n") : undefined),
        })

        this.updateSessionContext(innerNode, result)

        if (result.status === "paused") {
          const durationMs = Date.now() - start
          return {
            outputs: { iterations: this.iterations },
            status: "paused",
            durationMs,
            logLines,
            iterations: this.iterations,
            timeout: result.timeout,
          }
        }

        if (result.status === "cancelled") {
          this.logger?.log(this.node.id, 'branch_end', { iteration: this.iterations, status: "cancelled", nodeResults: iterationNodeResults })
          this.callbacks?.onBranchEnd?.(`${this.node.id}-iter-${this.iterations}`, this.iterations, "cancelled", iterationNodeResults)
          const durationMs = Date.now() - start
          return {
            outputs: { iterations: this.iterations },
            status: "cancelled",
            durationMs,
            logLines,
            iterations: this.iterations,
          }
        }

        if (result.status === "failed") {
          this.logger?.log(this.node.id, 'branch_end', { iteration: this.iterations, status: "failed", nodeResults: iterationNodeResults })
          this.callbacks?.onBranchEnd?.(`${this.node.id}-iter-${this.iterations}`, this.iterations, "failed", iterationNodeResults)
          const durationMs = Date.now() - start
          return {
            outputs: { iterations: this.iterations },
            status: "failed",
            durationMs,
            logLines,
            iterations: this.iterations,
          }
        }

        if (innerNode.type === "condition" && result.jumpTo === "break") {
          shouldBreak = true
          break
        }

        if (innerNode.type === "condition" && result.jumpTo === "continue") {
          shouldContinue = true
          continue
        }

        if (this.checkBreakWhen(this.node) || this.checkBreakWhen(innerNode)) {
          shouldBreak = true
          break
        }

        if (this.checkContinueWhen(this.node) || this.checkContinueWhen(innerNode)) {
          shouldContinue = true
          continue
        }

        // Condition jumpTo targeting another node
        if (innerNode.type === "condition" && result.jumpTo) {
          const targetIdx = innerNodes.findIndex(n => n.id === result.jumpTo)
          if (targetIdx > ni) {
            // Forward jump: skip nodes between current and target
            ni = targetIdx - 1 // -1 because for loop will ni++
          } else {
            // Backward jump or target not found: end this iteration
            // (backward re-entry is handled by the outer while loop's next iteration)
            break
          }
        }
      }
      } finally {
        this.logger?.restoreLoopContext(prevLoopContext ?? { loopNodeId: undefined, iteration: undefined })
      }

      this.logger?.log(this.node.id, 'branch_end', { iteration: this.iterations, status: "completed", nodeResults: iterationNodeResults })
      this.callbacks?.onBranchEnd?.(`${this.node.id}-iter-${this.iterations}`, this.iterations, "completed", iterationNodeResults)

      if (shouldBreak) {
        logLines.push(`Loop break at iteration ${this.iterations}`)
        break
      }
    }

    if (this.iterations >= maxIterations) {
      logLines.push(`Loop hit max_iterations limit: ${maxIterations}`)
    }

    const durationMs = Date.now() - start
    return {
      outputs: { iterations: this.iterations },
      status: "completed",
      durationMs,
      logLines,
      iterations: this.iterations,
      sessionId: this.globalSessionId,
    }
  }

  private checkWhileCondition(): boolean {
    const whileExpr = this.node.while
    if (!whileExpr) return true
    return evaluateExpression(whileExpr, this.pool, undefined, this.inputs, { iteration: this.iterations })
  }

  private checkBreakWhen(node: NodeDef): boolean {
    const breakExpr = node.break_when
    if (!breakExpr) return false
    return evaluateExpression(breakExpr, this.pool, undefined, this.inputs, { iteration: this.iterations })
  }

  private checkContinueWhen(node: NodeDef): boolean {
    const continueExpr = node.continue_when
    if (!continueExpr) return false
    return evaluateExpression(continueExpr, this.pool, undefined, this.inputs, { iteration: this.iterations })
  }

  private resolvePreviousSessionId(node: NodeDef): string | undefined {
    if (node.resume_from) {
      return this.branchSessionIds?.get(node.resume_from)
    }
    const effectiveContext = node.context ?? "continue"
    if (effectiveContext === "continue") {
      return this.globalSessionId
    }
    return undefined
  }

  private updateSessionContext(node: NodeDef, result: NodeExecutionResult): void {
    if (node.type !== "agent" || !result.sessionId) return

    if (node.resume_from) {
      this.globalSessionId = result.sessionId
      return
    }

    const effectiveContext = node.context ?? "continue"
    if (effectiveContext === "continue") {
      this.globalSessionId = result.sessionId
    } else {
      this.branchSessionIds?.set(node.id, result.sessionId)
    }
  }

  private createExecutor(node: NodeDef, pool?: VarPool): NodeExecutor {
    const p = pool ?? this.pool
    const loopCtx = { iteration: this.iterations }
    if (node.type === "swarm") {
      throw new Error("swarm 节点不支持嵌套在 loop 内部")
    }
    switch (node.type) {
      case "bash":
        return new BashExecutor(node, p, this.signal, (line, stream) => {
          const event = stream === "stderr" ? "bash_stderr" : "bash_log"
          this.logger?.log(node.id, event, { line })
          this.callbacks?.onNodeLog?.(node.id, line)
        }, this.cwd, undefined, undefined, loopCtx)
      case "python":
        return new PythonExecutor(node, p, this.signal, (line, stream) => {
          const event = stream === "stderr" ? "python_stderr" : "python_log"
          this.logger?.log(node.id, event, { line })
          this.callbacks?.onNodeLog?.(node.id, line)
        })
      case "condition":
        return new ConditionExecutor(node, p)
      case "approval":
        return new ApprovalExecutor(node, p, undefined, undefined, this.signal)
      case "agent": {
        const rawKey = node.engine ?? this.workflowEngine ?? "claude"
        const providerKey = rawKey === "claude-code" ? "claude" : rawKey
        const provider = this.providers[providerKey]
        if (!provider) throw new Error(`Unknown provider: ${rawKey}`)

        const runner = new AgentNodeRunner(provider, this.cwd, (event: AgentEvent) => {
          this.logger?.log(node.id, "agent_event", { event_data: event })
          this.callbacks?.onAgentEvent?.(node.id, event)
        })

        const previousSessionId = this.resolvePreviousSessionId(node)

        return new AgentExecutor(
          node, p, runner, previousSessionId,
          this.globalAutoAnswers, this.signal,
          undefined, undefined, undefined, undefined, undefined, undefined, loopCtx,
        )
      }
      case "loop":
        return new LoopExecutor(node, p, this.providers, this.cwd, this.globalAutoAnswers, this.signal, this.callbacks, this.logger, this.globalSessionId, this.branchSessionIds)
      default:
        throw new Error(`Unknown node type: ${node.type}`)
    }
  }
}