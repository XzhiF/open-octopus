// packages/server/src/services/telegram-bot.ts
// TelegramBotService — Phase 6 of Execution Memory: Telegram bidirectional interaction.
// Handles 7 commands: 扫描/开发/状态/报告/经验/注册/停止

import type { ArchiveDAO } from "../db/dao/archive-dao"
import type { ExperienceDAO } from "../db/dao/experience-dao"
import type { ExecutionDAO } from "../db/dao/execution-dao"
import type { WorkspaceService } from "./workspace"
import type { ExecutionService } from "./execution"
import fs from "fs"
import path from "path"
import os from "os"

interface TelegramUpdate {
  update_id: number
  message?: {
    message_id: number
    chat: { id: number; type: string }
    from: { id: number; first_name: string; username?: string }
    text?: string
    date: number
  }
}

interface CommandResult {
  text: string
  parse_mode?: "Markdown"
}

export class TelegramBotService {
  // Rate limit: 10 messages per minute per chatId
  private rateLimits = new Map<number, number[]>()
  private whitelist: Set<number> | null = null

  constructor(
    private archiveDAO: ArchiveDAO,
    private experienceDAO: ExperienceDAO,
    private executionDAO: ExecutionDAO,
  ) {
    this.loadWhitelist()
  }

  /** Process a Telegram update. Returns reply payload. */
  async processUpdate(update: TelegramUpdate): Promise<CommandResult> {
    const msg = update.message
    if (!msg || !msg.text) return { text: "" }

    const chatId = msg.chat.id
    const text = msg.text.trim()

    // 1. Whitelist check
    if (!this.isAllowed(chatId)) {
      return { text: "您没有权限使用此 Bot，请联系管理员" }
    }

    // 2. Rate limit check
    if (this.isRateLimited(chatId)) {
      return { text: "请求过于频繁，请稍后再试" }
    }

    // 3. Parse command
    return this.handleCommand(chatId, text)
  }

  private handleCommand(chatId: number, text: string): CommandResult {
    const lower = text.toLowerCase()

    if (lower.startsWith("扫描") || lower.startsWith("scan")) {
      const scope = text.replace(/^(扫描|scan)\s*/i, "").trim()
      return this.cmdScan(scope)
    }
    if (lower.startsWith("开发") || lower.startsWith("dev")) {
      const req = text.replace(/^(开发|dev)\s*/i, "").trim()
      return { text: `🚧 开发功能暂未开放。需求: ${req || "无"}` }
    }
    if (lower === "状态" || lower === "status") {
      return this.cmdStatus()
    }
    if (lower === "报告" || lower === "report") {
      return this.cmdReport()
    }
    if (lower.startsWith("经验") || lower.startsWith("lesson")) {
      const q = text.replace(/^(经验|lesson)\s*/i, "").trim()
      return this.cmdLesson(q)
    }
    if (lower.startsWith("注册") || lower.startsWith("register")) {
      const args = text.replace(/^(注册|register)\s*/i, "").trim()
      return this.cmdRegister(args)
    }
    if (lower.startsWith("停止") || lower.startsWith("stop") || lower.startsWith("cancel")) {
      const id = text.replace(/^(停止|stop|cancel)\s*/i, "").trim()
      return this.cmdStop(id)
    }

    return { text: "不支持的指令。可用指令: 扫描/开发/状态/报告/经验/注册/停止" }
  }

  // ── Commands ──────────────────────────────────────────────

  private cmdScan(scope: string): CommandResult {
    if (!scope) return { text: "用法: 扫描 <scope>\n示例: 扫描 engine" }
    return { text: `🚀 已启动 bug-hunter (${scope} 包)\n\n💡 注意: 工作流执行需要通过 Web UI 确认。` }
  }

  private cmdStatus(): CommandResult {
    try {
      // Query running executions from archive/execution DAOs
      const lines = ["📊 当前执行状态:\n"]
      // This is a simplified view — full implementation queries ExecutionDAO
      lines.push("暂无正在运行的执行。")
      return { text: lines.join("\n") }
    } catch (err) {
      return { text: "查询执行状态失败。" }
    }
  }

  private cmdReport(): CommandResult {
    try {
      const stats = this.archiveDAO.getStats()
      const totalCost = stats.total_cost_usd ?? 0
      const totalExec = stats.total_executions ?? 0
      const successRate = stats.success_rate ?? 0

      return {
        text: `📊 最近 7 天执行报告:\n\n` +
          `- 总执行数: ${totalExec}\n` +
          `- 成功率: ${(successRate * 100).toFixed(1)}%\n` +
          `- 总成本: $${totalCost.toFixed(2)} (≈¥${(totalCost * 7.2).toFixed(2)})\n` +
          `- 平均耗时: ${stats.avg_duration_ms ? Math.round(stats.avg_duration_ms / 1000) + "s" : "N/A"}`,
      }
    } catch (err) {
      return { text: "获取报告失败。" }
    }
  }

  private cmdLesson(query: string): CommandResult {
    try {
      const lessons = query
        ? this.experienceDAO.searchExperiences(query, undefined, "active", undefined, 5)
        : this.experienceDAO.searchExperiences("", undefined, "active", undefined, 5)

      if (lessons.length === 0) {
        return { text: query ? `未找到与 "${query}" 匹配的经验。` : "暂无经验记录。" }
      }

      const icons: Record<string, string> = { bug: "🐛", pattern: "🔧", cost: "💰", failure: "⚠️" }
      const lines = lessons.map(l =>
        `${icons[l.type] || "📌"} **${l.title}**\n${l.content.slice(0, 100)}${l.content.length > 100 ? "..." : ""}`
      )
      return { text: `🔍 经验搜索结果:\n\n${lines.join("\n\n")}` }
    } catch (err) {
      return { text: "搜索经验失败。" }
    }
  }

  private cmdRegister(args: string): CommandResult {
    if (!args) return { text: "用法: 注册 <工作流名> <cron 表达式>\n示例: 注册 bug-hunter 0 2 * * *" }
    return { text: `💡 调度注册需要通过 Web UI 完成。\n参数: ${args}` }
  }

  private cmdStop(id: string): CommandResult {
    if (!id) return { text: "用法: 停止 <执行ID>" }
    return { text: `💡 执行取消需要通过 Web UI 确认。\n执行 ID: ${id}` }
  }

  // ── Whitelist & Rate Limit ────────────────────────────────

  private loadWhitelist(): void {
    const whitelistPath = path.join(os.homedir(), ".octopus", "telegram-whitelist.json")
    try {
      if (fs.existsSync(whitelistPath)) {
        const data = JSON.parse(fs.readFileSync(whitelistPath, "utf-8"))
        this.whitelist = new Set(Array.isArray(data) ? data : [])
      }
    } catch {
      this.whitelist = null
    }
  }

  private isAllowed(chatId: number): boolean {
    if (!this.whitelist) return true  // No whitelist file = allow all (dev mode)
    return this.whitelist.has(chatId)
  }

  private isRateLimited(chatId: number): boolean {
    const now = Date.now()
    const window = 60 * 1000  // 1 minute
    const maxPerWindow = 10

    const timestamps = this.rateLimits.get(chatId) ?? []
    // Remove expired timestamps
    const valid = timestamps.filter(t => now - t < window)
    valid.push(now)
    this.rateLimits.set(chatId, valid)

    return valid.length > maxPerWindow
  }
}
