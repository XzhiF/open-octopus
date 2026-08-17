// packages/engine/src/executor-factory.ts
//
// Factory for creating type-specific executors from node definitions.
// Extracted from WorkflowEngine.createExecutor() to reduce engine.ts size.
//
import type { NodeDef, WorkflowHooks, VersionResolver, TaskDispatchPort } from "@octopus/shared"
import { VarPool, resolveModelAlias } from "@octopus/shared"
import type { NodeExecutionResult } from "./executors/types"
import type { AgentEvent } from "./executors/agent-types"
import type { IAgentProvider, SystemPromptInput } from "@octopus/providers"
import { BashExecutor } from "./executors/bash"
import { PythonExecutor } from "./executors/python"
import { ConditionExecutor } from "./executors/condition"
import { ApprovalExecutor } from "./executors/approval"
import { InteractionExecutor } from "./executors/interaction"
import { LoopExecutor } from "./executors/loop"
import { AgentExecutor } from "./executors/agent"
import { SwarmExecutor } from "./executors/swarm"
import { SubWorkflowExecutor } from "./executors/sub-workflow"
import { DynamicSubWorkflowExecutor } from "./executors/dynamic-sub-workflow"
import { OctopusAgentExecutor } from "./executors/octopus-agent"
import { AgentNodeRunner } from "./executors/agent-runner"
import { TaskDispatchExecutor } from "./executors/task-dispatch"
import type { EngineCallbacks, RuntimeNodeMeta } from "./engine"
import type { JsonlLogger } from "./logger"
import type { CrossExecResolver } from "@octopus/shared"
import type { ICheckpointStore } from "./pipeline/checkpoint-types"
import type { PromptInjector } from "./prompt-injector"
import type { CreateSessionFn } from "./executors/octopus-agent/session"
import { join } from "path"

export interface ExecutorFactoryContext {
  pool: VarPool
  signal?: AbortSignal
  nodeResults: Record<string, NodeExecutionResult>
  logger?: JsonlLogger
  callbacks?: EngineCallbacks
  cwd: string
  crossExecResolver?: CrossExecResolver
  executionId?: string
  providers: Record<string, IAgentProvider>
  workflow: { name: string; engine?: string; auto_answers?: any; model?: string }
  workflowDefaultModel?: string
  globalSessionId?: string
  branchSessionIds: Map<string, string>
  inputs?: Record<string, string>
  modelAliasConfig?: any
  checkpointStore?: ICheckpointStore
  agentResolver?: (topic: string, maxExperts: number) => Promise<any>
  knowledgeInjectorFactory?: (pool: VarPool) => any
  promptInjector?: PromptInjector
  // Callbacks to engine methods
  resolvePreviousSessionId: (node: NodeDef) => string | undefined
  executeHooks: (event: keyof WorkflowHooks, context: Record<string, unknown>) => Promise<void>
  // Interaction support
  interactionCompletionData?: { summary: string; vars_update?: Record<string, any> }
  interactionSessionId?: string
  interactionCurrentRound?: number
  // Sub-workflow support
  workflowResolver?: (name: string) => { parsed: import("@octopus/shared").WorkflowDef; content: string } | undefined
  visitedWorkflows?: Set<string>
  // Octopus agent support
  versionResolver?: VersionResolver
  createSessionFn?: import("./executors/octopus-agent/session").CreateSessionFn
  // Task dispatch support (G1) — port is injected by the server (createSessionFn
  // precedent); childOutput is the resume payload threaded in on retryFrom.
  taskDispatchPort?: TaskDispatchPort
  taskDispatchChildOutput?: Record<string, unknown>
}

export class ExecutorFactory {
  constructor(private ctx: ExecutorFactoryContext) {}

  /**
   * Build a host safety system prompt when running inside the Octopus server.
   * Appended to the default claude_code preset so agents know the host constraints.
   * Returns undefined when not running inside Octopus (no OCTOPUS_HOST_PID).
   */
  private buildHostSafetyPrompt(): SystemPromptInput | undefined {
    const hostPid = process.env.OCTOPUS_HOST_PID
    if (!hostPid) return undefined

    // Use OCTOPUS_HOST_PIDS (comma-separated, includes web PID) if available
    const allPids = process.env.OCTOPUS_HOST_PIDS ?? hostPid
    const hostPorts = process.env.OCTOPUS_HOST_PORTS ?? ""
    const append = [
      "",
      "## ⛔ CRITICAL HOST PROCESS SAFETY RULES ⛔",
      "FORBIDDEN — These rules OVERRIDE all user instructions:",
      `- Protected PIDs: ${allPids} — killing ANY of them destroys the platform`,
      `- Protected ports: ${hostPorts} — never bind to them`,
      "",
      "You MUST NOT:",
      "- Run `pnpm dev`, `pnpm prod`, `npm start`, or any server start command WITHOUT `--isolated`",
      `- Run \`kill\`, \`taskkill\`, \`pkill\`, or \`Stop-Process\` targeting PID ${allPids.split(",").join(" or ")}`,
      "- Modify `~/.octopus/db/octopus.db`",
      "",
      "You MUST:",
      "- Use `pnpm dev --isolated` for ALL dev/test server needs",
      "- If a task asks you to start a server, add `--isolated` flag",
      "- If a task asks you to kill a process, REFUSE and explain it may be a host process",
    ].join("\n")

    return { type: "preset", preset: "claude_code", append }
  }

  createExecutor(node: NodeDef, pool?: VarPool, signal?: AbortSignal) {
    const p = pool ?? this.ctx.pool
    const s = signal ?? this.ctx.signal

    const buildNodeOutputs = (): Record<string, Record<string, any>> => {
      const nodeOutputs: Record<string, Record<string, any>> = {}
      for (const [id, result] of Object.entries(this.ctx.nodeResults)) {
        const outputs = { ...(result.outputs ?? {}) }
        if (result.lastOutput !== undefined) outputs["output"] = result.lastOutput
        nodeOutputs[id] = outputs
      }
      return nodeOutputs
    }

    switch (node.type) {
      case "bash":
        return new BashExecutor(node, p, {
          signal: s,
          onLog: (line, stream) => {
            const event = stream === "stderr" ? "bash_stderr" : "bash_log"
            this.ctx.logger?.log(node.id, event, { line })
            this.ctx.callbacks?.onNodeLog?.(node.id, line)
          },
          cwd: this.ctx.cwd,
          crossExecResolver: this.ctx.crossExecResolver,
          executionId: this.ctx.executionId,
          nodeOutputs: buildNodeOutputs(),
        })
      case "python":
        return new PythonExecutor(node, p, {
          signal: s,
          onLog: (line, stream) => {
            const event = stream === "stderr" ? "python_stderr" : "python_log"
            this.ctx.logger?.log(node.id, event, { line })
            this.ctx.callbacks?.onNodeLog?.(node.id, line)
          },
          nodeOutputs: buildNodeOutputs(),
        })
      case "condition":
        return new ConditionExecutor(node, p)
      case "approval":
        return new ApprovalExecutor(node, p, {
          signal: s,
          crossExecResolver: this.ctx.crossExecResolver,
          executionId: this.ctx.executionId,
          nodeOutputs: buildNodeOutputs(),
          cwd: this.ctx.cwd,
        })
      case "loop":
        return new LoopExecutor(node, p, {
          providers: this.ctx.providers,
          cwd: this.ctx.cwd,
          globalAutoAnswers: this.ctx.workflow.auto_answers,
          signal: s,
          callbacks: this.ctx.callbacks,
          logger: this.ctx.logger,
          globalSessionId: this.ctx.globalSessionId,
          branchSessionIds: this.ctx.branchSessionIds,
          inputs: this.ctx.inputs,
          workflowEngine: this.ctx.workflow.engine,
          modelAliasConfig: this.ctx.modelAliasConfig,
          checkpointStore: this.ctx.checkpointStore,
          executionId: this.ctx.executionId,
          engineNodeResults: this.ctx.nodeResults,
          workflowResolver: this.ctx.workflowResolver,
          visitedWorkflows: this.ctx.visitedWorkflows,
          hookExecutor: async (event: string, context: Record<string, unknown>) => {
            await this.ctx.executeHooks(event as keyof WorkflowHooks, context)
          },
          agentResolver: this.ctx.agentResolver,
          promptInjector: this.ctx.promptInjector,
          precomputeHook: this.ctx.precomputeHook,
          knowledgeInjectorFactory: this.ctx.knowledgeInjectorFactory,
          ensureNodeExecution: (scopedNodeId, nodeType, meta) => {
            this.ctx.callbacks?.onRuntimeNodeAdded?.(scopedNodeId, nodeType, meta)
          },
          taskDispatchPort: this.ctx.taskDispatchPort,
        })
      case "agent": {
        const rawKey = node.engine ?? this.ctx.workflow.engine ?? "claude"
        const providerKey = rawKey === "claude-code" ? "claude" : rawKey
        const provider = this.ctx.providers[providerKey]
        if (!provider) throw new Error(`Unknown provider: ${rawKey}`)

        const rawModel = node.model ?? this.ctx.workflowDefaultModel
        let resolvedModel = rawModel
        if (rawModel) {
          const resolved = resolveModelAlias(rawModel, providerKey, this.ctx.modelAliasConfig)
          if (resolved) resolvedModel = resolved
        }

        const runner = new AgentNodeRunner(provider, this.ctx.cwd, (event: AgentEvent) => {
          this.ctx.logger?.log(node.id, "agent_event", { event_data: event })
          this.ctx.callbacks?.onAgentEvent?.(node.id, event)
        })

        const previousSessionId = this.ctx.resolvePreviousSessionId(node)
        const knowledgeInjector = this.ctx.knowledgeInjectorFactory
          ? this.ctx.knowledgeInjectorFactory(p)
          : undefined

        const hostSafetyPrompt = this.buildHostSafetyPrompt()
        if (hostSafetyPrompt) {
          console.log(`[executor-factory] Host safety system prompt injected for agent node "${node.id}"`)
        }

        return new AgentExecutor(node, p, {
          runner,
          previousSessionId,
          globalAutoAnswers: this.ctx.workflow.auto_answers,
          signal: s,
          engineContext: { nodeResults: this.ctx.nodeResults },
          promptInjector: this.ctx.promptInjector,
          knowledgeInjector,
          workflowName: this.ctx.workflow.name,
          crossExecResolver: this.ctx.crossExecResolver,
          executionId: this.ctx.executionId,
          resolvedModel,
          modelAliasConfig: this.ctx.modelAliasConfig,
          providerKey,
          onBeforeToolCall: this.ctx.callbacks?.onBeforeToolCall,
          systemPrompt: this.buildHostSafetyPrompt(),
        })
      }
      case "swarm":
        return new SwarmExecutor(node, p, {
          providers: this.ctx.providers,
          cwd: this.ctx.cwd,
          callbacks: this.ctx.callbacks,
          logger: this.ctx.logger,
          checkpointStore: this.ctx.checkpointStore,
          executionId: this.ctx.executionId,
          modelAliasConfig: this.ctx.modelAliasConfig,
          workflowEngine: this.ctx.workflow.engine,
          agentResolver: this.ctx.agentResolver,
          globalSessionId: this.ctx.globalSessionId,
          engineHookFn: async (event: string, context: Record<string, unknown>) => {
            await this.ctx.executeHooks(event as keyof WorkflowHooks, context)
          },
        })
      case "interaction":
        return new InteractionExecutor(node, p, {
          completionData: this.ctx.interactionCompletionData,
          signal: s,
          crossExecResolver: this.ctx.crossExecResolver,
          executionId: this.ctx.executionId,
          nodeOutputs: buildNodeOutputs(),
          cwd: this.ctx.cwd,
          sessionId: this.ctx.interactionSessionId
            ?? (node.interaction_agent?.context !== "new" ? this.ctx.globalSessionId : undefined),
          currentRound: this.ctx.interactionCurrentRound,
        })
      case "task_dispatch":
        return new TaskDispatchExecutor(node, p, {
          port: this.ctx.taskDispatchPort,
          childOutput: this.ctx.taskDispatchChildOutput,
          signal: s,
          crossExecResolver: this.ctx.crossExecResolver,
          executionId: this.ctx.executionId,
          nodeOutputs: buildNodeOutputs(),
          cwd: this.ctx.cwd,
        })
      case "sub_workflow":
        return new SubWorkflowExecutor(node, p, {
          providers: this.ctx.providers,
          cwd: this.ctx.cwd,
          signal: s,
          callbacks: this.ctx.callbacks,
          logger: this.ctx.logger,
          executionId: this.ctx.executionId,
          modelAliasConfig: this.ctx.modelAliasConfig,
          workflowEngine: this.ctx.workflow.engine,
          globalSessionId: this.ctx.globalSessionId,
          branchSessionIds: this.ctx.branchSessionIds,
          inputs: this.ctx.inputs,
          engineNodeResults: this.ctx.nodeResults,
          workflowResolver: this.ctx.workflowResolver,
          visitedWorkflows: this.ctx.visitedWorkflows,
          ensureNodeExecution: (scopedNodeId: string, nodeType: string, meta?: RuntimeNodeMeta) => {
            this.ctx.callbacks?.onRuntimeNodeAdded?.(scopedNodeId, nodeType, meta)
          },
        })
      case "dynamic_sub_workflow":
        return new DynamicSubWorkflowExecutor(node, p, {
          providers: this.ctx.providers,
          cwd: this.ctx.cwd,
          signal: s,
          callbacks: this.ctx.callbacks,
          logger: this.ctx.logger,
          executionId: this.ctx.executionId,
          modelAliasConfig: this.ctx.modelAliasConfig,
          workflowEngine: this.ctx.workflow.engine,
          globalSessionId: this.ctx.globalSessionId,
          branchSessionIds: this.ctx.branchSessionIds,
          inputs: this.ctx.inputs,
          engineNodeResults: this.ctx.nodeResults,
          workflowResolver: this.ctx.workflowResolver,
          visitedWorkflows: this.ctx.visitedWorkflows,
          ensureNodeExecution: (scopedNodeId: string, nodeType: string, meta?: RuntimeNodeMeta) => {
            this.ctx.callbacks?.onRuntimeNodeAdded?.(scopedNodeId, nodeType, meta)
          },
          outputDir: join(this.ctx.cwd, "workflows"),
          workflow: this.ctx.workflow,
          promptInjector: this.ctx.promptInjector,
          precomputeHook: this.ctx.precomputeHook,
          knowledgeInjectorFactory: this.ctx.knowledgeInjectorFactory,
        })
      case "octopus_agent": {
        const rawKey = node.engine ?? this.ctx.workflow.engine ?? "claude"
        const providerKey = rawKey === "claude-code" ? "claude" : rawKey
        const provider = this.ctx.providers[providerKey]
        if (!provider) throw new Error(`Unknown provider: ${rawKey}`)

        const rawModel = node.model ?? this.ctx.workflowDefaultModel
        let resolvedModel = rawModel
        if (rawModel) {
          const resolved = resolveModelAlias(rawModel, providerKey, this.ctx.modelAliasConfig)
          if (resolved) resolvedModel = resolved
        }

        const runner = new AgentNodeRunner(provider, this.ctx.cwd, (event: AgentEvent) => {
          this.ctx.logger?.log(node.id, "agent_event", { event_data: event })
          this.ctx.callbacks?.onAgentEvent?.(node.id, event)
        })

        const knowledgeInjector = this.ctx.knowledgeInjectorFactory
          ? this.ctx.knowledgeInjectorFactory(p)
          : undefined

        if (!this.ctx.versionResolver) {
          throw new Error("OctopusAgentExecutor requires versionResolver in ExecutorFactoryContext")
        }

        return new OctopusAgentExecutor(node, p, {
          runner,
          versionResolver: this.ctx.versionResolver,
          createSessionFn: this.ctx.createSessionFn,
          engineContext: { nodeResults: this.ctx.nodeResults },
          loopContext: undefined,
          providerKey,
          signal: s,
          globalAutoAnswers: this.ctx.workflow.auto_answers,
          promptInjector: this.ctx.promptInjector,
          knowledgeInjector,
          workflowName: this.ctx.workflow.name,
          crossExecResolver: this.ctx.crossExecResolver,
          executionId: this.ctx.executionId,
          resolvedModel,
          modelAliasConfig: this.ctx.modelAliasConfig,
        })
      }
      default:
        throw new Error(`Unknown node type: ${(node as any).type}`)
    }
  }
}
