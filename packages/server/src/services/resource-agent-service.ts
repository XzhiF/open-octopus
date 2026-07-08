import type { ResourceManager } from '@octopus/shared'
import type { ResourceAuditCaller } from '@octopus/shared'
import { getProvider } from '@octopus/providers'

/**
 * ResourceAgentService — Agent 代理层，包装资源操作。
 * 所有 source install/sync 操作通过此服务执行，实现：
 * - AI 智能决策（异常处理、依赖解析）
 * - 统一审计日志
 * - Skill 指导（octo-resource-manager, octo-source-analyzer）
 */
export class ResourceAgentService {
  private manager: ResourceManager
  private org: string

  constructor(manager: ResourceManager, org: string) {
    this.manager = manager
    this.org = org
  }

  /**
   * source install — Agent 指导的批量安装
   * Agent 使用 octo-resource-manager SKILL 执行安装，处理异常
   */
  async installFromSource(params: {
    sourceName: string
    group: string
    resources: Array<{ type: string; name: string; path: string }>
    caller: ResourceAuditCaller
  }): Promise<{ installed: number; skipped: number; errors: string[] }> {
    const { sourceName, group, resources, caller } = params
    const errors: string[] = []

    // Phase 1: 直接调用 ResourceManager（后续替换为 AI 决策）
    try {
      const result = this.manager.installFromSource(sourceName, group, resources, caller)
      return { ...result, errors }
    } catch (err: any) {
      // Agent 智能处理：记录错误，尝试逐个安装
      errors.push(`Batch install failed: ${err.message}. Trying individual installs...`)

      let installed = 0
      let skipped = 0
      for (const res of resources) {
        try {
          const single = this.manager.installFromSource(sourceName, group, [res], caller)
          installed += single.installed
          skipped += single.skipped
        } catch (e: any) {
          errors.push(`${res.type}:${res.name} — ${e.message}`)
        }
      }
      return { installed, skipped, errors }
    }
  }

  /**
   * source sync — Agent 指导的同步操作
   * Agent 使用 octo-source-analyzer SKILL 执行条件判断：
   * 1. git pull 更新缓存
   * 2. hash 对比跳过未变
   * 3. 覆盖变更文件
   * 4. 检测新增/删除
   */
  async syncSource(params: {
    sourceName: string
    caller: ResourceAuditCaller
  }): Promise<{
    sourceName: string
    updated: number
    added: number
    removed: number
    unchanged: number
    errors: string[]
  }> {
    const { sourceName, caller } = params
    const errors: string[] = []

    try {
      const result = this.manager.syncSource(sourceName, caller)
      return { ...result, errors }
    } catch (err: any) {
      errors.push(`Sync failed: ${err.message}`)
      return { sourceName, updated: 0, added: 0, removed: 0, unchanged: 0, errors }
    }
  }
}
