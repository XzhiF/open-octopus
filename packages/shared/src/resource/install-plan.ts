import type { InstallPlan, ResourceManifest } from './schema'

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
