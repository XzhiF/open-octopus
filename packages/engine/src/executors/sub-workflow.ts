// packages/engine/src/executors/sub-workflow.ts
//
// SubWorkflowExecutor — resolves and executes a child workflow by name,
// with scoped VarPool and explicit I/O mapping between parent and child.
//
import { VarPool, evaluateExpression, substituteVars } from "@octopus/shared"
import type { NodeDef, WorkflowDef } from "@octopus/shared"
import type { NodeExecutor, NodeExecutionResult } from "./types"
import type { SubWorkflowConfig } from "./executor-config"

export class SubWorkflowExecutor implements NodeExecutor {
  private config: SubWorkflowConfig

  constructor(
    private node: NodeDef,
    private pool: VarPool,
    config: SubWorkflowConfig,
  ) {
    this.config = config
  }

  async execute(): Promise<NodeExecutionResult> {
    const start = Date.now()
    const logLines: string[] = []
    const workflowName = this.node.workflow
    const onError = this.node.on_error ?? "fail"
    // execution_mode: "inline" (default) runs child in-process; "linked" is reserved for future concurrent support
    const executionMode = this.node.execution_mode ?? "inline"

    // Validate required fields
    if (!workflowName) {
      return {
        outputs: {},
        status: "failed",
        durationMs: Date.now() - start,
        logLines: ["sub_workflow node missing required 'workflow' field"],
        error: "Missing workflow reference",
      }
    }

    // Recursion detection
    const visited = this.config.visitedWorkflows ?? new Set<string>()
    if (visited.has(workflowName)) {
      const chain = [...visited, workflowName].join(" → ")
      return {
        outputs: {},
        status: "failed",
        durationMs: Date.now() - start,
        logLines: [`Recursive sub-workflow detected: ${chain}`],
        error: `Recursive workflow reference: ${workflowName}`,
      }
    }

    // Resolve child workflow
    if (!this.config.workflowResolver) {
      return {
        outputs: {},
        status: "failed",
        durationMs: Date.now() - start,
        logLines: ["No workflow resolver configured — cannot resolve sub-workflow"],
        error: "Workflow resolver not available",
      }
    }

    const resolved = this.config.workflowResolver(workflowName)
    if (!resolved) {
      return {
        outputs: {},
        status: "failed",
        durationMs: Date.now() - start,
        logLines: [`Child workflow not found: "${workflowName}"`],
        error: `Workflow "${workflowName}" not found in workspace`,
      }
    }

    logLines.push(`Resolved sub-workflow: ${workflowName} (${executionMode} mode)`)

    // Linked mode: create a separate execution record for independent audit trails
    let linkedExecutionId: string | undefined
    if (executionMode === "linked") {
      if (this.config.createChildExecution && this.config.executionId) {
        try {
          const linked = await this.config.createChildExecution(workflowName, this.config.executionId)
          linkedExecutionId = linked.executionId
          logLines.push(`Linked mode: created child execution ${linkedExecutionId}`)
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          logLines.push(`Linked mode: createChildExecution failed — ${msg}, falling back to inline`)
        }
      } else {
        logLines.push("Linked mode: createChildExecution not available, falling back to inline mode")
      }
    }

    // Create scoped child VarPool
    const childPool = new VarPool()

    // Apply input_mapping: resolve values from parent pool → set in child pool
    if (this.node.input_mapping) {
      const parentOutputs = this.buildParentNodeOutputs()
      for (const [childVar, expr] of Object.entries(this.node.input_mapping)) {
        try {
          const value = this.resolveMappingValue(expr, parentOutputs)
          childPool.set(childVar, value)
          logLines.push(`input_mapping: ${childVar} = ${JSON.stringify(value)}`)
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          logLines.push(`input_mapping error for ${childVar}: ${msg}`)
          if (onError === "fail") {
            return {
              outputs: {},
              status: "failed",
              durationMs: Date.now() - start,
              logLines,
              error: `Input mapping failed for "${childVar}": ${msg}`,
            }
          }
        }
      }
    }

    // Copy workflow-level variables from child workflow definition
    if (resolved.parsed.variables) {
      for (const [key, value] of Object.entries(resolved.parsed.variables)) {
        // Don't override explicitly mapped inputs
        if (!this.node.input_mapping || !(key in this.node.input_mapping)) {
          childPool.set(key, value)
        }
      }
    }

    // Set standard metadata vars in child pool
    childPool.set("workflow_name", resolved.parsed.name)
    childPool.set("parent_workflow_name", this.pool.get("workflow_name"))

    // Execute child workflow using dynamic import to avoid circular dependency
    let childResult: { status: string; nodeResults: Record<string, NodeExecutionResult>; poolSnapshot: Record<string, any>; durationMs: number }
    try {
      const { WorkflowEngine } = await import("../engine")

      // Build visited set for recursion detection in nested sub-workflows
      const childVisited = new Set(visited)
      childVisited.add(workflowName)

      // Create child callbacks that prefix events with sub-workflow name
      const childCallbacks = this.createChildCallbacks(logLines, workflowName)

      const childEngine = new WorkflowEngine(
        resolved.parsed,
        this.config.providers,
        this.config.cwd,
        this.config.cwd, // orgDir
        childCallbacks,
        this.config.signal,
        linkedExecutionId ?? (this.config.executionId ? `${this.config.executionId}-${workflowName}` : undefined),
        this.config.inputs,
        undefined, // executionName
        undefined, // crossExecResolver — child does not inherit parent's cross-exec resolver
        undefined, // promptInjector
        undefined, // precomputeHook
        undefined, // knowledgeInjectorFactory
        this.config.agentResolver,
      )

      // Inject the child pool into the engine
      childEngine.updateVarPool(childPool.snapshot())

      // Set workflow resolver for nested sub-workflows (with recursion detection)
      if (this.config.workflowResolver) {
        childEngine.setWorkflowResolver(this.config.workflowResolver, childVisited)
      }

      const result = await childEngine.run()
      childResult = result
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logLines.push(`Child workflow execution error: ${msg}`)
      if (onError === "continue") {
        return {
          outputs: { workflow: workflowName, error: msg },
          status: "completed",
          durationMs: Date.now() - start,
          logLines,
        }
      }
      return {
        outputs: {},
        status: "failed",
        durationMs: Date.now() - start,
        logLines,
        error: msg,
      }
    }

    // Check child execution status
    const childFailed = ["failed", "cancelled"].includes(childResult.status)

    if (childFailed && onError === "fail") {
      // Apply output_mapping even on failure (partial results may be useful)
      this.applyOutputMapping(childResult.poolSnapshot, logLines)

      logLines.push(`Child workflow "${workflowName}" ${childResult.status}`)
      return {
        outputs: { workflow: workflowName, childStatus: childResult.status },
        status: "failed",
        durationMs: Date.now() - start,
        logLines,
        error: `Child workflow "${workflowName}" ${childResult.status}`,
      }
    }

    // Apply output_mapping: read child pool vars → set in parent pool
    this.applyOutputMapping(childResult.poolSnapshot, logLines)

    const status = childFailed && onError === "continue" ? "completed" : childResult.status as NodeExecutionResult["status"]
    logLines.push(`Child workflow "${workflowName}" completed in ${childResult.durationMs}ms`)

    return {
      outputs: {
        workflow: workflowName,
        childStatus: childResult.status,
        childDurationMs: childResult.durationMs,
      },
      status,
      durationMs: Date.now() - start,
      logLines,
    }
  }

  private applyOutputMapping(
    childPoolSnapshot: Record<string, any>,
    logLines: string[],
  ): void {
    if (!this.node.output_mapping) return

    for (const [parentVar, childVar] of Object.entries(this.node.output_mapping)) {
      const value = childPoolSnapshot[childVar]
      if (value !== undefined) {
        this.pool.set(parentVar, value)
        logLines.push(`output_mapping: ${parentVar} = ${JSON.stringify(value)}`)
      } else {
        logLines.push(`output_mapping: ${parentVar} ← ${childVar} (not found in child pool)`)
      }
    }
  }

  /**
   * Resolve a mapping expression to its actual value (not boolean).
   * - Pure `$vars.key` → returns pool.get(key) preserving type
   * - Pure `$nodeId.output.key` → returns node output value
   * - Templates or literals → substituteVars (string result)
   */
  private resolveMappingValue(
    expr: string,
    nodeOutputs: Record<string, Record<string, any>>,
  ): unknown {
    // Pure $vars.xxx reference — return raw value preserving type
    const varsMatch = expr.match(/^\$vars\.([a-zA-Z0-9_]+)$/)
    if (varsMatch) {
      return this.pool.get(varsMatch[1])
    }

    // Pure $nodeId.output.key reference — return raw output value
    const outputMatch = expr.match(/^\$([a-zA-Z0-9_-]+)\.output\.([a-zA-Z0-9_]+)$/)
    if (outputMatch) {
      return nodeOutputs[outputMatch[1]]?.[outputMatch[2]]
    }

    // Template string or literal — use substituteVars for string interpolation
    return substituteVars(expr, this.pool, nodeOutputs)
  }

  private buildParentNodeOutputs(): Record<string, Record<string, any>> {
    const nodeOutputs: Record<string, Record<string, any>> = {}
    if (this.config.engineNodeResults) {
      for (const [id, result] of Object.entries(this.config.engineNodeResults)) {
        const outputs = { ...(result.outputs ?? {}) }
        if (result.lastOutput !== undefined) {
          outputs["output"] = result.lastOutput
          outputs["last_output"] = result.lastOutput
        }
        nodeOutputs[id] = outputs
      }
    }
    return nodeOutputs
  }

  private createChildCallbacks(
    logLines: string[],
    workflowName: string,
  ) {
    // Format: {sub_workflow_name}:{event_name} — matches the design spec for event panel display
    const fmt = (event: string, detail: string) => `${workflowName}:${event} ${detail}`
    return {
      onNodeStart: (nodeId: string, nodeType: string) => {
        const msg = fmt("node_start", `${nodeId} (${nodeType})`)
        logLines.push(msg)
        // Write to JSONL logger so compaction persists these events to agent_events DB
        this.config.logger?.log(this.node.id, "node_log", { line: msg })
        this.config.callbacks?.onNodeLog?.(this.node.id, msg)
      },
      onNodeEnd: (nodeId: string, status: string, durationMs: number, _result?: NodeExecutionResult, _nodeType?: string) => {
        const msg = fmt("node_end", `${nodeId} ${status} (${durationMs}ms)`)
        logLines.push(msg)
        this.config.logger?.log(this.node.id, "node_log", { line: msg })
        this.config.callbacks?.onNodeLog?.(this.node.id, msg)
      },
      onNodeLog: (nodeId: string, logLine: string) => {
        const msg = fmt("log", `[${nodeId}] ${logLine}`)
        this.config.logger?.log(this.node.id, "node_log", { line: msg })
        this.config.callbacks?.onNodeLog?.(this.node.id, msg)
      },
      onStatusChange: (status: string, progress: number) => {
        logLines.push(fmt("status", `${status} (${progress}%)`))
      },
      onError: (nodeId: string, error: string) => {
        const msg = fmt("error", `${nodeId}: ${error}`)
        logLines.push(msg)
        this.config.logger?.log(this.node.id, "node_log", { line: msg })
        this.config.callbacks?.onNodeLog?.(this.node.id, msg)
      },
    }
  }
}
