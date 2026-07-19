import { VarPool, evaluateExpression } from "@octopus/shared"
import type { NodeDef } from "@octopus/shared"
import type { NodeExecutor, NodeExecutionResult, InnerNodeOverride } from "./types"
import type { LoopConfig, ResumeConfig } from "./executor-config"
import type { AgentEvent } from "./agent-types"
import { AgentNodeRunner } from "./agent-runner"
import { BashExecutor } from "./bash"
import { PythonExecutor } from "./python"
import { ConditionExecutor } from "./condition"
import { ApprovalExecutor } from "./approval"
import { AgentExecutor } from "./agent"
import { SwarmExecutor } from "./swarm"

export class LoopExecutor implements NodeExecutor {
  private iterations = 0
  private config: LoopConfig
  private resume?: ResumeConfig

  constructor(
    private node: NodeDef,
    private pool: VarPool,
    config: LoopConfig,
    resume?: ResumeConfig,
  ) {
    this.config = config
    this.resume = resume
    if (resume?.resumeIteration) {
      // Set to resumeIteration - 1 because the while loop does this.iterations++ at the start.
      // This ensures the resumed iteration runs at the correct number (e.g., resume at iter 2,
      // not skip to iter 3).
      this.iterations = resume.resumeIteration - 1
    }
  }

  async execute(): Promise<NodeExecutionResult> {
    const start = Date.now()
    const maxIterations = this.node.max_iterations ?? 100
    const innerNodes = this.node.nodes ?? []
    const logLines: string[] = []

    while (this.iterations < maxIterations) {
      if (this.config.signal?.aborted) {
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

      this.config.logger?.log(this.node.id, 'branch_start', { iteration: this.iterations })
      this.config.callbacks?.onBranchStart?.(`${this.node.id}-iter-${this.iterations}`, this.iterations)

      let shouldBreak = false
      let shouldContinue = false
      let jumpToIndex = -1
      const iterationNodeResults: { nodeId: string; status: string; durationMs?: number; error?: string }[] = []
      /** Completed inner node results in this iteration (for resume on pending_approval) */
      const completedInnerResults = new Map<string, NodeExecutionResult>()

      // On first iteration with resumeFromNodeId, skip to that node
      const startNi = (this.iterations === 1 && this.resume?.resumeFromNodeId)
        ? innerNodes.findIndex(n => n.id === this.resume?.resumeFromNodeId)
        : jumpToIndex >= 0 ? jumpToIndex : 0

      const prevLoopContext = this.config.logger?.setLoopContext(this.node.id, this.iterations)
      try {
        for (let ni = startNi; ni < innerNodes.length; ni++) {
        jumpToIndex = -1 // reset for this iteration of the for loop
        const innerNode = innerNodes[ni]
        if (shouldContinue) continue

        // Check for inner node override (resume scenario)
        const override = this.resume?.innerNodeOverrides?.get(innerNode.id)
        let result: NodeExecutionResult

        if (override?.kind === "result") {
          // Use pre-computed result from previous iteration
          result = override.result
          this.config.logger?.log(innerNode.id, "start", { type: innerNode.type })
          this.config.callbacks?.onNodeStart?.(innerNode.id, innerNode.type)
          this.config.logger?.log(innerNode.id, "end", { status: result.status, durationMs: result.durationMs })
          this.config.callbacks?.onNodeEnd?.(innerNode.id, result.status, result.durationMs, result, innerNode.type)
        } else if (override?.kind === "approval") {
          // Create approval executor with user's choice
          const approvalExec = new ApprovalExecutor(innerNode, this.pool, { userChoice: override.userChoice, userComment: override.userComment, signal: this.config.signal, loopContext: { iteration: this.iterations } })
          this.config.logger?.log(innerNode.id, "start", { type: innerNode.type })
          this.config.callbacks?.onNodeStart?.(innerNode.id, innerNode.type)
          const innerStart = Date.now()
          result = await approvalExec.execute()
          const innerDurationMs = Date.now() - innerStart
          this.config.logger?.log(innerNode.id, "end", { status: result.status, durationMs: innerDurationMs })
          this.config.callbacks?.onNodeEnd?.(innerNode.id, result.status, innerDurationMs, result, innerNode.type)
          // Clear override after consumption so subsequent iterations pause again
          this.resume?.innerNodeOverrides?.delete(innerNode.id)
        } else {
          // Normal execution
          const executor = this.createExecutor(innerNode, undefined, completedInnerResults)

          // Notify engine about inner node execution (so it records to node_executions)
          this.config.logger?.log(innerNode.id, "start", { type: innerNode.type })
          this.config.callbacks?.onNodeStart?.(innerNode.id, innerNode.type)
          const innerStart = Date.now()
          result = await executor.execute()
          const innerDurationMs = Date.now() - innerStart
          this.config.logger?.log(innerNode.id, "end", { status: result.status, durationMs: innerDurationMs, exitCode: result.exitCode })
          this.config.callbacks?.onNodeEnd?.(innerNode.id, result.status, innerDurationMs, result, innerNode.type)
        }

        // Log approval metadata for approval nodes (both override and normal paths)
        if (innerNode.type === "approval" && (result.approvalMetadata || result.decision)) {
          this.config.logger?.log(innerNode.id, "approval_metadata", {
            prompt: result.approvalMetadata?.prompt ?? "",
            options: result.approvalMetadata?.options ?? [],
            decision: result.decision ?? "",
            comment: result.comment ?? "",
          })
        }

        // Compact iteration-scoped JSONL after inner node completes
        if (this.config.logger) {
          try {
            const mergedEvents = this.config.logger.compactFile(innerNode.id)
            if (mergedEvents && mergedEvents.length > 0) {
              this.config.callbacks?.onNodeCompacted?.(innerNode.id, mergedEvents)
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

        // Track completed inner node result for potential resume
        if (result.status === "completed" || result.status === "skipped" || result.status === "skipped_failed") {
          completedInnerResults.set(innerNode.id, result)
        }

        if (result.status === "paused" || result.status === "pending_approval") {
          const durationMs = Date.now() - start
          // Build innerNodeResults from completed nodes (for resume)
          const innerNodeResults: Record<string, NodeExecutionResult> = {}
          completedInnerResults.forEach((v, k) => { innerNodeResults[k] = v })
          return {
            outputs: { iterations: this.iterations },
            status: result.status,
            durationMs,
            logLines,
            iterations: this.iterations,
            timeout: result.timeout,
            // Propagate approvalMetadata so the server can store it and emit SSE.
            // The first time, the inner node's onNodeEnd already stored it,
            // but on subsequent loop iterations the loop's onNodeEnd is the
            // only source of the new approval info.
            approvalMetadata: result.approvalMetadata,
            innerNodeResults,
          }
        }

        if (result.status === "cancelled") {
          this.config.logger?.log(this.node.id, 'branch_end', { iteration: this.iterations, status: "cancelled", nodeResults: iterationNodeResults })
          this.config.callbacks?.onBranchEnd?.(`${this.node.id}-iter-${this.iterations}`, this.iterations, "cancelled", iterationNodeResults)
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
          this.config.logger?.log(this.node.id, 'branch_end', { iteration: this.iterations, status: "failed", nodeResults: iterationNodeResults })
          this.config.callbacks?.onBranchEnd?.(`${this.node.id}-iter-${this.iterations}`, this.iterations, "failed", iterationNodeResults)
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
        this.config.logger?.restoreLoopContext(prevLoopContext ?? { loopNodeId: undefined, iteration: undefined })
      }

      this.config.logger?.log(this.node.id, 'branch_end', { iteration: this.iterations, status: "completed", nodeResults: iterationNodeResults })
      this.config.callbacks?.onBranchEnd?.(`${this.node.id}-iter-${this.iterations}`, this.iterations, "completed", iterationNodeResults)

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
      sessionId: this.config.globalSessionId,
    }
  }

  private checkWhileCondition(): boolean {
    const whileExpr = this.node.while
    if (!whileExpr) return true
    return evaluateExpression(whileExpr, this.pool, undefined, this.config.inputs, { iteration: this.iterations })
  }

  private checkBreakWhen(node: NodeDef): boolean {
    const breakExpr = node.break_when
    if (!breakExpr) return false
    return evaluateExpression(breakExpr, this.pool, undefined, this.config.inputs, { iteration: this.iterations })
  }

  private checkContinueWhen(node: NodeDef): boolean {
    const continueExpr = node.continue_when
    if (!continueExpr) return false
    return evaluateExpression(continueExpr, this.pool, undefined, this.config.inputs, { iteration: this.iterations })
  }

  private resolvePreviousSessionId(node: NodeDef): string | undefined {
    if (node.resume_from) {
      return this.config.branchSessionIds?.get(node.resume_from)
    }
    const effectiveContext = node.context ?? "continue"
    if (effectiveContext === "continue") {
      return this.config.globalSessionId
    }
    return undefined
  }

  private updateSessionContext(node: NodeDef, result: NodeExecutionResult): void {
    if (node.type !== "agent" || !result.sessionId) return

    if (node.resume_from) {
      this.config.globalSessionId = result.sessionId
      return
    }

    const effectiveContext = node.context ?? "continue"
    if (effectiveContext === "continue") {
      this.config.globalSessionId = result.sessionId
    } else {
      this.config.branchSessionIds?.set(node.id, result.sessionId)
    }
  }

  private createExecutor(node: NodeDef, pool?: VarPool, completedInnerResults?: Map<string, NodeExecutionResult>): NodeExecutor {
    const p = pool ?? this.pool
    const loopCtx = { iteration: this.iterations }
    switch (node.type) {
      case "swarm":
        return new SwarmExecutor(node, p, {
          providers: this.config.providers,
          cwd: this.config.cwd,
          callbacks: this.config.callbacks,
          logger: this.config.logger,
          checkpointStore: this.config.checkpointStore,
          executionId: this.config.executionId,
          modelAliasConfig: this.config.modelAliasConfig,
          workflowEngine: this.config.workflowEngine,
          agentResolver: this.config.agentResolver,
          engineHookFn: this.config.hookExecutor,
        })
      case "bash": {
        // ponytail: build nodeOutputs so $nodeId.output.key works in bash scripts
        const bashNodeOutputs: Record<string, Record<string, any>> = {}
        if (completedInnerResults) {
          for (const [id, r] of completedInnerResults) {
            if (r.outputs) bashNodeOutputs[id] = r.outputs
          }
        }
        return new BashExecutor(node, p, {
          signal: this.config.signal,
          onLog: (line, stream) => {
            const event = stream === "stderr" ? "bash_stderr" : "bash_log"
            this.config.logger?.log(node.id, event, { line })
            this.config.callbacks?.onNodeLog?.(node.id, line)
          },
          cwd: this.config.cwd,
          loopContext: loopCtx,
          nodeOutputs: bashNodeOutputs,
        })
      }
      case "python":
        return new PythonExecutor(node, p, {
          signal: this.config.signal,
          onLog: (line, stream) => {
            const event = stream === "stderr" ? "python_stderr" : "python_log"
            this.config.logger?.log(node.id, event, { line })
            this.config.callbacks?.onNodeLog?.(node.id, line)
          },
        })
      case "condition":
        return new ConditionExecutor(node, p)
      case "approval": {
        // ponytail: build nodeOutputs from completed inner results so $nodeId.output.key works
        const approvalNodeOutputs: Record<string, Record<string, any>> = {}
        if (completedInnerResults) {
          for (const [id, r] of completedInnerResults) {
            if (r.outputs) approvalNodeOutputs[id] = r.outputs
          }
        }
        return new ApprovalExecutor(node, p, { signal: this.config.signal, loopContext: loopCtx, nodeOutputs: approvalNodeOutputs })
      }
      case "agent": {
        const rawKey = node.engine ?? this.config.workflowEngine ?? "claude"
        const providerKey = rawKey === "claude-code" ? "claude" : rawKey
        const provider = this.config.providers[providerKey]
        if (!provider) throw new Error(`Unknown provider: ${rawKey}`)

        const runner = new AgentNodeRunner(provider, this.config.cwd, (event: AgentEvent) => {
          this.config.logger?.log(node.id, "agent_event", { event_data: event })
          this.config.callbacks?.onAgentEvent?.(node.id, event)
        })

        const previousSessionId = this.resolvePreviousSessionId(node)

        // Build engineContext: merge engine's top-level results with loop's iteration results
        const mergedNodeResults: Record<string, NodeExecutionResult> = { ...(this.resume?.engineNodeResults ?? {}) }
        if (completedInnerResults) {
          for (const [id, r] of completedInnerResults) {
            mergedNodeResults[id] = r
          }
        }

        return new AgentExecutor(node, p, {
          runner,
          previousSessionId,
          globalAutoAnswers: this.config.globalAutoAnswers,
          signal: this.config.signal,
          engineContext: { nodeResults: mergedNodeResults },
          loopContext: loopCtx,
          modelAliasConfig: this.config.modelAliasConfig,
          providerKey,
        })
      }
      case "loop":
        return new LoopExecutor(node, p, this.config, { engineNodeResults: this.resume?.engineNodeResults })
      default:
        throw new Error(`Unknown node type: ${node.type}`)
    }
  }
}