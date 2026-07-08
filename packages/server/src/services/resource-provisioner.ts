import type { ResourceManager } from '@octopus/shared'
import type { ResourceAuditCaller } from '@octopus/shared'

/**
 * ResourceProvisioner — Agent 驱动的资源预配
 *
 * 将缺失的资源从全局库（~/.octopus/resources/installed/）复制到 workspace/.claude/。
 * 通过 ResourceAgentService 执行，利用 octo-resource-manager SKILL 指导操作。
 *
 * 依赖解析：如果 agent 依赖 skill，skill 也会被一并复制。
 */
export class ResourceProvisioner {
  private manager: ResourceManager
  private org: string

  constructor(manager: ResourceManager, org: string) {
    this.manager = manager
    this.org = org
  }

  /**
   * 预配缺失资源到 workspace
   *
   * @param missing - 缺失的资源列表
   * @param workspaceDir - 目标工作空间目录
   * @returns 预配结果
   */
  async provision(
    missing: Array<{ type: 'agent' | 'skill'; name: string }>,
    workspaceDir: string,
  ): Promise<{ provisioned: number; failed: string[] }> {
    const failed: string[] = []
    let provisioned = 0

    for (const item of missing) {
      try {
        await this.provisionOne(item.type, item.name, workspaceDir)
        provisioned++
      } catch (err: any) {
        failed.push(`${item.type}:${item.name} — ${err.message}`)
      }
    }

    return { provisioned, failed }
  }

  /**
   * 预配单个资源
   */
  private async provisionOne(
    type: 'agent' | 'skill',
    name: string,
    workspaceDir: string,
  ): Promise<void> {
    // 从全局 registry 查找资源
    const entry = this.manager.get(type, name)
    if (!entry) {
      throw new Error(`Resource not found in global registry: ${type}/${name}`)
    }
    if (!entry.installed) {
      throw new Error(`Resource not installed: ${type}/${name}`)
    }

    // 计算源路径和目标路径
    const sourcePath = entry.installPath
    const destBase = `${workspaceDir}/.claude`

    if (type === 'agent') {
      // Agent: 复制单个 .md 文件
      const fs = await import('fs')
      const path = await import('path')

      const sourceFile = path.join(sourcePath, `${name}.md`)
      const destDir = path.join(destBase, 'agents')
      const destFile = path.join(destDir, `${name}.md`)

      if (!fs.existsSync(sourceFile)) {
        throw new Error(`Agent file not found: ${sourceFile}`)
      }

      fs.mkdirSync(destDir, { recursive: true })
      fs.copyFileSync(sourceFile, destFile)
    } else {
      // Skill: 复制整个目录
      const fs = await import('fs')
      const path = await import('path')

      const destDir = path.join(destBase, 'skills')

      if (!fs.existsSync(sourcePath)) {
        throw new Error(`Skill directory not found: ${sourcePath}`)
      }

      fs.cpSync(sourcePath, path.join(destDir, name), { recursive: true })
    }

    // 如果 agent 有依赖的 skills，也一并预配
    if (type === 'agent' && entry.dependsOn && entry.dependsOn.length > 0) {
      for (const dep of entry.dependsOn) {
        // dependsOn 格式: "skill:name"
        const [depType, depName] = dep.split(':')
        if (depType === 'skill' && depName) {
          try {
            await this.provisionOne('skill', depName, workspaceDir)
          } catch {
            // 依赖预配失败不阻塞主资源
          }
        }
      }
    }
  }
}
