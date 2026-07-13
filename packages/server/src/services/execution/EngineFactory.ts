// packages/server/src/services/execution/EngineFactory.ts
import type { IEngineFactory } from "./interfaces"
import type { ServiceContext, ExecutionRow } from "./types"
import type { ExecutionDAO } from "../../db/dao/execution-dao"
import type { KnowledgeService } from "../knowledge"
import { WorkflowEngine } from "@octopus/engine"
import { PromptInjector } from "@octopus/engine"
import { CrossExecResolver } from "@octopus/shared"
import { PipelineConfigLoader } from "../pipeline-config"
import { getProvider } from "@octopus/providers"
import { collectNodeEngines } from "@octopus/shared"
import { getOrchestratorService } from "../agent/orchestrator-service"

export class EngineFactory implements IEngineFactory {
  private knowledgeService?: KnowledgeService

  constructor(
    private ctx: ServiceContext,
    private dao: ExecutionDAO,
    private pipelineConfigLoader: PipelineConfigLoader,
  ) {}

  /**
   * Set the knowledge service for injection pipeline.
   */
  setKnowledgeService(service: KnowledgeService): void {
    this.knowledgeService = service
  }

  createEngine(execution: ExecutionRow, workflow: any): WorkflowEngine {
    const pipelineConfig = this.pipelineConfigLoader.getConfig()

    const promptInjector = pipelineConfig?.prompts
      ? new PromptInjector(pipelineConfig.prompts)
      : undefined

    const lookup = {
      getById: (eid: string) => {
        const row = this.dao.findExecutionForLookup(eid)
        return row ? { parent_id: row.parent_id ?? undefined, var_pool: row.var_pool ?? undefined, input_values: row.input_values ?? undefined } : null
      },
      getNodeOutputs: (executionId: string, nodeId: string) => this.dao.findNodeOutputs(executionId, nodeId),
    }
    const crossExecResolver = new CrossExecResolver(lookup)

    // F-1: Collect all engines used by workflow nodes (including swarm experts)
    // and pre-register all required providers
    const providers: Record<string, any> = {}
    const nodes = workflow.nodes ?? []
    const engineKeys = collectNodeEngines(nodes)
    // Include workflow-level engine (nodes inherit it when node.engine is unset)
    if (workflow.engine && !engineKeys.includes(workflow.engine)) {
      engineKeys.push(workflow.engine)
    }
    for (const key of engineKeys) {
      try {
        const provider = getProvider(key)
        providers[key] = provider
      } catch (err) {
        console.warn(`[EngineFactory] Provider '${key}' not registered, skipping: ${err instanceof Error ? err.message : err}`)
      }
    }

    const inputValues = execution.input_values
      ? JSON.parse(execution.input_values)
      : undefined

    const orchestrator = this.ctx.org ? getOrchestratorService(this.ctx.org) : undefined
    const agentResolver = orchestrator
      ? (topic: string, maxExperts: number) =>
          orchestrator.selectAndInstallAgents(topic, maxExperts, this.ctx.workspacePath)
      : undefined

    return new WorkflowEngine(
      workflow, providers, this.ctx.workspacePath,
      this.ctx.org ? `${this.ctx.workspacePath}/.octopus` : undefined,
      undefined, undefined, execution.id, inputValues,
      execution.name || undefined, crossExecResolver, promptInjector,
      this.knowledgeService?.createPrecomputeHook(),
      this.knowledgeService?.createInjectorFactory(),
      agentResolver,
    )
  }

  reconstructEngine(execution: ExecutionRow): WorkflowEngine {
    const poolSnapshot = execution.var_pool ? JSON.parse(execution.var_pool) : {}
    const workflow = this.ctx.workflowService.getWorkflow(execution.workflow_ref)
    if (!workflow) {
      throw new Error(`Workflow ${execution.workflow_ref} not found`)
    }

    const engine = this.createEngine(execution, workflow)
    engine.updateVarPool(poolSnapshot)
    return engine
  }
}
