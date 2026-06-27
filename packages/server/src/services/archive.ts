// packages/server/src/services/archive.ts
// ArchiveService — execution archival, workspace archive, and recovery.
// Phase 1 of Execution Memory: Data Foundation & Auto-Archive.

import { randomUUID } from "crypto"
import type { ArchiveDAO } from "../db/dao/archive-dao"
import type { ExperienceDAO } from "../db/dao/experience-dao"
import type { ExecutionDAO } from "../db/dao/execution-dao"
import type { ExecutionArchiveRow, WorkspaceArchiveRow } from "../db/types-archive"
import { PrivacyFilter } from "./privacy-filter"
import { getDomainEventBus } from "./agent/domain-event-bus"
import type { EngineCallbacks } from "@octopus/engine"
import type { ExperienceExtractor } from "./experience-extractor"
import type { KnowledgeFilesService } from "./knowledge-files"

export class ArchiveService {
  private privacyFilter = new PrivacyFilter()
  private extractor?: ExperienceExtractor
  private knowledgeFiles?: KnowledgeFilesService

  constructor(
    private archiveDAO: ArchiveDAO,
    private experienceDAO: ExperienceDAO,
    private executionDAO: ExecutionDAO,
    options?: { extractor?: ExperienceExtractor; knowledgeFiles?: KnowledgeFilesService },
  ) {
    this.extractor = options?.extractor
    this.knowledgeFiles = options?.knowledgeFiles
  }

  // ── Public API ────────────────────────────────────────────────────

  /**
   * Archive a single execution. Fire-and-forget with retry.
   * Reads execution data from ExecutionDAO, aggregates tokens/cost,
   * builds node_summary, filters vars_snapshot, writes to execution_archive.
   */
  archiveExecution(executionId: string): void {
    // Fire-and-forget: don't await, catch errors internally
    this._archiveWithRetry(executionId).catch(err => {
      console.error(`[ArchiveService] archive failed after retries: ${executionId}`, err)
    })
  }

  /**
   * Archive all executions in a workspace before deletion.
   * Returns { archived: number, failed: number }
   */
  async archiveWorkspace(workspaceId: string, timeoutMs = 300_000): Promise<{ archived: number; failed: number }> {
    const executions = this.executionDAO.listByWorkspace(workspaceId)
    let archived = 0
    let failed = 0

    const deadline = Date.now() + timeoutMs
    for (const exec of executions) {
      if (Date.now() > deadline) break
      try {
        await this._archiveWithRetry(exec.id, 2) // fewer retries for batch
        archived++
      } catch (err) {
        console.error(`[ArchiveService] failed to archive execution ${exec.id}:`, err)
        failed++
      }
    }

    return { archived, failed }
  }

  /**
   * Build and insert a workspace_archive record.
   */
  insertWorkspaceArchive(
    workspaceId: string,
    workspaceName: string,
    org: string,
    executionCount: number,
    totalCostUsd: number,
    executionChains: unknown[],
    workflowManifest: unknown[],
  ): void {
    const row: WorkspaceArchiveRow = {
      id: randomUUID(),
      org,
      workspace_name: workspaceName,
      execution_count: executionCount,
      total_cost_usd: totalCostUsd,
      execution_chains: JSON.stringify(executionChains),
      workflow_manifest: JSON.stringify(workflowManifest),
      archived_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    }
    this.archiveDAO.insertWorkspaceArchive(row)
  }

  /**
   * Recover archived workspaces that still have filesystem directories.
   * Called periodically (every hour) to clean up orphaned directories.
   */
  recoverArchivedWorkspaces(): void {
    try {
      const workspaces = this.archiveDAO.listUnarchivedWorkspaces()
      const fs = require("fs") as typeof import("fs")
      const os = require("os") as typeof import("os")

      for (const ws of workspaces) {
        try {
          const resolvedPath = ws.path.replace(/^~/, os.homedir())
          if (fs.existsSync(resolvedPath)) {
            fs.promises.rm(resolvedPath, { recursive: true, force: true })
              .catch((err: Error) =>
                console.error(`[ArchiveService] recovery delete failed for ${ws.id}:`, err),
              )
          }
        } catch (err) {
          console.error(`[ArchiveService] recovery failed for workspace ${ws.id}:`, err)
        }
      }
    } catch (err) {
      console.error("[ArchiveService] recoverArchivedWorkspaces failed:", err)
    }
  }

  /**
   * Create an onComplete callback for archiving.
   * Usage: executionService.registerExternalCallbacks(
   *   archiveService.createOnCompleteCallback(executionId), executionId
   * )
   */
  createOnCompleteCallback(executionId: string): Partial<EngineCallbacks> {
    return {
      onComplete: ((_finalStatus: string) => {
        this.archiveExecution(executionId)
      }) as any,
    }
  }

  // ── Clone memory isolation ────────────────────────────────────────

  /**
   * Migrate clone's execution experiences to main agent on merge.
   * TC-043: clone lessons_learned written to main agent's experiences.
   */
  async migrateCloneExperiences(cloneWorkspaceId: string, mainWorkspaceId: string): Promise<number> {
    try {
      const cloneArchives = this.archiveDAO.listByCloneWorkspace(cloneWorkspaceId)
      let migrated = 0
      for (const archive of cloneArchives) {
        if (archive.lessons_learned) {
          try {
            if (this.experienceDAO) {
              this.experienceDAO.insertExperience({
                id: randomUUID(),
                type: "pattern",
                title: `Clone lesson: ${archive.workflow_name}`,
                content: archive.lessons_learned,
                project: archive.workflow_name ?? null,
                package: null,
                file_pattern: null,
                keywords: `${archive.workflow_name ?? ""},clone:${cloneWorkspaceId}`,
                status: "active",
                relevance_score: 0.5,
                use_count: 0,
                workflow_name: archive.workflow_name ?? null,
                execution_id: archive.id,
                resolved_at: null,
                resolved_by: null,
                org: archive.org ?? "",
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
              migrated++
            }
          } catch { /* duplicate or insert failure — skip */ }
        }
      }
      console.log(`[ArchiveService] Migrated ${migrated} clone experiences from ${cloneWorkspaceId} to main`)
      return migrated
    } catch (err) {
      console.error("[ArchiveService] clone experience migration failed:", err)
      return 0
    }
  }

  // ── Internal: archive with retry ──────────────────────────────────

  private async _archiveWithRetry(executionId: string, maxRetries = 3): Promise<void> {
    const delays = [1000, 5000, 30_000] // 1s, 5s, 30s exponential backoff
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await this._doArchive(executionId)
        // Emit domain event on success (best-effort)
        try {
          const bus = getDomainEventBus()
          bus.emit("archive.execution_completed", { executionId })
        } catch { /* domain event is best-effort */ }

        // After successful archive, write to Agent daily memory (best-effort)
        try {
          const { getMemoryService } = require('./agent/memory-service')
          const memoryService = getMemoryService()
          const archive = this.archiveDAO.findById(executionId)
          if (archive && archive.org) {
            const duration = archive.duration_ms ? `${Math.round(archive.duration_ms / 1000)}s` : 'N/A'
            const cost = archive.total_cost_usd?.toFixed(2) ?? '0.00'
            const conclusion = archive.lessons_learned || '无'
            const content = [
              `## 执行记录: ${archive.workflow_name}`,
              `- 状态: ${archive.status} | 耗时: ${duration} | 成本: $${cost}`,
              `- 关键结果: ${conclusion}`,
              '',
            ].join('\n')
            memoryService.appendDaily(archive.org, content)
          }
        } catch (err) {
          console.warn('[ArchiveService] daily memory write failed (best-effort):', err)
        }

        // Trigger experience extraction (fire-and-forget, best-effort)
        if (this.extractor) {
          this.extractor.extractLessons(executionId).then(() => {
            // After extraction, update knowledge files for all projects with active experiences
            if (this.knowledgeFiles) {
              try {
                const archive = this.archiveDAO.findById(executionId)
                if (archive?.org) {
                  const projects = this.experienceDAO.getDistinctProjects('active')
                  for (const project of projects) {
                    this.knowledgeFiles.updateKnowledgeFiles(archive.org, project)
                  }
                }
              } catch (err) {
                console.error(`[ArchiveService] knowledge files update failed for ${executionId}:`, err)
              }
            }
          }).catch(err => {
            console.error(`[ArchiveService] experience extraction failed for ${executionId}:`, err)
          })
        }
        return
      } catch (err) {
        if (attempt < maxRetries - 1) {
          await new Promise(r => setTimeout(r, delays[attempt] ?? 30_000))
        } else {
          throw err
        }
      }
    }
  }

  // ── Internal: single archive attempt ───────────────────────────────

  private async _doArchive(executionId: string): Promise<void> {
    const exec = this.executionDAO.findById(executionId)
    if (!exec) return

    // ── L1: Aggregate token/cost from node_token_usages ──
    const tokenUsages = this.executionDAO.findNodeTokenUsages(executionId)
    let totalInput = 0
    let totalOutput = 0
    const totalCost = 0 // Cost is on llm_calls, not token_usages — use 0 for now
    const modelBreakdown: Record<string, { input: number; output: number; cost: number }> = {}

    for (const tu of tokenUsages) {
      totalInput += tu.input_tokens
      totalOutput += tu.output_tokens
      if (!modelBreakdown[tu.model]) {
        modelBreakdown[tu.model] = { input: 0, output: 0, cost: 0 }
      }
      modelBreakdown[tu.model].input += tu.input_tokens
      modelBreakdown[tu.model].output += tu.output_tokens
    }

    // ── Build node_summary from node_executions ──
    const nodeExecs = this.executionDAO.findNodeExecutions(executionId)
    const nodeSummary = nodeExecs.map(ne => ({
      nodeId: ne.node_id,
      type: ne.node_type,
      status: ne.status,
      duration: ne.duration ?? 0,
    }))

    // Collect failed nodes
    const failedNodes = nodeExecs
      .filter(ne => ne.status === "failed")
      .map(ne => ne.node_id)
    const firstError = nodeExecs.find(ne => ne.status === "failed")?.error ?? null

    // ── L2: Filter vars_snapshot (blacklist secret keys, 64KB limit) ──
    let varsSnapshot = "{}"
    try {
      const raw = exec.var_pool ? JSON.parse(exec.var_pool) : {}
      const filtered = this.filterVarsSnapshot(raw)
      varsSnapshot = JSON.stringify(filtered)
      if (varsSnapshot.length > 65_536) {
        varsSnapshot = JSON.stringify({
          _truncated: true,
          _original_size: varsSnapshot.length,
        })
      }
    } catch {
      varsSnapshot = "{}"
    }

    // ── Calculate duration ──
    let durationMs: number | null = exec.duration ?? null
    if (!durationMs && exec.started_at && exec.completed_at) {
      durationMs = new Date(exec.completed_at).getTime() - new Date(exec.started_at).getTime()
    }

    const row: ExecutionArchiveRow = {
      id: exec.id,
      org: exec.org ?? "",
      workspace_id: exec.workspace_id,
      workspace_name: null, // Enriched by JOIN or left null
      workflow_ref: exec.workflow_ref ?? "",
      workflow_name: exec.workflow_name ?? "",
      status: exec.status,
      started_at: exec.started_at,
      completed_at: exec.completed_at,
      duration_ms: durationMs,
      total_input_tokens: totalInput,
      total_output_tokens: totalOutput,
      total_cost_usd: totalCost,
      node_summary: JSON.stringify(nodeSummary),
      model_breakdown: Object.keys(modelBreakdown).length > 0
        ? JSON.stringify(modelBreakdown)
        : null,
      failed_nodes: failedNodes.length > 0 ? JSON.stringify(failedNodes) : null,
      error_message: firstError,
      vars_snapshot: varsSnapshot,
      lessons_learned: null,
      parent_execution_id: exec.parent_id !== "0" ? exec.parent_id : null,
      workspace_archive_id: null,
      created_at: new Date().toISOString(),
    }

    this.archiveDAO.insertExecutionArchive(row)
  }

  // ── Internal: filter secret keys from vars snapshot ───────────────

  /**
   * Filter vars_snapshot: remove keys matching secret/password/token/credential patterns.
   * Recursively filters nested objects. Values matching the blacklist are replaced
   * with '[REDACTED]'.
   */
  private filterVarsSnapshot(obj: Record<string, unknown>): Record<string, unknown> {
    const blacklist = /secret|password|token|credential|api_key|apikey|auth/i
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj)) {
      if (blacklist.test(key)) {
        result[key] = "[REDACTED]"
      } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        result[key] = this.filterVarsSnapshot(value as Record<string, unknown>)
      } else {
        result[key] = value
      }
    }
    return result
  }
}
