import type { ResourceManager } from '@octopus/shared'
import fs from 'fs'
import path from 'path'

/**
 * ResourceProvisioner — 将工作流所需资源（agent/skill）预配到 workspace。
 *
 * 通过 ResourcePreFlight 分析出精确的缺失列表，直接从全局资源库复制。
 */
export class ResourceProvisioner {
  private manager: ResourceManager
  // ponytail: org kept in constructor for future use, currently unused
  private org: string

  constructor(manager: ResourceManager, org: string) {
    this.manager = manager
    this.org = org
  }

  /**
   * 预配缺失资源到 workspace — 直接 fs 复制
   *
   * missing 列表已包含精确的 {type, name}，manager registry 有 installPath，
   * 无需委托 LLM agent。直接复制比 agent 调用快 3-4 个数量级。
   */
  async provision(
    missing: Array<{ type: 'agent' | 'skill'; name: string }>,
    workspaceDir: string,
  ): Promise<{ provisioned: number; failed: string[] }> {
    return this.directProvision(missing, workspaceDir)
  }

  /**
   * 直接复制资源到 workspace
   */
  private directProvision(
    missing: Array<{ type: 'agent' | 'skill'; name: string }>,
    workspaceDir: string,
  ): Promise<{ provisioned: number; failed: string[] }> {
    const failed: string[] = []
    let provisioned = 0

    for (const item of missing) {
      try {
        this.directCopy(item.type, item.name, workspaceDir)
        provisioned++
      } catch (err: any) {
        failed.push(`${item.type}:${item.name} — ${err.message}`)
      }
    }

    return Promise.resolve({ provisioned, failed })
  }

  /**
   * 复制单个资源到 workspace
   */
  private directCopy(
    type: 'agent' | 'skill',
    name: string,
    workspaceDir: string,
  ): void {
    const entry = this.manager.get(type, name)
    if (!entry) {
      throw new Error(`Resource not found in registry: ${type}/${name}`)
    }
    if (!entry.installed) {
      throw new Error(`Resource not installed: ${type}/${name}`)
    }

    const sourcePath = entry.installPath
    const destBase = path.join(workspaceDir, '.claude')

    if (type === 'agent') {
      const sourceFile = path.join(sourcePath, `${name}.md`)
      const destDir = path.join(destBase, 'agents')
      const destFile = path.join(destDir, `${name}.md`)

      if (!fs.existsSync(sourceFile)) {
        throw new Error(`Agent file not found: ${sourceFile}`)
      }

      fs.mkdirSync(destDir, { recursive: true })
      fs.copyFileSync(sourceFile, destFile)
    } else {
      const destDir = path.join(destBase, 'skills')
      const destPath = path.join(destDir, name)

      if (!fs.existsSync(sourcePath)) {
        throw new Error(`Skill directory not found: ${sourcePath}`)
      }

      fs.cpSync(sourcePath, destPath, { recursive: true })
    }

    // 复制依赖的 skills
    if (type === 'agent' && entry.dependsOn && entry.dependsOn.length > 0) {
      for (const dep of entry.dependsOn) {
        const [depType, depName] = dep.split(':')
        if (depType === 'skill' && depName) {
          try {
            this.directCopy('skill', depName, workspaceDir)
          } catch {
            // 依赖复制失败不阻塞主资源
          }
        }
      }
    }
  }
}
