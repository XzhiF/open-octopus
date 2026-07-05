import { randomUUID } from "crypto"
import type { InstallPlan, ResourceManifest } from './schema'

/**
 * 快速创建 InstallPlan（工厂函数）
 */
export function createInstallPlan(
  additions: InstallPlan['additions'] = [],
  removals: string[] = [],
  conflicts: InstallPlan['conflicts'] = [],
): InstallPlan {
  return { id: randomUUID(), additions, removals, conflicts }
}

/**
 * InstallPlan builder — 计算安装计划的 additions/removals/conflicts
 */
export class InstallPlanBuilder {
  private additions: InstallPlan['additions'] = []
  private removals: string[] = []
  private conflicts: InstallPlan['conflicts'] = []
  private id: string

  constructor(id?: string) {
    this.id = id ?? `plan-${Date.now()}`
  }

  add(manifest: ResourceManifest, source: string): InstallPlanBuilder {
    this.additions.push({
      name: manifest.name,
      type: manifest.type,
      version: manifest.version,
      source,
    })
    return this
  }

  remove(name: string): InstallPlanBuilder {
    this.removals.push(name)
    return this
  }

  addConflict(name: string, reason: string): InstallPlanBuilder {
    this.conflicts.push({ name, reason })
    return this
  }

  build(): InstallPlan {
    return {
      id: this.id,
      additions: this.additions,
      removals: this.removals,
      conflicts: this.conflicts,
    }
  }

  get isEmpty(): boolean {
    return this.additions.length === 0 && this.removals.length === 0
  }

  get hasConflicts(): boolean {
    return this.conflicts.length > 0
  }
}
