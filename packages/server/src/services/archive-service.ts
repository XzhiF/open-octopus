// packages/server/src/services/archive-service.ts
import fs from "fs"
import path from "path"
import os from "os"
import type { ArchiveDAO } from "../db/dao/archive-dao"
import type { ExecutionDAO } from "../db/dao/execution-dao"
import type { TokenUsageDAO } from "../db/dao/token-usage-dao"
import type { ExperienceDAO } from "../db/dao/experience-dao"
import type { MemoryService } from "./agent/memory-service"

/**
 * ArchiveService — Layer 1+2 synchronous extraction.
 *
 * Layer 1: programmatic extraction (node_summary, token aggregation)
 * Layer 2: rule-based filtering (failed nodes, vars_snapshot filtering)
 *
 * All methods are synchronous (better-sqlite3 is sync) and wrapped in try-catch.
 * On error, log warning and return null (never throw to caller).
 */
export class ArchiveService {
  private memoryService?: MemoryService

  constructor(
    private archiveDAO: ArchiveDAO,
    private executionDAO: ExecutionDAO,
    private tokenUsageDAO: TokenUsageDAO,
    private experienceDAO?: ExperienceDAO,
    memoryService?: MemoryService,
  ) {
    this.memoryService = memoryService
  }

  /**
   * Archive a single execution. Returns the archive row id, or null on failure.
   */
  archiveExecution(executionId: string, wsArchiveId?: string): number | null {
    try {
      const execution = this.executionDAO.findById(executionId)
      if (!execution) return null

      const nodeExecutions = this.executionDAO.findNodeExecutions(executionId)

      // ── Layer 1: Build node_summary JSON ──────────────────────
      const nodeSummary = nodeExecutions.map(ne => ({
        node_id: ne.node_id,
        type: ne.node_type,
        status: ne.status,
        duration_ms: ne.duration ?? null,
        exit_code: ne.exit_code ?? null,
      }))

      // ── Layer 1: Aggregate token data ─────────────────────────
      // Use TokenUsageDAO to get cost data (includes cost_usd)
      const tokenRows = this.tokenUsageDAO.findByExecution(executionId)

      let totalInputTokens = 0
      let totalOutputTokens = 0
      let totalCostUsd = 0
      const modelBreakdown: Record<string, { input_tokens: number; output_tokens: number; cost_usd: number }> = {}

      for (const usage of tokenRows) {
        totalInputTokens += usage.input_tokens
        totalOutputTokens += usage.output_tokens
        const cost = usage.cost_usd ?? 0
        totalCostUsd += cost

        const model = usage.model || "unknown"
        if (!modelBreakdown[model]) {
          modelBreakdown[model] = { input_tokens: 0, output_tokens: 0, cost_usd: 0 }
        }
        modelBreakdown[model].input_tokens += usage.input_tokens
        modelBreakdown[model].output_tokens += usage.output_tokens
        modelBreakdown[model].cost_usd += cost
      }

      // Round total cost to avoid floating-point drift
      totalCostUsd = Math.round(totalCostUsd * 1e8) / 1e8

      // ── Layer 2: Extract failed nodes ─────────────────────────
      const failedNodes = nodeExecutions
        .filter(ne => ne.status === "failed")
        .map(ne => ne.node_id)
      const errorMessage = failedNodes.length > 0
        ? nodeExecutions.find(ne => ne.status === "failed")?.error ?? null
        : null

      // ── Layer 2: Filter vars_snapshot ─────────────────────────
      let varsSnapshot: Record<string, unknown> = {}
      try {
        const raw = execution.var_pool ? JSON.parse(execution.var_pool) : {}
        // Exclude large text values (> 1000 chars)
        for (const [k, v] of Object.entries(raw)) {
          if (typeof v === "string" && v.length > 1000) continue
          varsSnapshot[k] = v
        }
      } catch {
        // ignore parse errors
      }

      // ── Parent / chain metadata ──────────────────────────────
      const parentExecutionId = execution.parent_id !== "0" && execution.parent_id
        ? execution.parent_id
        : null
      const chainPosition = execution.child_index ?? null

      // ── Write to execution_archive ────────────────────────────
      const archiveId = this.archiveDAO.insertArchive({
        execution_id: executionId,
        workflow_ref: execution.workflow_ref,
        workflow_name: execution.workflow_name,
        status: execution.status,
        started_at: execution.started_at,
        completed_at: execution.completed_at,
        duration_ms: execution.duration,
        total_input_tokens: totalInputTokens,
        total_output_tokens: totalOutputTokens,
        total_cost_usd: totalCostUsd,
        node_summary: JSON.stringify(nodeSummary),
        failed_nodes: failedNodes.length > 0 ? JSON.stringify(failedNodes) : null,
        error_message: errorMessage,
        model_breakdown: Object.keys(modelBreakdown).length > 0 ? JSON.stringify(modelBreakdown) : null,
        vars_snapshot: JSON.stringify(varsSnapshot),
        workspace_id: execution.workspace_id,
        parent_execution_id: parentExecutionId,
        chain_position: chainPosition,
        workspace_archive_id: wsArchiveId ?? null,
      })

      // ── P4.5: Daily memory write ─────────────────────────────
      if (archiveId && this.memoryService) {
        try {
          const summary = this.formatMemoryEntry(
            { workflow_name: execution.workflow_name, status: execution.status, duration: execution.duration },
            totalCostUsd,
            nodeSummary,
          )
          this.memoryService.appendDaily(execution.org ?? "default", summary)
        } catch (err) {
          console.warn("[archive] daily memory write failed:", err)
        }
      }

      return archiveId
    } catch (err) {
      console.warn(`[archive] archiveExecution failed for ${executionId}:`, err)
      return null
    }
  }

  /**
   * Archive all executions in a workspace and create a workspace_archive entry.
   * Returns the workspace_archive row id, or null on failure.
   */
  archiveWorkspace(workspaceId: string): number | null {
    try {
      const executions = this.executionDAO.listByWorkspace(workspaceId)
      if (executions.length === 0) return null

      // Look up workspace metadata for the archive record
      // We need name and org — get from the first execution's workspace
      // The workspace row should still exist at this point (we archive before delete)
      let workspaceName = workspaceId
      let workspaceOrg = "unknown"
      try {
        // Access workspace info via a direct query through the archive DAO's db
        // We don't have WorkspaceDAO here, so we get it from execution data
        if (executions.length > 0) {
          workspaceOrg = executions[0].org || "unknown"
        }
      } catch {
        // fallback to defaults
      }

      // Archive each execution (skip already-archived ones)
      const archivedIds: number[] = []
      for (const exec of executions) {
        const existing = this.archiveDAO.getArchive(exec.id)
        if (existing) continue
        const id = this.archiveExecution(exec.id)
        if (id !== null) archivedIds.push(id)
      }

      // Build execution_chains: detect parent-child relationships
      const chainMap = new Map<string, string[]>()
      const rootExecs = executions.filter(e => !e.parent_id || e.parent_id === "0")
      for (const root of rootExecs) {
        const chain: string[] = [root.id]
        const children = executions.filter(e => e.parent_id === root.id)
        for (const child of children) {
          chain.push(child.id)
        }
        chainMap.set(root.id, chain)
      }
      const executionChains = Array.from(chainMap.entries()).map(([rootId, children]) => ({
        root: rootId,
        children,
      }))

      // Build workflow_manifest: list of unique workflow refs with metadata
      const workflowSet = new Set<string>()
      for (const exec of executions) {
        if (exec.workflow_ref) workflowSet.add(exec.workflow_ref)
      }
      const workflowManifest = Array.from(workflowSet).map(ref => ({
        workflow_ref: ref,
        workflow_name: executions.find(e => e.workflow_ref === ref)?.workflow_name || ref,
        execution_count: executions.filter(e => e.workflow_ref === ref).length,
      }))

      // Aggregate totals
      let totalCost = 0
      for (const exec of executions) {
        const archive = this.archiveDAO.getArchive(exec.id)
        if (archive) totalCost += archive.total_cost_usd
      }

      // Try to get workspace name from workspace row
      // Since we don't have direct access to WorkspaceDAO, we'll use a placeholder
      // The caller (WorkspaceService) could pass the name, but for now use workspaceId
      // We'll try to extract from the workspace path or use the ID
      try {
        // Access the underlying db through the archiveDAO (BaseDAO exposes db)
        const db = (this.archiveDAO as any).db
        if (db) {
          const wsRow = db.prepare("SELECT name FROM workspaces WHERE id = ?").get(workspaceId) as { name: string } | undefined
          if (wsRow) workspaceName = wsRow.name
        }
      } catch {
        // fallback
      }

      // Create workspace_archive
      const wsArchiveId = this.archiveDAO.insertWorkspaceArchive({
        workspace_id: workspaceId,
        workspace_name: workspaceName,
        org: workspaceOrg,
        execution_chains: JSON.stringify(executionChains),
        workflow_manifest: JSON.stringify(workflowManifest),
        total_executions: executions.length,
        total_cost_usd: Math.round(totalCost * 1e8) / 1e8,
      })

      // Back-fill workspace_archive_id on execution_archive rows
      const wsArchiveIdStr = String(wsArchiveId)
      for (const exec of executions) {
        try {
          const existing = this.archiveDAO.getArchive(exec.id)
          if (existing && !existing.workspace_archive_id) {
            // Update workspace_archive_id — use direct update
            const db = (this.archiveDAO as any).db
            if (db) {
              db.prepare("UPDATE execution_archive SET workspace_archive_id = ? WHERE execution_id = ?")
                .run(wsArchiveIdStr, exec.id)
            }
          }
        } catch {
          // non-fatal
        }
      }

      return wsArchiveId
    } catch (err) {
      console.warn(`[archive] archiveWorkspace failed for ${workspaceId}:`, err)
      return null
    }
  }

  /**
   * For the detail API — returns archive data for a single execution.
   * Returns the archive row or null if not archived.
   */
  archiveExecutionForDetail(executionId: string): object | null {
    try {
      const archive = this.archiveDAO.getArchive(executionId)
      if (!archive) return null
      return {
        ...archive,
        node_summary: safeJsonParse(archive.node_summary, []),
        failed_nodes: safeJsonParse(archive.failed_nodes, null),
        model_breakdown: safeJsonParse(archive.model_breakdown, null),
        vars_snapshot: safeJsonParse(archive.vars_snapshot, {}),
        experiences: [], // Populated in P2
      }
    } catch (err) {
      console.warn(`[archive] archiveExecutionForDetail failed for ${executionId}:`, err)
      return null
    }
  }

  /**
   * Layer 3: Extract lessons from an execution using haiku (cost-gated).
   *
   * Cost gate: skip LLM if total_cost_usd < $1 AND status === 'completed'.
   * For now, the actual LLM call is deferred (TODO) — the method structure
   * and cost gate logic are fully implemented.
   *
   * Returns null if: archive not found, cost gate skip, or LLM not yet integrated.
   */
  async extractLessons(executionId: string): Promise<null> {
    try {
      const archive = this.archiveDAO.getArchive(executionId)
      if (!archive) return null

      // ── Cost gate ──────────────────────────────────────────────
      // Skip LLM call for cheap, successful executions
      if (archive.total_cost_usd < 1.0 && archive.status === "completed") {
        return null
      }

      // ── Build prompt for haiku ─────────────────────────────────
      // Only reached if cost >= $1 OR status === 'failed'
      const nodeSummary = safeJsonParse(archive.node_summary, [])
      const failedNodes = safeJsonParse(archive.failed_nodes, null)
      const varsSnapshot = safeJsonParse(archive.vars_snapshot, {})

      // Truncate vars_snapshot to avoid token explosion
      const truncatedVars: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(varsSnapshot)) {
        if (typeof v === "string" && v.length > 200) {
          truncatedVars[k] = v.slice(0, 200) + "...[truncated]"
        } else {
          truncatedVars[k] = v
        }
      }

      const _prompt = [
        "Analyze this workflow execution and extract actionable lessons.",
        `Workflow: ${archive.workflow_name}`,
        `Status: ${archive.status}`,
        `Total cost: $${archive.total_cost_usd.toFixed(4)}`,
        `Duration: ${archive.duration_ms ?? "unknown"}ms`,
        `Node summary: ${JSON.stringify(nodeSummary)}`,
        failedNodes ? `Failed nodes: ${JSON.stringify(failedNodes)}` : "",
        archive.error_message ? `Error: ${archive.error_message}` : "",
        `Vars snapshot: ${JSON.stringify(truncatedVars)}`,
        "",
        "Return JSON: { lessons: string, items: Array<{ type: 'bug'|'pattern'|'cost'|'failure', title: string, content: string, project?: string, package?: string, file_pattern?: string, keywords?: string }> }",
      ].filter(Boolean).join("\n")

      // TODO: Call haiku LLM provider here when integration is ready.
      // For now, log and return null.
      console.log(`[archive] extractLessons: haiku would be called for ${executionId} (cost=$${archive.total_cost_usd.toFixed(4)}, status=${archive.status})`)

      // ── Future: write results when haiku integration is live ──────
      // if (haikuResult) {
      //   this.archiveDAO.updateLessonsLearned(executionId, haikuResult.lessons)
      //   if (this.experienceDAO) {
      //     for (const item of haikuResult.items) {
      //       // Supersede check: find same-dimension active entries
      //       const existing = this.experienceDAO.findByDimensions(
      //         item.project ?? "", item.file_pattern ?? null, item.type
      //       )
      //       const newId = this.experienceDAO.insert({
      //         type: item.type,
      //         title: item.title,
      //         content: item.content,
      //         project: item.project ?? null,
      //         package: item.package ?? null,
      //         file_pattern: item.file_pattern ?? null,
      //         keywords: item.keywords ?? null,
      //         workflow_name: archive.workflow_name,
      //         status: 'active',
      //         relevance_score: 0,
      //         use_count: 0,
      //       })
      //       // Supersede old entries
      //       const toSupersede = existing.filter(e => e.id !== newId)
      //       if (toSupersede.length > 0) {
      //         this.experienceDAO.markSuperseded(toSupersede.map(e => e.id), newId)
      //       }
      //     }
      //   }
      // }

      return null
    } catch (err) {
      console.warn(`[archive] extractLessons failed for ${executionId}:`, err)
      return null
    }
  }

  /**
   * Regenerate knowledge base markdown files for a given project.
   *
   * For each type in ['bug', 'pattern', 'cost', 'failure'], queries active
   * experiences (max 50, sorted by relevance_score DESC) and writes an
   * overwriting markdown file to ~/.octopus/knowledge/{project}/{type}.md.
   *
   * Resolved/obsolete entries naturally disappear on next regeneration.
   */
  updateKnowledgeFiles(project: string): void {
    if (!this.experienceDAO) return

    const types = ["bug", "pattern", "cost", "failure"] as const
    const baseDir = path.join(os.homedir(), ".octopus", "knowledge", project)

    for (const type of types) {
      try {
        const entries = this.experienceDAO.getActiveByProject(project, type, 50)
        // getActiveByProject already sorts by relevance_score DESC

        const lines: string[] = [
          `# ${type.charAt(0).toUpperCase() + type.slice(1)} Experiences — ${project}`,
          `> Auto-generated from experience_index. Do not edit manually.`,
          `> Generated: ${new Date().toISOString()}`,
          "",
        ]

        for (const entry of entries) {
          lines.push(`## ${entry.title}`)
          lines.push(entry.content)
          lines.push("---")
          lines.push("")
        }

        fs.mkdirSync(baseDir, { recursive: true })
        const filePath = path.join(baseDir, `${type}.md`)
        fs.writeFileSync(filePath, lines.join("\n"), "utf-8")
      } catch (err) {
        console.warn(`[archive] updateKnowledgeFiles failed for ${project}/${type}:`, err)
      }
    }
  }

  /**
   * P4.5: Format a memory entry for daily log after archiving.
   */
  private formatMemoryEntry(
    execution: { workflow_name: string; status: string; duration: number | null },
    costUsd: number,
    nodeSummary: Array<{ node_id: string; status: string }>,
  ): string {
    const duration = execution.duration ? `${(execution.duration / 1000).toFixed(0)}s` : "unknown"
    const failedCount = nodeSummary.filter(n => n.status === "failed").length
    return `## ${execution.workflow_name}
- 状态: ${execution.status}
- 耗时: ${duration}
- 成本: $${costUsd.toFixed(4)}
- 节点: ${nodeSummary.length} 个 (${failedCount} 失败)
- 时间: ${new Date().toISOString()}
`
  }
}

function safeJsonParse<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}
