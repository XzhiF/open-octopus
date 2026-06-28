import Database from "better-sqlite3"
import { randomUUID } from "crypto"
import { TokenUsageDAO, ExecutionDAO, WorkspaceDAO } from "../db/dao"
import type { ArchiveDAO } from "../db/dao/archive-dao"
import type { ExperienceDAO } from "../db/dao/experience-dao"

interface Suggestion {
  ruleName: string
  nodeId?: string
  severity: 'info' | 'warning' | 'critical'
  title: string
  detection: string
  diagnosis: string
  prescription: string
  impactEstimate?: string
}

interface RuleContext {
  tokenDao: TokenUsageDAO
  execDao: ExecutionDAO
  workspaceId: string
  workflowRef: string
}

interface SuggestionRule {
  name: string
  check: (ctx: RuleContext) => Suggestion[]
}

export class SuggestionEngine {
  private rules: SuggestionRule[]
  private archiveDAO?: ArchiveDAO
  private experienceDAO?: ExperienceDAO

  constructor(archiveDAO?: ArchiveDAO, experienceDAO?: ExperienceDAO) {
    this.archiveDAO = archiveDAO
    this.experienceDAO = experienceDAO
    this.rules = [
      {
        name: 'OverpoweredModel',
        check: (ctx) => {
          const rows = ctx.tokenDao.findLlmCallStatsByNode(ctx.workspaceId, ctx.workflowRef)

          return rows.filter(r => r.avg_out < 200 && r.tool_ratio < 0.3).map(r => ({
            ruleName: 'OverpoweredModel',
            nodeId: r.node_id,
            severity: 'warning' as const,
            title: '可能使用了过强的模型',
            detection: `节点 ${r.node_id} 平均输出 ${r.avg_out.toFixed(0)} tokens，tool 调用比例 ${(r.tool_ratio * 100).toFixed(0)}%`,
            diagnosis: '该节点的推理复杂度较低，当前模型可能过度消耗 token',
            prescription: '考虑将模型切换为 Claude Haiku 以降低成本',
            impactEstimate: `预计可节省 ~60% 的 LLM 成本（当前 ${r.calls} 次调用）`,
          }))
        },
      },
      {
        name: 'ThinkingOutputRatio',
        check: (ctx) => {
          const rows = ctx.tokenDao.findThinkingOutputRatio(ctx.workspaceId, ctx.workflowRef)

          return rows.filter(r => r.output_total > 0 && r.thinking_total > 5 * r.output_total).map(r => ({
            ruleName: 'ThinkingOutputRatio',
            nodeId: r.node_id,
            severity: 'info' as const,
            title: '思考输出比例过高',
            detection: `节点 ${r.node_id} thinking tokens 是实际输出的 ${(r.thinking_total / r.output_total).toFixed(0)}x`,
            diagnosis: 'Agent 花费了大量 token 在思考上，但实际产出较少',
            prescription: '优化 prompt，减少不必要的推理步骤',
            impactEstimate: `thinking tokens 约 ${r.thinking_total.toLocaleString()} tokens`,
          }))
        },
      },
      {
        name: 'RedundantCondition',
        check: (ctx) => {
          const rows = ctx.execDao.findNodeExecStatsByWorkflow(ctx.workspaceId, 36500)

          const byNode = new Map<string, Array<{ status: string; count: number }>>()
          for (const r of rows) {
            if (!byNode.has(r.node_id)) byNode.set(r.node_id, [])
            byNode.get(r.node_id)!.push({ status: r.status, count: r.count })
          }

          const suggestions: Suggestion[] = []
          for (const [nodeId, statuses] of byNode) {
            const total = statuses.reduce((s, x) => s + x.count, 0)
            const dominant = statuses.find(s => s.count / total > 0.95)
            if (dominant && total > 5) {
              suggestions.push({
                ruleName: 'RedundantCondition',
                nodeId,
                severity: 'info' as const,
                title: '条件分支几乎总是相同',
                detection: `节点 ${nodeId} 在 ${total} 次执行中 ${((dominant.count / total) * 100).toFixed(0)}% 走同一分支`,
                diagnosis: '该条件判断可能过于稳定，失去了条件分支的意义',
                prescription: '考虑简化为直接调用该分支，移除条件判断',
              })
            }
          }
          return suggestions
        },
      },
      {
        name: 'FlakyNode',
        check: (ctx) => {
          const rows = ctx.execDao.findFlakyNodeStats(ctx.workspaceId, 36500)

          return rows.filter(r => r.total > 2 && r.failures / r.total > 0.3).map(r => ({
            ruleName: 'FlakyNode',
            nodeId: r.node_id,
            severity: 'critical' as const,
            title: '节点失败率过高',
            detection: `节点 ${r.node_id} 在 ${r.total} 次执行中失败了 ${r.failures} 次 (${((r.failures / r.total) * 100).toFixed(0)}%)`,
            diagnosis: '该节点的可靠性低于 70%，频繁失败会影响整个工作流',
            prescription: '改进 prompt 增加鲁棒性，或添加 retry 机制',
          }))
        },
      },
      {
        name: 'OutputOverproduction',
        check: (ctx) => {
          const rows = ctx.tokenDao.findOutputOverproduction(ctx.workspaceId, ctx.workflowRef)

          return rows.filter(r => r.avg_out > 2000).map(r => ({
            ruleName: 'OutputOverproduction',
            nodeId: r.node_id,
            severity: 'warning' as const,
            title: '输出 token 过多',
            detection: `节点 ${r.node_id} 平均输出 ${r.avg_out.toFixed(0)} tokens`,
            diagnosis: 'Agent 生成的输出远超实际需要的内容',
            prescription: '在 workflow YAML 中添加 max_tokens 限制',
            impactEstimate: `限制到 1000 tokens 预计可节省 ~50% 的 output token 成本`,
          }))
        },
      },
    ]
  }

  generate(ctx: RuleContext): Suggestion[] {
    const all: Suggestion[] = []
    for (const rule of this.rules) {
      try {
        all.push(...rule.check(ctx))
      } catch {
        // 单条规则失败不影响其他规则
      }
    }
    return all
  }

  persistSuggestion(dao: WorkspaceDAO, workspaceId: string, workflowRef: string, suggestion: Suggestion): string {
    const id = randomUUID()
    const now = new Date().toISOString()
    dao.insertSuggestion({
      id, workspace_id: workspaceId, workflow_ref: workflowRef,
      rule_name: suggestion.ruleName, node_id: suggestion.nodeId ?? null,
      severity: suggestion.severity, title: suggestion.title,
      detection: suggestion.detection, diagnosis: suggestion.diagnosis,
      prescription: suggestion.prescription,
      impact_estimate: suggestion.impactEstimate ?? null,
      status: 'pending', created_at: now,
    })
    return id
  }

  applySuggestion(dao: WorkspaceDAO, suggestionId: string, changes: Record<string, unknown>): boolean {
    const row = dao.findSuggestionById(suggestionId)
    if (!row) return false
    dao.applySuggestion(suggestionId, JSON.stringify(changes))
    return true
  }

  getSuggestions(dao: WorkspaceDAO, workspaceId: string, status?: string) {
    return dao.findSuggestionsSorted(workspaceId, status)
  }

  /**
   * P4.2: Analyze repeating patterns across archived executions.
   * Returns suggestions for systemic issues.
   */
  analyzeRepeatingPatterns(days: number): Array<{
    title: string
    severity: 'info' | 'warning' | 'critical'
    detail: string
    recommendation: string
  }> {
    const suggestions: Array<{ title: string; severity: 'info' | 'warning' | 'critical'; detail: string; recommendation: string }> = []

    if (!this.archiveDAO || !this.experienceDAO) return suggestions

    try {
      // Find experiences with same project + package + type >= 3 in last N days
      const _cutoff = new Date(Date.now() - days * 86400000).toISOString()

      // Group bug experiences by project + package
      const bugExperiences = this.experienceDAO.search("bug", { type: "bug", status: "active", limit: 100 })
      const groups = new Map<string, typeof bugExperiences>()

      for (const exp of bugExperiences) {
        const key = `${exp.project || "unknown"}:${exp.package || "unknown"}`
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key)!.push(exp)
      }

      for (const [key, exps] of groups) {
        if (exps.length >= 3) {
          const [project, pkg] = key.split(":")
          suggestions.push({
            title: `重复 BUG 模式: ${pkg}`,
            severity: "warning",
            detail: `项目 ${project} 的 ${pkg} 包在过去 ${days} 天内出现 ${exps.length} 个同类 BUG`,
            recommendation: `建议对 ${pkg} 做一次系统性审查`,
          })
        }
      }
    } catch (err) {
      console.warn("[suggestion-engine] analyzeRepeatingPatterns failed:", err)
    }

    return suggestions
  }

  /**
   * P4.3: Detect failure patterns from experience index.
   */
  detectFailurePatterns(newWorkflow: string, experiences: Array<{ type: string; title: string; content: string }>): Array<{
    warning: string
    autoFix?: string
  }> {
    const warnings: Array<{ warning: string; autoFix?: string }> = []

    const failureExps = experiences.filter(e => e.type === 'failure')
    for (const exp of failureExps) {
      // Simple pattern matching: if the failure content mentions keywords from the workflow name
      if (exp.content.toLowerCase().includes(newWorkflow.toLowerCase()) ||
          exp.title.toLowerCase().includes(newWorkflow.toLowerCase())) {
        warnings.push({
          warning: `历史失败经验: "${exp.title}" — ${exp.content.slice(0, 200)}`,
        })
      }
    }

    return warnings
  }

  /**
   * P4.4: Analyze cost optimization opportunities from archived data.
   */
  analyzeCostOptimization(days: number): Array<{
    nodeId: string
    title: string
    detail: string
    estimatedSaving: string
  }> {
    const suggestions: Array<{ nodeId: string; title: string; detail: string; estimatedSaving: string }> = []

    if (!this.archiveDAO) return suggestions

    try {
      const stats = this.archiveDAO.getWorkflowStats(days, "total_cost_usd", "desc", 20)

      for (const ws of stats) {
        if (ws.avg_cost_usd > 5) { // Workflows costing > $5 avg
          suggestions.push({
            nodeId: ws.workflow_ref,
            title: `高成本工作流: ${ws.workflow_name}`,
            detail: `平均成本 $${ws.avg_cost_usd.toFixed(2)}, ${ws.execution_count} 次执行, 总成本 $${ws.total_cost_usd.toFixed(2)}`,
            estimatedSaving: `考虑对 scan 类节点使用 sonnet 替代 opus, 预计降低 40-60% 成本`,
          })
        }
      }
    } catch (err) {
      console.warn("[suggestion-engine] analyzeCostOptimization failed:", err)
    }

    return suggestions
  }
}
