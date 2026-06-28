import Database from "better-sqlite3"
import { randomUUID } from "crypto"
import { TokenUsageDAO, ExecutionDAO, WorkspaceDAO, ExperienceDAO, ArchiveDAO } from "../db/dao"
import { getDb } from "../db/connection"

export interface Suggestion {
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

  constructor() {
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
   * P5.2: Detect repeating bug patterns from experience index.
   * Uses Jaccard similarity on bug content to cluster related bugs,
   * not just exact project+package matching.
   */
  analyzeRepeatingPatterns(org: string, days: number = 7): Suggestion[] {
    try {
      const expDAO = new ExperienceDAO(getDb())
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
      const bugs = expDAO.searchFTS("bug", {
        org,
        type: "bug",
        status: "active",
        limit: 100,
      }).filter(e => e.created_at >= cutoff)

      if (bugs.length < 3) return []

      // Tokenize bug content (title + content) for Jaccard similarity
      const tokenize = (text: string): Set<string> => {
        const words = (text ?? "").toLowerCase()
          .replace(/[^\w一-鿿]/g, " ")
          .split(/\s+/)
          .filter(w => w.length > 1)
        return new Set(words)
      }

      const jaccard = (a: Set<string>, b: Set<string>): number => {
        if (a.size === 0 && b.size === 0) return 1
        let intersection = 0
        for (const word of a) if (b.has(word)) intersection++
        const union = a.size + b.size - intersection
        return union === 0 ? 0 : intersection / union
      }

      // Build similarity clusters: merge bugs with Jaccard > 0.6
      const tokenSets = bugs.map(b => tokenize(`${b.title} ${b.content}`))
      const clusters: number[][] = []
      const assigned = new Set<number>()

      for (let i = 0; i < bugs.length; i++) {
        if (assigned.has(i)) continue
        const cluster = [i]
        assigned.add(i)
        for (let j = i + 1; j < bugs.length; j++) {
          if (assigned.has(j)) continue
          // Check similarity with any member of the cluster
          const similar = cluster.some(k => jaccard(tokenSets[k], tokenSets[j]) > 0.6)
          if (similar) {
            cluster.push(j)
            assigned.add(j)
          }
        }
        if (cluster.length >= 3) {
          clusters.push(cluster)
        }
      }

      const suggestions: Suggestion[] = []
      for (const cluster of clusters) {
        const items = cluster.map(i => bugs[i])
        const projects = [...new Set(items.map(b => b.project ?? "unknown"))]
        const packages = [...new Set(items.map(b => b.package ?? "unknown"))]
        suggestions.push({
          ruleName: "RepeatingBugPattern",
          severity: "warning",
          title: `重复 BUG 模式: ${projects.join(",")}/${packages.join(",")}`,
          detection: `过去 ${days} 天发现 ${items.length} 个相似 BUG (Jaccard > 0.6)`,
          diagnosis: "相似内容的 BUG 反复出现，可能存在系统性缺陷",
          prescription: "建议进行系统性代码审查，关注共同的根因",
          impactEstimate: `${items.length} 个 BUG 待修复`,
        })
      }
      return suggestions
    } catch {
      return []
    }
  }

  /**
   * P5.3: Detect workflows with high failure rates from execution archive.
   * Clusters failures by failed_nodes + error_message for root-cause analysis.
   */
  analyzeFailurePatterns(org: string): Suggestion[] {
    try {
      const archiveDAO = new ArchiveDAO(getDb())
      const stats = archiveDAO.aggregateByWorkflow(org, 30)
      const suggestions: Suggestion[] = []

      for (const wf of stats) {
        const failRate = wf.failed_count / wf.execution_count
        if (failRate > 0.3 && wf.execution_count >= 5) {
          // Fetch individual failed executions for clustering
          const failed = archiveDAO.listExecutionArchives({
            org,
            workflow: wf.workflow_ref,
            status: "failed",
            page: 1,
            pageSize: 100,
          })

          // Cluster by failed_nodes + error_message pattern
          const patternCounts = new Map<string, { count: number; sampleError: string; sampleNodes: string }>()
          for (const exec of failed.data) {
            const nodes = exec.failed_nodes ?? "unknown"
            // Normalize error message: strip variable parts (IDs, paths, timestamps)
            const errorMsg = (exec.error_message ?? "unknown")
              .replace(/[0-9a-f]{8,}/gi, "*")
              .replace(/\/[\w/.-]+/g, "*")
              .substring(0, 120)
            const key = `${nodes}::${errorMsg}`
            const existing = patternCounts.get(key)
            if (existing) {
              existing.count++
            } else {
              patternCounts.set(key, { count: 1, sampleError: exec.error_message ?? "unknown", sampleNodes: nodes })
            }
          }

          // Report patterns with count >= 2 (recurring failures)
          for (const [key, info] of patternCounts) {
            if (info.count >= 2) {
              suggestions.push({
                ruleName: "RepeatingFailurePattern",
                severity: "critical",
                title: `工作流 ${wf.workflow_name} 重复失败模式`,
                detection: `失败节点: ${info.sampleNodes}，出现 ${info.count} 次`,
                diagnosis: `错误信息: ${info.sampleError.substring(0, 200)}`,
                prescription: "检查失败节点的错误日志，修复根本原因或添加重试机制",
                impactEstimate: `${info.count} 次失败，预计修复可节省 $${(wf.total_cost_usd * info.count / wf.execution_count).toFixed(2)} / 30天`,
              })
            }
          }

          // Also report overall high failure rate
          if (patternCounts.size === 0 || failRate > 0.5) {
            suggestions.push({
              ruleName: "HighFailureRate",
              severity: "critical",
              title: `工作流 ${wf.workflow_name} 失败率过高`,
              detection: `过去 30 天: ${wf.execution_count} 次执行, ${wf.failed_count} 次失败 (${(failRate * 100).toFixed(0)}%)`,
              diagnosis: "该工作流频繁失败，可能存在配置或代码问题",
              prescription: "检查失败节点的错误日志，修复根本原因",
              impactEstimate: `预计可节省 $${(wf.total_cost_usd * failRate).toFixed(2)} / 30天`,
            })
          }
        }
      }
      return suggestions
    } catch {
      return []
    }
  }

  /**
   * P5.3: Detect workflows with high average cost from execution archive.
   */
  analyzeCostOptimization(org: string): Suggestion[] {
    try {
      const archiveDAO = new ArchiveDAO(getDb())
      const stats = archiveDAO.aggregateByWorkflow(org, 30)
      const suggestions: Suggestion[] = []

      for (const wf of stats) {
        const avgCost = wf.total_cost_usd / wf.execution_count
        if (avgCost > 1.0) {
          suggestions.push({
            ruleName: "HighCostWorkflow",
            severity: "info",
            title: `工作流 ${wf.workflow_name} 成本偏高`,
            detection: `平均每次执行 $${avgCost.toFixed(2)}, 总计 $${wf.total_cost_usd.toFixed(2)}`,
            diagnosis: "该工作流消耗较多 token，可能存在优化空间",
            prescription: "考虑使用更经济的模型 (Haiku) 或优化 prompt 减少 token 消耗",
            impactEstimate: `降至 $${(avgCost * 0.5).toFixed(2)} 可节省 $${(wf.total_cost_usd * 0.5).toFixed(2)} / 30天`,
          })
        }
      }
      return suggestions
    } catch {
      return []
    }
  }
}
