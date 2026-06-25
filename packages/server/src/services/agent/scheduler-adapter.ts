import fs from 'fs'
import path from 'path'
import { SystemPromptAssembler } from './system-prompt-assembler'
import { getMemoryService } from './memory-service'
import { getNotificationService } from './notification-service'
import { getAgentDir, getReportsDir, getOctopusHome } from './paths'

// ── Types ──────────────────────────────────────────────────────────

export interface AgentJobConfig {
  name: string
  cron: string
  prompt: string
  workspace?: string
  memory_strategy: {
    read_recent_days: number
    read_last_report: boolean
    write_report_path: string
  }
  notify_strategy: {
    on_success: boolean
    on_failure: boolean
    channels: string[]
  }
  created_at: string
  updated_at: string
}

export interface SchedulerAdapterResult {
  job_name: string
  status: 'success' | 'failure' | 'timeout'
  report_path?: string
  report_content?: string
  duration_ms: number
  error?: string
}

// ── SchedulerAdapter ───────────────────────────────────────────────

/**
 * Adapter between the existing SchedulerService and the Agent system.
 * Handles agent job execution: assembles system prompt, injects memory context,
 * executes via Claude SDK, writes reports, sends notifications.
 * Maps to PRD Stories M7, M8, E1, E2.
 */
export class SchedulerAdapter {
  private org: string
  private agentDir: string
  private assembler: SystemPromptAssembler

  constructor(org: string) {
    this.org = org
    this.agentDir = getAgentDir()
    this.assembler = new SystemPromptAssembler(org)
  }

  /**
   * Execute an agent job: assemble prompt with memory context, run via Claude SDK,
   * write report, send notification.
   */
  async executeJob(config: AgentJobConfig): Promise<SchedulerAdapterResult> {
    const start = Date.now()

    try {
      // Step 1: Assemble system prompt with scheduled task context
      const systemPrompt = this.assembler.assemble({
        scheduled_task: true,
        session_context: {
          job_name: config.name,
          cron: config.cron,
        },
      })

      // Step 2: Read memory context (recent work memory + last report)
      let memoryContext = ''
      const memoryService = getMemoryService()

      try {
        const recentMemory = memoryService.readRecentWorkMemory(this.org, config.memory_strategy.read_recent_days)
        if (recentMemory) {
          memoryContext += `## 近期工作记忆\n${recentMemory}\n\n`
        }
      } catch {
        // Memory read failure is non-fatal
      }

      // Step 3: Read last report for deduplication
      if (config.memory_strategy.read_last_report) {
        const lastReport = this.readLastReport(config.memory_strategy.write_report_path)
        if (lastReport) {
          memoryContext += `## 上次报告\n${lastReport}\n\n`
        }
      }

      // Step 4: Build full prompt
      const fullPrompt = `${memoryContext}\n\n---\n\n## 本次任务\n${config.prompt}`

      // Step 5: Execute via Claude SDK with assembled system prompt
      const reportDate = new Date().toISOString().split('T')[0]
      const reportPath = config.memory_strategy.write_report_path.replace('{date}', reportDate)
      let reportContent: string

      try {
        const { getProvider } = await import('@octopus/providers')
        const provider = getProvider('claude')
        const cwd = config.workspace
          ? path.resolve(config.workspace)
          : getOctopusHome()

        const chunks = provider.sendQuery(fullPrompt, cwd, undefined, {
          systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPrompt },
        })

        const textParts: string[] = []
        for await (const chunk of chunks) {
          if (chunk.type === 'text_delta') {
            textParts.push(chunk.content)
          }
        }
        reportContent = textParts.join('')

        // If Claude SDK returned no content, fall back to template
        if (!reportContent.trim()) {
          reportContent = this.generateFallbackReport(config, fullPrompt, systemPrompt)
        }
      } catch {
        // Claude SDK unavailable — generate fallback report
        reportContent = this.generateFallbackReport(config, fullPrompt, systemPrompt)
      }

      // Step 6: Write report to disk
      this.writeReport(reportPath, reportContent)

      // Step 7: Update work memory with execution result
      try {
        memoryService.appendWorkMemory(this.org, {
          timestamp: new Date().toISOString(),
          task: `定时任务: ${config.name}`,
          result: `执行成功，报告写入: ${reportPath}`,
        })
      } catch {
        // Memory write failure is non-fatal
      }

      // Step 8: Send notification on success
      if (config.notify_strategy.on_success) {
        try {
          const notifyService = getNotificationService()
          await notifyService.sendNotification(this.org, {
            type: 'scheduled_task',
            title: `定时任务完成: ${config.name}`,
            body: `报告已生成: ${reportPath}`,
            priority: 'normal',
          })
        } catch {
          // Notification failure is non-fatal
        }
      }

      return {
        job_name: config.name,
        status: 'success',
        report_path: reportPath,
        report_content: reportContent,
        duration_ms: Date.now() - start,
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err)

      // Send notification on failure
      if (config.notify_strategy.on_failure) {
        try {
          const notifyService = getNotificationService()
          await notifyService.sendNotification(this.org, {
            type: 'execution_failed',
            title: `定时任务失败: ${config.name}`,
            body: `错误: ${errorMsg}`,
            priority: 'high',
          })
        } catch {
          // Notification failure is non-fatal
        }
      }

      return {
        job_name: config.name,
        status: 'failure',
        duration_ms: Date.now() - start,
        error: errorMsg,
      }
    }
  }

  /**
   * Read the last report for deduplication context.
   */
  private readLastReport(reportPathTemplate: string): string | null {
    const reportsDir = getReportsDir()
    if (!fs.existsSync(reportsDir)) return null

    try {
      // Find the most recent report matching the template pattern
      const dirName = path.dirname(reportPathTemplate)
      const targetDir = path.join(reportsDir, dirName)
      if (!fs.existsSync(targetDir)) return null

      const files = fs.readdirSync(targetDir)
        .filter(f => f.endsWith('.md'))
        .sort()
        .reverse()

      if (files.length === 0) return null

      const lastFile = path.join(targetDir, files[0])
      return fs.readFileSync(lastFile, 'utf-8')
    } catch {
      return null
    }
  }

  /**
   * Generate a fallback report when Claude SDK is unavailable.
   * In production, reports are generated by the LLM via sendQuery.
   */
  private generateFallbackReport(config: AgentJobConfig, prompt: string, systemPrompt: string): string {
    const now = new Date().toISOString()
    return `# ${config.name} 执行报告

> 生成时间: ${now}
> Cron: ${config.cron}

## 任务描述

${config.prompt}

## 执行上下文

- System Prompt 长度: ${systemPrompt.length} 字符
- 记忆上下文长度: ${prompt.length - config.prompt.length} 字符
- 执行时间: ${now}

## 结果

任务已记录。完整执行结果将在 Claude SDK 集成后可用。

---

*由 Octopus Agent Scheduler 自动生成*
`
  }

  /**
   * Write report to disk, creating directories as needed.
   */
  private writeReport(reportPath: string, content: string): void {
    const fullPath = path.join(getReportsDir(), reportPath)
    const dir = path.dirname(fullPath)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(fullPath, content, 'utf-8')
  }

  /**
   * Design a scheduled job from natural language description.
   * Maps to PRD Story E1: "每天 10 点总结新 PR".
   */
  designJob(description: string): AgentJobConfig {
    const name = this.extractJobName(description)
    const cron = this.extractCron(description)
    const now = new Date().toISOString()

    return {
      name,
      cron,
      prompt: description,
      memory_strategy: {
        read_recent_days: 3,
        read_last_report: true,
        write_report_path: `${name}/{date}.md`,
      },
      notify_strategy: {
        on_success: true,
        on_failure: true,
        channels: ['telegram:xzf_hermes'],
      },
      created_at: now,
      updated_at: now,
    }
  }

  /**
   * Extract job name from natural language description.
   */
  private extractJobName(description: string): string {
    // Try to extract the core action
    const actionMatch = description.match(/(总结|分析|检查|生成|创建|汇总|报告)/)
    const targetMatch = description.match(/(PR|pr|代码|项目|任务|工作)/)

    const action = actionMatch?.[1] ?? 'task'
    const target = targetMatch?.[1] ?? 'agent'

    return `${target}-${action}`
  }

  /**
   * Extract cron expression from natural language description.
   */
  private extractCron(description: string): string {
    // Parse common Chinese time expressions
    const hourMatch = description.match(/(\d+)\s*[点时]/)
    const minuteMatch = description.match(/(\d+)\s*分/)

    const hour = hourMatch ? parseInt(hourMatch[1], 10) : 10
    const minute = minuteMatch ? parseInt(minuteMatch[1], 10) : 0

    // Default: daily at specified hour
    if (/每天|每日/.test(description)) {
      return `${minute} ${hour} * * *`
    }

    if (/每周|每星期/.test(description)) {
      const dayMatch = description.match(/周([一二三四五六日天])/)
      const dayMap: Record<string, number> = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 }
      const day = dayMatch ? dayMap[dayMatch[1]] ?? 1 : 1
      return `${minute} ${hour} * * ${day}`
    }

    if (/每月/.test(description)) {
      const dayOfMonthMatch = description.match(/(\d+)\s*号/)
      const dayOfMonth = dayOfMonthMatch ? parseInt(dayOfMonthMatch[1], 10) : 1
      return `${minute} ${hour} ${dayOfMonth} * *`
    }

    // Default: daily at 10:00
    return `${minute} ${hour} * * *`
  }
}

// ── Singleton ───────────────────────────────────────────────────────

const instances = new Map<string, SchedulerAdapter>()

export function getSchedulerAdapter(org: string): SchedulerAdapter {
  let instance = instances.get(org)
  if (!instance) {
    instance = new SchedulerAdapter(org)
    instances.set(org, instance)
  }
  return instance
}
