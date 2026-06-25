import Database from "better-sqlite3"
import { randomUUID } from "crypto"
import { TokenUsageDAO, ExecutionDAO, WorkspaceDAO } from "../db/dao"

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
}
