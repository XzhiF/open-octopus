import path from 'path'
import fs from 'fs'

/**
 * ResourceManifest — 工作流所需的资源清单
 */
export interface ResourceManifest {
  agents: string[]   // agent 名称列表（不含 .md 后缀）
  skills: string[]   // skill 目录名称列表
}

/**
 * ResourceCheckResult — 资源可用性检查结果
 */
export interface ResourceCheckResult {
  available: Array<{ type: 'agent' | 'skill'; name: string }>
  missing: Array<{ type: 'agent' | 'skill'; name: string }>
}

/**
 * ResourcePreFlight — 工作流资源预检
 *
 * 在执行工作流前，解析 YAML 中的资源引用，检查 workspace 是否已有这些资源。
 * 缺失的资源需要通过 ResourceProvisioner 从全局库补充。
 *
 * 支持的模式：
 * - agent 节点: agent_file 字段引用 .md 文件
 * - swarm 节点: experts 数组中的 agent_file 引用
 * - 所有节点: skills 数组引用 skill 名称
 *
 * 限制：
 * - 变量引用（$vars.xxx）在预检阶段无法展开，跳过
 * - 动态 swarm 的 experts 由 LLM 运行时选择，预检无法预知
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

      // Swarm 节点: 提取 experts 中的 agent_file
      if (node.type === 'swarm' && node.experts) {
        for (const expert of node.experts) {
          if (expert.agent_file) {
            const name = this.extractAgentName(expert.agent_file)
            if (name) agents.add(name)
          }
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

      // 递归扫描子节点 (loop, condition 等)
      if (node.nodes && Array.isArray(node.nodes)) {
        this.scanNodes(node.nodes, agents, skills)
      }
    }
  }

  /**
   * 检查 workspace 中是否已有 manifest 中的资源
   */
  check(manifest: ResourceManifest, workspaceDir: string): ResourceCheckResult {
    const available: Array<{ type: 'agent' | 'skill'; name: string }> = []
    const missing: Array<{ type: 'agent' | 'skill'; name: string }> = []

    // 检查 agents
    for (const agent of manifest.agents) {
      const agentPath = path.join(workspaceDir, '.claude', 'agents', `${agent}.md`)
      if (fs.existsSync(agentPath)) {
        available.push({ type: 'agent', name: agent })
      } else {
        missing.push({ type: 'agent', name: agent })
      }
    }

    // 检查 skills
    for (const skill of manifest.skills) {
      const skillPath = path.join(workspaceDir, '.claude', 'skills', skill)
      if (fs.existsSync(skillPath)) {
        available.push({ type: 'skill', name: skill })
      } else {
        missing.push({ type: 'skill', name: skill })
      }
    }

    return { available, missing }
  }

  /**
   * 从 agent_file 路径中提取 agent 名称
   * 跳过变量引用（$vars.xxx）
   */
  private extractAgentName(agentFile: string): string | null {
    if (typeof agentFile !== 'string') return null
    if (agentFile.includes('$')) return null // 变量引用，无法预检

    const basename = path.basename(agentFile)
    return basename.replace(/\.md$/, '')
  }
}
