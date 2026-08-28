import { VarPool, substituteVars, substituteVarsFull, compileAutoAnswers, resolveModelAlias, applyOutputsMapping } from "@octopus/shared"
import type { NodeDef, AutoAnswer, SubAgentDef, CrossExecResolver, ModelAliasConfig } from "@octopus/shared"
import type { NodeExecutor, NodeExecutionResult } from "./types"
import type { AgentConfig } from "./executor-config"
import type { SystemPromptInput } from "@octopus/providers"
import { AgentNodeRunner } from "./agent-runner"
import type { AgentRunResult } from "./agent-types"
import type { PromptInjector } from "../prompt-injector"
import type { KnowledgeInjector } from "../knowledge-injector"
import { applyVarsUpdate } from "./parse-vars-update"
import fs from "fs"
import path from "path"
import os from "os"

/** Context from the engine for goal-mode agents (nodeResults + pool snapshot). */
export interface EngineContext {
  nodeResults: Record<string, NodeExecutionResult>
}

export class AgentExecutor implements NodeExecutor {
  private runner: AgentNodeRunner
  private previousSessionId?: string
  private globalAutoAnswers?: AutoAnswer[]
  private signal?: AbortSignal
  private engineContext?: EngineContext
  private promptInjector?: PromptInjector
  private knowledgeInjector?: KnowledgeInjector
  private workflowName?: string
  private crossExecResolver?: CrossExecResolver
  private executionId?: string
  private loopContext?: Record<string, any>
  private resolvedModel?: string
  private modelAliasConfig?: ModelAliasConfig
  private providerKey?: string
  private systemPrompt?: SystemPromptInput
  private onBeforeToolCall?: (toolName: string, input: unknown) => Promise<{ allow: boolean; reason?: string } | undefined>
  /** Warn-once state for resolveNodeNumber (walkthrough O). */
  private invalidNumberWarned = false

  constructor(
    private node: NodeDef,
    private pool: VarPool,
    config: AgentConfig,
  ) {
    this.runner = config.runner
    this.previousSessionId = config.previousSessionId
    this.globalAutoAnswers = config.globalAutoAnswers
    this.signal = config.signal
    this.engineContext = config.engineContext
    this.promptInjector = config.promptInjector
    this.knowledgeInjector = config.knowledgeInjector
    this.workflowName = config.workflowName
    this.crossExecResolver = config.crossExecResolver
    this.executionId = config.executionId
    this.loopContext = config.loopContext
    this.resolvedModel = config.resolvedModel
    this.modelAliasConfig = config.modelAliasConfig
    this.providerKey = config.providerKey
    this.systemPrompt = config.systemPrompt
    this.onBeforeToolCall = config.onBeforeToolCall
  }

  async execute(): Promise<NodeExecutionResult> {
    if (this.signal?.aborted) {
      return {
        outputs: {},
        status: "cancelled",
        durationMs: 0,
        logLines: ["Agent execution cancelled before start"],
      }
    }

    const start = Date.now()
    const timeout = this.node.timeout ?? 600 // default 10 minutes for agent nodes
    const activityTimeout = timeout * 1000 // activity-based: reset on each stream event

    // Create a timeout controller and forward external abort signal
    const timeoutAc = new AbortController()
    const onExternalAbort = () => timeoutAc.abort()
    this.signal?.addEventListener("abort", onExternalAbort, { once: true })
    let activityTimer = setTimeout(() => timeoutAc.abort(), activityTimeout)

    const resetActivityTimer = () => {
      clearTimeout(activityTimer)
      activityTimer = setTimeout(() => timeoutAc.abort(), activityTimeout)
    }

    // Heartbeat monitoring
    const HEARTBEAT_INTERVAL = 30_000 // 30 seconds
    const HEARTBEAT_WARN_THRESHOLD = 300_000 // 5 minutes
    const heartbeatWarnings: string[] = []
    let lastHeartbeatWarnAt = 0
    const heartbeatTimer = setInterval(() => {
      if (typeof this.runner.getLastActivityAt === "function") {
        const lastActivity = this.runner.getLastActivityAt()
        if (lastActivity > 0) {
          const idleMs = Date.now() - lastActivity
          if (idleMs > HEARTBEAT_WARN_THRESHOLD && Date.now() - lastHeartbeatWarnAt > HEARTBEAT_WARN_THRESHOLD) {
            const warnMsg = `Agent subprocess no activity for ${Math.round(idleMs / 1000)}s (threshold: ${HEARTBEAT_WARN_THRESHOLD / 1000}s)`
            heartbeatWarnings.push(warnMsg)
            lastHeartbeatWarnAt = Date.now()
          }
        }
      }
    }, HEARTBEAT_INTERVAL)

    try {
      const prompt = this.buildPrompt()

      const result = await this.runner.run({
        prompt,
        agent: this.node.agent,
        skills: this.node.skills,
        agents: this.resolveAgents(),
        model: this.resolvedModel ?? this.node.model,
        context: this.node.context ?? "continue",
        previousSessionId: this.previousSessionId,
        signal: timeoutAc.signal,
        onActivity: resetActivityTimer,
        effort: this.node.effort,
        systemPrompt: this.systemPrompt,
        onBeforeToolCall: this.onBeforeToolCall,
        // Node-level execution constraints (goal-task-dev): resolved here, passed
        // straight to the SDK (claude engine; other providers ignore the fields).
        maxTurns: this.resolveNodeNumber(this.node.max_turns),
        maxBudgetUsd: this.resolveNodeNumber(this.node.max_budget_usd),
        tools: this.node.tools,
        disallowedTools: this.node.disallowed_tools,
      })

      clearTimeout(activityTimer)

      // SDK hard-fuse terminal (error_max_turns / error_max_budget_usd) —
      // non-convergence must be LOUD in unattended runs (K3): node failed with
      // goal_evidence assembled from the last active_goal event + terminalMeta.
      if (result.terminalReason) {
        return this.buildTerminalResult(result, heartbeatWarnings)
      }

      const outputs: Record<string, any> = { last_output: result.finalText }
      this.applyVarsUpdate(result.finalText, outputs)
      this.applyOutputsMapping(outputs)

      const status = (outputs.__status === "failed") ? "failed" : "completed"

      return {
        lastOutput: result.finalText,
        outputs,
        status,
        durationMs: result.durationMs,
        logLines: [...heartbeatWarnings, result.finalText.slice(0, 500)],
        sessionId: result.sessionId,
        tokens: result.tokens,
        modelUsages: result.modelUsages,
        events: result.events,
        llmCalls: result.llmCalls,
      }
    } catch (err: any) {
      const durationMs = Date.now() - start
      const errorMessage = err.message ?? String(err)
      if (timeoutAc.signal.aborted && !this.signal?.aborted) {
        return {
          outputs: {},
          status: "failed",
          durationMs,
          error: `Agent execution timed out after ${timeout}s`,
          logLines: [...heartbeatWarnings, `Agent execution timed out after ${timeout}s`],
        }
      }
      return {
        outputs: {},
        status: "failed",
        durationMs,
        error: errorMessage,
        logLines: [...heartbeatWarnings, errorMessage],
      }
    } finally {
      clearTimeout(activityTimer)
      clearInterval(heartbeatTimer)
      this.signal?.removeEventListener("abort", onExternalAbort)
    }
  }

  /** Resolve a number-or-string node field (max_turns / max_budget_usd).
   *  number → passthrough; string → substituteVarsFull → Number;
   *  NaN → treated as UNSET (undefined = no limit, CC headless default) with a
   *  warn ONCE per node execution (walkthrough O — distinguishes invalid from
   *  simply-not-written). */
  private resolveNodeNumber(raw: number | string | undefined): number | undefined {
    if (raw === undefined) return undefined
    if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined
    const substituted = substituteVarsFull(raw, this.pool, this.buildNodeOutputs(), this.crossExecResolver, this.executionId, this.loopContext).trim()
    if (substituted === "") return undefined
    const n = Number(substituted)
    if (Number.isNaN(n)) {
      if (!this.invalidNumberWarned) {
        this.invalidNumberWarned = true
        console.warn(`[agent:${this.node.id}] numeric field "${raw}" did not resolve to a number — treated as unset (no limit)`)
      }
      return undefined
    }
    return n
  }

  /** Map an SDK hard-fuse terminal (from AgentNodeRunner) to a failed node
   *  result carrying convergence evidence. evidence = last active_goal event
   *  (iterations/last_reason from the evaluator) + terminalMeta (numTurns/costUsd). */
  private buildTerminalResult(result: AgentRunResult, heartbeatWarnings: string[]): NodeExecutionResult {
    const evidence: Record<string, unknown> = {}
    let lastActiveGoal: AgentRunResult["events"][number] | undefined
    for (const e of result.events) {
      if (e.type === "active_goal") lastActiveGoal = e
    }
    if (lastActiveGoal && lastActiveGoal.type === "active_goal") {
      evidence.iterations = lastActiveGoal.iterations
      if (lastActiveGoal.last_reason !== undefined) evidence.last_reason = lastActiveGoal.last_reason
    }
    if (result.terminalMeta?.numTurns !== undefined) evidence.numTurns = result.terminalMeta.numTurns
    if (result.terminalMeta?.costUsd !== undefined) evidence.costUsd = result.terminalMeta.costUsd

    const errorMessage = `goal_not_met (${result.terminalReason})`
    return {
      lastOutput: result.finalText,
      outputs: { last_output: result.finalText, goal_evidence: evidence },
      status: "failed",
      error: errorMessage,
      durationMs: result.durationMs,
      logLines: [...heartbeatWarnings, errorMessage],
      sessionId: result.sessionId,
      tokens: result.tokens,
      modelUsages: result.modelUsages,
      events: result.events,
      llmCalls: result.llmCalls,
    }
  }

  private stripFrontmatter(content: string): string {
    if (!content.startsWith("---")) return content
    const endIndex = content.indexOf("---", 3)
    if (endIndex === -1) return content
    return content.slice(endIndex + 3).trimStart()
  }

  /**
   * Parse YAML frontmatter from agent .md files.
   * Extracts flat key-value pairs (tools, model, maxTurns, etc.)
   * Returns empty object if no valid frontmatter found.
   */
  private parseFrontmatter(content: string): Record<string, any> {
    if (!content.startsWith("---")) return {}
    const endIndex = content.indexOf("---", 3)
    if (endIndex === -1) return {}

    const fmBlock = content.slice(3, endIndex).trim()
    const result: Record<string, any> = {}

    for (const line of fmBlock.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const colonIdx = trimmed.indexOf(":")
      if (colonIdx === -1) continue

      const key = trimmed.slice(0, colonIdx).trim()
      const rawVal = trimmed.slice(colonIdx + 1).trim()

      // Remove surrounding quotes
      const val = (rawVal.startsWith('"') && rawVal.endsWith('"')) ||
                  (rawVal.startsWith("'") && rawVal.endsWith("'"))
        ? rawVal.slice(1, -1)
        : rawVal

      // Type coercion for known fields
      if (key === "tools" || key === "disallowedTools" || key === "skills") {
        // Support both "Read, Write, Edit" and '["Read", "Write"]' formats
        if (val.startsWith("[")) {
          try {
            const parsed = JSON.parse(val)
            if (Array.isArray(parsed)) {
              result[key] = parsed.map((s: any) => String(s).trim()).filter(Boolean)
            }
          } catch {
            result[key] = val.replace(/[\[\]"']/g, "").split(",").map((s: string) => s.trim()).filter(Boolean)
          }
        } else {
          result[key] = val.split(",").map((s: string) => s.trim()).filter(Boolean)
        }
      } else if (key === "maxTurns") {
        const n = parseInt(val, 10)
        if (!isNaN(n)) result[key] = n
      } else if (key === "background") {
        result[key] = val === "true"
      } else if (val) {
        result[key] = val
      }
    }

    return result
  }

  private resolveAgents(): Record<string, any> | undefined {
    const agents = this.node.agents
    if (!agents) return undefined

    const cwd = this.runner.getCwd()
    const resolved: Record<string, any> = {}

    for (const [name, def] of Object.entries(agents)) {
      const agentDef = def as SubAgentDef

      if (agentDef.agent_file) {
        const filePath = substituteVars(agentDef.agent_file, this.pool, this.buildNodeOutputs(), this.crossExecResolver, this.executionId, this.loopContext)
        const expanded = filePath.startsWith("~")
          ? path.join(os.homedir(), filePath.slice(1))
          : filePath
        let absolutePath = path.isAbsolute(expanded)
          ? expanded
          : path.resolve(cwd, expanded)

        // Fallback: group/name.md → .claude/agents/name.md
        // Provisioner stores files at .claude/agents/{basename}.md (no group prefix)
        if (!fs.existsSync(absolutePath)) {
          const basename = path.basename(filePath).replace(/\.md$/, "")
          const fallback = path.join(cwd, ".claude", "agents", `${basename}.md`)
          if (fs.existsSync(fallback)) {
            absolutePath = fallback
          }
        }

        const rawContent = fs.readFileSync(absolutePath, "utf-8")
        const frontmatter = this.parseFrontmatter(rawContent)
        const fileContent = this.stripFrontmatter(rawContent)
        const combinedPrompt = agentDef.prompt
          ? `${fileContent}\n\n---\n\n${agentDef.prompt}`
          : fileContent

        // Merge: frontmatter provides defaults, YAML SubAgentDef overrides
        const merged: Record<string, any> = { ...frontmatter }

        // Apply SubAgentDef fields (override frontmatter)
        for (const [key, val] of Object.entries(agentDef)) {
          if (key === "agent_file") continue
          if (val !== undefined && val !== null) {
            merged[key] = val
          }
        }

        merged.prompt = combinedPrompt
        merged.agent_file = undefined

        // Resolve tier model names (pro-max → opus, pro → sonnet, etc.)
        if (merged.model && this.modelAliasConfig) {
          const pk = this.providerKey ?? this.node.engine ?? "claude"
          const resolved = resolveModelAlias(merged.model, pk, this.modelAliasConfig)
          if (resolved) merged.model = resolved
        }

        resolved[name] = merged
      } else if (agentDef.prompt) {
        // Resolve tier model names for prompt-only agents too
        const agentCopy = { ...agentDef }
        if (agentCopy.model && this.modelAliasConfig) {
          const pk = this.providerKey ?? this.node.engine ?? "claude"
          const resolved = resolveModelAlias(agentCopy.model, pk, this.modelAliasConfig)
          if (resolved) agentCopy.model = resolved
        }
        resolved[name] = agentCopy
      } else {
        throw new Error(`SubAgentDef "${name}": must have either "prompt" or "agent_file"`)
      }
    }

    return resolved
  }

  /** Build nodeOutputs map from engineContext for $nodeId.output resolution. */
  private buildNodeOutputs(): Record<string, Record<string, any>> | undefined {
    if (!this.engineContext?.nodeResults) return undefined
    const nodeOutputs: Record<string, Record<string, any>> = {}
    for (const [id, result] of Object.entries(this.engineContext.nodeResults)) {
      const outputs = { ...(result.outputs ?? {}) }
      if (result.lastOutput !== undefined) outputs["output"] = result.lastOutput
      nodeOutputs[id] = outputs
    }
    return nodeOutputs
  }

  private buildPrompt(): string {
    // Goal mode: structured prompt with context injection
    if (this.node.goal) {
      return this.buildGoalPrompt()
    }

    // Standard prompt mode (existing behavior)
    let prompt = this.node.prompt ?? ""

    prompt = substituteVarsFull(prompt, this.pool, this.buildNodeOutputs(), this.crossExecResolver, this.executionId, this.loopContext)

    // Inject pipeline-level prompts (global + targeted)
    if (this.promptInjector && this.workflowName) {
      const injectedPrompts = this.promptInjector.getInjectedPrompts(this.workflowName, this.node.id)
      if (injectedPrompts.length > 0) {
        prompt = injectedPrompts.join("\n\n---\n\n") + "\n\n---\n\n" + prompt
      }
    }

    // Inject knowledge prompts
    if (this.knowledgeInjector && this.workflowName) {
      const knowledgePrompts = this.knowledgeInjector.getInjectedPrompts(this.workflowName, this.node.id)
      if (knowledgePrompts.length > 0) {
        prompt = knowledgePrompts.join("\n\n---\n\n") + "\n\n---\n\n" + prompt
      }
    }

    const nodeAnswers: AutoAnswer[] = this.node.auto_answers ?? []

    const compiled = compileAutoAnswers(this.globalAutoAnswers ?? [], nodeAnswers)
    if (compiled) {
      prompt += "\n\n" + compiled
    }

    if (this.node.agent) {
      prompt += `\n\n你作为 ${this.node.agent} 角色执行此任务。`
    }

    return prompt
  }

  /** Build a structured prompt for goal-mode agent nodes.
   *
   *  goal-task-dev (K1): goal mode = Claude Code native `/goal` + thin adapter.
   *  First line is `/goal <interpolated condition>` — the condition is the FULL
   *  interpolated text of the node's `goal:` field (K2); the SDK's built-in
   *  evaluator owns convergence (met/impossible) and the node-level
   *  max_turns/max_budget_usd hard fuses are passed straight to the SDK.
   *  No more Allowed/Disallowed Tools prompt sections — the SDK enforces those.
   *  Context injection is FULL — the former 20-key/100-char/200-char truncation
   *  was a lying interface (K7). */
  private buildGoalPrompt(): string {
    const parts: string[] = []

    // /goal directive — condition = goal 全文插值后,首行前置
    const condition = substituteVarsFull(this.node.goal!, this.pool, this.buildNodeOutputs(), this.crossExecResolver, this.executionId, this.loopContext)
    parts.push(`/goal ${condition}`)

    // Constraints section (prompt-level soft constraints — stays, orthogonal to SDK enforcement)
    if (this.node.constraints?.length) {
      parts.push(``)
      parts.push(`## Constraints`)
      for (const c of this.node.constraints) {
        parts.push(`- ${c}`)
      }
    }

    // Instructions — concise autonomy guidance (convergence/exit is the evaluator's job)
    parts.push(``)
    parts.push(`## Instructions`)
    parts.push(`You are an autonomous agent. Plan your approach step by step:`)
    parts.push(`1. Think about what you need to do`)
    parts.push(`2. Identify what information you need`)
    parts.push(`3. Execute your plan using available tools`)
    parts.push(``)
    parts.push(`You must work within the stated constraints. If a constraint prevents completion, explain why in your output.`)

    // Context injection: previous node results (full, no truncation)
    const goalContext = this.buildGoalContext()
    if (goalContext) {
      parts.push(``)
      parts.push(goalContext)
    }

    // Inject execution history from pool (Upgrade 2)
    const history = this.pool.get('_execution_history')
    if (history) {
      parts.push(``)
      parts.push(`## Previous Execution History`)
      parts.push(history)
    }

    // Auto-answers
    const nodeAnswers: AutoAnswer[] = this.node.auto_answers ?? []
    const compiled = compileAutoAnswers(this.globalAutoAnswers ?? [], nodeAnswers)
    if (compiled) {
      parts.push(`\n` + compiled)
    }

    // Agent role
    if (this.node.agent) {
      parts.push(`\n你作为 ${this.node.agent} 角色执行此任务。`)
    }

    return parts.join('\n')
  }

  /** Build context section with previous node results and VarPool summary for goal-mode agents.
   *  Full injection — no key-count or char-count truncation (K7). */
  private buildGoalContext(): string {
    const parts: string[] = []

    // 1. Previous node results — complete lastOutput, verbatim
    if (this.engineContext) {
      const prevResults = Object.entries(this.engineContext.nodeResults)
        .filter(([_, r]) => r.status === 'completed' || r.status === 'failed')

      if (prevResults.length > 0) {
        parts.push('## Previous Node Results')
        for (const [id, result] of prevResults) {
          parts.push(`- ${id}: ${result.status} (${result.durationMs}ms)`)
          if (result.lastOutput) {
            parts.push(`  Output: ${result.lastOutput}`)
          }
        }
      }
    }

    // 2. VarPool snapshot — all keys, full values
    const poolSnapshot = this.pool.snapshot()
    const poolKeys = Object.keys(poolSnapshot)
    if (poolKeys.length > 0) {
      parts.push('## Available Variables')
      for (const key of poolKeys) {
        const val = poolSnapshot[key]
        parts.push(`- $vars.${key} = ${JSON.stringify(val)}`)
      }
    }

    return parts.join('\n')
  }

  private applyVarsUpdate(text: string, outputs: Record<string, any>) {
    applyVarsUpdate(text, this.pool, outputs)
  }

  private applyOutputsMapping(outputs: Record<string, any>) {
    if (!this.node.outputs) return
    applyOutputsMapping(this.node.outputs, outputs, this.pool, outputs.last_output, undefined)
  }
}