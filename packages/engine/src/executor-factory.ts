// packages/engine/src/executor-factory.ts
//
// Factory for creating type-specific executors from node definitions.
// Extracted from WorkflowEngine.createExecutor() to reduce engine.ts size.
//
import type { NodeDef, WorkflowHooks } from "@octopus/shared"
import { VarPool, resolveModelAlias } from "@octopus/shared"
import type { NodeExecutionResult } from "./executors/types"
import type { AgentEvent } from "./executors/agent-types"
import type { IAgentProvider } from "@octopus/providers"
import { BashExecutor } from "./executors/bash"
import { PythonExecutor } from "./executors/python"
import { ConditionExecutor } from "./executors/condition"
import { ApprovalExecutor } from "./executors/approval"
import { LoopExecutor } from "./executors/loop"
import { AgentExecutor } from "./executors/agent"
import { SwarmExecutor } from "./executors/swarm"
import { AgentNodeRunner } from "./executors/agent-runner"
import type { EngineCallbacks } from "./engine"
import type { JsonlLogger } from "./logger"
import type { CrossExecResolver } from "@octopus/shared"
import type { ICheckpointStore } from "./pipeline/checkpoint-types"
import type { PromptInjector } from "./prompt-injector"

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
}

export class ExecutorFactory {
  constructor(private ctx: ExecutorFactoryContext) {}

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
          hookExecutor: async (event: string, context: Record<string, unknown>) => {
            await this.ctx.executeHooks(event as keyof WorkflowHooks, context)
          },
          agentResolver: this.ctx.agentResolver,
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
      default:
        throw new Error(`Unknown node type: ${(node as any).type}`)
    }
  }
}
