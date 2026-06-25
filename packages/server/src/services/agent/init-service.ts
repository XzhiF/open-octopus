import fs from 'fs'
import path from 'path'
import yaml from 'js-yaml'
import { getAgentDir, getPersonaPath, getLongTermMemoryPath, getAgentConfigPath, getAgentSkillsDir } from './paths'

/**
 * Directory tree to create during agent initialization.
 * All paths relative to ~/.octopus/agent/
 */
const AGENT_DIRS = [
  'memory',
  'memory/daily',
  'memory/daily/archive',
  'clones',
  'skills',
  'evolution',
  'evolution/experiences',
  'reports',
  'backup',
  'debug',
  'debug/traces',
  'metrics',
] as const

/**
 * Default persona content (~200 tokens).
 */
const DEFAULT_PERSONA = `# 人格

你是 Octopus Agent，一个智能编排助手。

## 核心能力
- 理解用户意图，将自然语言任务转化为可执行的工作流
- 管理分身（Clones）并行执行多个任务
- 维护三层记忆系统，持续学习和改进
- 通过 SKILL 进化机制自主优化工作方式

## 工作原则
- 安全第一：危险操作必须确认，文件操作限定在工作空间内
- 透明沟通：解释你的决策过程，让用户了解每一步
- 持续学习：从每次任务中提取经验，优化未来表现
- 尊重边界：在授权范围内行动，超出范围时主动询问
`

/**
 * Long-term memory template with section headers.
 */
const DEFAULT_LONG_TERM_MEMORY = `# 长期记忆

## 人格
（随使用逐步积累）

## 偏好
（随使用逐步积累）

## 经验教训
（随使用逐步积累）

## 常用工作流
（随使用逐步积累）

## 项目索引
（随使用逐步积累）
`

/**
 * Default config.yaml content.
 */
const DEFAULT_CONFIG = {
  model: 'opus[1m]',
  timeout: 300,
  max_clones: 5,
  notification: {
    provider: 'hermes',
    target: '',
    timezone: 'Asia/Shanghai',
  },
  memory: {
    session_retention_days: 90,
    archive_cron_hour: 3,
    long_term_refine_trigger_days: 7,
    session_compress_threshold_messages: 50,
  },
  safe_mode: {
    enabled: false,
    inactive_days_threshold: 14,
  },
  debug: {
    enabled: false,
  },
  onboarding_completed: false,
}

export interface InitResult {
  org: string
  dirsCreated: string[]
  filesCreated: string[]
  filesSkipped: string[]
  dbInitialized: boolean
  skillsCopied: number
}

export class InitService {
  /**
   * Initialize the Agent module for an org.
   * Idempotent — existing files are not overwritten, existing directories are reused.
   */
  initAgent(org?: string): InitResult {
    const baseDir = getAgentDir()
    const result: InitResult = {
      org: org ?? '',
      dirsCreated: [],
      filesCreated: [],
      filesSkipped: [],
      dbInitialized: false,
      skillsCopied: 0,
    }

    // 1. Create directory tree
    for (const dir of AGENT_DIRS) {
      const fullPath = path.join(baseDir, dir)
      if (!fs.existsSync(fullPath)) {
        fs.mkdirSync(fullPath, { recursive: true })
        result.dirsCreated.push(dir)
      }
    }

    // 2. Generate default persona.md (skip if exists)
    const personaPath = getPersonaPath()
    if (!fs.existsSync(personaPath)) {
      fs.writeFileSync(personaPath, DEFAULT_PERSONA, 'utf-8')
      result.filesCreated.push('persona.md')
    } else {
      result.filesSkipped.push('persona.md')
    }

    // 3. Generate empty long-term.md (skip if exists)
    const longTermPath = getLongTermMemoryPath()
    if (!fs.existsSync(longTermPath)) {
      fs.writeFileSync(longTermPath, DEFAULT_LONG_TERM_MEMORY, 'utf-8')
      result.filesCreated.push('memory/long-term.md')
    } else {
      result.filesSkipped.push('memory/long-term.md')
    }

    // 4. Generate default config.yaml (skip if exists)
    const configPath = getAgentConfigPath()
    if (!fs.existsSync(configPath)) {
      fs.writeFileSync(configPath, yaml.dump(DEFAULT_CONFIG, { indent: 2, lineWidth: 120 }), 'utf-8')
      result.filesCreated.push('config.yaml')
    } else {
      result.filesSkipped.push('config.yaml')
    }

    // 5. DB initialization is handled by the unified schema at server startup
    result.dbInitialized = true

    // 6. Copy core-pack SKILL files to agent/skills/ (skip existing)
    result.skillsCopied = this.copyBuiltinSkills(baseDir)

    return result
  }

  /**
   * Check if agent module is initialized for an org.
   */
  isInitialized(_org?: string): boolean {
    const baseDir = getAgentDir()
    return fs.existsSync(baseDir) &&
      fs.existsSync(getPersonaPath()) &&
      fs.existsSync(getAgentConfigPath())
  }

  /**
   * Copy built-in SKILL files from core-pack to agent/skills/.
   * Only copies files that don't already exist in the target (idempotent).
   */
  private copyBuiltinSkills(baseDir?: string): number {
    const corePackSkillsDir = this.findCorePackSkillsDir()
    if (!corePackSkillsDir) return 0

    const targetDir = getAgentSkillsDir()
    let copied = 0

    try {
      const entries = fs.readdirSync(corePackSkillsDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith('octo-agent-')) continue

        const srcDir = path.join(corePackSkillsDir, entry.name)
        const destDir = path.join(targetDir, entry.name)

        // Create skill directory if it doesn't exist
        if (!fs.existsSync(destDir)) {
          fs.mkdirSync(destDir, { recursive: true })
        }

        // Copy SKILL.md if not exists
        const skillMd = 'SKILL.md'
        const srcFile = path.join(srcDir, skillMd)
        const destFile = path.join(destDir, skillMd)

        if (fs.existsSync(srcFile) && !fs.existsSync(destFile)) {
          fs.copyFileSync(srcFile, destFile)
          copied++
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[init-service] Could not copy built-in skills: ${msg}`)
    }

    return copied
  }

  /**
   * Find the core-pack skills directory.
   * Tries monorepo path first, then falls back to installed location.
   */
  private findCorePackSkillsDir(): string | null {
    const candidates = [
      path.resolve(__dirname, '../../../../core-pack/skills'),
      path.resolve(__dirname, '../../../core-pack/skills'),
      path.resolve(__dirname, '../../core-pack/skills'),
      path.resolve(__dirname, '../../core-pack/skills'),
      path.resolve(process.cwd(), 'packages/core-pack/skills'),
    ]

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate
    }

    return null
  }
}

// Singleton
let initServiceInstance: InitService | null = null

export function getInitService(): InitService {
  if (!initServiceInstance) {
    initServiceInstance = new InitService()
  }
  return initServiceInstance
}
