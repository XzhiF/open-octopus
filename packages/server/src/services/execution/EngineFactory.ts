// packages/server/src/services/execution/EngineFactory.ts
import type { IEngineFactory } from "./interfaces"
import type { ServiceContext, ExecutionRow } from "./types"
import type { ExecutionDAO } from "../../db/dao/execution-dao"
import type { KnowledgeService } from "../knowledge"
import type { EngineCallbacks } from "@octopus/engine"
import { WorkflowEngine, PromptInjector } from "@octopus/engine"
import { CrossExecResolver, collectNodeEngines, parseWorkflow, WorkflowRef } from "@octopus/shared"
import { PipelineConfigLoader } from "../pipeline-config"
import { getProvider } from "@octopus/providers"
import { getOrchestratorService } from "../agent/orchestrator-service"
import { existsSync, readFileSync } from "fs"
import { join } from "path"

export class EngineFactory implements IEngineFactory {
  private knowledgeService?: KnowledgeService

  constructor(
    private ctx: ServiceContext,
    private dao: ExecutionDAO,
    private pipelineConfigLoader: PipelineConfigLoader,
    private workspacePath: string,
  ) {}

  /**
   * Set the knowledge service for injection pipeline.
   */
  setKnowledgeService(service: KnowledgeService): void {
    this.knowledgeService = service
  }

  /**
   * Resolve workflow with snapshot priority.
   * Tries disk snapshot first (written at start()), falls back to workflow service.
   */
  resolveWorkflowWithSnapshot(executionId: string, workflowRef: string): { parsed: any; content: string } | undefined {
    // Try snapshot first
    const snapshotPath = join(this.workspacePath, "state", `${executionId}-${WorkflowRef.sanitize(workflowRef)}`)
    if (existsSync(snapshotPath)) {
      const content = readFileSync(snapshotPath, "utf-8")
      try {
        const parsed = parseWorkflow(content)
        return { parsed, content }
      } catch (e: any) {
        console.error(`[EngineFactory] snapshot parse failed: ${e.message}`)
      }
    }
    // Fallback to workflow service
    const local = this.ctx.workflowService.get(this.workspacePath, workflowRef)
    if (local) return { parsed: local.parsed, content: local.content }
    const builtIn = this.ctx.builtInWorkflowService.get(workflowRef)
    if (builtIn) return { parsed: builtIn.parsed, content: builtIn.content }
    return undefined
  }

  /**
   * Create a new WorkflowEngine for an execution.
   * @param callbacks - optional EngineCallbacks (if not provided, engine is created without callbacks)
   * @param signal - optional AbortSignal
   */
  createEngine(execution: ExecutionRow, workflow: any, callbacks?: EngineCallbacks, signal?: AbortSignal): WorkflowEngine {
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

    // Resolve providers from workflow node engines
    const providers = this.resolveProviders(workflow)

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
      this.ctx.workspacePath,
      callbacks, signal,
      execution.id, inputValues,
      execution.name || undefined, crossExecResolver, promptInjector,
      this.knowledgeService?.createPrecomputeHook(),
      this.knowledgeService?.createInjectorFactory(),
      agentResolver,
    )
  }

  /**
   * Reconstruct an engine from persisted state (snapshot + var_pool).
   * Does NOT restore node results or session context — caller must do that.
   */
  reconstructEngine(execution: ExecutionRow, callbacks: EngineCallbacks, signal: AbortSignal): WorkflowEngine {
    const wf = this.resolveWorkflowWithSnapshot(execution.id, execution.workflow_ref)
    if (!wf) throw new Error(`Workflow not found: ${execution.workflow_ref}`)

    const engine = this.createEngine(execution, wf.parsed, callbacks, signal)

    const poolSnapshot = execution.var_pool ? JSON.parse(execution.var_pool) : {}
    engine.updateVarPool(poolSnapshot)

    return engine
  }

  /**
   * Resolve providers for a workflow by scanning all node engines.
   * Falls back to { "claude": getProvider("claude") } if no engines found.
   */
  resolveProviders(workflow: any): Record<string, any> {
    const providers: Record<string, any> = {}
    const engineKeys = collectNodeEngines(workflow.nodes ?? [])
    // Include workflow-level engine (nodes inherit it when node.engine is unset)
    if (workflow.engine && !engineKeys.includes(workflow.engine)) {
      engineKeys.push(workflow.engine)
    }
    for (const key of engineKeys) {
      try {
        providers[key] = getProvider(key)
      } catch {
        // Provider not registered — skip silently
      }
    }
    if (Object.keys(providers).length === 0) {
      try { providers["claude"] = getProvider("claude") } catch { /* no providers at all */ }
    }
    return providers
  }
}
