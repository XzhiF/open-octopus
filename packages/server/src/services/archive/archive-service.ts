import type Database from "better-sqlite3"
import { LEDGER_SQL, costSummary } from "@octopus/shared"
import type { ArchiveDAO } from "../../db/dao/archive-dao"
import type { ExecutionDAO } from "../../db/dao/execution-dao"
import { WorkspaceDAO } from "../../db/dao/workspace-dao"
import { pricedCallsSql, PRICED_AGG } from "../../db/price-sql"
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

    // C3/Q8-1: token 单源 = node_token_usages 账本；calls 是明细计数，归 llm_calls 管辖。
    // NEW-r2: 钱不落账本 —— cost 从 llm_calls_costed 视图按价表窗口派生（与 billing 报表
    // 同源同规则），归档时算好并冻结：cascadeDelete 会把源账本行一并删除，事后不可重算。
    const tokenAgg = this.db.prepare(`
      SELECT
        COALESCE(SUM(input_tokens), 0) as input,
        COALESCE(SUM(output_tokens), 0) as output,
        COALESCE(SUM(cache_read_tokens), 0) as cache_read,
        COALESCE(SUM(cache_creation_tokens), 0) as cache_creation
      FROM node_token_usages
      WHERE node_execution_id IN (SELECT id FROM node_executions WHERE execution_id = ?)
    `).get(executionId) as Record<string, number>

    const tokenRows = this.db.prepare(`
      SELECT ntu.model as model,
             ${LEDGER_SQL.sumTokens('ntu.')} as tokens
      FROM node_token_usages ntu
      JOIN node_executions ne ON ntu.node_execution_id = ne.id
      WHERE ne.execution_id = ?
      GROUP BY ntu.model
    `).all(executionId) as Array<{ model: string | null; tokens: number }>

    const { sql: costSql, params: costParams } = pricedCallsSql(["l.execution_id = ?"], [executionId])
    const costRows = this.db.prepare(`
      SELECT q.model as model,
             COUNT(*) as calls,
             ${PRICED_AGG.sumCost('q')} as cost
      FROM (${costSql}) q
      GROUP BY q.model
    `).all(...costParams) as Array<{ model: string | null; calls: number; cost: number | null }>

    const modelBreakdown: Record<string, { calls: number; tokens: number; cost: number | null }> = {}
    for (const row of tokenRows) {
      const key = row.model ?? "unknown"
      modelBreakdown[key] = { calls: 0, tokens: row.tokens, cost: null }
    }
    // 只在 llm_calls 出现的模型也补一行（tokens=0），保证 breakdown 与 total_cost 自洽
    for (const row of costRows) {
      const key = row.model ?? "unknown"
      const entry = modelBreakdown[key] ?? { calls: 0, tokens: 0, cost: null }
      entry.calls = row.calls
      entry.cost = row.cost
      modelBreakdown[key] = entry
    }
    // 全未定价 → NULL（不焊 0）；部分定价 → 已知和
    const totalCost = costSummary(costRows.map(r => r.cost)).usd

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

  // ── P1.2: archiveWorkspaceRecords (two-phase, transactional) ─────────
  //
  // Records-only archive used by delete / archive-retry flows: archives every
  // execution + the workspace snapshot in ONE transaction, then marks the
  // workspace archived. No file deletion, no resource install — that is the
  // full `archiveWorkspace` flow below. (Was a duplicate `archiveWorkspace`
  // definition; last-one-wins made this one unreachable.)

  async archiveWorkspaceRecords(
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
        // 零执行 → 0（确知没花钱）；有执行但全未定价 → NULL（不焊 0）
        const costAgg = this.db.prepare(
          `SELECT COUNT(*) as cnt, ${LEDGER_SQL.sumCostOf('total_cost')} as total FROM execution_archive WHERE workspace_id = ?`,
        ).get(workspaceId) as { cnt: number; total: number | null }
        const wsRow: WorkspaceArchiveRow = {
          workspace_id: ws.id,
          name: ws.name,
          description: ws.description,
          source: ws.source,
          execution_count: execRows.length,
          total_cost: costAgg.cnt === 0 ? 0 : costAgg.total,
          total_duration_ms: execRows.length > 0 ? (this.db.prepare(
            "SELECT COALESCE(SUM(total_duration_ms), 0) as total FROM execution_archive WHERE workspace_id = ?",
          ).get(workspaceId) as { total: number }).total : 0,
          created_at: ws.created_at,
          archived_at: new Date().toISOString(),
          metadata: null,
          extracted_experiences: 0,
          extracted_skills: 0,
          extracted_workflows: 0,
          extracted_agents: 0,
          analysis_report: null,
          file_deleted: 0,
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

  // ── P2.4: archiveWorkspace (full archive with knowledge loop) ────
  //
  // 知识中心票10: 旧经验提炼/归并管线（三级提炼 archive-analysis-service +
  // experience-merger）已删除——归档知识沉淀改走 task archiving 态自动投喂
  // （services/tasks/archive-ingest-service.ts）。本方法保留 workspace 生命周期
  // 面：执行记录归档、资源安装（skills/workflows/agents）、文件清理、软归档。
  // experience 相关入参与 extractedExperiences 计数不再产出内容（计数恒 0，
  // 返回形状稳定；experiences 表本体属票09 删除面）。

  async archiveWorkspace(
    workspaceId: string,
    options: {
      installSkills: Array<{ name: string; group: string; path?: string; content?: string }>
      installWorkflows?: Array<{ name: string; group: string; path?: string; content?: string }>
      installAgents?: Array<{ name: string; group: string; path?: string; content?: string }>
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
    },
    emitter: StepEmitter = createNullEmitter(),
  ): Promise<{
    success: boolean
    archivedExecutions: number
    extractedExperiences: number
    installedSkills: number
    installedAgents: number
    fileDeleted: boolean
    error?: string
  }> {
    try {
      // Step 1: Get workspace details
      const workspaceDAO = new WorkspaceDAO(this.db)
      const workspace = workspaceDAO.findById(workspaceId)
      if (!workspace) {
        return { success: false, archivedExecutions: 0, extractedExperiences: 0, installedSkills: 0, installedAgents: 0, fileDeleted: false, error: "workspace_not_found" }
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

      // 工作区总费用 = 已冻结的 execution_archive 汇总（与 dashboard 的 archivedCost 同源）。
      // 客户端 stats.total_cost 不再作为存储值 —— 两侧口径不一（或为 0）会让
      // 「live + archived」双计/漏计。零执行 → 0；有执行但全未定价 → NULL。
      const costAgg = this.db.prepare(
        `SELECT COUNT(*) as cnt, ${LEDGER_SQL.sumCostOf('total_cost')} as total FROM execution_archive WHERE workspace_id = ?`,
      ).get(workspaceId) as { cnt: number; total: number | null }
      const archivedTotalCost = costAgg.cnt === 0 ? 0 : costAgg.total

      const workspaceArchiveRow: WorkspaceArchiveRow = {
        workspace_id: workspaceId,
        name: workspace.name,
        description: workspace.description,
        source: workspace.source,
        execution_count: stats.execution_count,
        total_cost: archivedTotalCost,
        total_duration_ms: stats.total_duration_ms,
        created_at: workspace.created_at,
        archived_at: new Date().toISOString(),
        metadata: options.metadata ? JSON.stringify(options.metadata) : null,
        extracted_experiences: 0,
        extracted_skills: 0,
        extracted_workflows: 0,
        extracted_agents: 0,
        analysis_report: null,
        file_deleted: 0,
      }

      if (options.analysisReport) {
        workspaceArchiveRow.analysis_report = JSON.stringify(options.analysisReport)
      }

      this.archiveDAO.insertWorkspaceArchive(workspaceArchiveRow)
      await emitter.stepDone("create_record")

      // Step 4（旧「经验归并」）已删 — 知识中心票10：归档产物改走 raw 投喂；
      // 计数恒 0 保返回形状（updateExtractionStats 照记）。
      const extractedExperiences = 0

      // Step 5: Install skills (resources system)
      await emitter.stepStart("install_skills", `安装 ${options.installSkills.length} 个 Skill...`)
      let installedSkills = 0
      if (options.installSkills.length > 0) {
        installedSkills = await this.installSkills(options.installSkills, emitter)
      }
      await emitter.stepDone("install_skills", { count: installedSkills })

      // Step 5.5: Install workflows (resources system)
      const installWorkflows = options.installWorkflows || []
      await emitter.stepStart("install_workflows", `安装 ${installWorkflows.length} 个 Workflow...`)
      let installedWorkflows = 0
      if (installWorkflows.length > 0) {
        installedWorkflows = await this.installWorkflowsToResources(installWorkflows, emitter)
      }
      await emitter.stepDone("install_workflows", { count: installedWorkflows })

      // Step 5.6: Install agents
      const installAgents = options.installAgents || []
      await emitter.stepStart("install_agents", `安装 ${installAgents.length} 个 Agent...`)
      let installedAgents = 0
      if (installAgents.length > 0) {
        installedAgents = await this.installAgentsToResources(installAgents, emitter)
      }
      await emitter.stepDone("install_agents", { count: installedAgents })

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
      this.archiveDAO.updateExtractionStats(workspaceId, extractedExperiences, installedSkills, installedWorkflows, installedAgents)
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
        installedAgents,
        fileDeleted,
      })

      return {
        success: true,
        archivedExecutions,
        extractedExperiences,
        installedSkills,
        installedAgents,
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
        installedAgents: 0,
        fileDeleted: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  /** 清理 LLM 提取的资源名称，确保符合 SAFE_NAME_RE */
  private sanitizeResourceName(raw: string, fallback = "unnamed"): string {
    const sanitized = raw
      .replace(/["']/g, "")
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .replace(/^[^a-zA-Z0-9]+/, "")
      .slice(0, 128)
    return sanitized || fallback
  }

  private async installSkills(
    skills: Array<{ name: string; group: string; path?: string; content?: string }>,
    emitter: StepEmitter,
  ): Promise<number> {
    try {
      const { getResourceRegistry } = await import("../resource-registry")
      const resourceManager = getResourceRegistry().get()
      const fs = await import("fs")
      const path = await import("path")
      const os = await import("os")
      let installedCount = 0

      for (const skill of skills) {
        try {
          const finalName = this.sanitizeResourceName(skill.name)
          const finalGroup = this.sanitizeResourceName(skill.group, "archive-extracted")
          if (!finalName) {
            await emitter.log(`✗ Skipping skill with empty name after sanitization: ${skill.name}`)
            continue
          }

          await emitter.stepProgress("install_skills", `安装 ${finalName} → ${finalGroup}`)

          if (skill.path && fs.existsSync(skill.path)) {
            // Auto-discovered skill: copy the entire skill directory
            const sourceDir = path.dirname(skill.path)
            const basePath = path.join(os.homedir(), ".octopus", "resources")
            const installDir = path.join(basePath, "installed", "skills", finalGroup, finalName)

            // Create target directory
            fs.mkdirSync(installDir, { recursive: true })

            // Copy all files from source skill directory
            this.copyDirRecursive(sourceDir, installDir)

            // Register in resource manager (files already copied)
            resourceManager.registerInstalled({
              name: finalName,
              type: "skill",
              group: finalGroup,
            })

            await emitter.log(`✓ Copied skill from ${sourceDir} → ${installDir}`)
          } else {
            // LLM-generated or builtin skill: use resource manager
            await resourceManager.install({
              ref: `builtin:${finalName}`,
              type: "skill",
              group: finalGroup,
            })
          }

          installedCount++
        } catch (err) {
          await emitter.log(`✗ Failed to install ${skill.name}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      return installedCount
    } catch (err) {
      logError("installSkills failed", err)
      return 0
    }
  }

  private async installWorkflowsToResources(
    workflows: Array<{ name: string; group: string; path?: string; content?: string }>,
    emitter: StepEmitter,
  ): Promise<number> {
    try {
      const { getResourceRegistry } = await import("../resource-registry")
      const resourceManager = getResourceRegistry().get()
      const fs = await import("fs")
      const path = await import("path")
      const os = await import("os")
      let installedCount = 0

      for (const wf of workflows) {
        try {
          const finalName = this.sanitizeResourceName(wf.name)
          const finalGroup = this.sanitizeResourceName(wf.group, "archive-extracted")
          if (!finalName) {
            await emitter.log(`✗ Skipping workflow with empty name after sanitization: ${wf.name}`)
            continue
          }

          await emitter.stepProgress("install_workflows", `安装 ${finalName} → ${finalGroup}`)

          const basePath = path.join(os.homedir(), ".octopus", "resources")
          const installDir = path.join(basePath, "installed", "workflows", finalGroup, finalName)

          // Create target directory
          fs.mkdirSync(installDir, { recursive: true })

          // Copy workflow yaml file or write content
          if (wf.path && fs.existsSync(wf.path)) {
            const destFile = path.join(installDir, path.basename(wf.path))
            fs.copyFileSync(wf.path, destFile)
            await emitter.log(`✓ Copied workflow from ${wf.path} → ${destFile}`)
          } else if (wf.content) {
            const destFile = path.join(installDir, `${finalName}.yaml`)
            fs.writeFileSync(destFile, wf.content, "utf-8")
            await emitter.log(`✓ Written workflow content → ${destFile}`)
          }

          // Register in resource manager (files already copied, upsert handles overwrite)
          resourceManager.registerInstalled({
            name: finalName,
            type: "workflow",
            group: finalGroup,
          })

          installedCount++
        } catch (err) {
          await emitter.log(`✗ Failed to install workflow ${wf.name}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      return installedCount
    } catch (err) {
      logError("installWorkflowsToResources failed", err)
      return 0
    }
  }

  private async installAgentsToResources(
    agents: Array<{ name: string; group: string; path?: string; content?: string }>,
    emitter: StepEmitter,
  ): Promise<number> {
    try {
      const { getResourceRegistry } = await import("../resource-registry")
      const resourceManager = getResourceRegistry().get()
      const fs = await import("fs")
      const path = await import("path")
      const os = await import("os")
      let installedCount = 0

      for (const agent of agents) {
        try {
          const finalName = this.sanitizeResourceName(agent.name)
          const finalGroup = this.sanitizeResourceName(agent.group, "archive-extracted")
          if (!finalName) {
            await emitter.log(`✗ Skipping agent with empty name after sanitization: ${agent.name}`)
            continue
          }

          await emitter.stepProgress("install_agents", `安装 ${finalName} → ${finalGroup}`)

          const basePath = path.join(os.homedir(), ".octopus", "resources")
          const installDir = path.join(basePath, "installed", "agents", finalGroup, finalName)

          // Create target directory
          fs.mkdirSync(installDir, { recursive: true })

          // Copy agent md file or write content
          if (agent.path && fs.existsSync(agent.path)) {
            const destFile = path.join(installDir, path.basename(agent.path))
            fs.copyFileSync(agent.path, destFile)
            await emitter.log(`✓ Copied agent from ${agent.path} → ${destFile}`)
          } else if (agent.content) {
            const destFile = path.join(installDir, `${finalName}.md`)
            fs.writeFileSync(destFile, agent.content, "utf-8")
            await emitter.log(`✓ Written agent content → ${destFile}`)
          }

          // Register in resource manager (files already copied, upsert handles overwrite)
          resourceManager.registerInstalled({
            name: finalName,
            type: "agent",
            group: finalGroup,
          })

          installedCount++
        } catch (err) {
          await emitter.log(`✗ Failed to install agent ${agent.name}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      return installedCount
    } catch (err) {
      logError("installAgentsToResources failed", err)
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
}

// ── Singleton ───────────────────────────────────────────────────────

let _instance: ArchiveService | null = null

export function initArchiveService(
  dao: ArchiveDAO,
  execDAO: ExecutionDAO,
  db: Database.Database,
): ArchiveService {
  _instance = new ArchiveService(dao, execDAO, db)
  return _instance
}

export function getArchiveService(): ArchiveService | null {
  return _instance
}
