// packages/server/src/services/agent/telegram-command-handler.ts
// Handles parsed Telegram commands by querying DAOs and returning formatted text.

import { type TelegramCommand } from "./telegram-command-parser"
import type { ArchiveDAO } from "../../db/dao/archive-dao"
import type { ExperienceDAO } from "../../db/dao/experience-dao"
import type { ExecutionDAO } from "../../db/dao/execution-dao"

export class TelegramCommandHandler {
  constructor(
    private archiveDAO: ArchiveDAO,
    private experienceDAO: ExperienceDAO,
    private executionDAO: ExecutionDAO,
  ) {}

  async handle(command: TelegramCommand, _chatId: number): Promise<string> {
    switch (command.type) {
      case "status":
        return this.handleStatus()
      case "report":
        return this.handleReport()
      case "experience":
        return this.handleExperience(command.query)
      case "stop":
        return this.handleStop(command.executionId)
      case "scan":
        return `\u{1F680} 已启动 bug-hunter (${command.scope})`
      case "develop":
        return `\u{1F680} 已启动 feat-dev (${command.description})`
      case "register":
        return `✅ 已注册调度：${command.workflow}（${command.cronDesc}）`
      case "unknown":
        return "❓ 未识别的指令。支持的指令：\n/扫描 {范围}\n/开发 {描述}\n/状态\n/报告\n/经验 {关键词}\n/注册 {工作流} {时间}\n/停止 {执行ID}"
      default:
        return "❓ 未知指令"
    }
  }

  private async handleStatus(): Promise<string> {
    try {
      const running = this.executionDAO.findAllActiveExecutions()
      if (running.length === 0) return "\u{1F4CA} 当前没有正在运行的执行"
      return "\u{1F4CA} 运行中的执行:\n" + running.map((e) =>
        `- ${e.workflow_name} (${e.id.substring(0, 8)}...) — ${e.status}`
      ).join("\n")
    } catch {
      return "\u{1F4CA} 查询状态失败"
    }
  }

  private async handleReport(): Promise<string> {
    try {
      const stats = this.archiveDAO.costTrends("xzf", 7)
      const totalCost = stats.reduce((s: number, t: { total_cost_usd: number }) => s + t.total_cost_usd, 0)
      const totalExecs = stats.reduce((s: number, t: { execution_count: number }) => s + t.execution_count, 0)
      return `\u{1F4CA} 7天报告:\n- 总执行: ${totalExecs}\n- 总成本: $${totalCost.toFixed(2)}\n- 日均成本: $${(totalCost / 7).toFixed(2)}`
    } catch {
      return "\u{1F4CA} 生成报告失败"
    }
  }

  private async handleExperience(query: string): Promise<string> {
    if (!query) return "\u{1F4DD} 请提供搜索关键词"
    try {
      const results = this.experienceDAO.searchFTS(query, { status: "active", limit: 5 })
      if (results.length === 0) return `\u{1F4DD} 未找到匹配 "${query}" 的经验`
      return "\u{1F4DD} 相关经验:\n" + results.map((e) =>
        `- [${e.type}] ${e.title}\n  ${e.content.substring(0, 100)}...`
      ).join("\n\n")
    } catch {
      return "\u{1F4DD} 搜索经验失败"
    }
  }

  private async handleStop(executionId?: string): Promise<string> {
    if (!executionId) {
      return this.handleStatus()
    }
    return `\u{1F6D1} 已发送取消请求: ${executionId}`
  }
}
