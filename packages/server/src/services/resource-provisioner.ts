import type { ResourceManager } from '@octopus/shared'
import { getOrchestratorService } from './agent/orchestrator-service'
import fs from 'fs'
import path from 'path'

/**
 * ResourceProvisioner — 委托 Orchestrator Agent 预配资源到 workspace。
 *
 * 所有文件操作通过 Agent 执行，使用 octo-resource-manager SKILL 指导。
 * Agent 负责：搜索全局库 → 复制到 workspace → 解析依赖 → 审计记录。
 *
 * 降级策略：如果 Agent 执行失败，回退到直接 fs 操作。
 */
export class ResourceProvisioner {
  private manager: ResourceManager
  private org: string

  constructor(manager: ResourceManager, org: string) {
    this.manager = manager
    this.org = org
  }

  /**
   * 预配缺失资源到 workspace — 委托 Orchestrator Agent
   */
  async provision(
    missing: Array<{ type: 'agent' | 'skill'; name: string }>,
    workspaceDir: string,
  ): Promise<{ provisioned: number; failed: string[] }> {
    const context = {
      action: 'workspace_provision',
      workspaceDir,
      missing,
      basePath: this.manager.basePath,
    }

    const resourceList = missing.map(m => `${m.type}:${m.name}`).join(', ')
    const task = `请将以下资源从全局资源库复制到工作空间 ${workspaceDir}：${resourceList}。` +
      `按 octo-resource-manager skill 指导执行：` +
      `1. 在 ~/.octopus/resources/installed/ 中查找每个资源 ` +
      `2. 复制 agent (.md) 到 workspace/.claude/agents/ ` +
      `3. 复制 skill (目录) 到 workspace/.claude/skills/ ` +
      `4. 如果 agent 依赖 skill（dependsOn），一并复制 ` +
      `5. 报告结果（provisioned/failed 数量）`

    const orchestrator = getOrchestratorService(this.org)
    try {
      const agentLog = await orchestrator.executeTask(
        task,
        ['octo-resource-manager'],
        context,
      )

      return this.parseProvisionResult(agentLog, missing.length)
    } catch (err: any) {
      // Agent 失败，降级为直接 fs 操作
      return this.fallbackProvision(missing, workspaceDir, err.message)
    }
  }

  /**
   * 降级：直接 fs 操作复制资源
   */
  private async fallbackProvision(
    missing: Array<{ type: 'agent' | 'skill'; name: string }>,
    workspaceDir: string,
    errorMsg: string,
  ): Promise<{ provisioned: number; failed: string[] }> {
    const failed: string[] = [`Agent delegation failed: ${errorMsg}. Falling back to direct copy.`]
    let provisioned = 0

    for (const item of missing) {
      try {
        await this.directCopy(item.type, item.name, workspaceDir)
        provisioned++
      } catch (err: any) {
        failed.push(`${item.type}:${item.name} — ${err.message}`)
      }
    }

    return { provisioned, failed }
  }

  /**
   * 直接复制单个资源（降级路径）
   */
  private async directCopy(
    type: 'agent' | 'skill',
    name: string,
    workspaceDir: string,
  ): Promise<void> {
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
            await this.directCopy('skill', depName, workspaceDir)
          } catch {
            // 依赖复制失败不阻塞主资源
          }
        }
      }
    }
  }

  /**
   * 从 Agent 日志解析预配结果
   */
  private parseProvisionResult(
    log: string,
    expected: number,
  ): { provisioned: number; failed: string[] } {
    const failed: string[] = []

    const provisionedMatch = log.match(/provisioned[:\s]+(\d+)/i)
    const failedMatch = log.match(/failed[:\s]+(\d+)/i)

    const provisioned = provisionedMatch ? parseInt(provisionedMatch[1], 10) : expected
    if (failedMatch && parseInt(failedMatch[1], 10) > 0) {
      failed.push(`Agent reported ${failedMatch[1]} failure(s)`)
    }

    return { provisioned, failed }
  }
}
