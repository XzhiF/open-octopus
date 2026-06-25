import type { ForkConfig, VarPool } from "@octopus/shared"

/**
 * Selects which fork branches to execute based on path_strategy.
 * v1 supports: all, primary.
 */
export class ForkPathSelector {
  constructor(private config: ForkConfig) {}

  selectPaths(
    forkNodeId: string,
    availableBranches: string[],
    pool: VarPool,
    primaryMap?: Map<string, boolean>,
  ): string[] {
    switch (this.config.path_strategy) {
      case "all":
        return [...availableBranches]
      case "primary": {
        if (!primaryMap || primaryMap.size === 0) {
          return [...availableBranches]
        }
        const selected = availableBranches.filter(b => primaryMap.get(b) === true)
        return selected.length > 0 ? selected : [...availableBranches]
      }
      default:
        return [...availableBranches]
    }
  }
}
