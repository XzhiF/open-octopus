import { VarPool, substituteVars, compileAutoAnswers, evaluateExpression, resolveModelAlias } from "@octopus/shared"
import type { NodeDef, AutoAnswer, SubAgentDef, CrossExecResolver, ModelAliasConfig } from "@octopus/shared"
import type { NodeExecutor, NodeExecutionResult } from "./types"
import type { AgentConfig } from "./executor-config"
import { AgentNodeRunner } from "./agent-runner"
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
      })

      clearTimeout(activityTimer)

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
        const absolutePath = path.isAbsolute(expanded)
          ? expanded
          : path.resolve(cwd, expanded)

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

    prompt = substituteVars(prompt, this.pool, this.buildNodeOutputs(), this.crossExecResolver, this.executionId, this.loopContext)

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

  /** Build a structured prompt for goal-mode agent nodes. */
  private buildGoalPrompt(): string {
    const parts: string[] = []

    // Goal section
    parts.push(`## Goal`)
    parts.push(substituteVars(this.node.goal!, this.pool, this.buildNodeOutputs(), this.crossExecResolver, this.executionId, this.loopContext))

    // Constraints section
    if (this.node.constraints?.length) {
      parts.push(``)
      parts.push(`## Constraints`)
      for (const c of this.node.constraints) {
        parts.push(`- ${c}`)
      }
    }

    // Planning tools
    if (this.node.planning?.tools?.length) {
      parts.push(``)
      parts.push(`## Allowed Tools`)
      for (const t of this.node.planning.tools) {
        parts.push(`- ${t}`)
      }
    }
    if (this.node.planning?.disallowed_tools?.length) {
      parts.push(``)
      parts.push(`## Disallowed Tools`)
      for (const t of this.node.planning.disallowed_tools) {
        parts.push(`- ${t}`)
      }
    }

    // Instructions
    parts.push(``)
    parts.push(`## Instructions`)
    parts.push(`You are an autonomous agent. Plan your approach step by step:`)
    parts.push(`1. Think about what you need to do`)
    parts.push(`2. Identify what information you need`)
    parts.push(`3. Execute your plan using available tools`)
    if (this.node.planning?.verify) {
      parts.push(`4. Verify your result before finishing`)
    }
    parts.push(``)
    parts.push(`You must work within the stated constraints. If a constraint prevents completion, explain why in your output.`)

    // Context injection: previous node results
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

  /** Build context section with previous node results and VarPool summary for goal-mode agents. */
  private buildGoalContext(): string {
    const parts: string[] = []

    // 1. Previous node results
    if (this.engineContext) {
      const prevResults = Object.entries(this.engineContext.nodeResults)
        .filter(([_, r]) => r.status === 'completed' || r.status === 'failed')

      if (prevResults.length > 0) {
        parts.push('## Previous Node Results')
        for (const [id, result] of prevResults) {
          parts.push(`- ${id}: ${result.status} (${result.durationMs}ms)`)
          if (result.lastOutput) {
            parts.push(`  Output: ${result.lastOutput.slice(0, 200)}...`)
          }
        }
      }
    }

    // 2. VarPool snapshot
    const poolSnapshot = this.pool.snapshot()
    const poolKeys = Object.keys(poolSnapshot)
    if (poolKeys.length > 0) {
      parts.push('## Available Variables')
      for (const key of poolKeys.slice(0, 20)) {
        const val = poolSnapshot[key]
        parts.push(`- $vars.${key} = ${JSON.stringify(val)?.slice(0, 100)}`)
      }
    }

    return parts.join('\n')
  }

  private applyVarsUpdate(text: string, outputs: Record<string, any>) {
    applyVarsUpdate(text, this.pool, outputs)
  }

  private applyOutputsMapping(outputs: Record<string, any>) {
    if (!this.node.outputs) return
    for (const [key, expr] of Object.entries(this.node.outputs)) {
      const VARS_ASSIGN_RE = /^\$vars\.(\w+)\s*=\s*(.+)$/
      const assignMatch = expr.match(VARS_ASSIGN_RE)
      if (assignMatch) {
        const varKey = assignMatch[1]
        const rhs = assignMatch[2].trim()
        const resolved = evaluateExpression(rhs, this.pool)
        this.pool.set(varKey, resolved)
        outputs[key] = resolved
        continue
      }

      if (expr === "$last_output") {
        this.pool.set(key, outputs.last_output)
        outputs[key] = outputs.last_output
      } else if (expr.startsWith("$vars.")) {
        const varKey = expr.slice(6)
        this.pool.set(key, this.pool.get(varKey))
        outputs[key] = this.pool.get(key)
      } else if (expr.startsWith("$")) {
        const resolved = substituteVars(expr, this.pool, this.buildNodeOutputs(), this.crossExecResolver, this.executionId, this.loopContext)
        this.pool.set(key, resolved)
        outputs[key] = resolved
      } else {
        this.pool.set(key, expr)
        outputs[key] = expr
      }
    }
  }
}