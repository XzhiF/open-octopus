import fs from 'fs'
import path from 'path'
import { getSkillLoader } from './skill-loader'
import { getAgentDir, getPersonaPath, getLongTermMemoryPath, getDailyMemoryDir, getReportsDir, getOctopusHome, getClonesDir } from './paths'

// ── Types ──────────────────────────────────────────────────────

export interface PromptSegment {
  name: string
  content: string
  tokenEstimate: number
  priority: number // lower = higher priority
  source: 'core' | 'persona' | 'daily_memory' | 'memory' | 'skills' | 'context' | 'scheduled' | 'clone'
}

export interface AssembleOptions {
  clone_name?: string
  max_tokens?: number
  scheduled_task?: boolean
  include_skills?: string[]
  session_context?: Record<string, unknown>
}

// ── Constants ──────────────────────────────────────────────────

const DEFAULT_MAX_TOKENS = 8000
const CHARS_PER_TOKEN = 4 // rough estimate

// ── SystemPromptAssembler ──────────────────────────────────────

/**
 * Assembles system prompts from 6 segments (7 for scheduled agents):
 * 1. Core identity — agent role and capabilities
 * 2. Persona — personality, tone, principles
 * 3. Memory — relevant long-term memory snippets
 * 4. Skills — priority-ranked skill instructions
 * 5. Context — workspace rules, environment info
 * 6. Clone — clone-specific instructions (if applicable)
 * 7. Scheduled — scheduled task context (if applicable)
 *
 * Supports budget truncation: lower-priority segments are trimmed
 * or dropped when token budget is exceeded.
 */
export class SystemPromptAssembler {
  private org: string
  private agentDir: string
  private workspaceDir?: string

  constructor(org: string, workspaceDir?: string) {
    this.org = org
    this.workspaceDir = workspaceDir
    this.agentDir = getAgentDir()
  }

  /**
   * Set or update workspace directory for Tier 0 skill resolution.
   * Call when workspace context becomes available after construction.
   */
  setWorkspaceDir(dir: string): void {
    this.workspaceDir = dir
  }

  /**
   * Assemble a complete system prompt from all segments.
   */
  assemble(options: AssembleOptions = {}): string {
    const segments = this.getSegments(options)
    const maxTokens = options.max_tokens ?? DEFAULT_MAX_TOKENS

    const truncated = this.truncateToBudget(segments, maxTokens)
    return truncated.map((seg) => seg.content).join('\n\n')
  }

  /**
   * Assemble for a specific clone with clone-specific context.
   */
  assembleForClone(cloneName: string, options: AssembleOptions = {}): string {
    const merged = { ...options, clone_name: cloneName }
    return this.assemble(merged)
  }

  /**
   * Get all prompt segments without assembly or truncation.
   */
  getSegments(options: AssembleOptions = {}): PromptSegment[] {
    const segments: PromptSegment[] = []

    // Segment 1: Core identity (priority 0 — never dropped)
    segments.push(this.buildCoreSegment())

    // Segment 2: Persona (priority 1)
    segments.push(this.buildPersonaSegment())

    // Segment 3: Memory — long-term (priority 3)
    segments.push(this.buildMemorySegment())

    // Segment 4: Daily/working memory (priority 3.5)
    segments.push(this.buildDailyMemorySegment())

    // Segment 5: Skills (priority 2)
    segments.push(this.buildSkillsSegment(options.include_skills))

    // Segment 5: Context — workspace rules (priority 4)
    segments.push(this.buildContextSegment())

    // Segment 6: Clone-specific (priority 5, only if clone_name provided)
    if (options.clone_name) {
      segments.push(this.buildCloneSegment(options.clone_name))
    }

    // Segment 7: Scheduled task context (priority 6, only if scheduled)
    if (options.scheduled_task) {
      segments.push(this.buildScheduledSegment())
    }

    return segments.sort((a, b) => a.priority - b.priority)
  }

  // ── Segment builders ─────────────────────────────────────────

  private buildCoreSegment(): PromptSegment {
    const content = `# Octopus Agent

你是 Octopus Agent，一个智能编排助手。你的核心能力包括：

- 理解用户意图，将自然语言任务转化为可执行的工作流
- 管理分身（Clones）并行执行多个任务
- 维护三层记忆系统，持续学习和改进
- 通过 SKILL 进化机制自主优化工作方式

## 系统端点
- 健康检查：\`GET /api/actuator/health\`（确认服务是否运行）
- 系统状态：\`GET /api/actuator/system\`（CPU、内存、事件循环）
- 调度健康：\`GET /api/actuator/scheduler\`（调度引擎状态）

## 技能加载机制
系统预加载了技能摘要列表。当你需要使用某个技能时：
1. 从「可用技能」列表中找到匹配的技能名称
2. 使用 \`Read\` 工具读取完整 SKILL.md 文件：
   - 内置技能：\`packages/core-pack/skills/{技能名}/SKILL.md\`
   - 本地进化技能：\`~/.octopus/{org}/agent/skills/{技能名}/SKILL.md\`（优先级更高）
3. 按照 SKILL.md 中的指令执行任务

示例：需要使用 octo-scheduler 技能时，先 \`Read\` 文件 \`packages/core-pack/skills/octo-scheduler/SKILL.md\`

## 安全原则
- 危险操作（rm -rf、force push 等）必须拦截并请求用户确认
- 文件操作限定在工作空间内，禁止路径逃逸
- 敏感信息（密钥、密码）不得出现在输出中

## 工作方式
- 优先使用已安装的 Skills 来完成任务
- 遇到不确定的操作时主动询问用户
- 从每次交互中提取经验，持续改进`

    return {
      name: 'core_identity',
      content,
      tokenEstimate: Math.ceil(content.length / CHARS_PER_TOKEN),
      priority: 0,
      source: 'core',
    }
  }

  private buildPersonaSegment(): PromptSegment {
    const personaPath = getPersonaPath()
    let content = ''

    if (fs.existsSync(personaPath)) {
      try {
        content = fs.readFileSync(personaPath, 'utf-8')
      } catch {
        content = '# 人格\n\n（默认人格配置）'
      }
    } else {
      content = '# 人格\n\n你是 Octopus Agent，一个智能编排助手。'
    }

    return {
      name: 'persona',
      content,
      tokenEstimate: Math.ceil(content.length / CHARS_PER_TOKEN),
      priority: 1,
      source: 'persona',
    }
  }

  private buildMemorySegment(): PromptSegment {
    const longTermPath = getLongTermMemoryPath()
    let content = ''

    if (fs.existsSync(longTermPath)) {
      try {
        const raw = fs.readFileSync(longTermPath, 'utf-8')
        content = `# 长期记忆\n\n${raw}`
      } catch {
        content = ''
      }
    }

    return {
      name: 'memory',
      content,
      tokenEstimate: Math.ceil(content.length / CHARS_PER_TOKEN),
      priority: 3,
      source: 'memory',
    }
  }

  private buildDailyMemorySegment(): PromptSegment {
    const dailyDir = getDailyMemoryDir()
    let content = ''

    if (fs.existsSync(dailyDir)) {
      try {
        // Read today's daily memory
        const today = new Date().toISOString().slice(0, 10)
        const todayFile = path.join(dailyDir, `${today}.md`)
        if (fs.existsSync(todayFile)) {
          const raw = fs.readFileSync(todayFile, 'utf-8')
          content = `# 工作记忆\n\n${raw}`
        }
      } catch {
        content = ''
      }
    }

    return {
      name: 'daily_memory',
      content,
      tokenEstimate: Math.ceil(content.length / CHARS_PER_TOKEN),
      priority: 3,
      source: 'daily_memory',
    }
  }

  private buildSkillsSegment(includeSkills?: string[]): PromptSegment {
    const loader = getSkillLoader(this.org, this.workspaceDir)
    const { content } = loader.buildPromptSegment(includeSkills)

    return {
      name: 'skills',
      content,
      tokenEstimate: Math.ceil(content.length / CHARS_PER_TOKEN),
      priority: 2,
      source: 'skills',
    }
  }

  private buildContextSegment(): PromptSegment {
    const parts: string[] = []

    // Check for workspace rules
    const rulesPath = path.join(this.agentDir, 'workspace_rules.md')
    if (fs.existsSync(rulesPath)) {
      try {
        const rules = fs.readFileSync(rulesPath, 'utf-8')
        parts.push(`## 工作空间规则\n${rules}`)
      } catch { /* skip */ }
    }

    // Add org context
    parts.push(`## 组织信息\n- 组织: ${this.org}`)

    const content = `# 上下文\n\n${parts.join('\n\n')}`
    return {
      name: 'context',
      content,
      tokenEstimate: Math.ceil(content.length / CHARS_PER_TOKEN),
      priority: 4,
      source: 'context',
    }
  }

  private buildCloneSegment(cloneName: string): PromptSegment {
    const clonesDir = getClonesDir()
    const cloneDir = path.join(clonesDir, cloneName)
    let content = `# 分身: ${cloneName}\n\n你当前以分身 "${cloneName}" 的身份运行。`

    const metaFile = path.join(cloneDir, 'meta.json')
    if (fs.existsSync(metaFile)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'))
        if (meta.current_task) {
          content += `\n\n当前任务: ${meta.current_task}`
        }
        if (meta.status) {
          content += `\n状态: ${meta.status}`
        }
      } catch { /* skip */ }
    }

    return {
      name: 'clone',
      content,
      tokenEstimate: Math.ceil(content.length / CHARS_PER_TOKEN),
      priority: 5,
      source: 'clone',
    }
  }

  private buildScheduledSegment(): PromptSegment {
    // Read last report summary from reports/ directory (PRD L3 §⑦段)
    const reportsDir = getReportsDir()
    let lastReportSummary = ''

    if (fs.existsSync(reportsDir)) {
      try {
        // Find the most recent report across all task subdirectories
        const subdirs = fs.readdirSync(reportsDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)

        let latestFile = ''
        let latestDate = ''

        for (const subdir of subdirs) {
          const subPath = path.join(reportsDir, subdir)
          const files = fs.readdirSync(subPath)
            .filter((f) => f.endsWith('.md'))
            .sort()
            .reverse()

          if (files.length > 0) {
            const fileDate = files[0].replace('.md', '')
            if (fileDate > latestDate) {
              latestDate = fileDate
              latestFile = path.join(subPath, files[0])
            }
          }
        }

        if (latestFile) {
          const reportContent = fs.readFileSync(latestFile, 'utf-8')
          // Extract first 300 chars as summary (budget-constrained)
          lastReportSummary = reportContent.length > 300
            ? reportContent.slice(0, 300) + '...'
            : reportContent
        }
      } catch {
        // Report read failure is non-fatal
      }
    }

    const content = `# 定时任务上下文

当前执行来自定时调度触发。请注意：
- 本次执行是自动触发，无需用户确认即可执行安全操作
- 危险操作仍需记录到安全事件日志
- 执行完成后请输出结构化的执行摘要
${lastReportSummary ? `\n## 上次报告摘要\n\n${lastReportSummary}` : ''}`

    return {
      name: 'scheduled',
      content,
      tokenEstimate: Math.ceil(content.length / CHARS_PER_TOKEN),
      priority: 6,
      source: 'scheduled',
    }
  }

  // ── Budget truncation (PRD L2 degradation rules) ───────────

  /**
   * Truncate segments to fit within token budget using PRD-specified rules:
   * - Long-term memory over 1500t → extract "经验教训"+"常用工作流"+"偏好" sections
   * - SKILL over 2000t → P1(never trim: orchestrator+memory) > P2(task-type) > P3(frequency) > P4(newest first)
   * - Working memory over 500t → today > yesterday > day-before
   * - Session memory over 500t → FTS top-3 → top-1
   * Post-degradation total must stay ≤ maxTokens.
   */
  truncateToBudget(segments: PromptSegment[], maxTokens: number): PromptSegment[] {
    const sorted = [...segments].sort((a, b) => a.priority - b.priority)

    // Phase 1: Apply segment-specific degradation rules
    const degraded = sorted.map((seg) => this.applyDegradationRule(seg, maxTokens))

    // Phase 2: Fit into budget by priority
    const result: PromptSegment[] = []
    let usedTokens = 0

    for (const segment of degraded) {
      if (usedTokens + segment.tokenEstimate <= maxTokens) {
        result.push(segment)
        usedTokens += segment.tokenEstimate
      } else {
        const remainingTokens = maxTokens - usedTokens
        if (remainingTokens > 50) {
          const maxChars = remainingTokens * CHARS_PER_TOKEN
          const truncated = {
            ...segment,
            content: segment.content.slice(0, maxChars) + '\n\n[... truncated ...]',
            tokenEstimate: remainingTokens,
          }
          result.push(truncated)
          usedTokens += remainingTokens
        }
        break
      }
    }

    return result
  }

  /**
   * Apply PRD L2 degradation rules to a single segment.
   */
  private applyDegradationRule(segment: PromptSegment, maxTokens: number): PromptSegment {
    // Budget thresholds per segment type (PRD §4)
    const BUDGET = {
      memory: 1500,
      skills: 2000,
      daily_memory: 500,
      context: 500, // FTS session memory
    }

    switch (segment.source) {
      // ── Long-term memory: extract three key sections ──────────
      case 'memory': {
        const budget = BUDGET.memory
        if (segment.tokenEstimate <= budget) return segment

        const content = segment.content
        const sections = this.extractKeySections(content, [
          '经验教训', '常用工作流', '偏好', 'lessons', 'workflows', 'preferences',
        ])
        const degraded = sections || content.slice(0, budget * CHARS_PER_TOKEN)

        return {
          ...segment,
          content: degraded,
          tokenEstimate: Math.ceil(degraded.length / CHARS_PER_TOKEN),
        }
      }

      // ── SKILL: priority-based trimming ────────────────────────
      case 'skills': {
        const budget = BUDGET.skills
        if (segment.tokenEstimate <= budget) return segment

        // P1: never trim orchestrator + memory skills
        // P4: trim newest dynamic skills first
        const content = segment.content
        const skillBlocks = this.parseSkillBlocks(content)
        const prioritized = this.prioritizeSkills(skillBlocks)

        let trimmed = ''
        let tokens = 0
        for (const block of prioritized) {
          const blockTokens = Math.ceil(block.length / CHARS_PER_TOKEN)
          if (tokens + blockTokens <= budget) {
            trimmed += block + '\n\n'
            tokens += blockTokens
          }
        }

        const degraded = trimmed || content.slice(0, budget * CHARS_PER_TOKEN)
        return {
          ...segment,
          content: degraded,
          tokenEstimate: Math.ceil(degraded.length / CHARS_PER_TOKEN),
        }
      }

      // ── Daily/working memory: today > yesterday > before ──────
      case 'daily_memory': {
        const budget = BUDGET.daily_memory
        if (segment.tokenEstimate <= budget) return segment

        const content = segment.content
        const degraded = content.slice(0, budget * CHARS_PER_TOKEN)
        return {
          ...segment,
          content: degraded,
          tokenEstimate: Math.ceil(degraded.length / CHARS_PER_TOKEN),
        }
      }

      // ── Session/FTS memory: top-3 → top-1 ─────────────────────
      case 'context': {
        const budget = BUDGET.context
        if (segment.tokenEstimate <= budget) return segment

        // Reduce FTS results from top-3 to top-1
        const content = segment.content
        const lines = content.split('\n')
        const resultLines: string[] = []
        let matchCount = 0
        for (const line of lines) {
          if (line.startsWith('### ') || line.startsWith('## 会话记忆')) {
            matchCount++
            if (matchCount > 1) break // Keep only top-1
          }
          resultLines.push(line)
        }

        const degraded = resultLines.join('\n').slice(0, budget * CHARS_PER_TOKEN)
        return {
          ...segment,
          content: degraded,
          tokenEstimate: Math.ceil(degraded.length / CHARS_PER_TOKEN),
        }
      }

      default:
        return segment
    }
  }

  /**
   * Extract key sections from long-term memory by heading keywords.
   */
  private extractKeySections(content: string, keywords: string[]): string | null {
    const lines = content.split('\n')
    const sections: string[] = []
    let inSection = false

    for (const line of lines) {
      const isHeading = /^##?\s+/.test(line)
      if (isHeading) {
        inSection = keywords.some((k) => line.toLowerCase().includes(k.toLowerCase()))
      }
      if (inSection) {
        sections.push(line)
      }
    }

    return sections.length > 0 ? sections.join('\n') : null
  }

  /**
   * Parse SKILL content into individual skill blocks.
   */
  private parseSkillBlocks(content: string): string[] {
    const blocks: string[] = []
    const lines = content.split('\n')
    let currentBlock: string[] = []

    for (const line of lines) {
      if (line.startsWith('### ') && currentBlock.length > 0) {
        blocks.push(currentBlock.join('\n'))
        currentBlock = [line]
      } else {
        currentBlock.push(line)
      }
    }
    if (currentBlock.length > 0) {
      blocks.push(currentBlock.join('\n'))
    }

    return blocks
  }

  /**
   * Prioritize SKILL blocks per PRD L2 trimming rules:
   * P1 (never trim): orchestrator + memory
   * P2 (task-type): kept based on current context
   * P3 (frequency): core skills (workspace, evolution)
   * P4 (trim first): dynamically created new skills
   */
  private prioritizeSkills(blocks: string[]): string[] {
    const P1_NEVER_TRIM = ['orchestrator', 'memory']
    const P3_CORE = ['workspace', 'evolution', 'scheduler']

    const scored = blocks.map((block) => {
      const nameMatch = block.match(/###\s+([\w-]+)/)
      const name = nameMatch?.[1]?.toLowerCase() ?? ''

      let score = 50 // default middle priority
      if (P1_NEVER_TRIM.some((k) => name.includes(k))) score = 0 // highest priority
      else if (P3_CORE.some((k) => name.includes(k))) score = 30
      else score = 60 // P4: dynamic skills trimmed first

      return { block, score }
    })

    return scored.sort((a, b) => a.score - b.score).map((s) => s.block)
  }
}
