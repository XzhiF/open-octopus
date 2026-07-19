import { VarPool, evaluateExpression, parsePipelineConfig, TemplateRenderer } from "@octopus/shared"
import type { WorkflowDef, NodeDef, AutoAnswer, HookDef, WorkflowHooks } from "@octopus/shared"
import type { IAgentProvider } from "@octopus/providers"
import type { TokenUsage } from "@octopus/providers"
import type { NodeExecutionResult, InnerNodeOverride } from "./executors/types"
import type { AgentEvent } from "./executors/agent-types"
import type { SwarmSSEEvent } from "./executors/swarm/swarm-types"
import { BashExecutor } from "./executors/bash"
import { PythonExecutor } from "./executors/python"
import { ConditionExecutor } from "./executors/condition"
import { ApprovalExecutor } from "./executors/approval"
import { LoopExecutor } from "./executors/loop"
import { AgentExecutor } from "./executors/agent"
import { SwarmExecutor } from "./executors/swarm"
import { AgentNodeRunner } from "./executors/agent-runner"
import { JsonlLogger } from "./logger"
import { join } from "path"
import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync, unlinkSync } from "fs"
import { tmpdir } from "os"
import type { CrossExecResolver } from "@octopus/shared"
import { resolveModelAlias, loadModelAliasConfig } from "@octopus/shared"
import type { ModelAliasConfig } from "@octopus/shared"
import { PromptInjector } from "./prompt-injector"
import type { KnowledgeInjector } from "./knowledge-injector"
import { RetryPolicyResolver } from "./pipeline/retry-resolver"
import { FailureClassifier } from "./pipeline/failure-classifier"
import { NotifyDispatcher } from "./notify/dispatcher"
import { ProviderRegistry } from "./notify/registry"
import { registerBuiltinProviders } from "./notify/index"
import type { ICheckpointStore, Checkpoint } from "./pipeline/checkpoint-types"
import { calculateBackoff } from "./pipeline/backoff"
import type { PipelineConfig } from "@octopus/shared"

export interface ExecutionResult {
  workflowName: string
  status: "completed" | "completed_with_failures" | "failed" | "paused" | "cancelled" | "rejected" | "pending_approval"
  nodeResults: Record<string, NodeExecutionResult>
  poolSnapshot: Record<string, any>
  durationMs: number
}

export interface EngineCallbacks {
  onNodeStart?: (nodeId: string, nodeType: string) => void
  onNodeEnd?: (nodeId: string, status: string, durationMs: number, result?: NodeExecutionResult, nodeType?: string) => void
  onNodeLog?: (nodeId: string, logLine: string) => void
  onStatusChange?: (status: string, progress: number) => void
  onError?: (nodeId: string, error: string) => void
  onComplete?: (finalStatus: string) => void
  onBranchStart?: (nodeExecutionId: string, iteration: number) => void
  onBranchEnd?: (nodeExecutionId: string, iteration: number, status: string, nodeResults?: { nodeId: string; status: string; durationMs?: number; error?: string }[]) => void
  onAgentEvent?: (nodeId: string, event: AgentEvent) => void
  onSwarmEvent?: (nodeId: string, event: SwarmSSEEvent) => void
  onNodeRetry?: (nodeId: string, attempt: number, maxAttempts: number, delayMs: number) => void
  onNodeCompacted?: (nodeId: string, mergedEvents: any[]) => void
  onCheckpoint?: (checkpoint: unknown) => void
  onPipelineReloaded?: (config: PipelineConfig) => void
  onRuntimeNodeAdded?: (nodeId: string, nodeType: string) => void
}

export class WorkflowEngine {
  private pool: VarPool
  private inputs: Record<string, any> = {}
  private nodeResults: Record<string, NodeExecutionResult> = {}
  private logger?: JsonlLogger
  private executionId: string
  private pausedAt?: string
  private pendingApprovalNodeId?: string
  private executionMode: "auto" | "serial"
  private maxConcurrent: number | undefined
  // globalSessionId: the workflow's main conversation thread.
  // Immutable after initialization — all context: "continue" agents resume this same sessionId.
  private globalSessionId?: string
  // branchSessionIds: stores sessionId for context: "new" agents only.
  // Used by resume_from to reference a specific branch session.
  private branchSessionIds: Map<string, string> = new Map()
  // Guard flag to prevent recursive hook execution (e.g., a hook node that itself triggers another hook)
  private isExecutingHook: boolean = false
  // Cross-execution variable resolver for $parent.* and $ancestor[N].* references
  private crossExecResolver?: CrossExecResolver
  // Pipeline-level prompt injector for global and targeted prompt injection
  private promptInjector?: PromptInjector
  // Knowledge injector factory (creates per-pool KnowledgeInjector from VarPool)
  private knowledgeInjectorFactory?: (pool: VarPool) => KnowledgeInjector
  // Model alias config for tier resolution (P0-2)
  private modelAliasConfig: ModelAliasConfig
  // BL-6: Workflow-level default model (replaces propagateModel mutation)
  private workflowDefaultModel?: string
  // Precompute hook: runs before node execution to populate VarPool with knowledge data
  private precomputeHook?: (pool: VarPool, workflowName: string, inputs: Record<string, string>) => Promise<void>
  // Dynamic agent resolver for swarm nodes
  private agentResolver?: (topic: string, maxExperts: number) => Promise<Array<{ role: string; agent_file: string; description: string }>>
  // Pipeline integration (set via setPipelineConfig)
  private pipelineConfig?: PipelineConfig
  private retryResolver?: RetryPolicyResolver
  private failureClassifier?: FailureClassifier
  private checkpointStore?: ICheckpointStore
  private hasPartialFailure: boolean = false
  // Notify system
  private notifyDispatcher: NotifyDispatcher
  // Pipeline hot-reload
  private pipelineConfigHash: string = ''
  private pipelinePath?: string
  // Runtime node tracking (Upgrade 3)
  private runtimeNodeIds: Set<string> = new Set()

  constructor(
    private workflow: WorkflowDef,
    private providers: Record<string, IAgentProvider>,
    private cwd: string,
    private orgDir?: string,
    private callbacks?: EngineCallbacks,
    private signal?: AbortSignal,
    executionId?: string,
    initialInputs?: Record<string, string>,
    executionName?: string,
    crossExecResolver?: CrossExecResolver,
    promptInjector?: PromptInjector,
    precomputeHook?: (pool: VarPool, workflowName: string, inputs: Record<string, string>) => Promise<void>,
    knowledgeInjectorFactory?: (pool: VarPool) => KnowledgeInjector,
    /** Dynamic agent resolver for swarm nodes: selects and installs agents from ResourceManager */
    agentResolver?: (topic: string, maxExperts: number) => Promise<Array<{ role: string; agent_file: string; description: string }>>,
  ) {
    this.pool = new VarPool(workflow.variables ?? {})

    // Inject execution metadata (name from UI input, workflow_name as fallback)
    if (executionName) {
      this.pool.set("execution_name", executionName)
    }
    this.pool.set("workflow_name", workflow.name)

    // Apply input defaults from workflow.inputs.*.default
    // Skip keys that are already provided in initialInputs
    if (workflow.inputs) {
      for (const [key, def] of Object.entries(workflow.inputs)) {
        if (def.default !== undefined && def.default !== "") {
          // Only apply default if not already provided by caller
          if (!initialInputs || !(key in initialInputs)) {
            this.pool.set(key, String(def.default))
          }
        }
      }
    }

    // Caller-provided values override defaults
    if (initialInputs) {
      this.pool.update(initialInputs)
    }

    // Build $inputs lookup: merge defaults + caller-provided for evaluateExpression
    const mergedInputs: Record<string, any> = {}
    if (workflow.inputs) {
      for (const [key, def] of Object.entries(workflow.inputs)) {
        if (def.default !== undefined && def.default !== "") {
          mergedInputs[key] = String(def.default)
        }
      }
    }
    if (initialInputs) {
      Object.assign(mergedInputs, initialInputs)
    }
    this.inputs = mergedInputs

    this.executionId = executionId ?? `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    this.executionMode = workflow.execution_mode ?? "auto"
    this.maxConcurrent = workflow.max_concurrent
    this.crossExecResolver = crossExecResolver
    this.promptInjector = promptInjector
    this.precomputeHook = precomputeHook
    this.knowledgeInjectorFactory = knowledgeInjectorFactory
    this.agentResolver = agentResolver

    // Load model alias config (P0-2: tier resolution for engine/model fields)
    this.modelAliasConfig = loadModelAliasConfig({
      orgDir: orgDir,
    })

    // BL-6: Don't mutate node.model — store the workflow default model instead
    // and use it as fallback when resolving model for agent/swarm nodes
    this.workflowDefaultModel = workflow.model

    if (orgDir) {
      this.logger = new JsonlLogger(orgDir, this.executionId)
    }

    // Initialize notify system
    registerBuiltinProviders()
    this.notifyDispatcher = new NotifyDispatcher(new ProviderRegistry(), new TemplateRenderer())
  }

  updateVarPool(data: Record<string, string>): void {
    this.pool.update(data)
  }

  /**
   * Set the resolver for $ref: cross-execution references.
   * Called by ExecutionService to inject DB-backed resolution before engine.run().
   * The resolver receives a path like "workflowRef.nodeId.outputKey" and returns the value.
   */
  setRefResolver(resolver: (refPath: string) => any): void {
    this.pool.setRefResolver(resolver)
  }

  setNodeResult(nodeId: string, result: NodeExecutionResult): void {
    this.nodeResults[nodeId] = result
  }

  /** Restore session context for retry/approve flows after engine reconstruction. */
  restoreSessionContext(globalSessionId: string | undefined, branchSessionIds: Map<string, string>): void {
    this.globalSessionId = globalSessionId
    this.branchSessionIds = branchSessionIds
  }

  /** Get the current global session ID (for persistence by the caller). */
  getGlobalSessionId(): string | undefined {
    return this.globalSessionId
  }

  async run(): Promise<ExecutionResult> {
    const start = Date.now()

    // Precompute hook: populate VarPool with knowledge data before node execution
    if (this.precomputeHook) {
      try {
        await this.precomputeHook(this.pool, this.workflow.name, this.inputs as Record<string, string>)
      } catch (err) {
        console.warn("[engine] precomputeHook failed:", err)
      }
    }

    const result = await this.executeNodes(this.workflow.nodes, this.signal)

    const durationMs = Date.now() - start

    // Workflow-level event triggers (unified: both CLI and Server paths)
    const nodeResultsArr = Object.values(this.nodeResults)
    const completedCount = nodeResultsArr.filter(r => r.status === "completed").length
    const failedCount = nodeResultsArr.filter(r => r.status === "failed").length
    const skippedCount = nodeResultsArr.filter(r => r.status === "skipped").length
    const totalCount = this.workflow.nodes.length

    const workflowContext: Record<string, unknown> = {
      final_status: result.status,
      total_duration_ms: durationMs,
      completed_count: completedCount,
      failed_count: failedCount,
      skipped_count: skippedCount,
      total_count: totalCount,
    }

    // Each event trigger is independently guarded so one failure doesn't skip others
    if (result.status === "completed" && !this.hasPartialFailure) {
      try {
        await this.executeNotifyOnlyHooks("on_success", workflowContext)
      } catch (hookErr: unknown) {
        const msg = hookErr instanceof Error ? hookErr.message : String(hookErr)
        this.logger?.log("hook", "error", { event: "on_success", error: msg })
      }
    } else if (result.status === "failed") {
      try {
        await this.executeNotifyOnlyHooks("on_workflow_failure", workflowContext)
      } catch (hookErr: unknown) {
        const msg = hookErr instanceof Error ? hookErr.message : String(hookErr)
        this.logger?.log("hook", "error", { event: "on_workflow_failure", error: msg })
      }
    }
    try {
      await this.executeNotifyOnlyHooks("on_complete", workflowContext)
    } catch (hookErr: unknown) {
      const msg = hookErr instanceof Error ? hookErr.message : String(hookErr)
      this.logger?.log("hook", "error", { event: "on_complete", error: msg })
    }

    // Write State JSON
    if (this.orgDir) {
      this.writeStateJson(result, durationMs)
    }

    this.callbacks?.onComplete?.(result.status)

    return {
      workflowName: this.workflow.name,
      status: result.status,
      nodeResults: this.nodeResults,
      poolSnapshot: this.pool.snapshot(),
      durationMs,
    }
  }

  async retryFrom(
    nodeId: string,
    opts?: {
      userChoice?: string
      userComment?: string
      signal?: AbortSignal
      intervention?: string
    }
  ): Promise<ExecutionResult> {
    this.pendingApprovalNodeId = undefined
    this.pausedAt = undefined  // ★ 清除暂停状态，允许继续执行
    const start = Date.now()

    const signal = opts?.signal ?? this.signal

    const sorted = this.topologicalSort(this.workflow.nodes)
    const startIdx = sorted.findIndex((n) => n.id === nodeId)

    // 路径 D: loop 内部节点的 approval 恢复 / on_reject 处理
    // 当 nodeId 不在顶层排序列表中时，搜索 loop 子节点
    if (startIdx < 0) {
      const loopInfo = this.findInnerNodeInLoop(nodeId)
      if (loopInfo) {
        const { parentNode, innerNode } = loopInfo
        // 保存上次的迭代次数，再清除 loop 节点的旧结果
        const prevLoopResult = this.nodeResults[parentNode.id]
        const resumeIteration = prevLoopResult?.iterations ?? 0
        delete this.nodeResults[parentNode.id]

        // 构建 inner node overrides
        const overrides = new Map<string, InnerNodeOverride>()
        if (innerNode.type === "approval" && opts?.userChoice) {
          // Approval 恢复：注入 userChoice
          overrides.set(innerNode.id, { kind: "approval", userChoice: opts.userChoice, userComment: opts.userComment })
        }
        // 非 approval 节点（on_reject handler）：不需要 override，正常运行

        // 创建 loop executor，从目标内部节点开始
        const loopExecutor = new LoopExecutor(parentNode, this.pool, {
          providers: this.providers,
          cwd: this.cwd,
          globalAutoAnswers: this.workflow.auto_answers,
          signal,
          callbacks: this.callbacks,
          logger: this.logger,
          globalSessionId: this.globalSessionId,
          branchSessionIds: this.branchSessionIds,
          inputs: this.inputs,
          workflowEngine: this.workflow.engine,
          modelAliasConfig: this.modelAliasConfig,
          checkpointStore: this.checkpointStore,
          executionId: this.executionId,
          hookExecutor: async (event: string, context: Record<string, unknown>) => {
            await this.executeHooks(event as keyof WorkflowHooks, context)
          },
          agentResolver: this.agentResolver,
        }, {
          innerNodeOverrides: overrides.size > 0 ? overrides : undefined,
          resumeFromNodeId: innerNode.id,
          engineNodeResults: this.nodeResults,
          resumeIteration,
        })

        this.callbacks?.onNodeStart?.(parentNode.id, parentNode.type)
        const loopStart = Date.now()
        const loopResult = await loopExecutor.execute()
        const loopDurationMs = Date.now() - loopStart
        this.callbacks?.onNodeEnd?.(parentNode.id, loopResult.status, loopDurationMs, loopResult, parentNode.type)
        this.nodeResults[parentNode.id] = loopResult

        if (loopResult.status === "pending_approval") {
          this.pendingApprovalNodeId = parentNode.id
          return { status: "pending_approval" as const, workflowName: this.workflow.name, nodeResults: this.nodeResults, poolSnapshot: this.pool.snapshot(), durationMs: loopDurationMs }
        }
        if (loopResult.status === "failed") {
          return { status: "failed" as const, workflowName: this.workflow.name, nodeResults: this.nodeResults, poolSnapshot: this.pool.snapshot(), durationMs: loopDurationMs }
        }
        if (loopResult.status === "cancelled") {
          return { status: "cancelled" as const, workflowName: this.workflow.name, nodeResults: this.nodeResults, poolSnapshot: this.pool.snapshot(), durationMs: loopDurationMs }
        }

        // Loop 完成，继续执行后续顶层节点
        const parentNodeIdx = sorted.findIndex(n => n.id === parentNode.id)
        const remainingNodes = sorted.slice(parentNodeIdx + 1)
        const execResult = await this.executeNodes(remainingNodes, signal, true)
        const durationMs = Date.now() - start
        return {
          workflowName: this.workflow.name,
          status: execResult.status,
          nodeResults: this.nodeResults,
          poolSnapshot: this.pool.snapshot(),
          durationMs,
        }
      }
      throw new Error(`Node not found: ${nodeId} (available: ${sorted.map(n => n.id).join(",")})`)
    }

    // ★ 清除目标节点的旧结果，确保重新执行（而非被跳过）
    // reconstructEngine 会从 DB 加载 status="paused" 的节点到 nodeResults，
    // 如果不清除，executeNodesSequential 会把它当作终态跳过
    delete this.nodeResults[nodeId]

    // 路径 A: approval 恢复 — 重建 approval executor 注入 userChoice
    const pauseNode = sorted[startIdx]
    if (pauseNode.type === "approval" && opts?.userChoice) {
      const executor = new ApprovalExecutor(pauseNode, this.pool, { userChoice: opts.userChoice, userComment: opts.userComment, signal, crossExecResolver: this.crossExecResolver, executionId: this.executionId })
      const result = await executor.execute()
      this.nodeResults[pauseNode.id] = result

      if (result.status === "rejected") {
        const durationMs = Date.now() - start
        return {
          workflowName: this.workflow.name,
          status: "rejected",
          nodeResults: this.nodeResults,
          poolSnapshot: this.pool.snapshot(),
          durationMs,
        }
      }

      if (result.status !== "completed") {
        const durationMs = Date.now() - start
        return {
          workflowName: this.workflow.name,
          status: "failed",
          nodeResults: this.nodeResults,
          poolSnapshot: this.pool.snapshot(),
          durationMs,
        }
      }

      const remainingNodes = sorted.slice(startIdx + 1)
      const execResult = await this.executeNodes(remainingNodes, signal, true)
      const durationMs = Date.now() - start
      return {
        workflowName: this.workflow.name,
        status: execResult.status,
        nodeResults: this.nodeResults,
        poolSnapshot: this.pool.snapshot(),
        durationMs,
      }
    }

    // 路径 B: intervention 恢复 — 阻塞等待干预完成，然后从暂停节点继续
    if (opts?.intervention) {
      // ★ 记录干预 prompt 到日志文件，便于查看
      try {
        const logDir = join(this.orgDir!, "logs", this.executionId!)
        if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true })
        const interventionLog = {
          type: "intervention",
          timestamp: new Date().toISOString(),
          nodeId,
          nodeName: (pauseNode as any).name || nodeId,
          prompt: opts.intervention,
          sessionId: pauseNode.type === "agent"
            ? (this.branchSessionIds.get(nodeId) || this.globalSessionId)
            : this.globalSessionId,
        }
        appendFileSync(join(logDir, "intervention.jsonl"), JSON.stringify(interventionLog) + "\n")
      } catch {
        // 日志写入失败不阻断流程
      }

      const sessionId = pauseNode.type === "agent"
        ? (this.branchSessionIds.get(nodeId) || this.globalSessionId)
        : this.globalSessionId

      const providerKey = Object.keys(this.providers)[0]
      const provider = providerKey ? this.providers[providerKey] : undefined

      // ★ 阻塞等待干预完成（resume API 已经是 fire-and-forget，不会阻塞 HTTP 响应）
      if (provider) {
        try {
          const interventionContext: "new" | "continue" = sessionId ? "continue" : "new"
          // ★ 修复：传入 onEvent 回调，使干预阶段的 agent 事件写入 JSONL 日志 + SSE
          const interventionRunner = new AgentNodeRunner(provider, this.cwd, (event: AgentEvent) => {
            this.logger?.log(nodeId, "agent_event", { event_data: event })
            this.callbacks?.onAgentEvent?.(nodeId, event)
          })
          const interventionResult = await interventionRunner.run({
            prompt: opts.intervention,
            context: interventionContext,
            previousSessionId: sessionId,
            signal,
          })

          // 更新 sessionId
          if (interventionResult.sessionId) {
            if (pauseNode.type === "agent") {
              this.branchSessionIds.set(nodeId, interventionResult.sessionId)
            }
            if (interventionContext === "new") {
              this.globalSessionId = interventionResult.sessionId
            }
          }

          console.log(`[Engine] Intervention completed for node ${nodeId}: ${interventionResult.finalText?.slice(0, 100)}`)

          // ★ 记录干预结果到日志
          try {
            const logDir = join(this.orgDir!, "logs", this.executionId!)
            const resultLog = {
              type: "intervention_result",
              timestamp: new Date().toISOString(),
              nodeId,
              result: interventionResult.finalText?.slice(0, 500),
              sessionId: interventionResult.sessionId,
            }
            appendFileSync(join(logDir, "intervention.jsonl"), JSON.stringify(resultLog) + "\n")
          } catch { /* ignore */ }
        } catch (err) {
          console.error(`[Engine] Intervention failed for node ${nodeId}:`, err)
        }
      }

      // 干预完成后，从暂停节点继续执行
      const remainingNodes = sorted.slice(startIdx)
      const execResult = await this.executeNodes(remainingNodes, signal, true)
      const durationMs = Date.now() - start
      return {
        workflowName: this.workflow.name,
        status: execResult.status,
        nodeResults: this.nodeResults,
        poolSnapshot: this.pool.snapshot(),
        durationMs,
      }
    }

    // 路径 C: retry 恢复 — 从 failed node 重新执行
    const remainingNodes = sorted.slice(startIdx)
    const execResult = await this.executeNodes(remainingNodes, signal, true)
    const durationMs = Date.now() - start
    return {
      workflowName: this.workflow.name,
      status: execResult.status,
      nodeResults: this.nodeResults,
      poolSnapshot: this.pool.snapshot(),
      durationMs,
    }
  }

  private writeStateJson(result: { status: string }, durationMs: number): void {
    const stateDir = join(this.orgDir!, "state")
    mkdirSync(stateDir, { recursive: true })
    const state = {
      executionId: this.executionId,
      workflowName: this.workflow.name,
      status: result.status,
      startedAt: new Date(Date.now() - durationMs).toISOString(),
      completedAt: new Date().toISOString(),
      duration: durationMs,
      nodes: Object.fromEntries(
        Object.entries(this.nodeResults).map(([id, r]) => [
          id, { status: r.status, exitCode: r.exitCode, durationMs: r.durationMs, lastOutput: r.lastOutput }
        ])
      ),
      poolSnapshot: this.pool.snapshot(),
    }
    writeFileSync(join(stateDir, `${this.executionId}.json`), JSON.stringify(state, null, 2))
  }

  // ── DAG ordering ──────────────────────────────────────────

  /**
   * Build implicit dependency edges: condition branch targets depend on their condition node.
   * Without this, Kahn's algorithm places targets like `no-bugs-found` at Level 0 (no deps),
   * causing them to execute before the condition gate that controls them.
   * ponytail: engine-level safety net — YAML authors shouldn't need to know about this.
   */
  private buildConditionTargetDeps(nodes: NodeDef[]): Map<string, Set<string>> {
    const implicitDeps = new Map<string, Set<string>>()
    for (const node of nodes) {
      if (node.type === "condition" && node.cases) {
        for (const c of node.cases) {
          if (c.then && c.then !== "default") {
            if (!implicitDeps.has(c.then)) implicitDeps.set(c.then, new Set())
            implicitDeps.get(c.then)!.add(node.id)
          }
        }
      }
    }
    return implicitDeps
  }

  private getEffectiveDeps(node: NodeDef, implicitDeps: Map<string, Set<string>>): string[] {
    const explicit = node.depends_on ?? []
    const implicit = implicitDeps.get(node.id)
    if (!implicit || implicit.size === 0) return explicit
    const merged = new Set(explicit)
    for (const dep of implicit) merged.add(dep)
    return Array.from(merged)
  }

  /**
   * Search for a node ID inside loop inner nodes.
   * Returns the parent loop node and the inner node definition if found.
   */
  private findInnerNodeInLoop(nodeId: string): { parentNode: NodeDef; innerNode: NodeDef } | null {
    for (const node of this.workflow.nodes) {
      if (node.type === "loop" && node.nodes) {
        const inner = node.nodes.find(n => n.id === nodeId)
        if (inner) return { parentNode: node, innerNode: inner }
        // Also check nested loops
        for (const innerNode of node.nodes) {
          if (innerNode.type === "loop" && innerNode.nodes) {
            const deepInner = innerNode.nodes.find(n => n.id === nodeId)
            if (deepInner) return { parentNode: innerNode, innerNode: deepInner }
          }
        }
      }
    }
    return null
  }

  /** DFS topological sort producing a flat linear order. Used by retryFrom() for index-based slicing. */
  private topologicalSort(nodes: NodeDef[]): NodeDef[] {
    const nodeMap = new Map(nodes.map(n => [n.id, n]))
    const implicitDeps = this.buildConditionTargetDeps(nodes)
    const sorted: NodeDef[] = []
    const visited = new Set<string>()
    const visiting = new Set<string>()

    const visit = (id: string) => {
      if (visited.has(id)) return
      if (visiting.has(id)) throw new Error(`Circular dependency detected: ${id}`)
      visiting.add(id)
      const node = nodeMap.get(id)
      if (!node) throw new Error(`Node not found: ${id} (available: ${Array.from(nodeMap.keys()).join(",")})`)
      for (const dep of this.getEffectiveDeps(node, implicitDeps)) {
        visit(dep)
      }
      visiting.delete(id)
      visited.add(id)
      sorted.push(node)
    }

    for (const node of nodes) {
      visit(node.id)
    }

    return sorted
  }

  /** Kahn's algorithm: compute DAG execution levels — sets of nodes that can run concurrently. */
  private computeExecutionLevels(nodes: NodeDef[]): NodeDef[][] {
    this.detectCycles(nodes)

    const nodeMap = new Map(nodes.map(n => [n.id, n]))
    const implicitDeps = this.buildConditionTargetDeps(nodes)
    const levels: NodeDef[][] = []
    const completed = new Set<string>()
    const remaining = new Set(nodes.map(n => n.id))

    while (remaining.size > 0) {
      const level: NodeDef[] = []
      for (const id of remaining) {
        const node = nodeMap.get(id)!
        const deps = this.getEffectiveDeps(node, implicitDeps)
        if (deps.every(d => completed.has(d))) {
          level.push(node)
        }
      }
      if (level.length === 0) {
        throw new Error(`Deadlock: remaining nodes have unsatisfied dependencies: ${Array.from(remaining).join(",")}`)
      }
      levels.push(level)
      for (const node of level) {
        completed.add(node.id)
        remaining.delete(node.id)
      }
    }

    return levels
  }

  /** Detect circular dependencies via DFS. Throws on cycle. */
  private detectCycles(nodes: NodeDef[]): void {
    const nodeMap = new Map(nodes.map(n => [n.id, n]))
    const implicitDeps = this.buildConditionTargetDeps(nodes)
    const visited = new Set<string>()
    const visiting = new Set<string>()

    const visit = (id: string) => {
      if (visited.has(id)) return
      if (visiting.has(id)) throw new Error(`Circular dependency detected: ${id}`)
      visiting.add(id)
      const node = nodeMap.get(id)
      if (!node) throw new Error(`Node not found: ${id} (available: ${Array.from(nodeMap.keys()).join(",")})`)
      for (const dep of this.getEffectiveDeps(node, implicitDeps)) {
        visit(dep)
      }
      visiting.delete(id)
      visited.add(id)
    }

    for (const node of nodes) {
      visit(node.id)
    }
  }

  // ── Execution ─────────────────────────────────────────────

  private async executeSingleNode(
    node: NodeDef,
    pool: VarPool,
    signal?: AbortSignal,
  ): Promise<NodeExecutionResult> {
    this.writeNotifyContextFile()
    try {
      const executor = this.createExecutor(node, pool, signal)

      this.logger?.log(node.id, "start", { type: node.type })
      this.callbacks?.onNodeStart?.(node.id, node.type)

      const nodeResult = await executor.execute()

      // Log approval metadata as a separate event so frontend can display prompt/options/decision
      if (node.type === "approval" && (nodeResult.approvalMetadata || nodeResult.decision)) {
        this.logger?.log(node.id, "approval_metadata", {
          prompt: nodeResult.approvalMetadata?.prompt ?? "",
          options: nodeResult.approvalMetadata?.options ?? [],
          decision: nodeResult.decision ?? "",
          comment: nodeResult.comment ?? "",
        })
      }

      // Only log "end" for terminal states — pending_approval/paused are pauses, not endings
      if (nodeResult.status !== "pending_approval" && nodeResult.status !== "paused") {
        this.logger?.log(node.id, "end", {
          status: nodeResult.status,
          durationMs: nodeResult.durationMs,
          exitCode: nodeResult.exitCode,
        })
      }

      this.callbacks?.onNodeEnd?.(node.id, nodeResult.status, nodeResult.durationMs, nodeResult, node.type)

      // Compact JSONL after node completes
      try {
        const mergedEvents = this.logger?.compactFile(node.id)
        if (mergedEvents && mergedEvents.length > 0) {
          this.callbacks?.onNodeCompacted?.(node.id, mergedEvents)
        }
      } catch (err) {
        // compact failure is non-fatal
      }

      return nodeResult
    } finally {
      this.deleteNotifyContextFile()
    }
  }

  /** Execute a single node with automatic retry based on pipeline config. */
  private async executeSingleNodeWithRetry(
    node: NodeDef,
    pool: VarPool,
    signal?: AbortSignal,
  ): Promise<NodeExecutionResult> {
    if (!this.retryResolver || !this.failureClassifier) {
      return this.executeSingleNode(node, pool, signal)
    }
    const policy = this.retryResolver.resolve(node.id)
    if (policy.max_attempts <= 1) {
      return this.executeSingleNode(node, pool, signal)
    }

    const nodeStartTime = Date.now()
    let nodeAbort: AbortController | undefined
    let nodeTimer: ReturnType<typeof setTimeout> | undefined
    if (policy.max_total_duration > 0) {
      nodeAbort = new AbortController()
      nodeTimer = setTimeout(() => nodeAbort!.abort(), policy.max_total_duration * 1000)
      signal?.addEventListener("abort", () => {
        if (nodeTimer) clearTimeout(nodeTimer)
        nodeAbort!.abort()
      }, { once: true })
    }
    const effectiveSignal = nodeAbort?.signal ?? signal

    let lastResult: NodeExecutionResult | undefined
    for (let attempt = 1; attempt <= policy.max_attempts; attempt++) {
      if (policy.max_total_duration > 0) {
        const elapsed = (Date.now() - nodeStartTime) / 1000
        if (elapsed >= policy.max_total_duration) {
          if (nodeTimer) clearTimeout(nodeTimer)
          return { ...(lastResult ?? { outputs: {}, status: "failed" as const, durationMs: 0, logLines: [] }), error: "Node total timeout exceeded", status: "failed" as const, retryCount: attempt - 1 }
        }
      }
      try {
        const result = await this.executeSingleNode(node, pool, effectiveSignal)
        if (result.status !== "failed") {
          if (nodeTimer) clearTimeout(nodeTimer)
          return { ...result, retryCount: attempt - 1 }
        }
        lastResult = result
        const errorCategory = this.failureClassifier.classify(result)
        if (policy.never_retry_on?.includes(errorCategory)) {
          if (nodeTimer) clearTimeout(nodeTimer)
          return { ...result, retryCount: attempt - 1 }
        }
        if (!policy.retry_on?.includes(errorCategory)) {
          if (nodeTimer) clearTimeout(nodeTimer)
          return { ...result, retryCount: attempt - 1 }
        }
        if (node.type === "agent" && errorCategory === "agent_partial_completion" && !policy.retry_on?.includes("agent_partial_completion")) {
          if (nodeTimer) clearTimeout(nodeTimer)
          return { ...result, retryCount: attempt - 1 }
        }
        if (attempt >= policy.max_attempts) {
          if (nodeTimer) clearTimeout(nodeTimer)
          return { ...result, retryCount: attempt - 1 }
        }
        let delayMs = calculateBackoff(policy.backoff, attempt) * 1000
        if (policy.max_total_duration > 0) {
          const remaining = (policy.max_total_duration - (Date.now() - nodeStartTime) / 1000) * 1000
          delayMs = Math.min(delayMs, Math.max(0, remaining))
        }
        this.callbacks?.onNodeRetry?.(node.id, attempt, policy.max_attempts, delayMs)
        await this.sleepWithAbort(delayMs, effectiveSignal)
      } catch (err: unknown) {
        if (signal?.aborted) { if (nodeTimer) clearTimeout(nodeTimer); throw err }
        if (effectiveSignal?.aborted && policy.max_total_duration > 0) {
          if (nodeTimer) clearTimeout(nodeTimer)
          return { outputs: {}, status: "failed" as const, durationMs: Date.now() - nodeStartTime, logLines: ["Node total timeout exceeded"], retryCount: attempt - 1 }
        }
        lastResult = { outputs: {}, status: "failed" as const, durationMs: 0, logLines: [err instanceof Error ? err.message : String(err)], retryCount: attempt - 1 }
        if (attempt >= policy.max_attempts) { if (nodeTimer) clearTimeout(nodeTimer); return lastResult }
      }
    }
    if (nodeTimer) clearTimeout(nodeTimer)
    return lastResult!
  }

  private async executeNodes(
    nodes: NodeDef[],
    signal?: AbortSignal,
    preSorted?: boolean,
  ): Promise<{ status: "completed" | "completed_with_failures" | "failed" | "paused" | "cancelled" | "pending_approval" }> {
    // Serial mode: preserve existing sequential behavior exactly
    if (this.executionMode === "serial" || preSorted) {
      return this.executeNodesSequential(nodes, signal, preSorted)
    }

    // Auto mode: level-based parallel execution
    return this.executeNodesParallel(nodes, signal)
  }

  /** Sequential execution — exact replica of original behavior, used as serial fallback and for preSorted (retryFrom). */
  private async executeNodesSequential(
    nodes: NodeDef[],
    signal?: AbortSignal,
    preSorted?: boolean,
  ): Promise<{ status: "completed" | "completed_with_failures" | "failed" | "paused" | "cancelled" | "pending_approval" }> {
    const sorted = preSorted ? nodes : this.topologicalSort(nodes)
    const totalNodes = sorted.length

    for (let i = 0; i < sorted.length; i++) {
      const node = sorted[i]

      // Skip nodes that already have a terminal result
      const existingResult = this.nodeResults[node.id]
      if (existingResult && ["completed", "failed", "skipped", "skipped_failed", "rejected", "cancelled", "paused", "pending_approval"].includes(existingResult.status)) {
        continue
      }

      // User-initiated pause check BEFORE signal check (pause takes priority)
      if (this.pausedAt) {
        this.nodeResults[node.id] = {
          outputs: {}, status: "paused", durationMs: 0,
          logLines: ["Paused by user"],
        }
        this.callbacks?.onNodeEnd?.(node.id, "paused", 0)
        return { status: "paused" }
      }

      // AbortSignal 检查 (only if not paused)
      if (signal?.aborted) {
        this.nodeResults[node.id] = {
          outputs: {}, status: "cancelled", durationMs: 0,
          logLines: ["Cancelled by user"],
        }
        this.callbacks?.onNodeEnd?.(node.id, "cancelled", 0)
        return { status: "cancelled" }
      }

      // Skip nodes whose dependencies were skipped/rejected/cancelled/failed
      // (but NOT dependencies skipped by execute_when — those are intentional)
      if (node.depends_on?.length) {
        const hasSkippedDep = node.depends_on.some(depId => {
          const depResult = this.nodeResults[depId]
          if (!depResult) return false
          if (depResult.skippedByCondition) return false // intentional skip, don't cascade
          return ["skipped", "skipped_failed", "rejected", "cancelled", "failed"].includes(depResult.status)
        })
        if (hasSkippedDep) {
          this.nodeResults[node.id] = {
            outputs: {}, status: "skipped", durationMs: 0,
            logLines: [`Skipped: dependency was skipped/rejected/cancelled/failed`],
          }
          this.callbacks?.onNodeStart?.(node.id, node.type)
          this.callbacks?.onNodeEnd?.(node.id, "skipped", 0)
          continue
        }
      }

      // execute_when 检查
      if (node.execute_when) {
        const nodeOutputs: Record<string, Record<string, any>> = {}
        for (const [id, result] of Object.entries(this.nodeResults)) {
          nodeOutputs[id] = result.outputs ?? {}
        }
        const shouldRun = evaluateExpression(node.execute_when, this.pool, nodeOutputs, this.inputs)
        if (!shouldRun) {
          this.nodeResults[node.id] = {
            outputs: {},
            status: "skipped",
            durationMs: 0,
            logLines: [`Skipped: execute_when "${node.execute_when}" evaluated false`],
            skippedByCondition: true,
          }
          this.callbacks?.onNodeStart?.(node.id, node.type)
          this.callbacks?.onNodeEnd?.(node.id, "skipped", 0)
          this.callbacks?.onStatusChange?.(
            "running",
            Math.round(((i + 1) / totalNodes) * 100),
          )
          continue
        }
      }

      let nodeResult: NodeExecutionResult
      try {
        nodeResult = await this.executeSingleNodeWithRetry(node, this.pool, signal)
      } catch (err: unknown) {
        // 如果 pause 期间节点抛出异常（如 abort 导致的 "Aborted"），
        // 应该返回 "paused" 而不是让异常传播导致 "failed"
        if (this.pausedAt) {
          const errMsg = err instanceof Error ? err.message : String(err)
          this.nodeResults[node.id] = {
            outputs: {},
            status: "paused" as const,
            durationMs: 0,
            logLines: [`Execution paused by user`, `Node interrupted: ${errMsg}`],
          }
          this.callbacks?.onNodeEnd?.(node.id, "paused", 0, this.nodeResults[node.id], node.type)
          return { status: "paused" }
        }
        // 不是 pause 导致的，重新抛出异常
        throw err
      }

      // 检查是否在执行期间被暂停（pause 优先于节点结果）
      // 无论节点是完成还是失败，只要 pausedAt 被设置就说明用户要求暂停
      if (this.pausedAt) {
        if (nodeResult.status === "failed") {
          // 节点因为 abort 信号失败，但实际上是被暂停了
          this.nodeResults[node.id] = {
            ...nodeResult,
            status: "paused" as const,
            logLines: [...(nodeResult.logLines || []), "Execution paused by user"],
          }
        } else {
          // 节点在 pause 信号到达前刚好完成 — 保留 completed 状态，但停止后续执行
          this.nodeResults[node.id] = nodeResult
        }
        this.callbacks?.onNodeEnd?.(node.id, "paused", nodeResult.durationMs, this.nodeResults[node.id], node.type)
        return { status: "paused" }
      }

      this.nodeResults[node.id] = nodeResult

      // ★ Pipeline hot-reload check
      if (this.reloadPipelineIfNeeded()) {
        this.callbacks?.onPipelineReloaded?.(this.pipelineConfig!)
      }

      // ★ Runtime node detection (Upgrade 3)
      if (this.pipelineConfig?.runtime_nodes?.length) {
        const newNodes = this.detectNewRuntimeNodes()
        if (newNodes.length > 0) {
          this.insertRuntimeNodes(newNodes, sorted)
        }
      }

      // Checkpoint save (per_node mode)
      // Checkpoint load is handled by SwarmExecutor via checkpointStore.load()
      if (this.checkpointStore && this.pipelineConfig?.checkpoint.enabled &&
          this.pipelineConfig?.checkpoint.save_on === "per-node") {
        try {
          const checkpoint = this.buildCheckpoint()
          this.checkpointStore.save(checkpoint)
          this.callbacks?.onCheckpoint?.(checkpoint)
        } catch (cpErr: unknown) {
          const msg = cpErr instanceof Error ? cpErr.message : String(cpErr)
          this.logger?.log(node.id, "checkpoint_error", { error: msg })
        }
      }

      this.updateSessionContext(node, nodeResult)

      if (nodeResult.status === "completed") {
        try {
          await this.executeHooks("on_node_success", {
            success_node_id: node.id,
            success_node_type: node.type,
            node_duration_ms: nodeResult.durationMs,
            node_comment: nodeResult.comment ?? "",
            node_decision: nodeResult.decision ?? "",
          })
        } catch (hookErr: unknown) {
          const msg = hookErr instanceof Error ? hookErr.message : String(hookErr)
          this.logger?.log("hook", "error", { event: "on_node_success", error: msg })
        }
      }

      // onStatusChange reports execution-level status, not node-level status.
      // While nodes are executing, the execution is "running".
      // Final status (completed/failed) is emitted by the caller after this method returns.
      this.callbacks?.onStatusChange?.(
        "running",
        Math.round(((i + 1) / totalNodes) * 100),
      )

      if (nodeResult.status === "failed") {
        try {
          await this.executeHooks("on_node_failure", {
            failed_node_id: node.id,
            failed_node_type: node.type,
            error: nodeResult.logLines?.join("\n") ?? "Unknown error",
            exit_code: nodeResult.exitCode,
            node_duration_ms: nodeResult.durationMs,
          })
        } catch (hookErr: unknown) {
          const msg = hookErr instanceof Error ? hookErr.message : String(hookErr)
          this.logger?.log("hook", "error", { event: "on_node_failure", error: msg })
        }
        const strategy = this.pipelineConfig?.execution.failure_strategy ?? "fail_fast"
        if (strategy === "fail_fast") {
          this.pausedAt = node.id
          this.callbacks?.onError?.(node.id, nodeResult.logLines?.join("\n") ?? "Unknown error")
          return { status: "failed" }
        }
        // continue or skip: mark partial failure, keep going
        this.hasPartialFailure = true
        this.callbacks?.onError?.(node.id, nodeResult.logLines?.join("\n") ?? "Unknown error")
        if (strategy === "skip") {
          this.markDownstreamSkipped(node.id, sorted, i)
        }
        continue
      }

      if (nodeResult.status === "paused") {
        this.pausedAt = node.id
        return { status: "paused" }
      }

      if (nodeResult.status === "pending_approval") {
        this.pendingApprovalNodeId = node.id
        return { status: "pending_approval" as const }
      }

      // Condition jumpTo: 跳过中间节点，跳到目标节点
      if (node.type === "condition" && nodeResult.jumpTo) {
        const jumpIdx = sorted.findIndex((n) => n.id === nodeResult.jumpTo)
        if (jumpIdx < 0) {
          console.warn(`Condition node "${node.id}" jumpTo target "${nodeResult.jumpTo}" not found`)
        } else if (jumpIdx <= i) {
          console.warn(`Condition node "${node.id}" cannot jump backward to "${nodeResult.jumpTo}"`)
        } else {
          for (let j = i + 1; j < jumpIdx; j++) {
            const skippedNode = sorted[j]
            this.nodeResults[skippedNode.id] = {
              outputs: {}, status: "skipped", durationMs: 0,
              logLines: [`Skipped: condition jump to "${nodeResult.jumpTo}"`],
            }
            this.callbacks?.onNodeStart?.(skippedNode.id, skippedNode.type)
            this.callbacks?.onNodeEnd?.(skippedNode.id, "skipped", 0)
          }
          i = jumpIdx - 1
          continue
        }
      }
    }

    if (this.hasPartialFailure) {
      return { status: "completed_with_failures" as const }
    }
    return { status: "completed" }
  }

  /** Level-based parallel execution — nodes in the same level run concurrently. */
  private async executeNodesParallel(
    nodes: NodeDef[],
    signal?: AbortSignal,
  ): Promise<{ status: "completed" | "completed_with_failures" | "failed" | "paused" | "cancelled" | "pending_approval" }> {
    const levels = this.computeExecutionLevels(nodes)
    const totalNodes = nodes.length
    let completedCount = 0
    const nodeLevelIndex = new Map<string, number>()
    for (let li = 0; li < levels.length; li++) {
      for (const n of levels[li]) {
        nodeLevelIndex.set(n.id, li)
      }
    }

    let jumpTarget: string | undefined = undefined

    for (let levelIdx = 0; levelIdx < levels.length; levelIdx++) {
      const level = levels[levelIdx]

      // User-initiated pause check BEFORE signal check (pause takes priority)
      if (this.pausedAt) {
        for (const node of level) {
          if (!this.nodeResults[node.id]) {
            this.nodeResults[node.id] = {
              outputs: {}, status: "paused", durationMs: 0,
              logLines: ["Paused by user"],
            }
          }
        }
        return { status: "paused" }
      }

      // AbortSignal 检查 (only if not paused)
      if (signal?.aborted) {
        for (const node of level) {
          this.nodeResults[node.id] = {
            outputs: {}, status: "cancelled", durationMs: 0,
            logLines: ["Cancelled by user"],
          }
        }
        return { status: "cancelled" }
      }

      // If a previous condition set a jumpTo, skip nodes between the condition level and target level
      if (jumpTarget) {
        const targetLevelIdx = nodeLevelIndex.get(jumpTarget)
        if (targetLevelIdx !== undefined && levelIdx < targetLevelIdx) {
          // Target is in a future level — skip entire current level
          for (const node of level) {
            this.nodeResults[node.id] = {
              outputs: {}, status: "skipped", durationMs: 0,
              logLines: [`Skipped: condition jump to "${jumpTarget}"`],
            }
            this.callbacks?.onNodeStart?.(node.id, node.type)
            this.callbacks?.onNodeEnd?.(node.id, "skipped", 0)
            completedCount++
          }
          this.callbacks?.onStatusChange?.("running", Math.round((completedCount / totalNodes) * 100))
          continue
        }
        // We've reached the target level (or target is in this level)
        // Skip nodes before the target within this level, then clear the jump
      }

      // execute_when 过滤 + jumpTo intra-level skip
      const runnable: NodeDef[] = []
      let jumpTargetFound = false
      for (const node of level) {
        // Skip nodes that already have a terminal result (from previous execution or reconstruction)
        const existingResult = this.nodeResults[node.id]
        if (existingResult && ["completed", "failed", "skipped", "rejected", "cancelled", "paused", "pending_approval"].includes(existingResult.status)) {
          completedCount++
          continue
        }

        // Skip nodes whose dependencies were skipped/rejected/cancelled
        // (but NOT dependencies skipped by execute_when — those are intentional)
        if (node.depends_on?.length) {
          const hasSkippedDep = node.depends_on.some(depId => {
            const depResult = this.nodeResults[depId]
            if (!depResult) return false
            if (depResult.skippedByCondition) return false // intentional skip, don't cascade
            return ["skipped", "rejected", "cancelled"].includes(depResult.status)
          })
          if (hasSkippedDep) {
            this.nodeResults[node.id] = {
              outputs: {}, status: "skipped", durationMs: 0,
              logLines: [`Skipped: dependency was skipped/rejected/cancelled`],
            }
            this.callbacks?.onNodeStart?.(node.id, node.type)
            this.callbacks?.onNodeEnd?.(node.id, "skipped", 0)
            completedCount++
            continue
          }
        }

        // If there's an active jumpTo at this level, only run the target node
        if (jumpTarget) {
          if (node.id === jumpTarget) {
            jumpTargetFound = true
            // The target itself runs — don't skip it
          } else {
            this.nodeResults[node.id] = {
              outputs: {}, status: "skipped", durationMs: 0,
              logLines: [`Skipped: condition jump to "${jumpTarget}"`],
            }
            this.callbacks?.onNodeStart?.(node.id, node.type)
            this.callbacks?.onNodeEnd?.(node.id, "skipped", 0)
            completedCount++
            continue
          }
        }

        if (node.execute_when) {
          const nodeOutputs: Record<string, Record<string, any>> = {}
          for (const [id, result] of Object.entries(this.nodeResults)) {
            nodeOutputs[id] = result.outputs ?? {}
          }
          const shouldRun = evaluateExpression(node.execute_when, this.pool, nodeOutputs, this.inputs)
          if (!shouldRun) {
            this.nodeResults[node.id] = {
              outputs: {}, status: "skipped", durationMs: 0,
              logLines: [`Skipped: execute_when "${node.execute_when}" evaluated false`],
              skippedByCondition: true,
            }
            this.callbacks?.onNodeStart?.(node.id, node.type)
            this.callbacks?.onNodeEnd?.(node.id, "skipped", 0)
            completedCount++
            continue
          }
        }
        runnable.push(node)
      }

      // Clear jumpTarget after processing
      if (jumpTarget) {
        jumpTarget = undefined
      }

      if (runnable.length === 0) {
        continue
      }

      // maxConcurrent batching: split runnable into batches
      const batches = this.splitIntoBatches(runnable)

      for (const batch of batches) {
        // Fork VarPool for each node in the batch
        const forks: VarPool[] = batch.map(() => this.pool.fork())

        // Execute batch concurrently
        const results = await Promise.allSettled(
          batch.map((node, idx) => this.executeSingleNodeWithRetry(node, forks[idx], signal))
        )

        // Process results
        let hasFailure = false
        let failureNodeId: string | undefined
        let failureMsg: string | undefined
        let hasPaused = false
        let pausedNodeId: string | undefined
        let jumpToFromCondition: string | undefined

        for (let i = 0; i < batch.length; i++) {
          const node = batch[i]
          const settled = results[i]

          if (settled.status === "fulfilled") {
            const nodeResult = settled.value

            // Merge fork data immediately — before pause check and hooks —
            // so every fulfilled fork is merged exactly once regardless of outcome.
            // (Removed second merge at end of loop to prevent hook var overwrite.)
            this.pool.merge([forks[i]])

            // 检查是否在执行期间被暂停（pause 优先于节点结果）
            // 无论节点是完成还是失败，只要 pausedAt 被设置就说明用户要求暂停
            if (this.pausedAt) {
              if (nodeResult.status === "failed") {
                this.nodeResults[node.id] = {
                  ...nodeResult,
                  status: "paused" as const,
                  logLines: [...(nodeResult.logLines || []), "Execution paused by user"],
                }
              } else {
                // 节点在 pause 信号到达前刚好完成 — 保留 completed 状态
                this.nodeResults[node.id] = nodeResult
              }
              this.callbacks?.onNodeEnd?.(node.id, "paused", nodeResult.durationMs, this.nodeResults[node.id], node.type)
              hasPaused = true
              pausedNodeId = node.id
              completedCount++
              continue
            }

            this.nodeResults[node.id] = nodeResult

            this.updateSessionContext(node, nodeResult)

            if (nodeResult.status === "failed") {
              hasFailure = true
              failureNodeId = node.id
              failureMsg = nodeResult.logLines?.join("\n") ?? "Unknown error"
              try {
                await this.executeHooks("on_node_failure", {
                  failed_node_id: node.id,
                  failed_node_type: node.type,
                  error: failureMsg,
                  exit_code: nodeResult.exitCode,
                  node_duration_ms: nodeResult.durationMs,
                })
              } catch (hookErr: unknown) {
                const msg = hookErr instanceof Error ? hookErr.message : String(hookErr)
                this.logger?.log("hook", "error", { event: "on_node_failure", error: msg })
              }
            }

            if (nodeResult.status === "paused") {
              hasPaused = true
              pausedNodeId = node.id
            }

            if (nodeResult.status === "completed") {
              try {
                await this.executeHooks("on_node_success", {
                  success_node_id: node.id,
                  success_node_type: node.type,
                  node_duration_ms: nodeResult.durationMs,
                  node_comment: nodeResult.comment ?? "",
                  node_decision: nodeResult.decision ?? "",
                })
              } catch (hookErr: unknown) {
                const msg = hookErr instanceof Error ? hookErr.message : String(hookErr)
                this.logger?.log("hook", "error", { event: "on_node_success", error: msg })
              }
            }

            // Condition jumpTo
            if (node.type === "condition" && nodeResult.jumpTo) {
              jumpToFromCondition = nodeResult.jumpTo
            }
          } else {
            // Promise rejected — check if it's due to pause (abort) first
            if (this.pausedAt) {
              // Abort caused by pause — treat as paused, not failed
              this.nodeResults[node.id] = {
                outputs: {},
                status: "paused" as const,
                durationMs: 0,
                logLines: [`Execution paused by user`, `Node interrupted: ${settled.reason?.message ?? String(settled.reason)}`],
              }
              this.callbacks?.onNodeEnd?.(node.id, "paused", 0, this.nodeResults[node.id], node.type)
              hasPaused = true
              pausedNodeId = node.id
            } else {
              // Genuine failure — treat as failed
              this.nodeResults[node.id] = {
                outputs: {}, status: "failed", durationMs: 0,
                logLines: [settled.reason?.message ?? String(settled.reason)],
              }
              hasFailure = true
              failureNodeId = node.id
              failureMsg = settled.reason?.message ?? String(settled.reason)
              try {
                await this.executeHooks("on_node_failure", {
                  failed_node_id: node.id,
                  failed_node_type: node.type,
                  error: failureMsg,
                  node_duration_ms: 0,
                })
              } catch (hookErr: unknown) {
                const msg = hookErr instanceof Error ? hookErr.message : String(hookErr)
                this.logger?.log("hook", "error", { event: "on_node_failure", error: msg })
              }
            }
          }

          completedCount++
        }

        // All fulfilled forks were already merged inside the loop above.
        // Rejected forks are intentionally excluded (unreliable partial data).

        // Checkpoint save (per-node or per-batch mode)
        const saveOn = this.pipelineConfig?.checkpoint.save_on
        if (this.checkpointStore && this.pipelineConfig?.checkpoint.enabled &&
            (saveOn === "per-node" || saveOn === "per-batch")) {
          try {
            const checkpoint = this.buildCheckpoint()
            this.checkpointStore.save(checkpoint)
            this.callbacks?.onCheckpoint?.(checkpoint)
          } catch (cpErr: unknown) {
            const msg = cpErr instanceof Error ? cpErr.message : String(cpErr)
            this.logger?.log("checkpoint", "checkpoint_error", { error: msg })
          }
        }

        // Progress update
        this.callbacks?.onStatusChange?.("running", Math.round((completedCount / totalNodes) * 100))

        // Failure strategy at batch boundary
        if (hasFailure) {
          const strategy = this.pipelineConfig?.execution.failure_strategy ?? "fail_fast"
          if (strategy === "fail_fast") {
            this.pausedAt = failureNodeId
            this.callbacks?.onError?.(failureNodeId!, failureMsg!)
            return { status: "failed" }
          }
          this.hasPartialFailure = true
          if (strategy === "skip") {
            const failedNodeIds = batch.filter((n, idx) => {
              const r = results[idx]
              return r.status === "fulfilled" && (r.value as NodeExecutionResult).status === "failed"
            }).map(n => n.id)
            for (const failedId of failedNodeIds) {
              for (let nextLevel = levelIdx + 1; nextLevel < levels.length; nextLevel++) {
                for (const node of levels[nextLevel]) {
                  if (!this.nodeResults[node.id] && node.depends_on?.some(d => {
                    const dep = this.nodeResults[d]
                    return dep && (dep.status === "failed" || dep.status === "skipped_failed")
                  })) {
                    this.nodeResults[node.id] = {
                      outputs: {}, status: "skipped_failed", durationMs: 0,
                      logLines: [`Skipped: upstream "${failedId}" failed (skip strategy)`],
                    }
                    this.callbacks?.onNodeStart?.(node.id, node.type)
                    this.callbacks?.onNodeEnd?.(node.id, "skipped_failed", 0)
                  }
                }
              }
            }
          }
        }

        if (hasPaused) {
          this.pausedAt = pausedNodeId
          return { status: "paused" }
        }

        const hasPendingApproval = results.some((r, i) => r.status === "fulfilled" && (r.value as NodeExecutionResult).status === "pending_approval")
        if (hasPendingApproval) {
          const pendingNode = batch.find((node, i) => {
            const r = results[i]
            return r.status === "fulfilled" && (r.value as NodeExecutionResult).status === "pending_approval"
          })
          if (pendingNode) {
            this.pendingApprovalNodeId = pendingNode.id
          }
          return { status: "pending_approval" as const }
        }

        // Condition jumpTo: set target for subsequent level skipping
        if (jumpToFromCondition) {
          jumpTarget = jumpToFromCondition
        }
      }
    }

    if (this.hasPartialFailure) {
      return { status: "completed_with_failures" as const }
    }
    return { status: "completed" }
  }

  /** Split a level's runnable nodes into batches respecting maxConcurrent. */
  private splitIntoBatches(nodes: NodeDef[]): NodeDef[][] {
    if (!this.maxConcurrent || nodes.length <= this.maxConcurrent) {
      return [nodes]
    }

    const batches: NodeDef[][] = []
    for (let i = 0; i < nodes.length; i += this.maxConcurrent!) {
      batches.push(nodes.slice(i, i + this.maxConcurrent!))
    }
    return batches
  }

  // ── Executor factory ──────────────────────────────────────

  private createExecutor(node: NodeDef, pool?: VarPool, signal?: AbortSignal) {
    const p = pool ?? this.pool
    const s = signal ?? this.signal
    switch (node.type) {
      case "bash":
        return new BashExecutor(node, p, {
          signal: s,
          onLog: (line, stream) => {
            const event = stream === "stderr" ? "bash_stderr" : "bash_log"
            this.logger?.log(node.id, event, { line })
            this.callbacks?.onNodeLog?.(node.id, line)
          },
          cwd: this.cwd,
          crossExecResolver: this.crossExecResolver,
          executionId: this.executionId,
        })
      case "python":
        return new PythonExecutor(node, p, {
          signal: s,
          onLog: (line, stream) => {
            const event = stream === "stderr" ? "python_stderr" : "python_log"
            this.logger?.log(node.id, event, { line })
            this.callbacks?.onNodeLog?.(node.id, line)
          },
        })
      case "condition":
        return new ConditionExecutor(node, p)
      case "approval":
        return new ApprovalExecutor(node, p, { signal: s, crossExecResolver: this.crossExecResolver, executionId: this.executionId })
      case "loop":
        return new LoopExecutor(node, p, {
          providers: this.providers,
          cwd: this.cwd,
          globalAutoAnswers: this.workflow.auto_answers,
          signal: s,
          callbacks: this.callbacks,
          logger: this.logger,
          globalSessionId: this.globalSessionId,
          branchSessionIds: this.branchSessionIds,
          inputs: this.inputs,
          workflowEngine: this.workflow.engine,
          modelAliasConfig: this.modelAliasConfig,
          checkpointStore: this.checkpointStore,
          executionId: this.executionId,
          hookExecutor: async (event: string, context: Record<string, unknown>) => {
            await this.executeHooks(event as keyof WorkflowHooks, context)
          },
          agentResolver: this.agentResolver,
        })
      case "agent": {
        const rawKey = node.engine ?? this.workflow.engine ?? "claude"
        const providerKey = rawKey === "claude-code" ? "claude" : rawKey
        const provider = this.providers[providerKey]
        if (!provider) throw new Error(`Unknown provider: ${rawKey}`)

        // P0-2 + BL-6: Resolve model alias without mutating node.model
        // Priority: node.model > workflow default model
        const rawModel = node.model ?? this.workflowDefaultModel
        let resolvedModel = rawModel
        if (rawModel) {
          const resolved = resolveModelAlias(rawModel, providerKey, this.modelAliasConfig)
          if (resolved) resolvedModel = resolved
        }

        const runner = new AgentNodeRunner(provider, this.cwd, (event: AgentEvent) => {
          this.logger?.log(node.id, "agent_event", { event_data: event })
          this.callbacks?.onAgentEvent?.(node.id, event)
        })

        const previousSessionId = this.resolvePreviousSessionId(node)
        const knowledgeInjector = this.knowledgeInjectorFactory
          ? this.knowledgeInjectorFactory(p)
          : undefined

        return new AgentExecutor(node, p, {
          runner,
          previousSessionId,
          globalAutoAnswers: this.workflow.auto_answers,
          signal: s,
          engineContext: { nodeResults: this.nodeResults },
          promptInjector: this.promptInjector,
          knowledgeInjector,
          workflowName: this.workflow.name,
          crossExecResolver: this.crossExecResolver,
          executionId: this.executionId,
          resolvedModel,
          modelAliasConfig: this.modelAliasConfig,
          providerKey,
        })
      }
      case "swarm":
        return new SwarmExecutor(node, p, {
          providers: this.providers,
          cwd: this.cwd,
          callbacks: this.callbacks,
          logger: this.logger,
          checkpointStore: this.checkpointStore,
          executionId: this.executionId,
          modelAliasConfig: this.modelAliasConfig,
          workflowEngine: this.workflow.engine,
          agentResolver: this.agentResolver,
          engineHookFn: async (event: string, context: Record<string, unknown>) => {
            await this.executeHooks(event as keyof WorkflowHooks, context)
          },
        })
      default:
        throw new Error(`Unknown node type: ${(node as any).type}`)
    }
  }

  /** Resolve previousSessionId for an agent node based on context and resume_from. */
  private resolvePreviousSessionId(node: NodeDef): string | undefined {
    // resume_from takes precedence: explicitly reference a context: "new" node's session
    if (node.resume_from) {
      return this.branchSessionIds.get(node.resume_from)
    }
    // context: "continue" → resume the workflow's global conversation thread
    const effectiveContext = node.context ?? "continue"
    if (effectiveContext === "continue") {
      return this.globalSessionId
    }
    // context: "new" → start independent session
    return undefined
  }

  /** Update session tracking after an agent node completes. */
  private updateSessionContext(node: NodeDef, result: NodeExecutionResult): void {
    if (node.type !== "agent" || !result.sessionId) return

    // Don't update globalSessionId with failed node's session —
    // we want to retry from the last SUCCESSFUL session, not the failed attempt.
    if (result.status === "failed") return

    // resume_from: merge branch back into the global thread
    if (node.resume_from) {
      this.globalSessionId = result.sessionId
      return
    }

    const effectiveContext = node.context ?? "continue"
    if (effectiveContext === "continue") {
      // context: "continue" → first agent initializes globalSessionId
      // subsequent agents confirm it (SDK returns the same sessionId on resume)
      this.globalSessionId = result.sessionId
    } else {
      // context: "new" → store for future resume_from references
      this.branchSessionIds.set(node.id, result.sessionId)
    }
  }

  // ── Hook execution ──────────────────────────────────────

  private async executeHooks(
    event: keyof WorkflowHooks,
    context: Record<string, unknown>,
  ): Promise<void> {
    // Guard against recursive hook execution (e.g., a hook node that itself triggers another hook).
    // Per spec §9.3: hook execution must never trigger new hooks to prevent infinite recursion.
    if (this.isExecutingHook) return

    const hooks = this.workflow.hooks?.[event]
    if (!hooks || hooks.length === 0) return

    this.writeNotifyContextFile()
    this.isExecutingHook = true
    try {
      await this.runHooks(hooks, event, context)
    } finally {
      this.isExecutingHook = false
      this.deleteNotifyContextFile()
    }
  }

  /**
   * Execute only notify-type hooks for workflow-level events.
   * Bash/agent workflow-level hooks are handled by the Server path (HookExecutor)
   * to avoid double dispatch when running in Server mode.
   */
  private async executeNotifyOnlyHooks(
    event: keyof WorkflowHooks,
    context: Record<string, unknown>,
  ): Promise<void> {
    const hooks = this.workflow.hooks?.[event]
    if (!hooks || hooks.length === 0) return

    const notifyHooks = hooks.filter(h => h.type === "notify")
    if (notifyHooks.length === 0) return

    this.writeNotifyContextFile()
    this.isExecutingHook = true
    try {
      await this.runHooks(notifyHooks, event, context)
    } finally {
      this.isExecutingHook = false
      this.deleteNotifyContextFile()
    }
  }

  // ── Notify context file management ──
  // octopus notify CLI reads {providers, channels, variables} from this file
  // via OCTOPUS_NOTIFY_CONTEXT_PATH env var.

  private getNotifyContextPath(): string {
    return join(tmpdir(), `octopus-notify-${this.executionId ?? "default"}.json`)
  }

  private writeNotifyContextFile(): void {
    const providers = this.workflow.providers ?? this.pipelineConfig?.providers ?? {}
    const channels = this.workflow.channels ?? this.pipelineConfig?.channels ?? {}

    try {
      const ctx = {
        providers,
        channels,
        variables: this.pool.snapshot(),
      }
      writeFileSync(this.getNotifyContextPath(), JSON.stringify(ctx))
      process.env.OCTOPUS_NOTIFY_CONTEXT_PATH = this.getNotifyContextPath()
    } catch {
      // Non-fatal: octopus notify simply won't work from within bash/agent nodes
    }
  }

  private deleteNotifyContextFile(): void {
    try {
      const p = this.getNotifyContextPath()
      if (existsSync(p)) unlinkSync(p)
    } catch {
      // Ignore cleanup errors
    }
    delete process.env.OCTOPUS_NOTIFY_CONTEXT_PATH
  }

  private async runHooks(
    hooks: HookDef[],
    event: keyof WorkflowHooks,
    context: Record<string, unknown>,
  ): Promise<void> {
    for (const hook of hooks) {
      // 1. nodes filter check (only for on_node_* events)
      if (typeof event === "string" && event.startsWith("on_node_") && hook.nodes) {
        const targetNodeId = context.failed_node_id ?? context.success_node_id
        if (!hook.nodes.includes(String(targetNodeId))) continue
      }

      // 2. condition expression check
      if (hook.condition) {
        const shouldRun = evaluateExpression(hook.condition, this.pool, {})
        if (!shouldRun) continue
      }

      // 3. Inject $hook.* variables
      const hookVars: Record<string, string> = {
        "hook.event": String(event).replace("on_", ""),
        "hook.workflow_name": this.workflow.name,
        "hook.execution_id": this.executionId,
        "hook.timestamp": new Date().toISOString(),
      }
      for (const [k, v] of Object.entries(context)) {
        hookVars[`hook.${k}`] = String(v ?? "")
      }

      // Unified node_id / node_type aliases
      const nodeId = context.success_node_id ?? context.failed_node_id
      if (nodeId) hookVars["hook.node_id"] = String(nodeId)
      const nodeType = context.success_node_type ?? context.failed_node_type
      if (nodeType) hookVars["hook.node_type"] = String(nodeType)

      this.pool.update(hookVars)

      // 4. Execute hook
      try {
        if (hook.type === "bash" || hook.bash) {
          await this.executeBashHook(hook)
        } else if (hook.type === "notify") {
          const aborted = await this.executeNotifyHook(hook)
          if (aborted) break
        } else {
          await this.executeAgentHook(hook)
        }
      } catch (hookErr: unknown) {
        const msg = hookErr instanceof Error ? hookErr.message : String(hookErr)
        this.logger?.log("hook", "error", { event, hookId: hook.id, error: msg })
      }

      // 5. Clean up $hook.* variables
      this.pool.removePrefix("hook.")
    }
  }

  private async executeBashHook(hook: HookDef): Promise<void> {
    const bashNode: NodeDef = {
      id: hook.id ?? `hook-bash-${Date.now()}`,
      type: "bash",
      bash: hook.bash!,
      timeout: hook.timeout ?? 60,
    }
    const executor = new BashExecutor(bashNode, this.pool, {
      signal: this.signal,
      onLog: (line) => this.logger?.log("hook", "log", { line }),
      cwd: this.cwd,
      crossExecResolver: this.crossExecResolver,
      executionId: this.executionId,
    })
    await executor.execute()
  }

  private async executeAgentHook(hook: HookDef): Promise<void> {
    const providerKey = hook.engine ?? this.workflow.engine ?? "claude"
    const provider = this.providers[providerKey]
    if (!provider) {
      this.logger?.log("hook", "error", { msg: `Provider not found: ${providerKey}` })
      return
    }

    const agentNode: NodeDef = {
      id: hook.id ?? `hook-agent-${Date.now()}`,
      type: "agent",
      prompt: hook.prompt!,
      model: hook.model ?? this.workflow.model,
      timeout: hook.timeout ?? 120,
      context: "new",
    }

    const runner = new AgentNodeRunner(provider, this.cwd, (event) => {
      this.logger?.log("hook", "agent_event", { event })
    })

    const executor = new AgentExecutor(agentNode, this.pool, {
      runner,
      globalAutoAnswers: this.workflow.auto_answers,
      signal: this.signal,
      promptInjector: this.promptInjector,
      workflowName: this.workflow.name,
      modelAliasConfig: this.modelAliasConfig,
      providerKey,
    })

    await executor.execute()
  }

  private async executeNotifyHook(hook: HookDef): Promise<boolean> {
    if (!this.notifyDispatcher) {
      this.logger?.log("hook", "error", { msg: "NotifyDispatcher not initialized" })
      return false
    }

    const results = await this.notifyDispatcher.dispatch({
      hook,
      pool: this.pool,
      providers: this.workflow.providers ?? this.pipelineConfig?.providers ?? {},
      channels: this.workflow.channels ?? this.pipelineConfig?.channels ?? {},
      nodeOutputs: Object.fromEntries(
        Object.entries(this.nodeResults).map(([id, r]) => [id, r.outputs ?? {}])
      ),
      logger: (level, data) => this.logger?.log("hook", level, data),
    })

    for (const result of results) {
      if (!result.success) {
        this.logger?.log("hook", "warn", {
          event: "notify_failed",
          channel: result.channel,
          provider: result.provider,
          error: result.error,
          durationMs: result.durationMs,
        })

        if (hook.on_failure === "abort") {
          this.logger?.log("hook", "error", {
            event: "notify_aborted",
            msg: `Notify failed on channel ${result.channel}: ${result.error}. Aborting hook chain.`,
          })
          return true
        }
      }
    }
    return false
  }

  // BL-6: propagateModel removed — use workflowDefaultModel as fallback at executor creation time

  // ── Pause / Resume ────────────────────────────────────────

  /** Sleep that can be interrupted by an AbortSignal. */
  private sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("Aborted"))
        return
      }
      const timer = setTimeout(resolve, ms)
      signal?.addEventListener("abort", () => {
        clearTimeout(timer)
        reject(new Error("Aborted"))
      }, { once: true })
    })
  }

  /** Mark all transitive downstream nodes as skipped_failed (for skip failure strategy). */
  private markDownstreamSkipped(failedNodeId: string, sorted: NodeDef[], currentIndex: number): void {
    const downstream = new Set<string>()
    const queue = [failedNodeId]
    while (queue.length > 0) {
      const current = queue.shift()!
      for (let j = currentIndex + 1; j < sorted.length; j++) {
        const n = sorted[j]
        if (n.depends_on?.includes(current) && !downstream.has(n.id)) {
          downstream.add(n.id)
          queue.push(n.id)
        }
      }
    }
    for (const nodeId of downstream) {
      if (!this.nodeResults[nodeId]) {
        this.nodeResults[nodeId] = {
          outputs: {}, status: "skipped_failed", durationMs: 0,
          logLines: [`Skipped: upstream "${failedNodeId}" failed (skip strategy)`],
        }
        const nodeType = sorted.find(n => n.id === nodeId)?.type ?? "unknown"
        this.callbacks?.onNodeStart?.(nodeId, nodeType)
        this.callbacks?.onNodeEnd?.(nodeId, "skipped_failed", 0)
      }
    }
  }

  /** Build a checkpoint snapshot from current engine state. */
  private buildCheckpoint(): Checkpoint {
    const completedNodes: Record<string, import("./pipeline/checkpoint").CheckpointNodeResult> = {}
    for (const [id, result] of Object.entries(this.nodeResults)) {
      if (result.status === "completed" || result.status === "failed" || result.status === "skipped" || result.status === "skipped_failed") {
        completedNodes[id] = {
          status: result.status === "skipped_failed" ? "skipped" : result.status as "completed" | "failed" | "skipped",
          durationMs: result.durationMs,
          sessionId: result.sessionId,
          retryCount: result.retryCount ?? 0,
        }
      }
    }
    return {
      executionId: this.executionId,
      workflowRef: this.workflow.name,
      timestamp: new Date().toISOString(),
      completedNodes,
      poolSnapshot: this.pool.snapshot(),
      globalSessionId: this.globalSessionId,
      branchSessionIds: Object.fromEntries(this.branchSessionIds),
      resumeAttempts: 0,
    }
  }

  /**
   * Update the engine's abort signal.
   * Called by resume() to replace the aborted signal with a fresh one.
   */
  updateSignal(signal: AbortSignal): void {
    this.signal = signal
  }

  /** Configure pipeline support for this engine instance. */
  setPipelineConfig(
    config: PipelineConfig,
    checkpointStore?: ICheckpointStore,
    pipelinePath?: string,
  ): void {
    this.pipelineConfig = config
    this.pipelineConfigHash = this.hashConfig(config)
    this.retryResolver = new RetryPolicyResolver(config.retry)
    this.failureClassifier = new FailureClassifier()
    this.checkpointStore = checkpointStore
    this.pipelinePath = pipelinePath
  }

  /** Stable hash for pipeline config change detection (key-order insensitive, deep). */
  private hashConfig(config: PipelineConfig): string {
    // Deep sort all keys recursively for stable comparison
    const deepSort = (obj: unknown): unknown => {
      if (obj === null || typeof obj !== 'object') return obj
      if (Array.isArray(obj)) return obj.map(deepSort)
      const sorted: Record<string, unknown> = {}
      for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
        sorted[key] = deepSort((obj as Record<string, unknown>)[key])
      }
      return sorted
    }
    const stable = JSON.stringify(deepSort(config))
    let h = 0
    for (let i = 0; i < stable.length; i++) {
      h = ((h << 5) - h + stable.charCodeAt(i)) | 0
    }
    return `${stable.length}:${h}`
  }

  /**
   * Re-read pipeline.yaml and apply changes if config has changed.
   * Returns true if config was reloaded, false otherwise.
   * Parse errors are logged but never thrown — hot-reload failure must not crash execution.
   */
  private reloadPipelineIfNeeded(): boolean {
    if (!this.pipelinePath) return false
    if (!existsSync(this.pipelinePath)) return false

    try {
      const content = readFileSync(this.pipelinePath, 'utf8')
      const newConfig = parsePipelineConfig(content)
      const newHash = this.hashConfig(newConfig)

      if (newHash !== this.pipelineConfigHash) {
        this.pipelineConfig = newConfig
        this.pipelineConfigHash = newHash
        this.retryResolver = new RetryPolicyResolver(newConfig.retry)
        // failureClassifier is stateless, no need to update
        this.logger?.log('pipeline', 'reloaded', {
          path: this.pipelinePath,
        })
        return true
      }
    } catch (err) {
      // Parse failure does not affect current execution
      this.logger?.log('pipeline', 'reload_error', { error: String(err) })
    }
    return false
  }

  /**
   * Trigger a user-initiated pause at the specified node.
   */
  pauseAtNode(nodeId: string): void {
    this.pausedAt = nodeId
  }

  /**
   * Resume from a user-initiated pause.
   * Returns the paused node ID and clears pausedAt.
   * Returns null if not currently paused.
   */
  resumeFromPause(): string | null {
    if (!this.pausedAt) return null
    const nodeId = this.pausedAt
    this.pausedAt = undefined
    return nodeId
  }

  /**
   * Check if currently paused (user-initiated).
   */
  isPaused(): boolean {
    return this.pausedAt !== undefined
  }

  /**
   * Check if currently waiting for approval.
   */
  isPendingApproval(): boolean {
    return this.pendingApprovalNodeId !== undefined
  }

  // ── Runtime Node Support (Upgrade 3) ──────────────────────

  /**
   * Detect new runtime nodes from pipelineConfig that haven't been
   * executed or registered yet.
   */
  private detectNewRuntimeNodes(): NodeDef[] {
    const runtimeNodes = (this.pipelineConfig as any)?.runtime_nodes ?? []
    if (!runtimeNodes.length) return []

    return runtimeNodes.filter((n: any) => {
      // Skip if already has a result or already registered
      if (this.nodeResults[n.id]) return false
      if (this.runtimeNodeIds.has(n.id)) return false
      return true
    }).map((n: any) => ({
      id: n.id,
      type: n.type,
      bash: n.bash,
      python: n.python,
      prompt: n.prompt,
      agent: n.agent,
      depends_on: n.depends_on,
      execute_when: n.execute_when,
      timeout: n.timeout,
    } as NodeDef))
  }

  /**
   * Insert detected runtime nodes into the execution sequence.
   * Validates depends_on references and fires onRuntimeNodeAdded callback.
   */
  private insertRuntimeNodes(newNodes: NodeDef[], sorted: NodeDef[]): void {
    const allNodeIds = new Set(sorted.map(n => n.id))

    for (const node of newNodes) {
      // Validate depends_on references exist
      const invalidDeps = (node.depends_on ?? []).filter(dep => !allNodeIds.has(dep))
      if (invalidDeps.length > 0) {
        this.logger?.log('runtime', 'invalid_dependency', {
          node: node.id,
          invalid_deps: invalidDeps,
        })
        // Skip node with invalid dependencies
        continue
      }

      this.runtimeNodeIds.add(node.id)

      // Append to execution sequence (topological sort handles ordering on next iteration)
      sorted.push(node)

      this.logger?.log('runtime', 'node_added', { id: node.id, type: node.type })
      this.callbacks?.onRuntimeNodeAdded?.(node.id, node.type)
    }
  }
}