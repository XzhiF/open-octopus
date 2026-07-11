import type { ResourceManager } from '@octopus/shared'
import type { ResourceAuditCaller } from '@octopus/shared'
import { getOrchestratorService } from './agent/orchestrator-service'

/**
 * ResourceAgentService — 所有资源操作统一委托 Orchestrator Agent。
 *
 * 设计原则：除 Engine 执行外，所有资源操作走 Orchestrator Agent，
 * 实现统一审计、高容错、可观测。
 *
 * Agent 使用 octo-resource-manager / octo-source-analyzer SKILL 指导操作。
 * ResourceManager 仅作为数据层被 Agent 间接调用。
 */
export class ResourceAgentService {
  private manager: ResourceManager

  constructor(manager: ResourceManager) {
    this.manager = manager
  }

  /**
   * source install — 委托 Orchestrator Agent 执行批量安装
   */
  async installFromSource(params: {
    sourceName: string
    group: string
    resources: Array<{ type: string; name: string; path: string }>
    caller: ResourceAuditCaller
  }): Promise<{ installed: number; skipped: number; errors: string[]; agentLog: string }> {
    const { sourceName, group, resources, caller } = params

    // 准备 context 供 Agent 使用
    const context = {
      action: 'source_install',
      sourceName,
      group,
      basePath: this.manager.basePath,
      resourceCount: resources.length,
      resources: resources.slice(0, 50), // 限制 context 大小
    }

    const task = `从源 ${sourceName} 安装 ${resources.length} 个资源到全局资源库。组名: ${group}。\n\n` +
      `安装策略（按优先级）：\n` +
      `1. 检查源仓库是否有安装脚本（setup.sh, install.sh, Makefile, package.json scripts），` +
      `如果有，按仓库自身的安装流程执行\n` +
      `2. 如果没有安装脚本，按 octo-resource-manager skill 指导，从 sources/ 缓存复制到 installed/ 目录\n` +
      `3. 检查资源依赖（agent frontmatter 中的 skills: 字段），一并安装依赖资源\n` +
      `4. 注册到 registry.json\n\n` +
      `如果某个资源安装失败，记录错误并继续下一个。\n` +
      `最后报告安装结果（installed/skipped/errors 数量）。`

    const orchestrator = getOrchestratorService("default")
    try {
      const agentLog = await orchestrator.executeTask(
        task,
        ['octo-resource-manager'],
        context,
      )

      // 解析 Agent 返回的结果
      const result = this.parseInstallResult(agentLog, resources.length)
      return { ...result, agentLog }
    } catch (err: any) {
      // Agent 执行失败，降级为直接调用 ResourceManager
      return this.fallbackInstall(sourceName, group, resources, caller, err.message)
    }
  }

  /**
   * source sync — 委托 Orchestrator Agent 执行同步
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
    agentLog: string
  }> {
    const { sourceName, caller } = params

    const context = {
      action: 'source_sync',
      sourceName,
      basePath: this.manager.basePath,
    }

    const task = `同步源 ${sourceName}。请按以下步骤执行：\n\n` +
      `1. git pull 更新 sources/ 缓存\n` +
      `2. 重新 discover 资源列表（用 octo-source-analyzer skill 的分析策略）\n` +
      `3. hash 对比：对比缓存文件和 installed/ 中已安装文件的 hash\n` +
      `   - hash 相同 → 跳过（计入 unchanged）\n` +
      `   - hash 不同 → 标记为 updated\n` +
      `4. 对 updated 资源：\n` +
      `   - 检查源仓库是否有安装脚本，如果有则重新执行安装流程\n` +
      `   - 如果没有安装脚本，直接从缓存覆盖 installed/ 中的文件\n` +
      `   - 更新 registry.json 的 sourceHash\n` +
      `5. 检测新增（added）— 不自动安装，报告给用户\n` +
      `6. 检测删除 — 标记为 orphan，不删除文件\n` +
      `7. 报告结果（updated/added/removed/unchanged 数量）`

    const orchestrator = getOrchestratorService("default")
    try {
      const agentLog = await orchestrator.executeTask(
        task,
        ['octo-source-analyzer', 'octo-resource-manager'],
        context,
      )

      const result = this.parseSyncResult(agentLog)
      return { sourceName, ...result, agentLog }
    } catch (err: any) {
      // Agent 执行失败，降级为直接调用
      return this.fallbackSync(sourceName, caller, err.message)
    }
  }

  /**
   * 降级：直接调用 ResourceManager 执行安装
   */
  private async fallbackInstall(
    sourceName: string,
    group: string,
    resources: Array<{ type: string; name: string; path: string }>,
    caller: ResourceAuditCaller,
    errorMsg: string,
  ): Promise<{ installed: number; skipped: number; errors: string[]; agentLog: string }> {
    const errors: string[] = [`Agent delegation failed: ${errorMsg}. Falling back to direct install.`]

    try {
      const result = this.manager.installFromSource(sourceName, group, resources as any, caller)
      return { ...result, errors, agentLog: '' }
    } catch (err: any) {
      errors.push(`Batch install failed: ${err.message}. Trying individual installs...`)

      let installed = 0
      let skipped = 0
      for (const res of resources) {
        try {
          const single = this.manager.installFromSource(sourceName, group, [res] as any, caller)
          installed += single.installed
          skipped += single.skipped
        } catch (e: any) {
          errors.push(`${res.type}:${res.name} — ${e.message}`)
        }
      }
      return { installed, skipped, errors, agentLog: '' }
    }
  }

  /**
   * 降级：直接调用 ResourceManager 执行同步
   */
  private fallbackSync(
    sourceName: string,
    caller: ResourceAuditCaller,
    errorMsg: string,
  ): {
    sourceName: string; updated: number; added: number; removed: number; unchanged: number
    errors: string[]; agentLog: string
  } {
    try {
      const result = this.manager.syncSource(sourceName, caller)
      return { ...result, errors: [`Agent delegation failed: ${errorMsg}. Used direct sync.`], agentLog: '' }
    } catch (err: any) {
      return {
        sourceName, updated: 0, added: 0, removed: 0, unchanged: 0,
        errors: [`Agent and direct sync both failed: ${err.message}`],
        agentLog: '',
      }
    }
  }

  /**
   * 从 Agent 日志中解析安装结果
   */
  private parseInstallResult(
    log: string,
    total: number,
  ): { installed: number; skipped: number; errors: string[] } {
    const errors: string[] = []
    let installed = 0
    let skipped = 0

    // 尝试从 Agent 输出中提取数字
    const installedMatch = log.match(/installed[:\s]+(\d+)/i)
    const skippedMatch = log.match(/skipped[:\s]+(\d+)/i)
    const errorMatch = log.match(/errors?[:\s]+(\d+)/i)

    if (installedMatch) installed = parseInt(installedMatch[1], 10)
    if (skippedMatch) skipped = parseInt(skippedMatch[1], 10)
    if (errorMatch && parseInt(errorMatch[1], 10) > 0) {
      errors.push(`Agent reported ${errorMatch[1]} error(s)`)
    }

    // 如果解析不到，保守估计
    if (installed === 0 && skipped === 0 && errors.length === 0) {
      installed = total // 假设 Agent 成功安装了全部
    }

    return { installed, skipped, errors }
  }

  /**
   * 从 Agent 日志中解析同步结果
   */
  private parseSyncResult(
    log: string,
  ): { updated: number; added: number; removed: number; unchanged: number; errors: string[] } {
    const errors: string[] = []

    const updatedMatch = log.match(/updated[:\s]+(\d+)/i)
    const addedMatch = log.match(/added[:\s]+(\d+)/i)
    const removedMatch = log.match(/removed[:\s]+(\d+)/i)
    const unchangedMatch = log.match(/unchanged[:\s]+(\d+)/i)

    return {
      updated: updatedMatch ? parseInt(updatedMatch[1], 10) : 0,
      added: addedMatch ? parseInt(addedMatch[1], 10) : 0,
      removed: removedMatch ? parseInt(removedMatch[1], 10) : 0,
      unchanged: unchangedMatch ? parseInt(unchangedMatch[1], 10) : 0,
      errors,
    }
  }
}
