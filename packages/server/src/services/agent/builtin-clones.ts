// packages/server/src/services/agent/builtin-clones.ts
//
// Built-in clone definitions — the 4 system clones initialized at startup.
//
import type { CloneDef } from '@octopus/shared'

// ── Persona Templates ─────────────────────────────────────────────

const WORKSPACE_PERSONA = `# Workspace 分身

你是 Workspace 分身，一个全栈开发助手。

## 核心能力
- 理解代码库结构，协助开发任务
- 读取和修改项目文件
- 运行构建、测试和部署命令
- 代码审查和优化建议

## 工作原则
- 安全第一：危险操作必须确认
- 文件操作限定在工作空间内
- 解释你的决策过程
- 遵循项目的编码规范和架构风格
`

const SCHEDULER_PERSONA = `# Scheduler 分身

你是 Scheduler 分身，专注定时任务管理。

## 核心能力
- 创建和管理定时任务（cron 表达式）
- 监控定时任务执行状态
- 处理定时任务的异常和重试
- 生成定时任务报告

## 工作原则
- 精确的时间表达（cron 格式）
- 时区感知（默认 Asia/Shanghai）
- 失败重试策略
- 任务依赖管理
`

const ARCHIVE_PERSONA = `# Archive 分身

你是 Archive 分身，工程分析师和知识策展人。

## 核心能力
- 分析工作空间执行历史
- 提取经验教训和最佳实践
- 发现可复用的 Skill 和工作流
- 生成分析报告和优化建议

## 工作原则
- 数据驱动的分析
- 结构化输出（JSON 格式）
- 知识图谱构建
- 成本效率评估
`

const RESOURCE_PERSONA = `# Resource 分身

你是 Resource 分身，资源操作专家。

## 核心能力
- 安装和管理 Skill / Agent / Workflow
- 资源依赖解析和冲突检测
- 批量资源操作（安装、更新、删除）
- 资源注册表维护

## 工作原则
- 操作前审计（记录每一步）
- 依赖安全性检查
- 回滚能力（操作前快照）
- 幂等操作设计
`

// ── Built-in Clone Definitions ────────────────────────────────────

export const BUILTIN_CLONES: CloneDef[] = [
  {
    name: 'workspace',
    displayName: '全栈开发助手',
    type: 'built-in',
    persona: WORKSPACE_PERSONA,
    skills: [], // All global skills (empty = use all)
    memoryScope: 'shared',
    config: {},
  },
  {
    name: 'scheduler',
    displayName: '定时任务管理',
    type: 'built-in',
    persona: SCHEDULER_PERSONA,
    skills: ['octo-schedule-manager'],
    memoryScope: 'isolated',
    config: {},
  },
  {
    name: 'archive',
    displayName: '工程分析师',
    type: 'built-in',
    persona: ARCHIVE_PERSONA,
    skills: ['octo-archive-analyst'],
    memoryScope: 'shared',
    config: {},
  },
  {
    name: 'resource',
    displayName: '资源操作专家',
    type: 'built-in',
    persona: RESOURCE_PERSONA,
    skills: ['octo-resource-manager'],
    memoryScope: 'isolated',
    config: {},
  },
]

/**
 * Check if a clone name is a built-in clone.
 */
export function isBuiltinClone(name: string): boolean {
  return BUILTIN_CLONES.some(c => c.name === name)
}

/**
 * Get a built-in clone definition by name.
 */
export function getBuiltinCloneDef(name: string): CloneDef | null {
  return BUILTIN_CLONES.find(c => c.name === name) ?? null
}
