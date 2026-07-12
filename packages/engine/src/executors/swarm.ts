import type { NodeExecutor, NodeExecutionResult } from "./types"
import type { NodeDef, ExpertDef, ModelAliasConfig } from "@octopus/shared"
import type { SwarmNodeDef } from "@octopus/shared"

// ponytail: NodeDef.mode union lags behind SwarmNodeDef; cast once here
const asSwarm = (n: NodeDef): SwarmNodeDef => n as SwarmNodeDef
import { VarPool, substituteVars, resolveModelAlias, resolveMoaModel } from "@octopus/shared"
import type { IAgentProvider, MessageChunk } from "@octopus/providers"
import type { ICheckpointStore, SwarmCheckpointData } from "../pipeline/checkpoint-types"
import { existsSync } from "fs"
import { join } from "path"
import { applyVarsUpdate } from "./parse-vars-update"
import { MessageBus } from "./swarm/message-bus"
import { SharedMemory } from "./swarm/shared-memory"
import { SwarmCoordinator } from "./swarm/swarm-coordinator"
import { DiscussionStrategy } from "./swarm/discussion-strategy"
import { DispatchStrategy } from "./swarm/dispatch-strategy"
import { MoaStrategy } from "./swarm/moa-strategy"
import { BudgetTracker } from "./swarm/budget-tracker"
import { HostAgent } from "./swarm/host-agent"
import type { SwarmResult, RouterDecision } from "./swarm/swarm-types"
import type { SwarmStrategyConfig, SwarmStrategy } from "./swarm/swarm-strategy"
import { ContextTierResolver } from "./swarm/context-tier-resolver"
import type { ContextTier } from "./swarm/context-tier-resolver"
import { DEFAULT_CONTEXT_TIER } from "./swarm/swarm-constants"
import type { EngineCallbacks } from "../engine"
import type { JsonlLogger } from "../logger"

/**
 * SwarmExecutor — the NodeExecutor entry point for swarm-type nodes.
 *
 * Orchestrates multi-expert discussion, debate, or DAG-dispatch workflows.
 * Delegates the actual execution logic to a strategy (DiscussionStrategy or DispatchStrategy)
 * via the SwarmCoordinator, which implements SwarmServices.
 */
export class SwarmExecutor implements NodeExecutor {
  constructor(
    private node: NodeDef,
    private pool: VarPool,
    private providers: Record<string, IAgentProvider>,
    private cwd: string,
    private callbacks?: EngineCallbacks,
    private logger?: JsonlLogger,
    private signal?: AbortSignal,
    private checkpointStore?: ICheckpointStore,
    private executionId?: string,
    private engineHookFn?: (event: string, context: Record<string, unknown>) => Promise<void>,
    /** BL-5: Model alias config for resolving expert.model aliases */
    private modelAliasConfig?: ModelAliasConfig,
    /** Workflow-level engine fallback (node.engine ?? workflow.engine ?? "claude") */
    private workflowEngine?: string,
  ) {}

  async execute(): Promise<NodeExecutionResult> {
    const start = Date.now()
    const logLines: string[] = []

    try {
      // Merge expert_defaults into each expert
      const baseExperts: ExpertDef[] = (this.node.experts ?? []).map(e => ({
        ...this.node.expert_defaults,
        ...e,
      }))

      // BL-5: Resolve expert.model aliases immutably (tier → real model name)
      const nodeMode = asSwarm(this.node).mode ?? "review"
      const rawEngineKey = this.node.engine ?? this.workflowEngine ?? "claude"
      const providerKey = rawEngineKey === "claude-code" ? "claude" : rawEngineKey

      // ponytail: per-expert engine → resolve providerKey for alias lookup
      const resolveExpertProviderKey = (expert: ExpertDef): string => {
        const raw = expert.engine ?? this.node.engine ?? this.workflowEngine ?? "claude"
        return raw === "claude-code" ? "claude" : raw
      }

      const experts: ExpertDef[] = this.modelAliasConfig
        ? baseExperts.map(expert => {
            if (!expert.model) return expert
            const epk = resolveExpertProviderKey(expert)
            if (nodeMode === "moa") {
              // C-3 fix: claude engine → resolve tier alias (pro-max → opus) via resolveModelAlias
              if (epk === "claude") {
                const resolved = resolveModelAlias(expert.model, epk, this.modelAliasConfig!)
                return resolved ? { ...expert, model: resolved } : expert
              }
              // pi engine → MOA-aware resolution with degradation chain
              const resolution = resolveMoaModel(expert.model, epk, this.modelAliasConfig!)
              logLines.push(`[moa] Model ${expert.model} degraded: ${resolution.chain.join(" → ")} → ${resolution.resolved}`)
              return resolution.resolved ? { ...expert, model: resolution.resolved } : expert
            }
            const resolved = resolveModelAlias(expert.model, epk, this.modelAliasConfig!)
            return resolved ? { ...expert, model: resolved } : expert
          })
        : baseExperts

      // Resolve $vars.* references in topic (consistent with agent/bash/python executors)
      const resolvedTopic = substituteVars(this.node.topic ?? "", this.pool)

      // Setup LLM call function using the provider's sendQuery
      const defaultProvider = this.resolveProvider()
      if (!defaultProvider) throw new Error("No LLM provider available")

      // ponytail: per-expert provider lookup — expert.engine → node.engine → workflow.engine → "claude"
      const resolveProviderForExpert = (expertEngine?: string): IAgentProvider => {
        if (!expertEngine) return defaultProvider
        const raw = expertEngine === "claude-code" ? "claude" : expertEngine
        return this.providers[raw] ?? defaultProvider
      }

      const budgetTracker = new BudgetTracker(this.node.budget, this.node.timeout)

      const llmCall = async (
        prompt: string,
        model?: string,
        engine?: string,
      ): Promise<{ text: string; model: string; tokens: number; inputTokens: number; outputTokens: number; toolsUsed: string[]; filesChanged: string[] }> => {
        // ponytail: resolve provider per-expert, then resolve tier aliases for that provider
        const p = resolveProviderForExpert(engine)
        const epk = engine ? (engine === "claude-code" ? "claude" : engine) : providerKey
        const rawModel = model ?? this.node.model
        const resolvedModel = this.modelAliasConfig
          ? resolveModelAlias(rawModel, epk, this.modelAliasConfig) ?? rawModel
          : rawModel
        const result = await collectFromProvider(p, prompt, this.cwd, resolvedModel)
        budgetTracker.addUsage(result.model, result.inputTokens, result.outputTokens, result.cacheReadTokens, result.cacheCreationTokens, result.costUsd)
        return { text: result.text, model: result.model, tokens: result.tokens, inputTokens: result.inputTokens, outputTokens: result.outputTokens, toolsUsed: result.toolsUsed, filesChanged: result.filesChanged }
      }

      // Setup HostAgent
      const hostAgent = new HostAgent(async (prompt, model) => {
        const result = await llmCall(prompt, model ?? this.node.host?.model)
        return result.text
      })

      // --- Dynamic routing (P3.3) ---
      let effectiveExperts: ExpertDef[] = [...experts]
      let effectiveMode = this.node.mode ?? "review"
      let routerDecision: RouterDecision | undefined

      if (this.node.dynamic) {
        const { RoleRegistry } = await import("./swarm/role-registry")
        const { SwarmRouter } = await import("./swarm/swarm-router")

        const registry = new RoleRegistry(this.getScanPaths())
        const router = new SwarmRouter(registry)
        routerDecision = await router.analyze(resolvedTopic, {
          maxExperts: this.node.max_experts,
          llmCall: async (prompt, model) => {
            const result = await llmCall(prompt, model)
            return result.text
          },
        })

        // For "swarm" mode, use router's mode decision
        if (effectiveMode === "swarm") {
          effectiveMode = routerDecision.mode
          logLines.push(`Router selected mode: ${effectiveMode} (${routerDecision.mode_reasoning})`)
        }

        // Add dynamic experts (those not already in predefined list)
        const predefinedRoles = new Set(experts.map(e => e.role))
        for (const routerExpert of routerDecision.experts) {
          if (!predefinedRoles.has(routerExpert.role)) {
            const resolved = registry.resolve(routerExpert.role)
            effectiveExperts.push({
              ...this.node.expert_defaults,
              role: routerExpert.role,
              agent_file: resolved?.agent_file,
              prompt: routerExpert.match_reasoning,
            })
            logLines.push(`Dynamic expert added: ${routerExpert.role} (score: ${routerExpert.match_score})`)
          }
        }
      }

      // Setup Coordinator — bus/memory must exist before coordinator (closures reference them)
      const startTime = start
      const self = this // capture for closures below

      const bus = new MessageBus()
      const memory = new SharedMemory()

      // ponytail: checkpoint resume — load saved swarm state if available
      let resumeFromRound: number | undefined
      let loadedCheckpoint = null
      if (this.checkpointStore && this.executionId) {
        loadedCheckpoint = this.checkpointStore.load(this.executionId)
        if (loadedCheckpoint?.swarmData && loadedCheckpoint.swarmData.nodeId === this.node.id) {
          bus.loadFromCheckpoint(loadedCheckpoint.swarmData.messages)
          resumeFromRound = loadedCheckpoint.swarmData.currentRound
          logLines.push(`Resuming from checkpoint: round ${resumeFromRound}, ${loadedCheckpoint.swarmData.messages.length} messages restored`)
        }
      }

      const coordinator = new SwarmCoordinator({
        llmCall,
        hostAgent,
        nodeId: this.node.id,
        emitSSE: event => {
          // Wire swarm events to engine callbacks for SSE emission
          this.callbacks?.onSwarmEvent?.(this.node.id, event)
        },
        logSwarmEvent: (nodeId, event, data) => {
          this.logger?.log(nodeId, event, data)
        },
        executeHook: (event, context) => {
          // Strip "on_" prefix for consistent event naming in logs
          const eventName = event.startsWith("on_") ? event.slice(3) : event
          if (self.engineHookFn) {
            self.engineHookFn(event, context).catch(err => {
              self.logger?.log(self.node.id, "hook_error", { event: eventName, error: String(err) })
            })
          } else {
            this.logger?.log(this.node.id, "hook_event", { event: eventName, ...context })
          }
        },
        saveCheckpoint: () => {
          // Save swarm checkpoint data if checkpoint store is available
          if (!self.checkpointStore || !self.executionId) return
          try {
            const cs = coordinator.checkpointState
            const swarmData: SwarmCheckpointData = {
              nodeId: self.node.id,
              mode: effectiveMode,
              currentRound: cs.currentRound,
              messages: bus.getAll(),
              expertResults: cs.expertResults,
              consensusScore: cs.consensusScore,
              consumedTokens: budgetTracker.getConsumed(),
              startTime,
            }
            self.checkpointStore.save({
              executionId: self.executionId,
              workflowRef: self.pool.get("workflow_name") || self.node.id,
              timestamp: new Date().toISOString(),
              completedNodes: {},
              poolSnapshot: self.pool.snapshot(),
              branchSessionIds: {},
              resumeAttempts: 0,
              swarmData,
            })
          } catch (err) {
            self.logger?.log(self.node.id, "checkpoint_error", { error: String(err) })
          }
        },
        checkBudget: () => budgetTracker.checkBudget(),
        isTimedOut: () => budgetTracker.isTimedOut(startTime),
      })

      // Select strategy
      const config: SwarmStrategyConfig = {
        mode: effectiveMode as SwarmStrategyConfig["mode"],
        topic: resolvedTopic,
        rounds: this.node.rounds ?? 3,
        consensusThreshold: this.node.consensus_threshold ?? 0.7,
        outputFormat: this.node.output_format,
        nodeId: this.node.id,
        failurePolicy:
          this.node.failure_policy ??
          (effectiveMode === "dispatch" ? "fail_fast" : "continue_partial"),
        resumeFromRound: resumeFromRound,
        contextTier: new ContextTierResolver((this.node.context_tier as ContextTier) ?? DEFAULT_CONTEXT_TIER),
        host: this.node.host,
        aggregator: asSwarm(this.node).aggregator,
      }

      // ponytail: restore coordinator checkpoint state if resuming
      if (resumeFromRound && loadedCheckpoint?.swarmData) {
        coordinator.checkpointState = {
          currentRound: loadedCheckpoint.swarmData.currentRound,
          consensusScore: loadedCheckpoint.swarmData.consensusScore,
          expertResults: [...loadedCheckpoint.swarmData.expertResults],
        }
      }

      // Log swarm start
      this.callbacks?.onNodeLog?.(this.node.id, `[swarm] Starting swarm: mode=${config.mode}, experts=${effectiveExperts.length}`)

      const strategy = this.selectStrategy(config, coordinator)
      const result = await strategy.run(effectiveExperts, bus, memory)

      // Log swarm completion
      this.callbacks?.onNodeLog?.(this.node.id, `[swarm] Completed: status=${result.status}, rounds=${result.rounds_used}`)

      // Attach router decision if dynamic
      if (routerDecision) {
        result.router_decision = routerDecision
        // ponytail: router decision IS the task breakdown for dynamic mode
        result.task_breakdown = {
          topic: resolvedTopic,
          mode: routerDecision.mode,
          experts: routerDecision.experts.map(e => ({
            role: e.role,
            task: e.match_reasoning,
            reasoning: e.match_reasoning,
          })),
        }
      }

      // Write auto-outputs to VarPool
      this.writeAutoOutputs(result)

      const durationMs = Date.now() - start
      logLines.push(
        `Swarm completed: ${result.status}, ${result.rounds_used} rounds, ${result.expert_count} experts`,
      )

      // Extract vars_update from host synthesis (consistent with agent/bash/python executors)
      const outputs = this.buildOutputs(result)
      // Use rawResponse (full LLM text) for vars_update extraction — synthesis may only
      // contain the first JSON object, missing vars_update if host outputs multiple JSONs
      const varsUpdateSource = result.rawResponse ?? result.synthesis
      if (varsUpdateSource) {
        applyVarsUpdate(varsUpdateSource, this.pool, outputs)
      }

      return {
        lastOutput: result.synthesis,
        outputs,
        status: result.status === "completed" ? "completed" : "failed",
        durationMs,
        logLines,
        tokens: budgetTracker.getTokenUsage(),
        modelUsages: budgetTracker.getModelUsages(),
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e)
      const durationMs = Date.now() - start
      logLines.push(`Swarm failed: ${message}`)
      return {
        outputs: {},
        status: "failed",
        durationMs,
        logLines,
        error: message,
      }
    }
  }

  private resolveProvider(): IAgentProvider | undefined {
    const rawKey = this.node.engine ?? this.workflowEngine ?? "claude"
    const providerKey = rawKey === "claude-code" ? "claude" : rawKey
    return this.providers[providerKey] ?? this.providers["claude"]
  }

  private getScanPaths(): string[] {
    const paths: string[] = []
    // Highest priority: workspace .claude/agents/
    const claudeAgents = join(this.cwd, ".claude/agents")
    if (existsSync(claudeAgents)) paths.push(claudeAgents)

    // Shared agents: ~/.octopus/agents/ (not org-scoped)
    const home = process.env.HOME || process.env.USERPROFILE || ""
    if (home) {
      const orgAgents = join(home, ".octopus/agents")
      if (existsSync(orgAgents)) paths.push(orgAgents)
    }

    // agency-agents-zh dependency (installed via `octopus setup`)
    const agencyAgents = join(this.cwd, "dependencies/agency-agents-zh")
    if (existsSync(agencyAgents)) paths.push(agencyAgents)

    return paths
  }

  private selectStrategy(
    config: SwarmStrategyConfig,
    coordinator: SwarmCoordinator,
  ): SwarmStrategy {
    switch (config.mode) {
      case "review":
      case "debate":
      case "swarm":
        return new DiscussionStrategy(coordinator, config)
      case "dispatch":
        return new DispatchStrategy(coordinator, config)
      case "moa":
        return new MoaStrategy(coordinator, {
          ...config,
          aggregator: asSwarm(this.node).aggregator,
          timeout: this.node.timeout,
        })
      default:
        throw new Error(`Unknown swarm mode: ${config.mode}`)
    }
  }

  private writeAutoOutputs(result: SwarmResult): void {
    const id = this.node.id
    this.pool.set(`${id}_synthesis`, result.synthesis)
    this.pool.set(`${id}_consensus_score`, result.consensus_score)
    this.pool.set(`${id}_rounds_used`, result.rounds_used)
    this.pool.set(`${id}_expert_count`, result.expert_count)
    this.pool.set(`${id}_experts`, JSON.stringify(result.experts.map(e => e.role)))
    this.pool.set(`${id}_history`, JSON.stringify(result.history))
    this.pool.set(`${id}_task_breakdown`, JSON.stringify(result.task_breakdown ?? null))
    this.pool.set(`${id}_budget_exhausted`, result.budget_exhausted)
    this.pool.set(`${id}_timeout_exceeded`, result.timeout_exceeded)
    this.pool.set(`${id}_expert_outputs`, JSON.stringify(result.experts.filter(e => e.status === "completed").map(e => ({ role: e.role, output: e.output }))))
    this.pool.set(`${id}_failed_experts`, JSON.stringify(result.failed_experts))
  }

  private buildOutputs(result: SwarmResult): Record<string, any> {
    const outputs: Record<string, any> = {
      synthesis: result.synthesis,
      consensus_score: result.consensus_score,
      rounds_used: result.rounds_used,
      expert_count: result.expert_count,
      status: result.status,
      experts: result.experts.filter(e => e.status === "completed").map(e => ({ role: e.role, output: e.output })),
      failed_experts: result.failed_experts,
    }
    // Map user-defined outputs
    if (this.node.outputs) {
      for (const [key, expr] of Object.entries(this.node.outputs)) {
        outputs[key] = expr
      }
    }
    return outputs
  }
}

/**
 * Collect text and token usage from an IAgentProvider.sendQuery async generator.
 */
async function collectFromProvider(
  provider: IAgentProvider,
  prompt: string,
  cwd: string,
  model?: string,
): Promise<{
  text: string
  tokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  model: string
  costUsd?: number
  toolsUsed: string[]
  filesChanged: string[]
}> {
  let text = ""
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheCreationTokens = 0
  let resolvedModel = model ?? "unknown"
  let costUsd: number | undefined
  const toolsUsed: string[] = []
  const filesChanged: string[] = []

  const gen = provider.sendQuery(prompt, cwd, undefined, {
    model,
    systemPrompt: "You are an expert assistant.",
  })

  for await (const chunk of gen) {
    if (chunk.type === "text_delta") {
      text += chunk.content
    } else if (chunk.type === "result") {
      inputTokens = chunk.tokens?.input ?? 0
      outputTokens = chunk.tokens?.output ?? 0
      cacheReadTokens = (chunk as any).tokens?.cache_read ?? 0
      cacheCreationTokens = (chunk as any).tokens?.cache_creation ?? 0
      costUsd = chunk.costUsd
      if (chunk.modelUsages && chunk.modelUsages.length > 0) {
        resolvedModel = chunk.modelUsages[0].model
        inputTokens = chunk.modelUsages[0].inputTokens || inputTokens
        outputTokens = chunk.modelUsages[0].outputTokens || outputTokens
        cacheReadTokens = chunk.modelUsages[0].cacheReadInputTokens ?? cacheReadTokens
        cacheCreationTokens = chunk.modelUsages[0].cacheCreationInputTokens ?? cacheCreationTokens
        costUsd = chunk.modelUsages[0].costUsd ?? costUsd
      }
    } else if (chunk.type === "tool_call") {
      if (!toolsUsed.includes(chunk.toolName)) toolsUsed.push(chunk.toolName)
      // Track file changes from Write/Edit tool calls
      const input = chunk.toolInput as Record<string, unknown> | undefined
      if (input?.file_path && typeof input.file_path === "string") {
        if (!filesChanged.includes(input.file_path)) filesChanged.push(input.file_path)
      }
    }
  }

  return {
    text,
    tokens: inputTokens + outputTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    model: resolvedModel,
    costUsd,
    toolsUsed,
    filesChanged,
  }
}
