import type Database from "better-sqlite3"
import type { ArchiveDAO } from "../../db/dao/archive-dao"
import type { ExecutionDAO } from "../../db/dao/execution-dao"
import { WorkspaceDAO } from "../../db/dao/workspace-dao"
import type { DomainEventBus } from "../agent/domain-event-bus"
import type { ExecutionArchiveRow, WorkspaceArchiveRow, ExecutionRow } from "../../db/types"
import { logError, logInfo } from "../../file-logger"
import type { StepEmitter } from "./step-emitter"
import { createNullEmitter } from "./step-emitter"

export class ArchivePartialFailure extends Error {
  constructor(public readonly failures: Array<{ execId: string; error: string }>) {
    super(`Archive partial failure: ${failures.length} executions failed`)
    this.name = "ArchivePartialFailure"
  }
}

export class ArchiveService {
  constructor(
    private archiveDAO: ArchiveDAO,
    private executionDAO: ExecutionDAO,
    private db: Database.Database,
    private domainEventBus?: DomainEventBus,
  ) {}

  // ── P1.1: archiveExecution ──────────────────────────────────────────

  private static TERMINAL_STATUSES = new Set(["completed", "completed_with_failures", "failed", "cancelled", "rejected"])

  async archiveExecution(executionId: string): Promise<{ archived: boolean; reason?: string }> {
    const exec = this.executionDAO.findById(executionId)
    if (!exec) return { archived: false, reason: "execution_not_found" }

    if (!ArchiveService.TERMINAL_STATUSES.has(exec.status)) {
      return { archived: false, reason: "execution_not_terminal" }
    }

    const row = this.buildExecutionArchiveRow(executionId, exec)

    try {
      const { inserted } = this.archiveDAO.insertExecutionArchive(row)
      return { archived: inserted, reason: inserted ? undefined : "already_archived" }
    } catch (err) {
      logError("archive execution failed", err, { executionId })
      return { archived: false, reason: "insert_failed" }
    }
  }

  // ── Shared: build ExecutionArchiveRow from source tables ─────────

  private buildExecutionArchiveRow(executionId: string, exec: ExecutionRow): ExecutionArchiveRow {
    const nodeCount = (this.db.prepare(
      "SELECT COUNT(*) as cnt FROM node_executions WHERE execution_id = ?",
    ).get(executionId) as { cnt: number }).cnt

    const successNodes = (this.db.prepare(
      "SELECT COUNT(*) as cnt FROM node_executions WHERE execution_id = ? AND status = 'completed'",
    ).get(executionId) as { cnt: number }).cnt

    const tokenAgg = this.db.prepare(`
      SELECT
        COALESCE(SUM(input_tokens), 0) as input,
        COALESCE(SUM(output_tokens), 0) as output,
        COALESCE(SUM(cache_read_tokens), 0) as cache_read,
        COALESCE(SUM(cache_creation_tokens), 0) as cache_creation
      FROM node_token_usages
      WHERE node_execution_id IN (SELECT id FROM node_executions WHERE execution_id = ?)
    `).get(executionId) as Record<string, number>

    const modelRows = this.db.prepare(`
      SELECT model, COUNT(*) as calls,
             SUM(input_tokens + output_tokens) as tokens,
             COALESCE(SUM(cost_usd), 0) as cost
      FROM llm_calls WHERE execution_id = ?
      GROUP BY model
    `).all(executionId) as Array<{ model: string; calls: number; tokens: number; cost: number }>

    const modelBreakdown: Record<string, { calls: number; tokens: number; cost: number }> = {}
    let totalCost = 0
    for (const row of modelRows) {
      modelBreakdown[row.model ?? "unknown"] = { calls: row.calls, tokens: row.tokens, cost: row.cost }
      totalCost += row.cost
    }

    const nodeSummary = this.db.prepare(`
      SELECT node_id, node_type, status, duration
      FROM node_executions WHERE execution_id = ?
      ORDER BY started_at ASC
    `).all(executionId)

    const children = this.db.prepare(
      "SELECT id FROM executions WHERE parent_id = ?",
    ).all(executionId) as Array<{ id: string }>

    return {
      execution_id: exec.id,
      workspace_id: exec.workspace_id,
      org: exec.org,
      workflow_name: exec.workflow_name,
      total_cost: totalCost,
      total_duration_ms: exec.duration ?? 0,
      node_count: nodeCount,
      success_rate: nodeCount > 0 ? successNodes / nodeCount : 0,
      token_breakdown: JSON.stringify(tokenAgg),
      model_breakdown: JSON.stringify(modelBreakdown),
      node_summary: JSON.stringify(nodeSummary),
      chain_info: JSON.stringify({
        parent_execution_id: exec.parent_id !== "0" ? exec.parent_id : null,
        child_execution_ids: children.map(c => c.id),
      }),
      status: exec.status,
      archived_at: new Date().toISOString(),
      metadata: null,
    }
  }

  // ── P1.2: archiveWorkspace (two-phase) ──────────────────────────────

  async archiveWorkspace(
    workspaceId: string,
    workspaceDAO: WorkspaceDAO,
  ): Promise<{ archived: boolean; execution_count: number }> {
    const ws = workspaceDAO.findById(workspaceId)
    if (!ws) return { archived: false, execution_count: 0 }

    const execRows = this.db.prepare(
      "SELECT id FROM executions WHERE workspace_id = ?",
    ).all(workspaceId) as Array<{ id: string }>

    const failures: Array<{ execId: string; error: string }> = []

    try {
      this.archiveDAO.transaction(() => {
        // Phase 1: mark archiving
        workspaceDAO.setArchiveStatus(workspaceId, "archiving")

        // Phase 2: archive all executions inline (sync, inside transaction)
        for (const { id } of execRows) {
          try {
            const exec = this.executionDAO.findById(id)
            if (!exec) continue
            const row = this.buildExecutionArchiveRow(id, exec)
            this.archiveDAO.insertExecutionArchive(row)
          } catch (e) {
            failures.push({ execId: id, error: e instanceof Error ? e.message : String(e) })
          }
        }

        // CRITICAL: if any failures, throw to rollback transaction
        if (failures.length > 0) {
          throw new ArchivePartialFailure(failures)
        }

        // Phase 3: workspace metadata snapshot
        const wsRow: WorkspaceArchiveRow = {
          workspace_id: ws.id,
          org: ws.org,
          name: ws.name,
          description: ws.description,
          source: ws.source,
          execution_count: execRows.length,
          total_cost: execRows.length > 0 ? (this.db.prepare(
            "SELECT COALESCE(SUM(total_cost), 0) as total FROM execution_archive WHERE workspace_id = ?",
          ).get(workspaceId) as { total: number }).total : 0,
          total_duration_ms: execRows.length > 0 ? (this.db.prepare(
            "SELECT COALESCE(SUM(total_duration_ms), 0) as total FROM execution_archive WHERE workspace_id = ?",
          ).get(workspaceId) as { total: number }).total : 0,
          created_at: ws.created_at,
          archived_at: new Date().toISOString(),
          metadata: null,
        }
        this.archiveDAO.insertWorkspaceArchive(wsRow)

        // Phase 4: mark archived
        workspaceDAO.setArchiveStatus(workspaceId, "archived")
      })

      logInfo("workspace archived", { workspaceId, execution_count: execRows.length })
      return { archived: true, execution_count: execRows.length }
    } catch (err) {
      logError("workspace archive failed", err, { workspaceId })
      // Transaction rolled back — mark as archive_failed for diagnostics
      try {
        workspaceDAO.setArchiveStatus(workspaceId, "archive_failed")
        logInfo("workspace marked as archive_failed", { workspaceId, error: err instanceof Error ? err.message : String(err) })
      } catch (statusErr) {
        // If even status update fails, log it but don't swallow the original error
        logError("failed to set archive_failed status", statusErr, { workspaceId })
      }
      throw err
    }
  }

  // ── P2.2: archiveMemoryBatch ─────────────────────────────────────

  async archiveMemoryBatch(
    org: string,
    config: { session_retention_days: number; long_term_refine_trigger_days: number },
  ): Promise<{ archived_count: number }> {
    let archivedCount = 0

    // 1. Archive daily memory files older than retention days
    try {
      // Dynamic imports to avoid circular deps and heavy transitive loads
      const { getAgentService } = await import('../agent/agent-service')
      const { getDailyMemoryDir } = await import('../agent/paths')
      const fs = await import('fs')

      const agentService = getAgentService()
      const dailyDir = getDailyMemoryDir()

      if (fs.existsSync(dailyDir)) {
        const files = fs.readdirSync(dailyDir).filter((f: string) => f.endsWith('.md'))
        const retentionCutoff = new Date()
        retentionCutoff.setDate(retentionCutoff.getDate() - config.session_retention_days)

        for (const file of files) {
          const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})\.md$/)
          if (!dateMatch) continue
          const fileDate = new Date(dateMatch[1])
          if (fileDate >= retentionCutoff) continue

          try {
            await agentService.archiveMemory(org, dateMatch[1])
            archivedCount++
            this.emitArchived(dateMatch[1], 'daily_memory', new Date().toISOString())
          } catch (err) {
            logError('failed to archive daily memory', err, { org, date: dateMatch[1] })
          }
        }
      }
    } catch (err) {
      logError('archiveMemoryBatch daily scan failed', err, { org })
      throw err
    }

    // 2. Check long-term memory refine trigger
    try {
      const { getMemoryService } = await import('../agent/memory-service')
      const { getLongTermMemoryPath } = await import('../agent/paths')
      const fs = await import('fs')

      const ltPath = getLongTermMemoryPath()
      if (fs.existsSync(ltPath)) {
        const stat = fs.statSync(ltPath)
        const daysSinceModified = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24)
        if (daysSinceModified >= config.long_term_refine_trigger_days) {
          try {
            const memoryService = getMemoryService()
            memoryService.refineLongTerm(org)
          } catch (err) {
            logError('long-term refine failed', err, { org })
          }
        }
      }
    } catch (err) {
      logError('long-term refine check failed', err, { org })
      throw err
    }

    return { archived_count: archivedCount }
  }

  // ── P2.4: archiveWorkspace (full archive with knowledge loop) ────

  async archiveWorkspace(
    workspaceId: string,
    org: string,
    options: {
      extractExperiences: string[]
      installSkills: Array<{ name: string; group: string; path?: string; content?: string }>
      analysisReport?: unknown
      metadata?: Record<string, unknown>
      stats?: {
        execution_count: number
        total_cost: number
        total_duration_ms: number
        success_rate: number
        avg_cost_per_execution: number
        avg_duration_ms: number
        lifespan_days: number
        workflow_count: number
      }
      experienceActions?: Array<{
        id: string
        text: string
        action: "add" | "update" | "delete"
        replaces_text?: string
        confidence: number
        category: string
        scope?: string
        target?: string
      }>
    },
    emitter: StepEmitter = createNullEmitter(),
  ): Promise<{
    success: boolean
    archivedExecutions: number
    extractedExperiences: number
    installedSkills: number
    fileDeleted: boolean
    error?: string
  }> {
    try {
      // Step 1: Get workspace details
      const workspaceDAO = new WorkspaceDAO(this.db)
      const workspace = workspaceDAO.findById(workspaceId)
      if (!workspace) {
        return { success: false, archivedExecutions: 0, extractedExperiences: 0, installedSkills: 0, fileDeleted: false, error: "workspace_not_found" }
      }

      // Step 2: Archive all executions in this workspace
      const executions = this.executionDAO.listByWorkspace(workspaceId)
      let archivedExecutions = 0
      await emitter.stepStart("archive_executions", `归档 ${executions.length} 条执行记录...`)
      for (const exec of executions) {
        const result = await this.archiveExecution(exec.id)
        if (result.archived) {
          archivedExecutions++
          await emitter.log(`Archived execution ${exec.id}`)
        }
      }
      await emitter.stepDone("archive_executions", { count: archivedExecutions })

      // Step 3: Create workspace archive record
      await emitter.stepStart("create_record", "创建归档记录...")
      const stats = options.stats ?? {
        execution_count: archivedExecutions,
        total_cost: 0,
        total_duration_ms: 0,
        success_rate: 0,
        avg_cost_per_execution: 0,
        avg_duration_ms: 0,
        lifespan_days: 0,
        workflow_count: 0,
      }

      const workspaceArchiveRow: WorkspaceArchiveRow = {
        workspace_id: workspaceId,
        org: workspace.org,
        name: workspace.name,
        description: workspace.description,
        source: workspace.source,
        execution_count: stats.execution_count,
        total_cost: stats.total_cost,
        total_duration_ms: stats.total_duration_ms,
        created_at: workspace.created_at,
        archived_at: new Date().toISOString(),
        metadata: options.metadata ? JSON.stringify(options.metadata) : null,
        extracted_experiences: 0,
        extracted_skills: 0,
        analysis_report: null,
        file_deleted: 0,
      }

      if (options.analysisReport) {
        workspaceArchiveRow.analysis_report = JSON.stringify(options.analysisReport)
      }

      this.archiveDAO.insertWorkspaceArchive(workspaceArchiveRow)
      await emitter.stepDone("create_record")

      // Step 4: Merge experiences via Agent
      await emitter.stepStart("extract_experiences", `提取 ${options.extractExperiences.length} 条经验...`)
      let extractedExperiences = 0
      if (options.experienceActions && options.experienceActions.length > 0) {
        try {
          const { ExperienceMerger } = await import("./experience-merger")
          const merger = new ExperienceMerger()
          const result = await merger.merge(org, options.experienceActions, emitter)
          extractedExperiences = result.added + result.updated + result.deleted
          await emitter.stepDone("extract_experiences", {
            added: result.added,
            updated: result.updated,
            deleted: result.deleted,
          })
        } catch (err) {
          await emitter.stepError("extract_experiences", err instanceof Error ? err.message : String(err))
          throw err
        }
      } else {
        await emitter.stepDone("extract_experiences", { count: 0 })
      }

      // Step 5: Install skills (resources system)
      await emitter.stepStart("install_skills", `安装 ${options.installSkills.length} 个 Skill...`)
      let installedSkills = 0
      if (options.installSkills.length > 0) {
        installedSkills = await this.installSkills(org, options.installSkills, emitter)
      }
      await emitter.stepDone("install_skills", { count: installedSkills })

      // Step 6: Delete workspace files from disk
      await emitter.stepStart("delete_files", "清理工作空间文件...")
      let fileDeleted = false
      try {
        const fs = await import("fs/promises")
        await fs.rm(workspace.path, { recursive: true, force: true })
        fileDeleted = true
        logInfo("workspace files deleted", { workspaceId, path: workspace.path })
      } catch (err) {
        logError("failed to delete workspace files", err, { workspaceId, path: workspace.path })
      }
      await emitter.stepDone("delete_files", { deleted: fileDeleted })

      // Step 7: Update workspace archive with extraction stats
      await emitter.stepStart("update_stats", "更新统计...")
      this.archiveDAO.updateExtractionStats(workspaceId, extractedExperiences, installedSkills)
      this.archiveDAO.setFileDeleted(workspaceId, fileDeleted ? 1 : 0)
      await emitter.stepDone("update_stats")

      // Step 8: Soft-archive workspace (mark as archived, preserve DB row)
      await emitter.stepStart("soft_archive", "软归档...")
      workspaceDAO.softArchive(workspaceId)
      await emitter.stepDone("soft_archive")

      logInfo("workspace archived successfully", {
        workspaceId,
        archivedExecutions,
        extractedExperiences,
        installedSkills,
        fileDeleted,
      })

      // Cleanup draft after successful archive
      await emitter.stepStart("cleanup_draft", "清理草稿...")
      try {
        const { ArchiveDraftDAO } = await import("../../db/dao/archive-draft-dao")
        const draftDAO = new ArchiveDraftDAO(this.db)
        draftDAO.delete(workspaceId)
      } catch { /* non-fatal */ }
      await emitter.stepDone("cleanup_draft")

      await emitter.complete({
        success: true,
        archivedExecutions,
        extractedExperiences,
        installedSkills,
        fileDeleted,
      })

      return {
        success: true,
        archivedExecutions,
        extractedExperiences,
        installedSkills,
        fileDeleted,
      }
    } catch (err) {
      await emitter.stepError("unknown", err instanceof Error ? err.message : String(err))
      logError("archiveWorkspace failed", err, { workspaceId })
      return {
        success: false,
        archivedExecutions: 0,
        extractedExperiences: 0,
        installedSkills: 0,
        fileDeleted: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  private async extractExperiences(
    workspaceId: string,
    org: string,
    _executionIds: string[]
  ): Promise<number> {
    try {
      const { buildArchiveContext } = await import("./context-builder")
      const { buildExperiencePrompt } = await import("./prompts")
      const { getProvider } = await import("@octopus/providers")
      const { PendingReviewDAO } = await import("../../db/dao/pending-review-dao")
      const { WorkspaceDAO } = await import("../../db/dao/workspace-dao")
      const { ExecutionDAO } = await import("../../db/dao/execution-dao")

      const pendingReviewDAO = new PendingReviewDAO(this.db)
      const workspaceDAO = new WorkspaceDAO(this.db)
      const executionDAO = new ExecutionDAO(this.db)

      const ctx = await buildArchiveContext(workspaceId, workspaceDAO, executionDAO, this.db, org)
      if (!ctx) {
        logError("extractExperiences: workspace not found", new Error("workspace not found"), { workspaceId })
        return 0
      }

      const prompt = buildExperiencePrompt(ctx)
      const systemPrompt = "You are a knowledge extraction engine. Respond with only the JSON array."

      const provider = getProvider('claude')
      const chunks: string[] = []
      const stream = provider.sendQuery(prompt, process.cwd(), undefined, { systemPrompt })
      for await (const chunk of stream) {
        if (chunk.type === "text_delta") chunks.push(chunk.content)
      }
      const raw = chunks.join("")

      if (!raw) {
        logError("extractExperiences: empty LLM response", new Error("empty LLM response"), { workspaceId })
        return 0
      }

      const cleaned = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim()
      const arr = JSON.parse(cleaned)
      if (!Array.isArray(arr)) {
        logError("extractExperiences: LLM response is not an array", new Error("invalid response"), { workspaceId })
        return 0
      }

      let extractedCount = 0
      for (const exp of arr) {
        const id = exp.id || `exp-${workspaceId}-${extractedCount}-${Date.now()}`
        pendingReviewDAO.insert({
          id,
          type: "experience",
          source: "archive",
          source_ref: workspaceId,
          source_label: ctx.workspace.name,
          content: exp.text || "",
          target_file: "",
          scope: exp.scope || "workspace",
          conflicts: null,
          confidence: typeof exp.confidence === "number" ? exp.confidence : 0.5,
          auto_approve: 0,
          status: "pending",
          user_notes: null,
        })
        extractedCount++
      }

      return extractedCount
    } catch (err) {
      logError("extractExperiences failed", err, { workspaceId })
      return 0
    }
  }

  private async installSkills(
    org: string,
    skills: Array<{ name: string; group: string; path?: string; content?: string }>,
    emitter: StepEmitter,
  ): Promise<number> {
    try {
      const { getResourceManager } = await import("../resource-manager")
      const resourceManager = getResourceManager(org)
      const fs = await import("fs")
      const path = await import("path")
      const os = await import("os")
      let installedCount = 0

      for (const skill of skills) {
        try {
          await emitter.stepProgress("install_skills", `安装 ${skill.name} → ${skill.group}`)

          if (skill.path && fs.existsSync(skill.path)) {
            // Auto-discovered skill: copy the entire skill directory
            const sourceDir = path.dirname(skill.path)
            const basePath = path.join(os.homedir(), ".octopus", "orgs", org, "resources")
            const installDir = path.join(basePath, "installed", "skills", skill.group, skill.name)

            // Create target directory
            fs.mkdirSync(installDir, { recursive: true })

            // Copy all files from source skill directory
            this.copyDirRecursive(sourceDir, installDir)

            // Register in resource manager (use local source for file-based skills)
            await resourceManager.install({
              ref: `local:${sourceDir}`,
              type: "skill",
              group: skill.group,
            })

            await emitter.log(`✓ Copied skill from ${sourceDir} → ${installDir}`)
          } else {
            // LLM-generated or builtin skill: use resource manager
            await resourceManager.install({
              ref: `builtin:${skill.name}`,
              type: "skill",
              group: skill.group,
            })
          }

          installedCount++
        } catch (err) {
          await emitter.log(`✗ Failed to install ${skill.name}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      return installedCount
    } catch (err) {
      logError("installSkills failed", err, { org })
      return 0
    }
  }

  private copyDirRecursive(src: string, dest: string): void {
    const fs = require("fs")
    const path = require("path")

    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true })
    }

    const entries = fs.readdirSync(src, { withFileTypes: true })
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name)
      const destPath = path.join(dest, entry.name)

      if (entry.isDirectory()) {
        this.copyDirRecursive(srcPath, destPath)
      } else {
        fs.copyFileSync(srcPath, destPath)
      }
    }
  }

  // ── P2.3: emitArchived ───────────────────────────────────────────

  private emitArchived(memoryId: string, memoryType: string, archivedAt: string): void {
    if (!this.domainEventBus) return
    this.domainEventBus.emit('memory.archived', {
      memory_id: memoryId,
      memory_type: memoryType,
      archived_at: archivedAt,
    }, { source: 'archive-service' }).catch(err => {
      logError('emit memory.archived failed', err, { memoryId })
    })
  }
}

// ── Singleton ───────────────────────────────────────────────────────

let _instance: ArchiveService | null = null

export function initArchiveService(
  dao: ArchiveDAO,
  execDAO: ExecutionDAO,
  db: Database.Database,
  bus?: DomainEventBus,
): ArchiveService {
  _instance = new ArchiveService(dao, execDAO, db, bus)
  return _instance
}

export function getArchiveService(): ArchiveService | null {
  return _instance
}
