import fs from 'fs'
import path from 'path'
import os from 'os'
import type { IAgentProvider, MessageChunk } from '@octopus/providers'
import { getProvider } from '@octopus/providers'
import { SystemPromptAssembler } from './system-prompt-assembler'
import { getMemoryService } from './memory-service'
import { getNotificationService } from './notification-service'
import { getAgentDir } from './paths'
import type { StepEmitter } from '../archive/step-emitter'
import { createNullEmitter } from '../archive/step-emitter'

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

import type { ArchivePreview, AnalysisReport, ExperienceCandidate, SkillCandidate } from '../archive/analysis-assembler'

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

  constructor(org: string) {
    this.org = org
    this.agentDir = getAgentDir()
    this.assembler = new SystemPromptAssembler(org)
  }

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

  /**
   * Execute a specific task via the AI agent with skill guidance.
   * Used for resource operations (install, sync, provision) that need
   * intelligent decision-making and auditability.
   *
   * @param task - Natural language task description
   * @param skills - Skill names to load for guidance (e.g., "octo-resource-manager")
   * @param context - Additional context for the task
   * @returns Agent's text response
   */
  async executeTask(
    task: string,
    skills: string[] = [],
    context?: Record<string, unknown>,
  ): Promise<string> {
    const provider = getProvider('claude')

    // Build system prompt with skill content
    const skillSegments = skills.map((skillName) => {
      const skillPath = path.join(this.agentDir, 'skills', skillName, 'SKILL.md')
      if (fs.existsSync(skillPath)) {
        return `# Skill: ${skillName}\n\n${fs.readFileSync(skillPath, 'utf-8')}`
      }
      return null
    }).filter(Boolean)

    const contextStr = context ? `\n\n## Context\n\n\`\`\`json\n${JSON.stringify(context, null, 2)}\n\`\`\`` : ''

    const systemPrompt = [
      '你是 Octopus 平台的资源管理 Agent。你的职责是执行资源操作任务（安装、同步、预配等）。',
      '严格按照 Skill 指导执行操作，确保每一步都有审计记录。',
      '如果遇到异常，智能处理并报告结果。',
      '',
      ...skillSegments,
    ].join('\n\n')

    const prompt = `${task}${contextStr}`
    const cwd = path.join(os.homedir(), '.octopus', 'resources')

    // Collect response from agent
    const chunks: string[] = []
    try {
      const stream = provider.sendQuery(prompt, cwd, undefined, {
        systemPrompt: systemPrompt as any,
        skills,
      })

      for await (const chunk of stream) {
        if (chunk.type === 'text_delta') {
          chunks.push(chunk.content)
        } else if (chunk.type === 'error') {
          throw new Error(`Agent error: ${chunk.message}`)
        }
      }
    } catch (err: any) {
      throw new Error(`executeTask failed: ${err.message}`)
    }

    return chunks.join('')
  }

  // ── Archive V2: 3-Phase Analysis Pipeline ────────────────────────

  async analyzeWorkspaceForArchive(workspaceId: string, emitter: StepEmitter = createNullEmitter()): Promise<ArchivePreview> {
    // Phase 1: Build context
    await emitter.stepStart("build_context", "构建分析上下文...")
    await emitter.log("═══ 归档分析开始 ═══")
    await emitter.log(`工作空间: ${workspaceId}`)
    const { buildArchiveContext } = await import('../archive/context-builder')
    const { WorkspaceDAO } = await import('../../db/dao/workspace-dao')
    const { ExecutionDAO } = await import('../../db/dao/execution-dao')
    const { getDb } = await import('../../db')
    const { discoverSkillsFromWorkspace } = await import('../archive/skill-discovery')

    const db = getDb()
    const workspaceDAO = new WorkspaceDAO(db)
    const executionDAO = new ExecutionDAO(db)
    const ctx = await buildArchiveContext(workspaceId, workspaceDAO, executionDAO, db, this.org)

    if (!ctx) {
      await emitter.stepError("build_context", "工作空间未找到")
      await emitter.log("ERROR: 工作空间未找到")
      return this.emptyPreview('Workspace not found')
    }
    await emitter.log(`✓ 上下文构建完成: ${ctx.executions.length} 条执行记录, ${ctx.workflows.length} 个工作流`)
    await emitter.stepDone("build_context")

    // Phase 1.5: Auto-discover skills from .claude/skills/
    await emitter.stepStart("discover_skills", "扫描 .claude/skills/ 自动发现...")
    await emitter.log("扫描 .claude/skills/ 目录...")
    const rawPath = workspaceDAO.findPathById(workspaceId)
    const workspacePath = rawPath?.replace(/^~/, os.homedir()) ?? null
    const rawDiscoveredSkills = workspacePath
      ? discoverSkillsFromWorkspace(workspacePath)
      : []

    // Compare against ResourceManager installed skills
    let autoDiscoveredSkills: Array<Record<string, unknown>> = []
    try {
      const { getResourceRegistry } = await import('../resource-registry')
      const resourceManager = getResourceRegistry().getOrCreate(this.org)
      const installed = resourceManager.list({ type: "skill", installed: true })
      const installedMap = new Map<string, { group: string; installPath: string }>()
      for (const entry of installed.resources ?? []) {
        if (entry.installPath) installedMap.set(entry.name, { group: entry.group, installPath: entry.installPath })
      }

      const fsMod = await import("fs")
      const crypto = await import("crypto")

      for (const skill of rawDiscoveredSkills) {
        const existing = installedMap.get(skill.name)
        if (existing) {
          // Compare content — read FULL source file (not truncated)
          let sourceContent = ""
          try { sourceContent = fsMod.readFileSync(skill.path, "utf-8") } catch {}

          let existingContent = ""
          try {
            const mainFile = path.join(existing.installPath, "SKILL.md")
            if (fsMod.existsSync(mainFile)) {
              existingContent = fsMod.readFileSync(mainFile, "utf-8")
            }
          } catch {}

          const normalize = (s: string) => s.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd()
          const hash1 = crypto.createHash("md5").update(normalize(sourceContent)).digest("hex")
          const hash2 = crypto.createHash("md5").update(normalize(existingContent)).digest("hex")

          if (hash1 === hash2) {
            await emitter.log(`  ⊘ ${skill.name} — 内容相同，跳过`)
            continue // Skip unchanged
          }
          await emitter.log(`  ↻ ${skill.name} — 内容有更新 (原组: ${existing.group})`)
          autoDiscoveredSkills.push({
            name: skill.name, description: skill.description,
            content_outline: skill.content_outline, reason: skill.reason,
            evidence_workflows: [], evidence_executions: [],
            estimated_reuse: skill.estimated_reuse,
            content: skill.content, path: skill.path,
            auto_discovered: true, status: "updated", existingGroup: existing.group,
          })
        } else {
          await emitter.log(`  + ${skill.name} — 新发现`)
          autoDiscoveredSkills.push({
            name: skill.name, description: skill.description,
            content_outline: skill.content_outline, reason: skill.reason,
            evidence_workflows: [], evidence_executions: [],
            estimated_reuse: skill.estimated_reuse,
            content: skill.content, path: skill.path,
            auto_discovered: true, status: "new", existingGroup: null,
          })
        }
      }
    } catch (err) {
      // Fallback: treat all as new
      await emitter.log(`ResourceManager 比对失败: ${err instanceof Error ? err.message : String(err)}`)
      autoDiscoveredSkills = rawDiscoveredSkills.map((s) => ({
        name: s.name, description: s.description,
        content_outline: s.content_outline, reason: s.reason,
        evidence_workflows: [], evidence_executions: [],
        estimated_reuse: s.estimated_reuse,
        content: s.content, path: s.path,
        auto_discovered: true, status: "new", existingGroup: null,
      }))
    }

    await emitter.log(`✓ 发现 ${autoDiscoveredSkills.length} 个 Skill (${rawDiscoveredSkills.length - autoDiscoveredSkills.length} 个无变化已跳过)`)
    await emitter.stepDone("discover_skills", { count: autoDiscoveredSkills.length })

    // Phase 1.6: Auto-discover workflows from workflows/
    await emitter.stepStart("discover_workflows", "扫描 workflows/ 目录...")
    const { discoverWorkflowsFromWorkspace } = await import('../archive/skill-discovery')
    const rawDiscoveredWorkflows = workspacePath
      ? discoverWorkflowsFromWorkspace(workspacePath)
      : []

    // Compare against ResourceManager installed workflows
    let autoDiscoveredWorkflows: Array<Record<string, unknown>> = []
    try {
      const { getResourceRegistry } = await import('../resource-registry')
      const resourceManager = getResourceRegistry().getOrCreate(this.org)
      const installed = resourceManager.list({ type: "workflow", installed: true })
      const installedMap = new Map<string, { group: string; installPath: string }>()
      for (const entry of installed.resources ?? []) {
        if (entry.installPath) installedMap.set(entry.name, { group: entry.group, installPath: entry.installPath })
      }

      const fs = await import("fs")
      const crypto = await import("crypto")

      for (const wf of rawDiscoveredWorkflows) {
        const existing = installedMap.get(wf.name)
        if (existing) {
          let existingContent = ""
          try {
            const files = fs.readdirSync(existing.installPath)
            const yamlFile = files.find((f: string) => f.endsWith(".yaml") || f.endsWith(".yml"))
            if (yamlFile) existingContent = fs.readFileSync(`${existing.installPath}/${yamlFile}`, "utf-8")
          } catch {}

          const normalizeWS = (s: string) => s.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd()
          const hash1 = crypto.createHash("md5").update(normalizeWS(wf.content)).digest("hex")
          const hash2 = crypto.createHash("md5").update(normalizeWS(existingContent)).digest("hex")

          if (hash1 === hash2) {
            await emitter.log(`  ⊘ ${wf.name} — 内容相同，跳过`)
            continue
          }
          await emitter.log(`  ↻ ${wf.name} — 内容有更新 (原组: ${existing.group})`)
          autoDiscoveredWorkflows.push({
            name: wf.name, description: wf.description, content: wf.content, path: wf.path,
            status: "updated", existingGroup: existing.group,
          })
        } else {
          await emitter.log(`  + ${wf.name} — 新发现`)
          autoDiscoveredWorkflows.push({
            name: wf.name, description: wf.description, content: wf.content, path: wf.path,
            status: "new", existingGroup: null,
          })
        }
      }
    } catch (err) {
      await emitter.log(`ResourceManager 比对失败: ${err instanceof Error ? err.message : String(err)}`)
      autoDiscoveredWorkflows = rawDiscoveredWorkflows.map((w) => ({
        name: w.name, description: w.description, content: w.content, path: w.path,
        status: "new", existingGroup: null,
      }))
    }

    await emitter.log(`✓ 发现 ${autoDiscoveredWorkflows.length} 个项目级工作流 (${rawDiscoveredWorkflows.length - autoDiscoveredWorkflows.length} 个已跳过)`)
    await emitter.stepDone("discover_workflows", { count: autoDiscoveredWorkflows.length })

    // Phase 1.7: Auto-discover agents from .claude/agents/
    await emitter.stepStart("discover_agents", "扫描 .claude/agents/ 目录...")
    const { discoverAgentsFromWorkspace } = await import('../archive/skill-discovery')
    const rawDiscoveredAgents = workspacePath
      ? discoverAgentsFromWorkspace(workspacePath)
      : []

    let autoDiscoveredAgents: Array<Record<string, unknown>> = []
    try {
      const { getResourceRegistry } = await import('../resource-registry')
      const resourceManager = getResourceRegistry().getOrCreate(this.org)
      const installed = resourceManager.list({ type: "agent", installed: true })
      const installedMap = new Map<string, { group: string; installPath: string }>()
      for (const entry of installed.resources ?? []) {
        if (entry.installPath) installedMap.set(entry.name, { group: entry.group, installPath: entry.installPath })
      }

      const fsAgent = await import("fs")
      const cryptoAgent = await import("crypto")

      for (const agent of rawDiscoveredAgents) {
        const existing = installedMap.get(agent.name)
        if (existing) {
          let existingContent = ""
          try {
            const files = fsAgent.readdirSync(existing.installPath)
            const mdFile = files.find((f: string) => f.endsWith(".md"))
            if (mdFile) existingContent = fsAgent.readFileSync(`${existing.installPath}/${mdFile}`, "utf-8")
          } catch {}

          const norm = (s: string) => s.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd()
          const h1 = cryptoAgent.createHash("md5").update(norm(agent.content)).digest("hex")
          const h2 = cryptoAgent.createHash("md5").update(norm(existingContent)).digest("hex")

          if (h1 === h2) {
            await emitter.log(`  ⊘ ${agent.name} — 内容相同，跳过`)
            continue
          }
          await emitter.log(`  ↻ ${agent.name} — 内容有更新 (原组: ${existing.group})`)
          autoDiscoveredAgents.push({
            name: agent.name, description: agent.description, content: agent.content, path: agent.path,
            status: "updated", existingGroup: existing.group,
          })
        } else {
          await emitter.log(`  + ${agent.name} — 新发现`)
          autoDiscoveredAgents.push({
            name: agent.name, description: agent.description, content: agent.content, path: agent.path,
            status: "new", existingGroup: null,
          })
        }
      }
    } catch (err) {
      await emitter.log(`ResourceManager 比对失败: ${err instanceof Error ? err.message : String(err)}`)
      autoDiscoveredAgents = rawDiscoveredAgents.map((a) => ({
        name: a.name, description: a.description, content: a.content, path: a.path,
        status: "new", existingGroup: null,
      }))
    }

    await emitter.log(`✓ 发现 ${autoDiscoveredAgents.length} 个 Agent`)
    await emitter.stepDone("discover_agents", { count: autoDiscoveredAgents.length })

    // Phase 2: Parallel LLM analysis (3 calls)
    await emitter.stepStart("analyze_parallel", "3 个 LLM 并行分析中...")
    await emitter.log("启动 3 个 LLM 并行分析: 报告 / 经验提取 / Skill 发现...")
    const { buildRetrospectivePrompt, buildExperiencePrompt, buildSkillDiscoveryPrompt } = await import('../archive/prompts')
    const { assembleAnalysis } = await import('../archive/analysis-assembler')

    const retrospectivePrompt = buildRetrospectivePrompt(ctx)
    const experiencePrompt = buildExperiencePrompt(ctx)
    const skillPrompt = buildSkillDiscoveryPrompt(ctx)

    const [reportResult, experienceResult, skillResult] = await Promise.allSettled([
      (async () => { await emitter.log("  → 分析报告 LLM 调用中..."); const r = await this.callArchiveLLM(retrospectivePrompt, 'You are an expert engineering analyst reviewing a completed workspace for archival.'); await emitter.log("  ✓ 分析报告完成"); return r })(),
      (async () => { await emitter.log("  → 经验提取 LLM 调用中..."); const r = await this.callArchiveLLM(experiencePrompt, 'You are a knowledge extraction engine. Respond with only the JSON array.'); await emitter.log("  ✓ 经验提取完成"); return r })(),
      (async () => { await emitter.log("  → Skill 发现 LLM 调用中..."); const r = await this.callArchiveLLM(skillPrompt, 'You are a skill discovery agent. Respond with only the JSON array.'); await emitter.log("  ✓ Skill 发现完成"); return r })(),
    ])

    const report = parseReport(reportResult)
    const experiences = parseExperiences(experienceResult)
    const llmSkills = parseSkills(skillResult)
    await emitter.log(`✓ LLM 分析完成: 提取 ${experiences.length} 条经验, 发现 ${llmSkills.length} 个 Skill`)
    await emitter.stepDone("analyze_parallel", {
      experiences: experiences.length,
      skills: llmSkills.length,
    })

    // Merge: auto-discovered skills take priority, LLM skills fill gaps
    const autoNames = new Set(autoDiscoveredSkills.map((s) => s.name))
    const mergedSkills = [
      ...autoDiscoveredSkills,
      ...llmSkills.filter((s) => !autoNames.has(s.name)),
    ]

    // Phase 2.5: Token stats
    await emitter.log("查询 Token 使用统计...")
    let tokenStats = { total: { inputTokens: 0, outputTokens: 0, cost: 0 }, byModel: [] as any[], byWorkflow: [] as any[], nodes: [] as any[] }
    try {
      const { TokenUsageDAO } = await import('../../db/dao/token-usage-dao')
      const tokenDAO = new TokenUsageDAO(db)
      const wsStats = tokenDAO.getWorkspaceTokenStats(workspaceId)
      const nodes = tokenDAO.getNodeTokenStats(workspaceId)
      tokenStats = { ...wsStats, nodes }
      await emitter.log(`✓ Token 统计: ${tokenStats.total.inputTokens + tokenStats.total.outputTokens} tokens, $${tokenStats.total.cost.toFixed(4)}, ${tokenStats.byModel.length} models, ${nodes.length} nodes`)
    } catch (err) {
      await emitter.log(`Token 统计查询失败: ${err instanceof Error ? err.message : String(err)}`)
    }

    // Phase 3: Assemble
    await emitter.stepStart("assemble", "合并分析结果...")
    const preview = assembleAnalysis(ctx, report, experiences, mergedSkills)
    ;(preview as any).tokenStats = tokenStats
    // Use tokenStats cost when execution-level cost is 0
    if (tokenStats.total.cost > 0 && preview.stats.total_cost === 0) {
      preview.stats.total_cost = tokenStats.total.cost
      preview.stats.avg_cost_per_execution = preview.stats.execution_count > 0
        ? tokenStats.total.cost / preview.stats.execution_count : 0
    }
    ;(preview as any).workflows = autoDiscoveredWorkflows.map(w => ({
      name: w.name,
      description: w.description,
      content: w.content,
      path: w.path,
    }))
    ;(preview as any).agents = autoDiscoveredAgents.map(a => ({
      name: a.name,
      description: a.description,
      content: a.content,
      path: a.path,
    }))
    await emitter.log(`✓ 结果合并完成: ${preview.experiences.length} 经验, ${preview.skills.length} Skill`)
    await emitter.stepDone("assemble")

    // ★ Draft: persist before returning — survives client disconnect
    await emitter.stepStart("save_draft", "保存分析草稿...")
    try {
      const { ArchiveDraftDAO } = await import('../../db/dao/archive-draft-dao')
      const archiveDraftDAO = new ArchiveDraftDAO(db)
      archiveDraftDAO.upsert({
        workspace_id: workspaceId,
        org: this.org,
        analysis_report: JSON.stringify(preview.analysis),
        experiences: JSON.stringify(preview.experiences),
        skills: JSON.stringify(preview.skills),
        stats: JSON.stringify(preview.stats),
        workflows: JSON.stringify((preview as any).workflows ?? []),
        token_stats: JSON.stringify((preview as any).tokenStats ?? {}),
        agents: JSON.stringify((preview as any).agents ?? []),
      })
    } catch (err) {
      console.warn('Failed to save archive draft:', err)
      // Non-fatal: preview still returns to client
    }
    await emitter.stepDone("save_draft")
    await emitter.log("✓ 草稿已保存")
    await emitter.log("═══ 归档分析完成 ═══")

    return preview
  }

  private async callArchiveLLM(prompt: string, systemPrompt: string): Promise<string> {
    try {
      const provider = getProvider('claude')
      const chunks: string[] = []
      const stream = provider.sendQuery(prompt, process.cwd(), undefined, {
        systemPrompt,
      })
      for await (const chunk of stream) {
        if (chunk.type === 'text_delta') chunks.push(chunk.content)
      }
      return chunks.join('')
    } catch (err) {
      console.error('archive LLM call failed', err)
      return ''
    }
  }

  private emptyPreview(reason: string): ArchivePreview {
    return {
      stats: {
        execution_count: 0,
        success_rate: 0,
        total_cost: 0,
        total_duration_ms: 0,
        avg_cost_per_execution: 0,
        avg_duration_ms: 0,
        lifespan_days: 0,
        workflow_count: 0,
      },
      analysis: {
        summary: reason,
        execution_patterns: [],
        cost_efficiency: { rating: 'moderate', analysis: '', optimization_ideas: [] },
        error_patterns: [],
        recommendations: [],
      },
      experiences: [],
      skills: [],
    }
  }
}

// ── Archive Analysis Parsers ─────────────────────────────────────

function parseReport(result: PromiseSettledResult<string>): AnalysisReport {
  const fallback: AnalysisReport = {
    summary: 'Analysis unavailable',
    execution_patterns: [],
    cost_efficiency: { rating: 'moderate', analysis: 'Analysis failed', optimization_ideas: [] },
    error_patterns: [],
    recommendations: [],
  }
  if (result.status !== 'fulfilled' || !result.value) return fallback
  try {
    const cleaned = result.value.replace(/```json?\n?/g, '').replace(/```/g, '').trim()
    const parsed = JSON.parse(cleaned)
    return {
      summary: parsed.summary || fallback.summary,
      execution_patterns: toStringArray(parsed.execution_patterns),
      cost_efficiency: normalizeCostEfficiency(parsed.cost_efficiency),
      error_patterns: toStringArray(parsed.error_patterns),
      recommendations: toStringArray(parsed.recommendations),
    }
  } catch {
    return { ...fallback, summary: result.value.slice(0, 500) || 'Analysis parse failed' }
  }
}

function toStringArray(arr: unknown): string[] {
  if (!Array.isArray(arr)) return []
  return arr.map((item: unknown) => {
    if (typeof item === 'string') return item
    if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>
      return String(obj.pattern || obj.action || obj.text || obj.analysis || JSON.stringify(item))
    }
    return String(item)
  })
}

function normalizeCostEfficiency(raw: unknown): AnalysisReport['cost_efficiency'] {
  const fallback = { rating: 'moderate', analysis: '', optimization_ideas: [] as string[] }
  if (!raw || typeof raw !== 'object') return fallback
  const obj = raw as Record<string, unknown>
  return {
    rating: String(obj.rating || obj.assessment || 'moderate'),
    analysis: String(obj.analysis || obj.detail || ''),
    optimization_ideas: toStringArray(obj.optimization_ideas || obj.optimization_suggestions || []),
  }
}

function parseExperiences(result: PromiseSettledResult<string>): ExperienceCandidate[] {
  if (result.status !== 'fulfilled' || !result.value) return []
  try {
    const cleaned = result.value.replace(/```json?\n?/g, '').replace(/```/g, '').trim()
    const arr = JSON.parse(cleaned)
    if (!Array.isArray(arr)) return []
    return arr.map((e: any, i: number) => ({
      id: e.id || `exp-${i}`,
      text: e.text || '',
      scope: e.scope || 'project',
      target: e.target || '',
      confidence: typeof e.confidence === 'number' ? e.confidence : 0.5,
      evidence: e.evidence || '',
      category: e.category || 'process',
      conflicts: Array.isArray(e.conflicts) ? e.conflicts : [],
      action: (['add', 'update', 'delete'].includes(e.action) ? e.action : 'add') as 'add' | 'update' | 'delete',
      replaces_text: e.replaces_text || undefined,
    }))
  } catch {
    return []
  }
}

function parseSkills(result: PromiseSettledResult<string>): SkillCandidate[] {
  if (result.status !== 'fulfilled' || !result.value) return []
  try {
    const cleaned = result.value.replace(/```json?\n?/g, '').replace(/```/g, '').trim()
    const arr = JSON.parse(cleaned)
    if (!Array.isArray(arr)) return []
    return arr.map((s: any) => ({
      name: s.name || '',
      description: s.description || '',
      content_outline: Array.isArray(s.content_outline) ? s.content_outline : [],
      reason: s.reason || '',
      evidence_workflows: Array.isArray(s.evidence_workflows) ? s.evidence_workflows : [],
      evidence_executions: Array.isArray(s.evidence_executions) ? s.evidence_executions : [],
      estimated_reuse: s.estimated_reuse || 'low',
    }))
  } catch {
    return []
  }
}

// ── Singleton ───────────────────────────────────────────────────────

const instances = new Map<string, OrchestratorService>()

export function getOrchestratorService(org: string): OrchestratorService {
  let instance = instances.get(org)
  if (!instance) {
    instance = new OrchestratorService(org)
    instances.set(org, instance)
  }
  return instance
}
