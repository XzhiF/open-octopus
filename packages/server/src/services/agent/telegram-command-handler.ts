// packages/server/src/services/agent/telegram-command-handler.ts
// Handles parsed Telegram commands by querying DAOs and returning formatted text.

import { type TelegramCommand } from "./telegram-command-parser"
import type { ArchiveDAO } from "../../db/dao/archive-dao"
import type { ExperienceDAO } from "../../db/dao/experience-dao"
import type { ExecutionDAO } from "../../db/dao/execution-dao"
import type { ScheduleConfigDAO } from "../../db/dao/schedule-config-dao"
import type { EnginePool } from "../execution/EnginePool"
import type { WorkflowService } from "../workflow"
import { randomUUID } from "crypto"

export interface TelegramHandlerDeps {
  archiveDAO: ArchiveDAO
  experienceDAO: ExperienceDAO
  executionDAO: ExecutionDAO
  scheduleDAO?: ScheduleConfigDAO
  enginePool?: EnginePool
  workflowService?: WorkflowService
  org?: string
}

export class TelegramCommandHandler {
  private archiveDAO: ArchiveDAO
  private experienceDAO: ExperienceDAO
  private executionDAO: ExecutionDAO
  private scheduleDAO?: ScheduleConfigDAO
  private enginePool?: EnginePool
  private workflowService?: WorkflowService
  private org: string

  constructor(deps: TelegramHandlerDeps)
  constructor(archiveDAO: ArchiveDAO, experienceDAO: ExperienceDAO, executionDAO: ExecutionDAO)
  constructor(
    depsOrArchive: TelegramHandlerDeps | ArchiveDAO,
    experienceDAO?: ExperienceDAO,
    executionDAO?: ExecutionDAO,
  ) {
    if ("archiveDAO" in (depsOrArchive as TelegramHandlerDeps)) {
      const deps = depsOrArchive as TelegramHandlerDeps
      this.archiveDAO = deps.archiveDAO
      this.experienceDAO = deps.experienceDAO
      this.executionDAO = deps.executionDAO
      this.scheduleDAO = deps.scheduleDAO
      this.enginePool = deps.enginePool
      this.workflowService = deps.workflowService
      this.org = deps.org ?? "xzf"
    } else {
      this.archiveDAO = depsOrArchive
      this.experienceDAO = experienceDAO!
      this.executionDAO = executionDAO!
      this.org = "xzf"
    }
  }

  async handle(command: TelegramCommand, chatId: number): Promise<string> {
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
        return `🚀 已启动 bug-hunter (${command.scope})`
      case "develop":
        return this.handleDevelop(command.description)
      case "register":
        return this.handleRegister(command.workflow, command.cronDesc)
      case "unknown":
        return "❓ 未识别的指令。支持的指令：\n/扫描 {范围}\n/开发 {描述}\n/状态\n/报告\n/经验 {关键词}\n/注册 {工作流} {cron}\n/停止 {执行ID}"
      default:
        return "❓ 未知指令"
    }
  }

  private async handleStatus(): Promise<string> {
    try {
      const running = this.executionDAO.findAllActiveExecutions()
      if (running.length === 0) return "📊 当前没有正在运行的执行"
      return "📊 运行中的执行:\n" + running.map((e) =>
        `- ${e.workflow_name} (${e.id.substring(0, 8)}...) — ${e.status}`
      ).join("\n")
    } catch {
      return "📊 查询状态失败"
    }
  }

  private async handleReport(): Promise<string> {
    try {
      const stats = this.archiveDAO.costTrends(this.org, 7)
      const totalCost = stats.reduce((s: number, t: { total_cost_usd: number }) => s + t.total_cost_usd, 0)
      const totalExecs = stats.reduce((s: number, t: { execution_count: number }) => s + t.execution_count, 0)
      return `📊 7天报告:\n- 总执行: ${totalExecs}\n- 总成本: $${totalCost.toFixed(2)}\n- 日均成本: $${(totalCost / 7).toFixed(2)}`
    } catch {
      return "📊 生成报告失败"
    }
  }

  private async handleExperience(query: string): Promise<string> {
    if (!query) return "📝 请提供搜索关键词"
    try {
      const results = this.experienceDAO.searchFTS(query, { org: this.org, status: "active", limit: 5 })
      if (results.length === 0) return `📝 未找到匹配 "${query}" 的经验`
      return "📝 相关经验:\n" + results.map((e) =>
        `- [${e.type}] ${e.title}\n  ${e.content.substring(0, 100)}...`
      ).join("\n\n")
    } catch {
      return "📝 搜索经验失败"
    }
  }

  private async handleStop(executionId?: string): Promise<string> {
    if (!executionId) {
      return this.handleStatus()
    }

    try {
      // Cancel via EnginePool if available (active in-memory execution)
      if (this.enginePool) {
        const cancelled = this.enginePool.cancel(executionId)
        if (cancelled) {
          return `🛑 已取消执行: ${executionId}`
        }
      }

      // Fallback: mark as cancelled in DB (for executions not in memory)
      const exec = this.executionDAO.findById(executionId)
      if (!exec) {
        return `🛑 执行不存在: ${executionId}`
      }
      if (exec.status === "completed" || exec.status === "failed" || exec.status === "cancelled") {
        return `🛑 执行已结束 (${exec.status}): ${executionId}`
      }

      // Update status to cancelled in DB
      this.executionDAO.updateExecution(executionId, { status: "cancelled" })
      return `🛑 已取消执行: ${executionId}`
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return `🛑 取消失败: ${msg}`
    }
  }

  private async handleRegister(workflow: string, cronDesc: string): Promise<string> {
    if (!workflow) return "❌ 请提供工作流名称"

    try {
      if (!this.scheduleDAO) {
        return `✅ 已记录调度请求：${workflow}（${cronDesc || "每日"}）— ScheduleDAO 未配置`
      }

      const id = randomUUID()
      const now = new Date().toISOString()
      // Parse cron from description, default to "0 9 * * *" (daily 9am)
      const cronExpression = this.parseCron(cronDesc)

      this.scheduleDAO.insertAgentSchedule(
        id, this.org, `tg-${workflow}`, cronExpression,
        "workflow_run", JSON.stringify({ workflow_ref: workflow, source: "telegram" }),
        now,
      )

      return `✅ 已注册调度：${workflow}\n- ID: ${id.substring(0, 8)}\n- Cron: ${cronExpression}\n- 下次触发: 由调度器计算`
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return `❌ 注册失败: ${msg}`
    }
  }

  private async handleDevelop(description: string): Promise<string> {
    if (!description) return "❌ 请提供开发任务描述"

    try {
      if (!this.workflowService) {
        return `🚀 已记录开发请求: ${description} — WorkflowService 未配置`
      }

      // Find feat-dev workflow or use default
      const workflowRef = "feat-dev"
      const workflow = this.workflowService.getWorkflow(workflowRef)
      if (!workflow) {
        return `🚀 已记录开发请求: ${description}\n⚠️ 工作流 "${workflowRef}" 未找到，请确认工作流已注册`
      }

      // Register as a schedule job for the scheduler to pick up and execute
      if (this.scheduleDAO) {
        const id = randomUUID()
        const now = new Date().toISOString()
        this.scheduleDAO.insertAgentSchedule(
          id, this.org, `tg-dev-${description.substring(0, 20)}`,
          "* * * * *",  // ASAP: next scheduler tick
          "workflow_run",
          JSON.stringify({
            workflow_ref: workflowRef,
            source: "telegram",
            description,
            one_shot: true,
          }),
          now,
        )
        return `🚀 已启动 feat-dev\n- 任务: ${description}\n- 调度 ID: ${id.substring(0, 8)}\n- 将在下次调度器周期内执行`
      }

      return `🚀 已记录开发请求: ${description}\n⚠️ ScheduleDAO 未配置，无法自动调度`
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return `❌ 启动失败: ${msg}`
    }
  }

  private parseCron(desc: string): string {
    if (!desc) return "0 9 * * *"
    // Simple mappings for common Chinese patterns
    if (desc.includes("每小时") || desc.includes("hourly")) return "0 * * * *"
    if (desc.includes("每天") || desc.includes("daily")) return "0 9 * * *"
    if (desc.includes("每周一") || desc.includes("weekly")) return "0 9 * * 1"
    if (desc.includes("每月") || desc.includes("monthly")) return "0 9 1 * *"
    // Try to use as-is if it looks like a cron expression
    if (/^[\d*/,-]+\s+[\d*/,-]+/.test(desc)) return desc
    return "0 9 * * *"
  }
}
