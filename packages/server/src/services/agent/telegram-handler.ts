// packages/server/src/services/agent/telegram-handler.ts
import { parseTelegramCommand, type ParsedCommand } from "./telegram-commands"
import type { ExperienceDAO } from "../../db/dao/experience-dao"
import type { ArchiveDAO } from "../../db/dao/archive-dao"
import type { ExecutionDAO } from "../../db/dao/execution-dao"

export interface TelegramHandlerDeps {
  experienceDAO: ExperienceDAO
  archiveDAO: ArchiveDAO
  executionDAO: ExecutionDAO
  // Hermes/notification service for sending replies
  sendReply: (chatId: number, text: string) => Promise<void>
  // Orchestrator or execution service for triggering workflows
  triggerWorkflow?: (workflowRef: string, inputValues?: Record<string, string>) => Promise<{ executionId: string } | null>
  // Schedule registration
  registerSchedule?: (params: { name: string; cron: string; workflowRef: string }) => Promise<{ id: string } | null>
  // Stop execution
  stopExecution?: (executionId: string) => Promise<boolean>
}

export class TelegramHandler {
  constructor(private deps: TelegramHandlerDeps) {}

  async handleMessage(chatId: number, text: string, from: { id: number; first_name: string; username?: string }): Promise<string> {
    const parsed = parseTelegramCommand(text)
    let reply: string

    switch (parsed.command) {
      case "scan":
        reply = await this.handleScan(parsed.args)
        break
      case "status":
        reply = await this.handleStatus()
        break
      case "report":
        reply = await this.handleReport()
        break
      case "experience":
        reply = await this.handleExperience(parsed.args)
        break
      case "register":
        reply = await this.handleRegister(parsed.args)
        break
      case "stop":
        reply = await this.handleStop(parsed.args)
        break
      case "develop":
        reply = await this.handleDevelop(parsed.args)
        break
      default:
        reply = this.getHelpMessage()
    }

    // Send reply via Hermes
    try {
      await this.deps.sendReply(chatId, reply)
    } catch (err) {
      console.warn(`[telegram] Failed to send reply to chat ${chatId}:`, err)
    }

    return reply
  }

  private async handleScan(args: Record<string, string>): Promise<string> {
    const scope = args.scope || "all"
    if (this.deps.triggerWorkflow) {
      const result = await this.deps.triggerWorkflow("bug-hunter", { scope })
      if (result) {
        return `🚀 已启动 bug-hunter (${scope})\n📋 执行 ID: ${result.executionId}`
      }
    }
    return `🔍 扫描请求: ${scope}\n⚠️ 工作流触发功能暂未完全集成`
  }

  private async handleStatus(): Promise<string> {
    try {
      const running = this.deps.executionDAO.findRunningExecutionIds()
      if (running.length === 0) return "✅ 当前没有运行中的执行"
      const lines = running.slice(0, 10).map(e =>
        `• ${e.workflow_ref} (${e.id.slice(0, 8)}...) — workspace: ${e.workspace_id.slice(0, 8)}...`
      )
      return `🏃 运行中 (${running.length}):\n${lines.join("\n")}`
    } catch {
      return "❌ 查询状态失败"
    }
  }

  private async handleReport(): Promise<string> {
    try {
      const stats = this.deps.archiveDAO.getStats()
      const top = this.deps.archiveDAO.getTopWorkflows(3)
      let msg = `📊 7天报告:\n`
      msg += `• 总执行: ${stats.total_executions}\n`
      msg += `• 成功率: ${(stats.success_rate * 100).toFixed(1)}%\n`
      msg += `• 总成本: $${stats.total_cost_usd.toFixed(2)}\n`
      if (top.length > 0) {
        msg += `\n🏆 Top 工作流:\n`
        top.forEach((w, i) => {
          msg += `${i + 1}. ${w.workflow_name} (${w.execution_count}次, $${w.total_cost_usd.toFixed(2)})\n`
        })
      }
      return msg
    } catch {
      return "❌ 生成报告失败"
    }
  }

  private async handleExperience(args: Record<string, string>): Promise<string> {
    const keyword = args.keyword
    if (!keyword) return "📚 用法: 经验 {关键词}"
    try {
      const results = this.deps.experienceDAO.search(keyword, { status: "active", limit: 5 })
      if (results.length === 0) return `🔍 未找到匹配 "${keyword}" 的经验`
      const icons: Record<string, string> = { bug: "🐛", pattern: "🔧", cost: "💰", failure: "⚠️" }
      const lines = results.map(e =>
        `${icons[e.type] || "📌"} ${e.title}\n  ${e.content.slice(0, 100)}...`
      )
      return `📚 经验搜索结果 (${results.length}):\n${lines.join("\n\n")}`
    } catch {
      return "❌ 搜索失败"
    }
  }

  private async handleRegister(args: Record<string, string>): Promise<string> {
    const { workflow, cron } = args
    if (!workflow) return "📋 用法: 注册 {工作流名} {cron表达式}"
    if (!cron) return "📋 请提供 cron 表达式，如: 注册 bug-hunter 0 2 * * *"

    if (this.deps.registerSchedule) {
      const result = await this.deps.registerSchedule({ name: `tg-${workflow}`, cron, workflowRef: workflow })
      if (result) return `✅ 已注册调度: ${workflow}\n📅 ID: ${result.id}`
      return `❌ 注册失败，工作流 "${workflow}" 可能不存在`
    }
    return "⚠️ 调度注册功能暂未集成"
  }

  private async handleStop(args: Record<string, string>): Promise<string> {
    const { executionId } = args
    if (!executionId) {
      // List running executions for user to choose
      const running = this.deps.executionDAO.findRunningExecutionIds()
      if (running.length === 0) return "✅ 没有运行中的执行"
      const lines = running.slice(0, 5).map(e => `• ${e.id} (${e.workflow_ref})`)
      return `🏃 运行中的执行:\n${lines.join("\n")}\n\n使用: 停止 {执行ID}`
    }
    if (this.deps.stopExecution) {
      const ok = await this.deps.stopExecution(executionId)
      return ok ? `✅ 已停止执行 ${executionId}` : `❌ 未找到执行 ${executionId}`
    }
    return "⚠️ 停止功能暂未集成"
  }

  private async handleDevelop(args: Record<string, string>): Promise<string> {
    const desc = args.description || ""
    if (!desc) return "📋 用法: 开发 {需求描述}"
    if (this.deps.triggerWorkflow) {
      const result = await this.deps.triggerWorkflow("prd-impl", { description: desc })
      if (result) return `🚀 已启动开发工作流\n📝 ${desc}\n📋 执行 ID: ${result.executionId}`
    }
    return `📝 开发请求: ${desc}\n⚠️ 工作流触发功能暂未完全集成`
  }

  private getHelpMessage(): string {
    return `📋 支持的指令:
• 扫描 {scope} — 启动 bug-hunter 扫描
• 开发 {需求} — 启动开发工作流
• 状态 — 查看运行中的执行
• 报告 — 查看 7 天汇总报告
• 经验 {关键词} — 搜索经验库
• 注册 {工作流} {cron} — 注册定时调度
• 停止 [执行ID] — 停止执行`
  }
}
