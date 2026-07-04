import { ResourceManifest, ResourceType } from "../types/resource-manifest"
import { RepoError } from "./errors"

export interface ResolveTarget {
  name: string
  type: ResourceType
}

export interface InstallStep {
  name: string
  type: ResourceType
  manifest: ResourceManifest
}

export interface InstallPlan {
  ordered: InstallStep[]
  skipped: string[]
  totalSize: number
}

interface ResolverOptions {
  maxDepth?: number
}

export class DependencyResolver {
  private manifestMap = new Map<string, ResourceManifest>()
  private maxDepth: number

  constructor(manifests: ResourceManifest[], opts: ResolverOptions = {}) {
    this.maxDepth = opts.maxDepth ?? 3
    for (const m of manifests) {
      this.manifestMap.set(`${m.type}:${m.name}`, m)
    }
  }

  resolve(targets: ResolveTarget[]): InstallPlan {
    const visited = new Set<string>()
    const inStack = new Set<string>()
    const order: InstallStep[] = []
    const skipped: string[] = []

    const visit = (qn: string, depth: number, chain: string[]) => {
      if (depth > this.maxDepth) {
        throw new RepoError(
          `Depth exceeds limit (max ${this.maxDepth}): ${chain.join("→")}`,
          "DEPTH_EXCEEDED",
          "Reduce dependency chain depth",
          2
        )
      }
      if (inStack.has(qn)) {
        const cycleStart = chain.indexOf(qn)
        const cycle = [...chain.slice(cycleStart), qn].join("→")
        throw new RepoError(
          `Circular: ${cycle}`,
          "CIRCULAR_DEPENDENCY",
          `Break the cycle at ${cycle.split("→").slice(-2).join("→")}`,
          2
        )
      }
      if (visited.has(qn)) return

      const manifest = this.manifestMap.get(qn)
      if (!manifest) return

      inStack.add(qn)
      visited.add(qn)

      for (const dep of manifest.dependencies) {
        const depQn = `${dep.type}:${dep.name}`
        const depManifest = this.manifestMap.get(depQn)
        if (!depManifest) {
          if (dep.optional) {
            skipped.push(dep.name)
            continue
          }
          throw new RepoError(
            `Dependency not found: ${depQn} (required by ${qn})`,
            "DEPENDENCY_NOT_FOUND",
            `Register ${dep.name} first: octopus repo register <ref> --type ${dep.type}`,
            4
          )
        }
        visit(depQn, depth + 1, [...chain, qn])
      }

      inStack.delete(qn)
      order.push({ name: manifest.name, type: manifest.type, manifest })
    }

    for (const target of targets) {
      const qn = `${target.type}:${target.name}`
      if (!this.manifestMap.has(qn)) {
        throw new RepoError(
          `Resource not found: ${qn}`,
          "RESOURCE_NOT_FOUND",
          `Register it first: octopus repo register <ref> --type ${target.type}`,
          4
        )
      }
      visit(qn, 0, [])
    }

    return { ordered: order, skipped, totalSize: 0 }
  }
}
