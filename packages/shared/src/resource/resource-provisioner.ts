import type { ResourceManager } from './resource-manager'
import fs from 'fs'
import path from 'path'

/**
 * Provisionable resource type — clone is excluded (never auto-provisioned).
 */
export type ProvisionableType = 'agent' | 'skill' | 'command' | 'rule'

/**
 * ResourceProvisioner — 将工作流所需资源（agent/skill/command/rule）预配到 workspace。
 *
 * 通过 ResourcePreFlight 分析出精确的缺失列表，直接从全局资源库复制。
 */
export class ResourceProvisioner {
  private manager: ResourceManager

  constructor(manager: ResourceManager) {
    this.manager = manager
  }

  /**
   * 预配缺失资源到 workspace — 直接 fs 复制
   *
   * missing 列表已包含精确的 {type, name}，manager registry 有 installPath，
   * 无需委托 LLM agent。直接复制比 agent 调用快 3-4 个数量级。
   *
   * clone type is rejected — clones must be installed manually.
   */
  async provision(
    missing: Array<{ type: ProvisionableType; name: string }>,
    workspaceDir: string,
  ): Promise<{ provisioned: number; failed: string[]; byType: Record<string, number> }> {
    return this.directProvision(missing, workspaceDir)
  }

  /**
   * 直接复制资源到 workspace
   */
  private directProvision(
    missing: Array<{ type: ProvisionableType; name: string }>,
    workspaceDir: string,
  ): Promise<{ provisioned: number; failed: string[]; byType: Record<string, number> }> {
    const failed: string[] = []
    let provisioned = 0
    const byType: Record<string, number> = {}

    for (const item of missing) {
      try {
        this.directCopy(item.type, item.name, workspaceDir)
        provisioned++
        byType[item.type] = (byType[item.type] ?? 0) + 1
      } catch (err: any) {
        failed.push(`${item.type}:${item.name} — ${err.message}`)
      }
    }

    return Promise.resolve({ provisioned, failed, byType })
  }

  /**
   * 复制单个资源到 workspace
   */
  private directCopy(
    type: ProvisionableType,
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
    // Use entry.name (plain name from registry) for path construction,
    // since `name` parameter may be group-qualified (e.g. "built-in/vision-analyzer")
    const plainName = entry.name
    const destBase = path.join(workspaceDir, '.claude')

    switch (type) {
      case 'agent':
      case 'command':
      case 'rule': {
        const subdir = type === 'agent' ? 'agents' : type === 'command' ? 'commands' : 'rules'
        this.copyMdResource(type, plainName, sourcePath, destBase, subdir)
        break
      }
      case 'skill': {
        const destDir = path.join(destBase, 'skills')
        const destPath = path.join(destDir, plainName)

        if (!fs.existsSync(sourcePath)) {
          throw new Error(`Skill directory not found: ${sourcePath}`)
        }

        fs.cpSync(sourcePath, destPath, { recursive: true })
        break
      }
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

  /**
   * Copy a single .md resource file to the workspace .claude/{subdir}/ directory.
   * Shared by agent, command, and rule types.
   */
  private copyMdResource(
    type: string,
    plainName: string,
    sourcePath: string,
    destBase: string,
    subdir: string,
  ): void {
    const sourceFile = path.join(sourcePath, `${plainName}.md`)
    const destDir = path.join(destBase, subdir)
    const destFile = path.join(destDir, `${plainName}.md`)

    if (!fs.existsSync(sourceFile)) {
      throw new Error(`${type} file not found: ${sourceFile}`)
    }

    fs.mkdirSync(destDir, { recursive: true })
    fs.copyFileSync(sourceFile, destFile)
  }
}
