// packages/server/src/services/execution/EngineFactory.ts
import type { IEngineFactory } from "./interfaces"
import type { ServiceContext, ExecutionRow } from "./types"
import type { ExecutionDAO } from "../../db/dao/execution-dao"
import type { KnowledgeService } from "../knowledge"
import { WorkflowEngine } from "@octopus/engine"
import { PromptInjector } from "@octopus/engine"
import { CrossExecResolver } from "@octopus/shared"
import { PipelineConfigLoader } from "../pipeline-config"
import { getProviderAsync } from "@octopus/providers"

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

  async createEngine(execution: ExecutionRow, workflow: any): Promise<WorkflowEngine> {
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

    const providers: Record<string, any> = {}
    const engineType = workflow.engine || "claude"
    const provider = await getProviderAsync(engineType)
    if (provider) {
      providers[engineType] = provider
    }

    const inputValues = execution.input_values
      ? JSON.parse(execution.input_values)
      : undefined

    return new WorkflowEngine(
      workflow, providers, this.ctx.workspacePath,
      this.ctx.org ? `${this.ctx.workspacePath}/.octopus` : undefined,
      undefined, undefined, execution.id, inputValues,
      execution.name || undefined, crossExecResolver, promptInjector,
      this.knowledgeService?.createPrecomputeHook(),
      this.knowledgeService?.createInjectorFactory(),
    )
  }

  async reconstructEngine(execution: ExecutionRow): Promise<WorkflowEngine> {
    const poolSnapshot = execution.var_pool ? JSON.parse(execution.var_pool) : {}
    const workflow = this.ctx.workflowService.getWorkflow(execution.workflow_ref)
    if (!workflow) {
      throw new Error(`Workflow ${execution.workflow_ref} not found`)
    }

    const engine = await this.createEngine(execution, workflow)
    engine.updateVarPool(poolSnapshot)
    return engine
  }
}
