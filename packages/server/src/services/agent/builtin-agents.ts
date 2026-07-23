import { getAgentRegistry, type AvatarConfig } from './agent-registry'
import { getAgentDir, getAgentMemoryDir, getAgentSkillsDir, getPersonaPath, getAgentConfigPath } from './paths'
import fs from 'fs'
import path from 'path'
import yaml from 'js-yaml'

/**
 * Built-in Agent definitions.
 * Each agent has its own persona, skills, and memory directory.
 */

const BUILTIN_AGENTS: AvatarConfig[] = [
  {
    id: 'workspace-agent',
    displayName: 'Workspace Agent',
    description: '通用工作空间助手，处理日常开发任务、代码分析、重构等',
    handlesIntents: ['single_task', 'general_chat', 'info_query'],
    persona: `# Workspace Agent

你是 Octopus 的工作空间助手，专注于帮助用户完成日常开发任务。

## 核心能力
- 代码分析与重构
- 功能开发与 Bug 修复
- 项目结构理解与导航
- 工作流选择与执行

## 工作原则
- 优先理解用户需求，提供精准的代码修改方案
- 保持代码质量，遵循项目现有风格
- 主动解释决策过程，让用户了解每一步
`,
    isBuiltin: true,
  },
  {
    id: 'scheduler-agent',
    displayName: 'Scheduler Agent',
    description: '定时任务管理助手，处理 cron 任务注册、调度、监控',
    handlesIntents: ['scheduled_task'],
    persona: `# Scheduler Agent

你是 Octopus 的定时任务管理助手，专注于 cron 任务的创建与管理。

## 核心能力
- Cron 表达式解析与生成
- 定时任务注册与调度
- 任务执行监控与告警
- 周期性报告生成

## 工作原则
- 确保 cron 表达式准确无误
- 提供清晰的任务调度说明
- 主动检查任务冲突与资源占用
`,
    isBuiltin: true,
  },
  {
    id: 'resource-agent',
    displayName: 'Resource Agent',
    description: '资源管理助手，处理 skills/agents/workflows 的安装、同步、预配',
    handlesIntents: ['resource_management'],
    persona: `# Resource Agent

你是 Octopus 的资源管理助手，专注于 skills、agents、workflows 的生命周期管理。

## 核心能力
- 资源安装与卸载
- 资源同步与更新
- 依赖解析与冲突处理
- 资源审计与版本管理

## 工作原则
- 严格按照 ResourceManager 规范操作
- 保持资源一致性和完整性
- 提供详细的操作日志和审计记录
`,
    isBuiltin: true,
  },
  {
    id: 'archive-agent',
    displayName: 'Archive Agent',
    description: '归档分析助手，执行工作空间回顾、经验提取、知识沉淀',
    handlesIntents: ['archive_analysis'],
    persona: `# Archive Agent

你是 Octopus 的归档分析助手，专注于工作空间的知识沉淀和经验提取。

## 核心能力
- 工作空间执行历史分析
- 经验教训提取与分类
- Skills 自动发现与推荐
- 成本效率评估与优化建议

## 工作原则
- 深入分析执行数据，提取有价值的洞察
- 保持客观评估，提供可操作的改进建议
- 尊重用户隐私，仅分析授权的数据
`,
    isBuiltin: true,
  },
]

/**
 * Initialize per-agent directory structure.
 * Creates: ~/.octopus/agent/{agentId}/{memory,skills,persona.md,config.yaml}
 */
export function initBuiltinAgentDirectories(agentId: string): void {
  const agentDir = getAgentDir(agentId)
  const memoryDir = getAgentMemoryDir(agentId)
  const skillsDir = getAgentSkillsDir(agentId)
  const personaPath = getPersonaPath(agentId)
  const configPath = getAgentConfigPath(agentId)

  // Create directories
  if (!fs.existsSync(agentDir)) {
    fs.mkdirSync(agentDir, { recursive: true })
  }
  if (!fs.existsSync(memoryDir)) {
    fs.mkdirSync(memoryDir, { recursive: true })
  }
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true })
  }

  // Create persona.md if not exists
  const agent = BUILTIN_AGENTS.find(a => a.id === agentId)
  if (agent && !fs.existsSync(personaPath)) {
    fs.writeFileSync(personaPath, agent.persona, 'utf-8')
  }

  // Create config.yaml if not exists
  if (!fs.existsSync(configPath)) {
    const defaultConfig = {
      model: 'opus[1m]',
      timeout: 300,
      memory: {
        session_retention_days: 90,
      },
    }
    fs.writeFileSync(configPath, yaml.dump(defaultConfig, { indent: 2 }), 'utf-8')
  }
}

/**
 * Register all built-in agents to AgentRegistry and initialize their directories.
 */
export function registerBuiltinAgents(): void {
  const registry = getAgentRegistry()

  for (const agent of BUILTIN_AGENTS) {
    // Register to registry
    registry.register(agent)

    // Initialize per-agent directories
    initBuiltinAgentDirectories(agent.id)
  }
}

/**
 * Get list of built-in agent IDs.
 */
export function getBuiltinAgentIds(): string[] {
  return BUILTIN_AGENTS.map(a => a.id)
}

/**
 * Check if an agent ID is a built-in agent.
 */
export function isBuiltinAgent(agentId: string): boolean {
  return BUILTIN_AGENTS.some(a => a.id === agentId)
}
