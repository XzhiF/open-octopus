// packages/server/src/services/execution/EngineFactory.ts
import type { IEngineFactory } from "./interfaces"
import type { ServiceContext, ExecutionRow } from "./types"
import type { ExecutionDAO } from "../../db/dao/execution-dao"
import { AgentVersionDAO } from "../../db/dao/agent-version-dao"
import type { KnowledgeService } from "../knowledge"
import type { EngineCallbacks } from "@octopus/engine"
import { WorkflowEngine, PromptInjector } from "@octopus/engine"
import { CrossExecResolver, collectNodeEngines, parseWorkflow, WorkflowRef, VersionResolver } from "@octopus/shared"
import type { WorkflowDef, AgentVersionInfo } from "@octopus/shared"
import { PipelineConfigLoader } from "../pipeline-config"
import { getProvider } from "@octopus/providers"
import { selectAndInstallAgents } from "../resource-agent-service"
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

    const agentResolver = this.ctx.org
      ? (topic: string, maxExperts: number) =>
          selectAndInstallAgents(topic, maxExperts, this.ctx.workspacePath)
      : undefined

    const engine = new WorkflowEngine(
      workflow, providers, this.ctx.workspacePath,
      this.ctx.workspacePath,
      callbacks, signal,
      execution.id, inputValues,
      execution.name || undefined, crossExecResolver, promptInjector,
      this.knowledgeService?.createPrecomputeHook(),
      this.knowledgeService?.createInjectorFactory(),
      agentResolver,
    )

    // Set workflow resolver for sub_workflow nodes
    // Resolution order: exact ref → append .yaml/.yml → match by workflow name
    const workflowResolver = (name: string): { parsed: WorkflowDef; content: string } | undefined => {
      // 1. Try exact ref (e.g. "child-basic.yaml" or "group/name")
      const local = this.ctx.workflowService.get(this.workspacePath, name)
      if (local) return { parsed: local.parsed, content: local.content }

      // 2. Try appending .yaml / .yml (e.g. "child-basic" → "child-basic.yaml")
      if (!name.endsWith(".yaml") && !name.endsWith(".yml")) {
        for (const ext of [".yaml", ".yml"]) {
          const withExt = this.ctx.workflowService.get(this.workspacePath, name + ext)
          if (withExt) return { parsed: withExt.parsed, content: withExt.content }
        }
      }

      // 3. Search by workflow name (scan all workflows in workspace)
      const allWorkflows = this.ctx.workflowService.list(this.workspacePath)
      for (const wf of allWorkflows) {
        if (wf.name === name) {
          const found = this.ctx.workflowService.get(this.workspacePath, wf.ref)
          if (found) return { parsed: found.parsed, content: found.content }
        }
      }

      // 4. Fall back to built-in workflows
      const builtIn = this.ctx.builtInWorkflowService.get(name)
      if (builtIn) return { parsed: builtIn.parsed, content: builtIn.content }
      return undefined
    }
    engine.setWorkflowResolver(workflowResolver)

    // Set version resolver for octopus_agent nodes
    try {
      const versionDao = new AgentVersionDAO(this.ctx.db)
      const rows = versionDao.listAllPublished()
      const versions: AgentVersionInfo[] = rows.map((r) => ({
        id: r.id,
        agent_name: r.agent_name,
        version: r.version,
        stage: r.stage as AgentVersionInfo["stage"],
        status: r.status as AgentVersionInfo["status"],
        snapshot: r.snapshot,
        changelog: r.changelog ?? undefined,
        published_at: r.published_at ?? undefined,
        created_at: r.created_at,
      }))
      engine.setVersionResolver(new VersionResolver(versions))
      console.log(`[EngineFactory] VersionResolver set: ${versions.length} published versions`)
    } catch (err) {
      // agent_versions table may not exist yet (pre-migration) — create empty resolver as fallback
      console.warn(`[EngineFactory] VersionResolver fallback (empty): ${err instanceof Error ? err.message : err}`)
      engine.setVersionResolver(new VersionResolver([]))
    }

    return engine
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
