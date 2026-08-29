// packages/engine/src/executors/octopus-agent.ts
//
// OctopusAgentExecutor — delegates tasks to versioned Octopus agents.
// Composition pattern: wraps AgentExecutor internally with added capabilities:
//   - Version resolution (via VersionResolver)
//   - Structured Task Contract prompt building
//   - Heartbeat event streaming
//   - Harness directive handling (abort/pause)
//   - Structured result parsing
//

import { VarPool, substituteVarsFull, applyOutputsMapping, VersionResolver } from "@octopus/shared"
import type { NodeDef, OctopusAgentNodeDef, ResolvedVersion } from "@octopus/shared"
import type { NodeExecutionResult, NodeExecutor } from "./types"
import type { OctopusAgentConfig } from "./executor-config"
import type { AgentConfig } from "./executor-config"
import { AgentExecutor } from "./agent"
import { buildTaskPrompt } from "./octopus-agent/task-prompt"
import { parseStructuredResult } from "./octopus-agent/parse-result"
import { HeartbeatHandler } from "./octopus-agent/heartbeat"
import { createDelegateSession, type CreateSessionFn, type DelegateSession } from "./octopus-agent/session"
import { applyVarsUpdate } from "./parse-vars-update"
import type { AgentEvent } from "./agent-types"
import { existsSync, readFileSync, readdirSync } from "fs"
import { join } from "path"
import { homedir } from "os"

/**
 * OctopusAgentExecutor — delegates tasks to versioned Octopus agents.
 *
 * Execution flow:
 * 1. Resolve agent version via VersionResolver
 * 2. Create delegate session
 * 3. Build Task Contract prompt from node.task
 * 4. Setup Heartbeat handler
 * 5. Delegate to internal AgentExecutor
 * 6. Parse structured result
 * 7. Return NodeExecutionResult with merged outputs
 */
export class OctopusAgentExecutor implements NodeExecutor {
  private readonly node: OctopusAgentNodeDef
  private readonly pool: VarPool
  private readonly config: OctopusAgentConfig

  constructor(
    node: NodeDef,
    pool: VarPool,
    config: OctopusAgentConfig,
  ) {
    this.node = node as OctopusAgentNodeDef
    this.pool = pool
    this.config = config
  }

  async execute(): Promise<NodeExecutionResult> {
    const start = Date.now()

    // 1. Resolve agent version
    let resolved: ResolvedVersion
    try {
      const versionSpec = this.node.version ?? "latest"
      resolved = this.config.versionResolver.resolve(
        this.node.agent,
        versionSpec,
        this.node.min_stage,
      )
    } catch (versionErr: unknown) {
      // Fallback: if no published versions exist, use current clone config from filesystem
      const fallback = this.resolveFallback(this.node.agent)
      if (fallback) {
        resolved = fallback
      } else {
        const errorMessage = versionErr instanceof Error ? versionErr.message : String(versionErr)
        return {
          status: "failed",
          lastOutput: undefined,
          outputs: {},
          durationMs: Date.now() - start,
          logLines: [`Version resolution failed: ${errorMessage}`],
          error: `Version resolution failed: ${errorMessage}`,
        }
      }
    }

    // 2. Create delegate session
    let session: DelegateSession
    try {
      const executionId = this.config.executionId ?? "unknown"
      if (this.config.createSessionFn) {
        session = await this.config.createSessionFn({
          session_type: "delegate",
          clone_name: this.node.agent,
          version: resolved.version,
          parent_execution_id: executionId,
        })
      } else {
        session = createDelegateSession(this.node.agent, resolved.version, executionId)
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      return {
        status: "failed",
        lastOutput: undefined,
        outputs: {},
        durationMs: Date.now() - start,
        logLines: [`Session creation failed: ${errorMessage}`],
        error: `Session creation failed: ${errorMessage}`,
      }
    }

    // 3. Build Task Contract prompt
    const nodeOutputs = this.buildNodeOutputs()
    const taskPrompt = buildTaskPrompt(
      this.node.task,
      this.pool,
      nodeOutputs as Record<string, Record<string, any>> | undefined,
      this.node.harness,
    )

    // 4. Setup Heartbeat handler
    let abortRequested = false
    const heartbeatHandler = new HeartbeatHandler(
      this.node.id,
      this.node.harness ?? {},
      this.node.task.budget,
      (event: AgentEvent) => {
        // Fix 5: Intercept harness_directive abort to stop execution
        if (
          event.type === "harness_directive" &&
          (event.data as { type?: string }).type === "abort" &&
          this.config.signal &&
          !this.config.signal.aborted
        ) {
          // AbortController not available on raw AbortSignal; use internal abort via a flag
          // The signal is read-only, so we set a local flag checked after agent execution
          abortRequested = true
        }

        // Fix 3: Enrich heartbeat events with agent_name and version for SSE
        if (event.type === "heartbeat") {
          this.config.runner.onEvent?.({
            type: "heartbeat",
            data: {
              ...event.data,
              agent_name: this.node.agent,
              version: resolved.version,
            },
          } as AgentEvent)
        } else {
          this.config.runner.onEvent?.(event)
        }
      },
    )

    // 5. Create internal AgentExecutor with resolved version
    const agentConfig: AgentConfig = {
      runner: this.config.runner,
      engineContext: this.config.engineContext,
      loopContext: this.config.loopContext,
      providerKey: this.config.providerKey,
      // Delegate session is newly created — don't use as previousSessionId
      // (Claude SDK requires previousSessionId to have existing conversation)
      previousSessionId: this.config.previousSessionId,
      signal: this.config.signal,
      globalAutoAnswers: this.config.globalAutoAnswers,
      promptInjector: this.config.promptInjector,
      knowledgeInjector: this.config.knowledgeInjector,
      workflowName: this.config.workflowName,
      crossExecResolver: this.config.crossExecResolver,
      executionId: this.config.executionId,
      resolvedModel: this.config.resolvedModel,
      modelAliasConfig: this.config.modelAliasConfig,
      // Fix 6: Inject persona.md content as system prompt when available
      systemPrompt: resolved.snapshot.persona || undefined,
    }

    // Create a modified node with the task prompt as the prompt field
    const agentNode: NodeDef = {
      ...this.node,
      type: "agent", // Temporarily treat as agent for AgentExecutor
      prompt: taskPrompt,
      agent: this.node.agent,
      skills: resolved.snapshot.skills,
    }

    const agentExecutor = new AgentExecutor(agentNode, this.pool, agentConfig)

    // 6. Execute via AgentExecutor
    let agentResult: NodeExecutionResult
    try {
      agentResult = await agentExecutor.execute()
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      return {
        status: "failed",
        lastOutput: undefined,
        outputs: {},
        durationMs: Date.now() - start,
        logLines: [`Agent execution failed: ${errorMessage}`],
        error: `Agent execution failed: ${errorMessage}`,
      }
    }

    // Fix 5: Process agent events through heartbeat handler post-execution.
    // This enables step counting, heartbeat emission, and budget directive detection.
    if (agentResult.events) {
      for (const event of agentResult.events) {
        heartbeatHandler.onAgentEvent(event)
      }
    }
    if (agentResult.usage) {
      heartbeatHandler.updateTokens(agentResult.usage)
    }

    // 7. Parse structured result from agent output
    const structured = parseStructuredResult(agentResult.lastOutput ?? "")

    // 8. Build final outputs (Fix 2: use unknown instead of any where possible)
    let outputs: Record<string, unknown> = {
      last_output: agentResult.lastOutput,
      session_id: session.id,
      agent_version: resolved.version,
      agent_name: this.node.agent,
      task_brief: this.node.task?.brief,
    }

    // Track final status without mutating agentResult (Fix 1: immutability)
    let finalStatus = agentResult.status

    // If structured result found, merge its outputs and vars_update
    if (structured) {
      // Merge structured output fields (Fix 1: spread instead of Object.assign)
      outputs = { ...outputs, ...structured.output }

      // Apply vars_update to pool and outputs
      if (structured.vars_update) {
        this.pool.update(structured.vars_update as Record<string, any>)
        outputs.vars_update = structured.vars_update
      }

      // Update status based on structured result status
      if (structured.status === "failed" || structured.status === "aborted" || structured.status === "budget_exceeded") {
        finalStatus = "failed"
      }
    } else {
      // Fallback: apply vars_update from raw text (existing AgentExecutor behavior)
      if (agentResult.lastOutput) {
        applyVarsUpdate(agentResult.lastOutput, this.pool, outputs as Record<string, any>)
      }
    }

    // Fix 5: Check if heartbeat handler requested abort (budget exceeded)
    if (abortRequested && finalStatus !== "failed") {
      finalStatus = "failed"
    }

    // 9. Apply outputs mapping (from node.outputs)
    if (this.node.outputs) {
      applyOutputsMapping(
        this.node.outputs,
        outputs as Record<string, any>,
        this.pool,
        agentResult.lastOutput,
        undefined,
      )
    }

    // 10. Return final result
    return {
      ...agentResult,
      status: finalStatus,
      outputs,
      sessionId: session.id,
      durationMs: Date.now() - start,
      logLines: [
        ...agentResult.logLines,
        `Delegate session: ${session.id}`,
        `Agent version: ${resolved.version} (${resolved.stage})`,
        structured ? `Structured result: ${structured.status}` : "No structured result found",
        ...(abortRequested ? ["Budget abort requested by harness"] : []),
      ],
    }
  }

  /**
   * Build nodeOutputs map from engineContext for $nodeId.output resolution.
   */
  private buildNodeOutputs(): Record<string, Record<string, unknown>> | undefined {
    if (!this.config.engineContext?.nodeResults) return undefined
    const nodeOutputs: Record<string, Record<string, unknown>> = {}
    for (const [id, result] of Object.entries(this.config.engineContext.nodeResults)) {
      const outputs = { ...(result.outputs ?? {}) }
      if (result.lastOutput !== undefined) outputs["output"] = result.lastOutput
      nodeOutputs[id] = outputs
    }
    return nodeOutputs
  }

  /**
   * Fallback version resolution: reads current clone config from filesystem
   * when no published versions exist. Uses ~/.octopus/agent/clones/{name}/ directory.
   */
  private resolveFallback(agentName: string): ResolvedVersion | null {
    try {
      const cloneDir = join(homedir(), ".octopus", "agent", "clones", agentName)
      if (!existsSync(cloneDir)) return null

      // Read persona.md
      const personaPath = join(cloneDir, "persona.md")
      const persona = existsSync(personaPath) ? readFileSync(personaPath, "utf-8") : ""

      // Read config.json
      const configPath = join(cloneDir, "config.json")
      let config: Record<string, unknown> = {}
      if (existsSync(configPath)) {
        try { config = JSON.parse(readFileSync(configPath, "utf-8")) } catch { /* empty */ }
      }

      // List skills
      const skillsDir = join(cloneDir, "skills")
      let skills: string[] = []
      if (existsSync(skillsDir)) {
        skills = readdirSync(skillsDir).filter((f) => !f.startsWith("."))
      }

      return {
        version: "current",
        stage: "stable",
        snapshot: { persona, config, skills },
        fsPath: cloneDir,
      }
    } catch {
      return null
    }
  }
}

