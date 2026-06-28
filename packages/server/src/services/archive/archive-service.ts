import { randomUUID } from "crypto"
import type { ArchiveDAO } from "../../db/dao/archive-dao"
import type { ExecutionDAO } from "../../db/dao/execution-dao"
import type { TokenUsageDAO } from "../../db/dao/token-usage-dao"
import type { WorkspaceDAO } from "../../db/dao/workspace-dao"
import type { ExperienceDAO } from "../../db/dao/experience-dao"
import type { ExecutionArchiveRow, WorkspaceArchiveRow } from "../../db/types"
import { LayerFilter, REFLECTION_THRESHOLD } from "./layer-filter"
import { LLMReflection } from "./llm-reflection"
import { KnowledgeFiles } from "./knowledge-files"

export class ArchiveService {
  private layerFilter: LayerFilter
  private llmReflection: LLMReflection
  private knowledgeFiles: KnowledgeFiles

  constructor(
    private archiveDAO: ArchiveDAO,
    private executionDAO: ExecutionDAO,
    private tokenUsageDAO: TokenUsageDAO,
    private workspaceDAO: WorkspaceDAO,
    private experienceDAO?: ExperienceDAO,
    anthropicClient?: any,
  ) {
    this.layerFilter = new LayerFilter(executionDAO, tokenUsageDAO, archiveDAO)
    this.llmReflection = new LLMReflection(anthropicClient)
    this.knowledgeFiles = new KnowledgeFiles(experienceDAO!)
  }

  archiveExecution(executionId: string, workspaceArchiveId?: string): string {
    const exec = this.executionDAO.findById(executionId)
    if (!exec) throw new Error(`Execution not found: ${executionId}`)

    const nodeExecs = this.executionDAO.findNodeExecutions(executionId)
    const tokenUsages = this.tokenUsageDAO.findByExecution(executionId)

    const nodeSummary = nodeExecs.map(ne => ({
      nodeId: ne.node_id,
      type: ne.node_type,
      status: ne.status,
      duration_ms: ne.duration,
    }))

    const failedNodes = nodeExecs
      .filter(ne => ne.status === "failed")
      .map(ne => ne.node_id)

    let errorMessage: string | null = null
    if (exec.status === "failed") {
      const firstFailed = nodeExecs.find(ne => ne.status === "failed")
      errorMessage = firstFailed?.error ?? "Execution failed"
    }

    const modelBreakdown: Record<string, { input_tokens: number; output_tokens: number; cost_usd: number }> = {}
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let totalCostUsd = 0

    for (const tu of tokenUsages) {
      const model = tu.model
      if (!modelBreakdown[model]) {
        modelBreakdown[model] = { input_tokens: 0, output_tokens: 0, cost_usd: 0 }
      }
      modelBreakdown[model].input_tokens += tu.input_tokens
      modelBreakdown[model].output_tokens += tu.output_tokens
      modelBreakdown[model].cost_usd += tu.cost_usd ?? 0
      totalInputTokens += tu.input_tokens
      totalOutputTokens += tu.output_tokens
      totalCostUsd += tu.cost_usd ?? 0
    }

    let varSnapshot: string = "{}"
    try {
      varSnapshot = exec.var_pool ?? "{}"
    } catch {
      varSnapshot = "{}"
    }

    const archiveId = randomUUID()
    const row: Omit<ExecutionArchiveRow, "created_at"> = {
      id: archiveId,
      org: exec.org,
      workflow_ref: exec.workflow_ref,
      workflow_name: exec.workflow_name,
      status: exec.status,
      started_at: exec.started_at ?? new Date().toISOString(),
      completed_at: exec.completed_at,
      duration_ms: exec.duration,
      node_summary: JSON.stringify(nodeSummary),
      failed_nodes: failedNodes.length > 0 ? JSON.stringify(failedNodes) : null,
      error_message: errorMessage,
      total_input_tokens: totalInputTokens,
      total_output_tokens: totalOutputTokens,
      total_cost_usd: totalCostUsd,
      model_breakdown: Object.keys(modelBreakdown).length > 0 ? JSON.stringify(modelBreakdown) : null,
      vars_snapshot: varSnapshot,
      lessons_learned: null,
      workspace_archive_id: workspaceArchiveId ?? null,
      workspace_id: exec.workspace_id,
      chain_position: exec.child_index,
      parent_execution_id: exec.parent_id !== "0" ? exec.parent_id : null,
      schedule_id: null,
      clone_name: null,
    }

    this.archiveDAO.insertExecutionArchive(row)

    // P2.6: Trigger extractLessons asynchronously (fire-and-forget)
    if (this.experienceDAO) {
      setImmediate(() => {
        this.extractLessons(archiveId).catch(err => {
          console.warn(`[ArchiveService] extractLessons failed for ${archiveId}:`, err)
        })
      })
    }

    return archiveId
  }

  async extractLessons(archiveId: string): Promise<void> {
    const archive = this.archiveDAO.findExecutionArchiveById(archiveId)
    if (!archive) return

    const potential = this.layerFilter.computeExperiencePotential(archiveId)
    if (potential.score < REFLECTION_THRESHOLD) {
      return
    }

    const result = await this.llmReflection.reflect(archive, potential)
    if (!result.lessons && result.items.length === 0) {
      return
    }

    if (result.lessons) {
      this.archiveDAO.insertExecutionArchive({
        ...archive,
        lessons_learned: result.lessons,
      })
    }

    if (result.items.length > 0 && this.experienceDAO) {
      for (const item of result.items) {
        const itemId = randomUUID()
        this.experienceDAO.insert({
          id: itemId,
          org: archive.org,
          archive_id: archiveId,
          workflow_name: archive.workflow_name,
          type: item.type,
          title: item.title,
          content: item.content,
          status: "active",
          resolved_at: null,
          resolved_by: null,
          project: item.project ?? null,
          package: item.package ?? null,
          file_pattern: item.file_pattern ?? null,
          keywords: item.keywords.join(" "),
          relevance_score: 1.0,
          use_count: 0,
        })
      }

      if (result.items[0]?.project) {
        this.knowledgeFiles.rebuild(result.items[0].project)
      }
    }
  }

  archiveWorkspace(workspaceId: string): number {
    const ws = this.workspaceDAO.findById(workspaceId)
    if (!ws) throw new Error(`Workspace not found: ${workspaceId}`)

    const result = this.workspaceDAO.updateArchiveStatus(workspaceId, "archiving")
    if (result.changes === 0) {
      console.warn(`[ArchiveService] Workspace ${workspaceId} already archiving or archived`)
      return 0
    }

    try {
      const executions = this.executionDAO.listByWorkspace(workspaceId)
      const archivedExecIds: string[] = []

      const wsArchiveId = randomUUID()
      let totalCost = 0
      let totalDuration = 0
      const workflowManifest: Set<string> = new Set()

      for (const exec of executions) {
        try {
          const archiveId = this.archiveExecution(exec.id, wsArchiveId)
          archivedExecIds.push(archiveId)
          totalCost += 0
          totalDuration += exec.duration ?? 0
          workflowManifest.add(exec.workflow_ref)
        } catch (err) {
          console.error(`[ArchiveService] Failed to archive execution ${exec.id}:`, err)
        }
      }

      const executionChains: Record<string, string[]> = {}
      for (const exec of executions) {
        const parentId = exec.parent_id !== "0" ? exec.parent_id : null
        if (parentId) {
          if (!executionChains[parentId]) executionChains[parentId] = []
          executionChains[parentId].push(exec.id)
        }
      }

      const wsArchiveRow: Omit<WorkspaceArchiveRow, "archived_at"> = {
        id: wsArchiveId,
        org: ws.org,
        workspace_name: ws.name,
        workspace_path: ws.path,
        created_at: ws.created_at,
        execution_count: archivedExecIds.length,
        total_cost_usd: totalCost,
        total_duration_ms: totalDuration,
        execution_chains: JSON.stringify(executionChains),
        workflow_manifest: JSON.stringify(Array.from(workflowManifest)),
        summary: null,
      }

      this.archiveDAO.insertWorkspaceArchive(wsArchiveRow)
      this.workspaceDAO.updateArchiveStatus(workspaceId, "archived")

      console.log(`[ArchiveService] Archived workspace ${workspaceId}: ${archivedExecIds.length} executions`)
      return archivedExecIds.length
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      console.error(`[ArchiveService] Failed to archive workspace ${workspaceId}:`, errorMsg)
      this.workspaceDAO.updateArchiveStatus(workspaceId, "archive_failed", errorMsg)
      throw err
    }
  }

  retryCleanup(): void {
    const staleWorkspaces = this.workspaceDAO.findArchivedButFilesExist()
    for (const ws of staleWorkspaces) {
      try {
        const fs = require("fs")
        const path = require("path")
        const os = require("os")
        const resolvedPath = ws.path.replace(/^~/, os.homedir())
        if (fs.existsSync(resolvedPath)) {
          fs.rmSync(resolvedPath, { recursive: true, force: true })
          console.log(`[ArchiveService] Cleaned up stale workspace: ${ws.id}`)
        }
      } catch (err) {
        console.error(`[ArchiveService] Failed to cleanup workspace ${ws.id}:`, err)
      }
    }
  }

  recoverStuckArchiving(): void {
    const result = this.workspaceDAO.resetStuckArchiving(30)
    if (result.changes > 0) {
      console.warn(`[ArchiveService] Recovered ${result.changes} stuck archiving workspaces`)
    }
  }
}
