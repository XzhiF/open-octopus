import fs from 'fs'
import path from 'path'
import os from 'os'
import type { IAgentProvider, MessageChunk } from '@octopus/providers'
import { getProvider } from '@octopus/providers'
import { SystemPromptAssembler } from './system-prompt-assembler'
import { getMemoryService } from './memory-service'
import { getNotificationService } from './notification-service'
import { getAgentDir } from './paths'
import type { ExperienceDAO } from '../../db/dao/experience-dao'
import type { ArchiveDAO } from '../../db/dao/archive-dao'

// ── Types ──────────────────────────────────────────────────────────

export type IntentType = 'single_task' | 'scheduled_task' | 'info_query' | 'clone_management' | 'general_chat'

export interface IntentClassification {
  intent: IntentType
  confidence: number
  reasoning: string
}

export interface WorkflowMatch {
  workflow_path: string
  workflow_name: string
  score: number
  reason: string
}

export interface OrchestratorResult {
  intent: IntentClassification
  workflow?: WorkflowMatch
  generated_workflow?: GeneratedWorkflow
  workspace?: { name: string; path: string }
  inputs: Record<string, string>
  execution_id?: string
  summary: string
  experiences?: Array<{ type: string; title: string; content: string }>
  recentExecutions?: Array<{ workflow_name: string; status: string; cost_usd: number }>
}

export interface GeneratedWorkflow {
  workflow_name: string
  yaml: string
  file_path: string
  valid: boolean
  validation_errors: string[]
}

export interface OrchestrationEvent {
  type: 'intent_classified' | 'workflow_selected' | 'workflow_generated' | 'workspace_created' | 'execution_started' | 'execution_completed' | 'execution_failed' | 'text_delta' | 'tool_call' | 'status' | 'error'
  data: unknown
  timestamp: string
}

// ── OrchestratorService ────────────────────────────────────────────

/**
 * Core orchestration engine: classifies user intent, selects/generates workflows,
 * organizes inputs, creates workspaces, and triggers execution.
 * Maps to PRD Story B1, B3, B4, B5.
 */
export class OrchestratorService {
  private org: string
  private agentDir: string
  private assembler: SystemPromptAssembler
  private experienceDAO?: ExperienceDAO
  private archiveDAO?: ArchiveDAO

  constructor(org: string, experienceDAO?: ExperienceDAO, archiveDAO?: ArchiveDAO) {
    this.org = org
    this.agentDir = getAgentDir()
    this.assembler = new SystemPromptAssembler(org)
    this.experienceDAO = experienceDAO
    this.archiveDAO = archiveDAO
  }

  setExperienceDAO(dao: ExperienceDAO): void { this.experienceDAO = dao }
  setArchiveDAO(dao: ArchiveDAO): void { this.archiveDAO = dao }

  /**
   * Classify user intent from a natural language message.
   * Uses SKILL-guided classification rules embedded in the orchestrator SKILL.
   */
  classifyIntent(message: string): IntentClassification {
    const lowerMsg = message.toLowerCase()

    // Scheduled task patterns (Story E1)
    const scheduledPatterns = [
      /每天|每日|定时|cron|定期|每周|每月|凌晨|上午\d+点|下午\d+点|\d+点/,
      /schedule|periodic|recurring|interval/,
    ]
    for (const pattern of scheduledPatterns) {
      if (pattern.test(message) || pattern.test(lowerMsg)) {
        return {
          intent: 'scheduled_task',
          confidence: 0.9,
          reasoning: `消息匹配定时任务模式: ${pattern.source}`,
        }
      }
    }

    // Clone management patterns (Story D1-D7)
    const clonePatterns = [
      /分身|clone|创建分身|委派|delegate|merge.*分身|合并分身/,
      /前端分身|后端分身|parallel.*task/,
    ]
    for (const pattern of clonePatterns) {
      if (pattern.test(message) || pattern.test(lowerMsg)) {
        return {
          intent: 'clone_management',
          confidence: 0.85,
          reasoning: `消息匹配分身管理模式: ${pattern.source}`,
        }
      }
    }

    // Information query patterns (Story C1)
    const queryPatterns = [
      /昨天做了什么|上次|历史|查看.*记录|搜索|回忆|之前|最近.*做了/,
      /what did|history|search|recall|previously/,
    ]
    for (const pattern of queryPatterns) {
      if (pattern.test(message) || pattern.test(lowerMsg)) {
        return {
          intent: 'info_query',
          confidence: 0.85,
          reasoning: `消息匹配信息查询模式: ${pattern.source}`,
        }
      }
    }

    // Single task patterns (Story B1)
    const taskPatterns = [
      /给.*加|添加|创建|实现|开发|修复|重构|部署|配置/,
      /add|create|implement|develop|fix|refactor|deploy|build/,
    ]
    for (const pattern of taskPatterns) {
      if (pattern.test(message) || pattern.test(lowerMsg)) {
        return {
          intent: 'single_task',
          confidence: 0.8,
          reasoning: `消息匹配单次任务模式: ${pattern.source}`,
        }
      }
    }

    // Default: general chat
    return {
      intent: 'general_chat',
      confidence: 0.7,
      reasoning: '未匹配特定模式，归类为通用对话',
    }
  }

  /**
   * Search available workflows in the workspace for a match.
   */
  selectWorkflow(intent: IntentClassification, message: string): WorkflowMatch | null {
    const workflowsDir = path.join(os.homedir(), '.octopus', 'orgs', this.org, 'workspaces')
    const candidates: WorkflowMatch[] = []

    // Scan workspace workflows directory
    if (fs.existsSync(workflowsDir)) {
      try {
        const entries = fs.readdirSync(workflowsDir, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const wsWorkflowsDir = path.join(workflowsDir, entry.name, 'workflows')
            if (fs.existsSync(wsWorkflowsDir)) {
              const yamlFiles = fs.readdirSync(wsWorkflowsDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
              for (const yamlFile of yamlFiles) {
                const score = this.scoreWorkflowMatch(yamlFile, message, intent)
                if (score > 0.3) {
                  candidates.push({
                    workflow_path: path.join(wsWorkflowsDir, yamlFile),
                    workflow_name: yamlFile.replace(/\.(yaml|yml)$/, ''),
                    score,
                    reason: `文件名匹配度: ${score.toFixed(2)}`,
                  })
                }
              }
            }
          }
        }
      } catch {
        // Non-fatal: workflow scan failure degrades to no match
      }
    }

    // Also check core-pack workflows
    const coreWorkflowsDir = path.join(process.cwd(), 'packages', 'core-pack', 'workflows')
    if (fs.existsSync(coreWorkflowsDir)) {
      try {
        const yamlFiles = fs.readdirSync(coreWorkflowsDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
        for (const yamlFile of yamlFiles) {
          const score = this.scoreWorkflowMatch(yamlFile, message, intent)
          if (score > 0.3) {
            candidates.push({
              workflow_path: path.join(coreWorkflowsDir, yamlFile),
              workflow_name: yamlFile.replace(/\.(yaml|yml)$/, ''),
              score,
              reason: `core-pack 工作流匹配: ${score.toFixed(2)}`,
            })
          }
        }
      } catch {
        // Non-fatal
      }
    }

    // Return best match
    candidates.sort((a, b) => b.score - a.score)
    return candidates[0] ?? null
  }

  /**
   * Score how well a workflow file matches the user's intent.
   */
  private scoreWorkflowMatch(filename: string, message: string, intent: IntentClassification): number {
    const lowerName = filename.toLowerCase()
    const lowerMsg = message.toLowerCase()
    let score = 0

    // Intent-based matching
    if (intent.intent === 'single_task') {
      if (lowerName.includes('prd-impl') || lowerName.includes('impl') || lowerName.includes('dev')) score += 0.4
      if (lowerName.includes('feature') || lowerName.includes('feat')) score += 0.3
    } else if (intent.intent === 'scheduled_task') {
      if (lowerName.includes('sched') || lowerName.includes('cron') || lowerName.includes('periodic')) score += 0.5
    }

    // Keyword extraction from message
    const keywords = lowerMsg.match(/[一-龥a-z]+/g) ?? []
    for (const kw of keywords) {
      if (kw.length >= 2 && lowerName.includes(kw)) score += 0.1
    }

    return Math.min(score, 1.0)
  }

  /**
   * Organize inputs for a workflow based on the user message and intent.
   */
  organizeInputs(message: string, intent: IntentClassification, workflow?: WorkflowMatch): Record<string, string> {
    const inputs: Record<string, string> = {
      requirement: message,
      intent_type: intent.intent,
    }

    // Extract target scope from message
    const targetMatch = message.match(/给\s*(\S+)\s*(加|添加|创建|实现|修复)/)
    if (targetMatch) {
      inputs.target_scope = targetMatch[1]
    }

    // For scheduled tasks, extract cron-related info
    if (intent.intent === 'scheduled_task') {
      const timeMatch = message.match(/(\d+)\s*点/)
      if (timeMatch) {
        inputs.schedule_hour = timeMatch[1]
      }
      inputs.task_description = message
    }

    return inputs
  }

  /**
   * Generate a dynamic workflow YAML when no existing workflow matches.
   * Called as fallback when selectWorkflow returns null for task intents.
   */
  generateWorkflow(message: string, intent: IntentClassification): GeneratedWorkflow {
    const workflowName = `dynamic-${Date.now().toString(36)}`
    const workflowDir = path.join(this.agentDir, 'workflows')
    if (!fs.existsSync(workflowDir)) {
      fs.mkdirSync(workflowDir, { recursive: true })
    }

    const nodes = this.buildWorkflowNodes(intent, message)
    const yamlContent = `# Dynamic workflow generated by Agent
# Task: ${message}
# Generated: ${new Date().toISOString()}
name: ${workflowName}
description: "${message.slice(0, 200)}"

nodes:
${nodes.map(n => `  - id: ${n.id}
    type: ${n.type}${n.depends_on ? `\n    depends_on: [${n.depends_on.join(', ')}]` : ''}
    prompt: |
      ${n.prompt}`).join('\n\n')}
`

    // Validate YAML syntax
    let valid = true
    const validationErrors: string[] = []
    try {
      // Basic YAML validation: check for required structure
      if (!workflowName) validationErrors.push('Missing name')
      if (nodes.length === 0) validationErrors.push('No nodes generated')
    } catch {
      valid = false
      validationErrors.push('Generation failed')
    }

    const filePath = path.join(workflowDir, `${workflowName}.yaml`)
    fs.writeFileSync(filePath, yamlContent, 'utf-8')

    return {
      workflow_name: workflowName,
      yaml: yamlContent,
      file_path: filePath,
      valid,
      validation_errors: validationErrors,
    }
  }

  /**
   * Build workflow nodes based on intent type.
   */
  private buildWorkflowNodes(intent: IntentClassification, message: string): Array<{
    id: string; type: string; depends_on?: string[]; prompt: string
  }> {
    if (intent.intent === 'scheduled_task') {
      return [
        {
          id: 'design_schedule',
          type: 'agent',
          prompt: `分析定时任务需求: ${message}\n确定 cron 表达式和执行策略。`,
        },
        {
          id: 'register_job',
          type: 'agent',
          depends_on: ['design_schedule'],
          prompt: `根据设计方案注册定时任务:\n$design_schedule.output`,
        },
        {
          id: 'verify_schedule',
          type: 'agent',
          depends_on: ['register_job'],
          prompt: `验证定时任务注册成功，检查 cron 表达式合法性。`,
        },
      ]
    }

    if (intent.intent === 'clone_management') {
      return [
        {
          id: 'analyze_clones',
          type: 'agent',
          prompt: `分析分身管理需求: ${message}\n确定需要创建/使用哪些分身。`,
        },
        {
          id: 'execute_clone_ops',
          type: 'agent',
          depends_on: ['analyze_clones'],
          prompt: `执行分身操作:\n$analyze_clones.output`,
        },
      ]
    }

    // Default: single_task workflow (analyze → implement → verify)
    return [
      {
        id: 'analyze',
        type: 'agent',
        prompt: `分析需求: ${message}\n制定实现方案并输出步骤清单。`,
      },
      {
        id: 'implement',
        type: 'agent',
        depends_on: ['analyze'],
        prompt: `根据分析结果执行实现:\n$analyze.output`,
      },
      {
        id: 'verify',
        type: 'agent',
        depends_on: ['implement'],
        prompt: `验证实现结果:\n- 构建是否通过\n- 测试是否通过\n- 代码质量检查`,
      },
    ]
  }

  /**
   * Main orchestration entry point: classify → select → organize → (execute).
   * Returns orchestration result for the chat endpoint to act on.
   */
  async orchestrate(
    message: string,
    sessionId: string,
    onEvent?: (event: OrchestrationEvent) => void,
  ): Promise<OrchestratorResult> {
    const emitEvent = (type: OrchestrationEvent['type'], data: unknown) => {
      onEvent?.({ type, data, timestamp: new Date().toISOString() })
    }

    // Step 1: Classify intent
    const intent = this.classifyIntent(message)
    emitEvent('intent_classified', intent)

    // Step 1.5: Experience injection (P4.1)
    let injectedExperiences: Array<{ type: string; title: string; content: string }> = []
    let injectedRecentExecutions: Array<{ workflow_name: string; status: string; cost_usd: number }> = []
    try {
      if (this.experienceDAO) {
        const keywords = message.slice(0, 100) // Use first 100 chars as FTS query
        const experiences = this.experienceDAO.search(keywords, { status: 'active', limit: 5 })
        // Also get recent archive records
        const recentArchives = this.archiveDAO?.getRecentByOrg(this.org, 3) || []

        // Inject into orchestration context
        injectedExperiences = experiences.map(e => ({
          type: e.type, title: e.title, content: e.content.slice(0, 300),
        }))
        injectedRecentExecutions = recentArchives.map(a => ({
          workflow_name: a.workflow_name, status: a.status, cost_usd: a.total_cost_usd,
        }))
      }
    } catch (err) {
      console.warn("[orchestrator] Experience injection failed:", err)
      // Continue without experiences
    }

    // Step 2: Select workflow (for single_task and scheduled_task)
    let workflow: WorkflowMatch | undefined
    let generatedWorkflow: GeneratedWorkflow | undefined
    if (intent.intent === 'single_task' || intent.intent === 'scheduled_task') {
      const match = this.selectWorkflow(intent, message)
      if (match) {
        workflow = match
        emitEvent('workflow_selected', workflow)
      } else {
        // B3: No matching workflow found — generate one dynamically
        generatedWorkflow = this.generateWorkflow(message, intent)
        if (generatedWorkflow.valid) {
          workflow = {
            workflow_path: generatedWorkflow.file_path,
            workflow_name: generatedWorkflow.workflow_name,
            score: 0.5,
            reason: '动态生成工作流',
          }
          emitEvent('workflow_generated', generatedWorkflow)
          emitEvent('workflow_selected', workflow)
        }
      }
    }

    // Step 3: Organize inputs
    const inputs = this.organizeInputs(message, intent, workflow)

    // Step 4: For info_query, read from memory
    if (intent.intent === 'info_query') {
      try {
        const memoryService = getMemoryService()
        const memoryContent = memoryService.readRecentWorkMemory(this.org, 3)
        if (memoryContent) {
          inputs.memory_context = memoryContent
        }
      } catch {
        // Memory read failure is non-fatal
      }
    }

    // Step 5: Write work memory entry
    try {
      const memoryService = getMemoryService()
      memoryService.appendWorkMemory(this.org, {
        timestamp: new Date().toISOString(),
        task: message,
        result: `意图分类: ${intent.intent}, 工作流: ${workflow?.workflow_name ?? '无匹配'}`,
      })
    } catch {
      // Memory write failure is non-fatal
    }

    // Build summary
    const summary = this.buildSummary(intent, workflow, inputs)

    // Notify via hermes for key events
    if (workflow) {
      try {
        const notifyService = getNotificationService()
        await notifyService.sendNotification(this.org, {
          type: 'workflow_selected',
          title: '工作流编排',
          body: `已选择工作流: ${workflow.workflow_name} (${(workflow.score * 100).toFixed(0)}% 匹配)`,
        })
      } catch {
        // Notification failure is non-fatal
      }
    }

    return {
      intent,
      workflow,
      generated_workflow: generatedWorkflow,
      inputs,
      summary,
      experiences: injectedExperiences.length > 0 ? injectedExperiences : undefined,
      recentExecutions: injectedRecentExecutions.length > 0 ? injectedRecentExecutions : undefined,
    }
  }

  /**
   * Build a human-readable summary of the orchestration result.
   */
  private buildSummary(
    intent: IntentClassification,
    workflow?: WorkflowMatch,
    inputs?: Record<string, string>,
  ): string {
    const parts: string[] = []

    parts.push(`意图识别: ${intent.intent} (${(intent.confidence * 100).toFixed(0)}%)`)

    if (workflow) {
      parts.push(`工作流: ${workflow.workflow_name} (${(workflow.score * 100).toFixed(0)}% 匹配)`)
    }

    if (inputs?.target_scope) {
      parts.push(`目标: ${inputs.target_scope}`)
    }

    if (intent.intent === 'scheduled_task' && inputs?.schedule_hour) {
      parts.push(`计划执行: 每天 ${inputs.schedule_hour}:00`)
    }

    return parts.join(' | ')
  }
}

// ── Singleton ───────────────────────────────────────────────────────

const instances = new Map<string, OrchestratorService>()

export function getOrchestratorService(org: string, experienceDAO?: ExperienceDAO, archiveDAO?: ArchiveDAO): OrchestratorService {
  let instance = instances.get(org)
  if (!instance) {
    instance = new OrchestratorService(org, experienceDAO, archiveDAO)
    instances.set(org, instance)
  } else {
    if (experienceDAO) instance.setExperienceDAO(experienceDAO)
    if (archiveDAO) instance.setArchiveDAO(archiveDAO)
  }
  return instance
}
