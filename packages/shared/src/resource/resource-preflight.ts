import path from 'path'
import fs from 'fs'
import os from 'os'

/**
 * ResourceItemType — 资源类型联合
 */
export type ResourceItemType = 'agent' | 'skill' | 'command' | 'rule' | 'clone'

/**
 * ResourceManifest — 工作流所需的资源清单
 */
export interface ResourceManifest {
  agents: string[]   // agent 名称列表（不含 .md 后缀）
  skills: string[]   // skill 目录名称列表
  commands: string[] // command 名称列表（不含 .md 后缀）
  rules: string[]    // rule 名称列表（不含 .md 后缀）
  // Note: clones NOT included — checked by separate hard-fail gate in engine-init
}

/**
 * ResourceCheckResult — 资源可用性检查结果
 */
export interface ResourceCheckResult {
  available: Array<{ type: ResourceItemType; name: string }>
  missing: Array<{ type: ResourceItemType; name: string }>
}

/**
 * ResourcePreFlight — 工作流资源预检
 *
 * 在执行工作流前，解析 YAML 中的资源引用，检查 workspace 是否已有这些资源。
 * 缺失的资源需要通过 ResourceProvisioner 从全局库补充。
 *
 * 支持的模式：
 * - agent 节点: agent_file 字段引用 .md 文件
 * - agent 节点: sub-agents (agents 字段) 中的 agent_file 引用
 * - swarm 节点: experts / expert_pool / host / aggregator 中的 agent_file 引用
 * - 所有节点: skills 数组引用 skill 名称
 * - 递归扫描: loop / condition 等容器的子节点
 *
 * 限制：
 * - 变量引用（$vars.xxx）在预检阶段无法展开，跳过
 */
export class ResourcePreFlight {
  /**
   * 解析工作流定义，提取所有资源引用
   */
  analyze(workflow: any): ResourceManifest {
    const agents = new Set<string>()
    const skills = new Set<string>()

    const nodes = workflow.nodes ?? workflow.steps ?? []
    this.scanNodes(nodes, agents, skills)

    return {
      agents: Array.from(agents),
      skills: Array.from(skills),
      commands: [],
      rules: [],
    }
  }

  /**
   * Recursively scan nodes for resource references.
   * Handles nested nodes (loop, condition, etc.) and sub-agent definitions.
   */
  private scanNodes(
    nodes: any[],
    agents: Set<string>,
    skills: Set<string>,
  ): void {
    for (const node of nodes) {
      // Agent 节点: 提取 agent_file
      if (node.type === 'agent' && node.agent_file) {
        const name = this.extractAgentName(node.agent_file)
        if (name) agents.add(name)
      }

      // Agent 节点: 提取 sub-agents 中的 agent_file
      if (node.agents && typeof node.agents === 'object') {
        for (const subAgent of Object.values(node.agents)) {
          if (subAgent && typeof subAgent === 'object' && (subAgent as any).agent_file) {
            const name = this.extractAgentName((subAgent as any).agent_file)
            if (name) agents.add(name)
          }
        }
      }

      // Swarm 节点: 提取 experts / expert_pool / host / aggregator 中的 agent_file
      if (node.type === 'swarm') {
        // 静态模式 experts
        this.collectAgentFiles(node.experts, agents)
        // 动态模式 expert_pool
        this.collectAgentFiles(node.expert_pool, agents)
        // host agent（可选）
        if (node.host?.agent_file) {
          const name = this.extractAgentName(node.host.agent_file)
          if (name) agents.add(name)
        }
        // aggregator agent（MOA 模式，可选）
        if (node.aggregator?.agent_file) {
          const name = this.extractAgentName(node.aggregator.agent_file)
          if (name) agents.add(name)
        }
      }

      // 所有节点: 提取 skills
      if (node.skills && Array.isArray(node.skills)) {
        for (const skill of node.skills) {
          if (typeof skill === 'string' && !skill.includes('$')) {
            skills.add(skill)
          }
        }
      }

      // Agent sub-agents: 提取 agents.{name}.skills
      if (node.agents && typeof node.agents === 'object') {
        for (const subAgent of Object.values(node.agents)) {
          if (subAgent && typeof subAgent === 'object') {
            const sa = subAgent as Record<string, unknown>
            if (Array.isArray(sa.skills)) {
              for (const skill of sa.skills) {
                if (typeof skill === 'string' && !skill.includes('$')) {
                  skills.add(skill)
                }
              }
            }
          }
        }
      }

      // Swarm expert_defaults.skills (applied to all experts)
      if (node.type === 'swarm' && node.expert_defaults?.skills && Array.isArray(node.expert_defaults.skills)) {
        for (const skill of node.expert_defaults.skills) {
          if (typeof skill === 'string' && !skill.includes('$')) {
            skills.add(skill)
          }
        }
      }

      // 递归扫描子节点 (loop, condition 等)
      if (node.nodes && Array.isArray(node.nodes)) {
        this.scanNodes(node.nodes, agents, skills)
      }
    }
  }

  /**
   * 检查 workspace 中是否已有 manifest 中的资源
   *
   * 支持 group-qualified 名称: "group/name" 会被解析为纯名称用于路径检查。
   * 例: "built-in/vision-analyzer" → 检查 .claude/agents/vision-analyzer.md
   */
  check(manifest: ResourceManifest, workspaceDir: string): ResourceCheckResult {
    const available: Array<{ type: ResourceItemType; name: string }> = []
    const missing: Array<{ type: ResourceItemType; name: string }> = []

    // 检查 agents
    for (const agent of manifest.agents) {
      const plainName = agent.replace(/\.md$/, '')
      const agentPath = path.join(workspaceDir, '.claude', 'agents', `${plainName}.md`)
      if (fs.existsSync(agentPath)) {
        available.push({ type: 'agent', name: agent })
      } else {
        missing.push({ type: 'agent', name: agent })
      }
    }

    // 检查 skills — stripGroup extracts plain name from "group/name"
    for (const skill of manifest.skills) {
      const plainName = stripGroup(skill)
      const skillPath = path.join(workspaceDir, '.claude', 'skills', plainName)
      if (fs.existsSync(skillPath)) {
        available.push({ type: 'skill', name: skill })
      } else {
        missing.push({ type: 'skill', name: skill })
      }
    }

    // 检查 commands — .claude/commands/{name}.md
    for (const command of manifest.commands) {
      const plainName = command.replace(/\.md$/, '')
      const commandPath = path.join(workspaceDir, '.claude', 'commands', `${plainName}.md`)
      if (fs.existsSync(commandPath)) {
        available.push({ type: 'command', name: command })
      } else {
        missing.push({ type: 'command', name: command })
      }
    }

    // 检查 rules — .claude/rules/{name}.md
    for (const rule of manifest.rules) {
      const plainName = rule.replace(/\.md$/, '')
      const rulePath = path.join(workspaceDir, '.claude', 'rules', `${plainName}.md`)
      if (fs.existsSync(rulePath)) {
        available.push({ type: 'rule', name: rule })
      } else {
        missing.push({ type: 'rule', name: rule })
      }
    }

    return { available, missing }
  }

  /**
   * 检查 clone 是否已安装（hard-fail gate，独立于 check()）
   *
   * 检查两个路径:
   * - ~/.octopus/agent/clones/{name}/
   * - ~/.octopus/agent/built-in/{name}/
   *
   * 任一存在即视为 available。
   */
  checkClones(cloneNames: string[]): ResourceCheckResult {
    const available: Array<{ type: ResourceItemType; name: string }> = []
    const missing: Array<{ type: ResourceItemType; name: string }> = []

    for (const name of cloneNames) {
      const clonePaths = [
        path.join(os.homedir(), '.octopus', 'agent', 'clones', name),
        path.join(os.homedir(), '.octopus', 'agent', 'built-in', name),
      ]
      if (clonePaths.some(p => fs.existsSync(p))) {
        available.push({ type: 'clone', name })
      } else {
        missing.push({ type: 'clone', name })
      }
    }

    return { available, missing }
  }

  /**
   * 从 expert 数组中批量提取 agent_file 引用
   */
  private collectAgentFiles(
    experts: any[] | undefined,
    agents: Set<string>,
  ): void {
    if (!experts || !Array.isArray(experts)) return
    for (const expert of experts) {
      if (expert.agent_file) {
        const name = this.extractAgentName(expert.agent_file)
        if (name) agents.add(name)
      }
    }
  }

  /**
   * 从 agent_file 路径中提取 agent 名称
   * 跳过变量引用（$vars.xxx）
   * 支持 group-qualified 路径: "built-in/vision-analyzer.md" → "vision-analyzer"
   */
  private extractAgentName(agentFile: string): string | null {
    if (typeof agentFile !== 'string') return null
    if (agentFile.includes('$')) return null // 变量引用，无法预检

    const basename = path.basename(agentFile)
    return basename.replace(/\.md$/, '')
  }
}

/**
 * Strip group prefix from "group/name" format → "name".
 * "superpowers-zh/test-driven-development" → "test-driven-development"
 * "test-driven-development" → "test-driven-development"
 */
function stripGroup(qualifiedName: string): string {
  const idx = qualifiedName.lastIndexOf('/')
  return idx >= 0 ? qualifiedName.slice(idx + 1) : qualifiedName
}
