// packages/engine/src/executors/interaction.ts
//
// InteractionExecutor — manages multi-turn AI-driven conversations
// through the Chat Bridge pattern. Returns pending_interaction on first call,
// processes completion data on resume.

import { VarPool, substituteVarsFull, substituteVars, applyOutputsMapping, evaluateExpression } from "@octopus/shared"
import type { NodeDef, CrossExecResolver } from "@octopus/shared"
import type { NodeExecutor, NodeExecutionResult, InteractionMetadata } from "./types"
import type { InteractionConfig } from "./executor-config"
import { readFileSync, existsSync } from "fs"
import { resolve } from "path"

/** Completion data provided when resuming from a pending_interaction state. */
export interface InteractionCompletionData {
  summary: string
  vars_update?: Record<string, any>
}

export class InteractionExecutor implements NodeExecutor {
  private completionData?: InteractionCompletionData
  private signal?: AbortSignal
  private loopContext?: Record<string, any>
  private crossExecResolver?: CrossExecResolver
  private executionId?: string
  private nodeOutputs?: Record<string, Record<string, any>>
  private cwd?: string
  private sessionId?: string
  private currentRound?: number

  constructor(
    private node: NodeDef,
    private pool: VarPool,
    config?: InteractionConfig,
  ) {
    this.completionData = config?.completionData
    this.signal = config?.signal
    this.loopContext = config?.loopContext
    this.crossExecResolver = config?.crossExecResolver
    this.executionId = config?.executionId
    this.nodeOutputs = config?.nodeOutputs
    this.cwd = config?.cwd
    this.sessionId = config?.sessionId
    this.currentRound = config?.currentRound
  }

  async execute(): Promise<NodeExecutionResult> {
    const start = Date.now()

    if (this.signal?.aborted) {
      return {
        outputs: {},
        status: "cancelled",
        durationMs: 0,
        logLines: ["Interaction cancelled before execution"],
      }
    }

    // If completion data is provided, this is a resume — process and return completed
    if (this.completionData) {
      return this.processCompletion(start)
    }

    // Check interaction_exit_when expression — if true, complete immediately
    if (this.node.interaction_exit_when) {
      const shouldExit = evaluateExpression(
        this.node.interaction_exit_when,
        this.pool,
        this.nodeOutputs,
        undefined,
        this.loopContext,
      )
      if (shouldExit) {
        return {
          outputs: { last_output: "[interaction_exit_when evaluated to true]" },
          status: "completed",
          durationMs: Date.now() - start,
          logLines: ["interaction_exit_when evaluated to true — skipping interaction"],
        }
      }
    }

    // Check max_rounds — if reached, auto-complete
    const maxRounds = this.node.interaction_max_rounds ?? 20
    if (this.currentRound !== undefined && this.currentRound >= maxRounds) {
      return {
        outputs: { last_output: `[interaction completed after ${this.currentRound} rounds (max: ${maxRounds})]` },
        status: "completed",
        durationMs: Date.now() - start,
        logLines: [`interaction_max_rounds reached (${maxRounds}) — auto-completing`],
      }
    }

    // First call: resolve prompt and return pending_interaction
    const logLines = ["Interaction node waiting for chat session"]
    const timeout = this.node.interaction_timeout ?? undefined
    if (timeout) {
      logLines.push(`Interaction timeout: ${timeout}s`)
    }

    // Resolve the agent prompt with variable substitution
    const agentConfig = this.node.interaction_agent
    const rawPrompt = agentConfig?.prompt || ""

    // Pre-process: resolve $file:path references
    let promptWithFiles = rawPrompt.replace(/\$file:([^\s\n]+)/g, (_match, rawPath: string) => {
      const resolvedPath = substituteVars(rawPath, this.pool, this.nodeOutputs, this.crossExecResolver, this.executionId, this.loopContext)
      const fullPath = this.cwd ? resolve(this.cwd, resolvedPath) : resolvedPath
      try {
        if (existsSync(fullPath)) {
          return readFileSync(fullPath, "utf8").trimEnd()
        }
        return `[file not found: ${resolvedPath}]`
      } catch {
        return `[error reading: ${resolvedPath}]`
      }
    })

    const resolvedPrompt = substituteVarsFull(promptWithFiles, this.pool, this.nodeOutputs, this.crossExecResolver, this.executionId, this.loopContext)

    const interactionMetadata: InteractionMetadata = {
      sessionId: this.sessionId ?? "",
      nodeId: this.node.id,
      maxRounds,
      timeout,
      initialPrompt: resolvedPrompt || undefined,
    }

    logLines.push(`Interaction max_rounds: ${maxRounds}`)
    if (resolvedPrompt) {
      logLines.push(`Interaction prompt: ${resolvedPrompt.slice(0, 200)}`)
    }

    return {
      outputs: {},
      status: "pending_interaction",
      durationMs: Date.now() - start,
      logLines,
      timeout,
      interactionMetadata,
    }
  }

  private processCompletion(start: number): NodeExecutionResult {
    const { summary, vars_update } = this.completionData!
    const outputs: Record<string, any> = {
      last_output: summary,
      summary,
    }

    // Apply vars_update to VarPool
    if (vars_update) {
      this.pool.update(vars_update)
      outputs.vars_update = vars_update
    }

    // Apply outputs mapping (e.g. "$vars.clarify_summary": "$last_output")
    this.applyOutputsMapping(outputs)

    return {
      lastOutput: summary,
      outputs,
      status: "completed",
      durationMs: Date.now() - start,
      logLines: [
        `Interaction completed: ${summary.slice(0, 200)}`,
        vars_update ? `vars_update: ${JSON.stringify(vars_update).slice(0, 200)}` : "no vars_update",
      ],
      sessionId: this.sessionId,
    }
  }

  private applyOutputsMapping(outputs: Record<string, any>) {
    if (!this.node.outputs) return
    applyOutputsMapping(this.node.outputs, outputs, this.pool, outputs.last_output, undefined)
  }
}
