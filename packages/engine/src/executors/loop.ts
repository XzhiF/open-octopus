import { VarPool, evaluateExpression, resolveModelAlias } from "@octopus/shared"
import type { NodeDef, SubunitSpec } from "@octopus/shared"
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
import { SubWorkflowExecutor } from "./sub-workflow"
import { DynamicSubWorkflowExecutor } from "./dynamic-sub-workflow"
import { TaskDispatchExecutor } from "./task-dispatch"
import { extractBreakWhenVars, forceAdvanceLoopVars } from "./loop-fallback"
import { join } from "path"

export class LoopExecutor implements NodeExecutor {
  private iterations = 0
  private config: LoopConfig
  private resume?: ResumeConfig
  /** Carry forward previous iteration's inner node results for $nodeId.output resolution */
  private prevIterationResults = new Map<string, NodeExecutionResult>()

  /**
   * Build nodeOutputs map from engine results + inner loop results.
   * Maps lastOutput → "output" and "last_output" keys so $nodeId.output.last_output resolves.
   */
  private buildInnerNodeOutputs(
    completedInnerResults?: Map<string, NodeExecutionResult>,
  ): Record<string, Record<string, any>> {
    const nodeOutputs: Record<string, Record<string, any>> = {}
    if (this.config.engineNodeResults) {
      for (const [id, r] of Object.entries(this.config.engineNodeResults)) {
        const outputs = { ...(r.outputs ?? {}) }
        if (r.lastOutput !== undefined) {
          outputs["output"] = r.lastOutput
          outputs["last_output"] = r.lastOutput
        }
        nodeOutputs[id] = outputs
      }
    }
    if (completedInnerResults) {
      for (const [id, r] of completedInnerResults) {
        const outputs = { ...(r.outputs ?? {}) }
        if (r.lastOutput !== undefined) {
          outputs["output"] = r.lastOutput
          outputs["last_output"] = r.lastOutput
        }
        nodeOutputs[id] = outputs
      }
    }
    return nodeOutputs
  }

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
    // Restore inner node results from the iteration that paused,
    // so $nodeId.output references resolve correctly in subsequent iterations.
    if (resume?.prevIterationResults) {
      for (const [id, r] of Object.entries(resume.prevIterationResults)) {
        this.prevIterationResults.set(id, r)
      }
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
      // Seed with previous iteration's results so $nodeId.output references resolve
      // across iterations (e.g., $requirements-approval.output.comment in round 2)
      if (this.iterations > 0) {
        for (const [id, r] of this.prevIterationResults) {
          completedInnerResults.set(id, r)
        }
      }

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
          const approvalExec = new ApprovalExecutor(innerNode, this.pool, {
            userChoice: override.userChoice,
            userComment: override.userComment,
            signal: this.config.signal,
            loopContext: { iteration: this.iterations },
            nodeOutputs: this.buildInnerNodeOutputs(completedInnerResults),
            cwd: this.config.cwd,
          })
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
          // ── Snapshot loop-condition vars BEFORE agent execution ──
          const loopConditionExprs = [
            this.node.break_when,
            this.node.while,
            innerNode.break_when,
          ].filter(Boolean) as string[]
          const loopConditionVars = innerNode.type === "agent"
            ? [...new Set(loopConditionExprs.flatMap(extractBreakWhenVars))]
            : []
          const snapshotBefore = new Map<string, unknown>()
          for (const key of loopConditionVars) {
            snapshotBefore.set(key, this.pool.get(key))
          }

          // Check execute_when before executing (mirrors engine.ts:866)
          if (innerNode.execute_when) {
            const nodeOutputs = this.buildInnerNodeOutputs(completedInnerResults)
            const shouldRun = evaluateExpression(innerNode.execute_when, this.pool, nodeOutputs)
            if (!shouldRun) {
              result = {
                status: "skipped",
                outputs: {},
                durationMs: 0,
                logLines: [`Skipped: execute_when "${innerNode.execute_when}" evaluated false`],
                skippedByCondition: true,
              }
              this.config.logger?.log(innerNode.id, "start", { type: innerNode.type })
              this.config.callbacks?.onNodeStart?.(innerNode.id, innerNode.type)
              this.config.logger?.log(innerNode.id, "end", { status: "skipped" })
              this.config.callbacks?.onNodeEnd?.(innerNode.id, "skipped", 0, result, innerNode.type)
              // Still track as completed so later nodes can reference it
              completedInnerResults.set(innerNode.id, result)
              // Collect log lines & update session context
              logLines.push(...result.logLines)
              iterationNodeResults.push({
                nodeId: innerNode.id,
                status: result.status,
                durationMs: 0,
              })
              this.updateSessionContext(innerNode, result)
              continue
            }
          }

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

          // ── Loop fallback: force-advance if agent completed without updating loop vars ──
          if (innerNode.type === "agent" && result.status === "completed" && loopConditionVars.length > 0) {
            const fallbackResult = forceAdvanceLoopVars(this.pool, loopConditionVars, snapshotBefore)
            if (fallbackResult.applied) {
              const changesDesc = fallbackResult.changes
                .map(c => `${c.key}: ${JSON.stringify(c.oldVal)} → ${JSON.stringify(c.newVal)}`)
                .join(", ")
              const warnMsg = `[loop-fallback] Agent "${innerNode.id}" completed without vars_update; force-advanced: ${changesDesc}`
              logLines.push(warnMsg)
              this.config.logger?.log(this.node.id, "loop_fallback", {
                agentNodeId: innerNode.id,
                iteration: this.iterations,
                changes: fallbackResult.changes,
              })
            }
            if (fallbackResult.skippedVars.length > 0) {
              const warnMsg = `[loop-fallback] Non-numeric loop vars not advanced: ${fallbackResult.skippedVars.join(", ")} — loop relies on max_iterations`
              logLines.push(warnMsg)
              this.config.logger?.log(this.node.id, "loop_fallback_skipped", {
                agentNodeId: innerNode.id,
                iteration: this.iterations,
                skippedVars: fallbackResult.skippedVars,
              })
            }
          }
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

        // Fire hooks for inner node success/failure (ponytail: mirrors engine.ts:991-1027)
        if (this.config.hookExecutor) {
          if (result.status === "completed") {
            try {
              await this.config.hookExecutor("on_node_success", {
                success_node_id: innerNode.id,
                success_node_type: innerNode.type,
                node_duration_ms: result.durationMs,
                node_comment: result.comment ?? "",
                node_decision: result.decision ?? "",
              })
            } catch (hookErr: unknown) {
              const msg = hookErr instanceof Error ? hookErr.message : String(hookErr)
              this.config.logger?.log("hook", "error", { event: "on_node_success", node: innerNode.id, error: msg })
            }
          }
          if (result.status === "failed") {
            try {
              await this.config.hookExecutor("on_node_failure", {
                failed_node_id: innerNode.id,
                failed_node_type: innerNode.type,
                error: result.logLines?.join("\n") ?? "Unknown error",
                exit_code: result.exitCode,
                node_duration_ms: result.durationMs,
              })
            } catch (hookErr: unknown) {
              const msg = hookErr instanceof Error ? hookErr.message : String(hookErr)
              this.config.logger?.log("hook", "error", { event: "on_node_failure", node: innerNode.id, error: msg })
            }
          }
        }

        if (result.status === "paused" || result.status === "pending_approval" || result.status === "pending_task_dispatch") {
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
            // G1: propagate task_dispatch pause metadata so the server can correlate
            // the child schedule completion back to this loop's inner task_dispatch node.
            taskDispatchMetadata: result.taskDispatchMetadata,
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

      // Save this iteration's results for the next iteration's $nodeId.output resolution
      this.prevIterationResults = new Map(completedInnerResults)

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
    // G10: expose the current subunit to inner nodes via loopContext so a
    // composition-style Loop (subunit: "$iteration.subunit") resolves to the
    // i-th SubunitSpec. this.iterations is 1-based (incremented before use at
    // line 103), so the 0-based array index is iteration - 1.
    const loopCtx: Record<string, any> = { iteration: this.iterations }
    const subunits = this.resolveSubunits()
    if (subunits && this.iterations >= 1 && this.iterations <= subunits.length) {
      loopCtx.subunit = subunits[this.iterations - 1]
    }
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
      case "bash":
        return new BashExecutor(node, p, {
          signal: this.config.signal,
          onLog: (line, stream) => {
            const event = stream === "stderr" ? "bash_stderr" : "bash_log"
            this.config.logger?.log(node.id, event, { line })
            this.config.callbacks?.onNodeLog?.(node.id, line)
          },
          cwd: this.config.cwd,
          loopContext: loopCtx,
          nodeOutputs: this.buildInnerNodeOutputs(completedInnerResults),
        })
      case "python":
        return new PythonExecutor(node, p, {
          signal: this.config.signal,
          onLog: (line, stream) => {
            const event = stream === "stderr" ? "python_stderr" : "python_log"
            this.config.logger?.log(node.id, event, { line })
            this.config.callbacks?.onNodeLog?.(node.id, line)
          },
          nodeOutputs: this.buildInnerNodeOutputs(completedInnerResults),
        })
      case "condition":
        return new ConditionExecutor(node, p)
      case "approval":
        return new ApprovalExecutor(node, p, {
          signal: this.config.signal,
          loopContext: loopCtx,
          nodeOutputs: this.buildInnerNodeOutputs(completedInnerResults),
          executionId: this.config.executionId,
          cwd: this.config.cwd,
        })
      case "agent": {
        const rawKey = node.engine ?? this.config.workflowEngine ?? "claude"
        const providerKey = rawKey === "claude-code" ? "claude" : rawKey
        const provider = this.config.providers[providerKey]
        if (!provider) throw new Error(`Unknown provider: ${rawKey}`)

        // Resolve model alias (se → haiku, pro → sonnet, etc.)
        let resolvedModel = node.model
        if (resolvedModel && this.config.modelAliasConfig) {
          const resolved = resolveModelAlias(resolvedModel, providerKey, this.config.modelAliasConfig)
          if (resolved) resolvedModel = resolved
        }

        const runner = new AgentNodeRunner(provider, this.config.cwd, (event: AgentEvent) => {
          this.config.logger?.log(node.id, "agent_event", { event_data: event })
          this.config.callbacks?.onAgentEvent?.(node.id, event)
        })

        const previousSessionId = this.resolvePreviousSessionId(node)

        // Build engineContext: merge engine's outer results + resume results + loop's inner results
        const mergedNodeResults: Record<string, NodeExecutionResult> = {
          ...(this.config.engineNodeResults ?? {}),
          ...(this.resume?.engineNodeResults ?? {}),
        }
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
          resolvedModel,
          modelAliasConfig: this.config.modelAliasConfig,
          providerKey,
        })
      }
      case "loop":
        return new LoopExecutor(node, p, {
          ...this.config,
          ensureNodeExecution: (scopedNodeId, nodeType, meta) => {
            // Outer loop passes through; inner loop will override iterationIndex when it runs
            this.config.ensureNodeExecution?.(scopedNodeId, nodeType, meta)
          },
        }, { engineNodeResults: this.resume?.engineNodeResults })
      case "sub_workflow":
        return new SubWorkflowExecutor(node, p, {
          providers: this.config.providers,
          cwd: this.config.cwd,
          signal: this.config.signal,
          callbacks: this.config.callbacks,
          logger: this.config.logger,
          executionId: this.config.executionId,
          modelAliasConfig: this.config.modelAliasConfig,
          workflowEngine: this.config.workflowEngine,
          globalSessionId: this.config.globalSessionId,
          branchSessionIds: this.config.branchSessionIds,
          inputs: this.config.inputs,
          engineNodeResults: this.config.engineNodeResults,
          workflowResolver: (this.config as any).workflowResolver,
          visitedWorkflows: (this.config as any).visitedWorkflows,
          iterationIndex: this.iterations - 1, // 0-based iteration index
          ensureNodeExecution: (scopedNodeId, nodeType, meta) => {
            // Inject iteration context from this loop (0-based iteration index)
            this.config.ensureNodeExecution?.(scopedNodeId, nodeType, {
              ...meta,
              iterationIndex: meta?.iterationIndex ?? (this.iterations - 1),
            })
          },
        })
      case "dynamic_sub_workflow":
        return new DynamicSubWorkflowExecutor(node, p, {
          providers: this.config.providers,
          cwd: this.config.cwd,
          signal: this.config.signal,
          callbacks: this.config.callbacks,
          logger: this.config.logger,
          executionId: this.config.executionId,
          modelAliasConfig: this.config.modelAliasConfig,
          workflowEngine: this.config.workflowEngine,
          globalSessionId: this.config.globalSessionId,
          branchSessionIds: this.config.branchSessionIds,
          inputs: this.config.inputs,
          engineNodeResults: this.config.engineNodeResults,
          workflowResolver: (this.config as any).workflowResolver,
          visitedWorkflows: (this.config as any).visitedWorkflows,
          iterationIndex: this.iterations - 1, // 0-based iteration index
          ensureNodeExecution: (scopedNodeId, nodeType, meta) => {
            this.config.ensureNodeExecution?.(scopedNodeId, nodeType, {
              ...meta,
              iterationIndex: meta?.iterationIndex ?? (this.iterations - 1),
            })
          },
          outputDir: join(this.config.cwd, "workflows"),
          workflow: (this.config as any).workflow,
          promptInjector: (this.config as any).promptInjector,
          precomputeHook: (this.config as any).precomputeHook,
          knowledgeInjectorFactory: (this.config as any).knowledgeInjectorFactory,
        })
      case "task_dispatch": {
        // G1 resume inside a loop: the resumed iteration's inner task_dispatch
        // node gets the childOutput payload (one-shot — approval-override delete
        // precedent at line ~164) so it applies output_mapping and completes
        // without re-dispatching. Subsequent iterations dispatch the next
        // subunit via the port (loopContext.subunit, populated above).
        let childOutput: Record<string, unknown> | undefined
        if (this.resume?.resumeFromNodeId === node.id && this.resume?.taskDispatchChildOutput) {
          childOutput = this.resume.taskDispatchChildOutput
          // One-shot: clear so the next iteration's createExecutor(dispatch-child)
          // dispatches instead of re-resuming.
          this.resume.taskDispatchChildOutput = undefined
        }
        return new TaskDispatchExecutor(node, p, {
          port: this.config.taskDispatchPort,
          childOutput,
          signal: this.config.signal,
          loopContext: loopCtx,
          executionId: this.config.executionId,
          nodeOutputs: this.buildInnerNodeOutputs(completedInnerResults),
          cwd: this.config.cwd,
        })
      }
      default:
        throw new Error(`Unknown node type: ${node.type}`)
    }
  }

  /**
   * Resolve the subunits array for a composition-style Loop (G10): each
   * iteration dispatches subunits[iteration-1] as the inner task_dispatch
   * node's subunit. Reads from the VarPool first ($vars.subunits — where the
   * server's input_values land via pool.update, and where composition-task.yaml's
   * sibling $vars.subunit_count / $vars.goal already live), falling back to
   * LoopConfig.inputs.subunits. Returns undefined when this loop isn't iterating
   * over subunits; loopContext.subunit stays unset, so a task_dispatch node that
   * references "$iteration.subunit" fails with a clear coerceSubunit error
   * (deterministic, not a silent crash) — by design.
   */
  private resolveSubunits(): SubunitSpec[] | undefined {
    const fromPool = this.pool.get("subunits")
    if (Array.isArray(fromPool)) return fromPool as SubunitSpec[]
    const fromInputs = this.config.inputs?.subunits
    if (Array.isArray(fromInputs)) return fromInputs as SubunitSpec[]
    return undefined
  }
}