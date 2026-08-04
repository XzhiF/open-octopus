// packages/shared/src/version/version-resolver.ts
//
// Version resolution utilities for octopus_agent nodes.
// Provides Maven-style version comparison, parsing, and resolution logic.
// The actual DB lookup is done by the server's AgentVersionService;
// the engine injects that service's results into VersionResolver.
//

import type { VersionStage, AgentVersionInfo, AgentSnapshot, ResolvedVersion } from "../types/octopus-agent"

// ===== VersionNotFoundError =====

export class VersionNotFoundError extends Error {
  constructor(
    public readonly agentName: string,
    public readonly versionSpec: string,
  ) {
    super(`Version not found for agent "${agentName}" with spec "${versionSpec}"`)
    this.name = "VersionNotFoundError"
  }
}

// ===== stageRank =====

const STAGE_RANKS: Record<VersionStage, number> = {
  alpha: 0,
  beta: 1,
  rc: 2,
  stable: 3,
}

export function stageRank(stage: VersionStage): number {
  return STAGE_RANKS[stage]
}

// ===== parseVersionString =====

export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  stage: VersionStage
  qualifier?: string
}

const VERSION_REGEX = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)(?:\.(\d+))?)?$/

export function parseVersionString(version: string): ParsedVersion {
  const match = VERSION_REGEX.exec(version)
  if (!match) {
    throw new Error(`Invalid version string: "${version}"`)
  }

  const [, majorStr, minorStr, patchStr, stageStr, qualifierStr] = match

  return {
    major: parseInt(majorStr, 10),
    minor: parseInt(minorStr, 10),
    patch: parseInt(patchStr, 10),
    stage: (stageStr as VersionStage) || "stable",
    qualifier: qualifierStr || undefined,
  }
}

// ===== compareVersions =====

/**
 * Compare two Maven-style version strings.
 * Returns negative if a < b, positive if a > b, 0 if equal.
 *
 * Ordering: 1.0.0-alpha.1 < 1.0.0-beta.1 < 1.0.0-rc.1 < 1.0.0
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersionString(a)
  const pb = parseVersionString(b)

  // Compare major.minor.patch
  if (pa.major !== pb.major) return pa.major - pb.major
  if (pa.minor !== pb.minor) return pa.minor - pb.minor
  if (pa.patch !== pb.patch) return pa.patch - pb.patch

  // Compare stage rank
  const stageDiff = stageRank(pa.stage) - stageRank(pb.stage)
  if (stageDiff !== 0) return stageDiff

  // Compare qualifier (numeric)
  const qa = pa.qualifier ? parseInt(pa.qualifier, 10) : -1
  const qb = pb.qualifier ? parseInt(pb.qualifier, 10) : -1
  return qa - qb
}

// ===== VersionResolver =====

/**
 * Resolves an agent version spec against a list of available versions.
 *
 * Version specs:
 * - "latest" → latest published version with stage >= minStage (default: stable)
 * - "1.2.0" → exact match
 * - "1.2.0-beta.1" → exact match with qualifier
 *
 * Archived versions are skipped for "latest" but accessible via exact pin.
 * Draft versions are always skipped.
 */
export class VersionResolver {
  constructor(private readonly versions: AgentVersionInfo[]) {}

  resolve(agentName: string, versionSpec: string, minStage?: VersionStage): ResolvedVersion {
    const agentVersions = this.versions.filter((v) => v.agent_name === agentName)

    if (agentVersions.length === 0) {
      throw new VersionNotFoundError(agentName, versionSpec)
    }

    if (versionSpec === "latest") {
      return this.resolveLatest(agentName, agentVersions, minStage)
    }

    return this.resolvePinned(agentName, versionSpec, agentVersions)
  }

  private resolveLatest(
    agentName: string,
    versions: AgentVersionInfo[],
    minStage?: VersionStage,
  ): ResolvedVersion {
    const minRank = stageRank(minStage ?? "stable")

    // Filter: published only, stage >= minStage
    const candidates = versions.filter((v) => {
      if (v.status !== "published") return false
      if (stageRank(v.stage) < minRank) return false
      return true
    })

    if (candidates.length === 0) {
      throw new VersionNotFoundError(agentName, "latest")
    }

    // Sort by version descending, pick highest
    candidates.sort((a, b) => compareVersions(b.version, a.version))
    const best = candidates[0]

    return this.toResolvedVersion(best)
  }

  private resolvePinned(
    agentName: string,
    versionSpec: string,
    versions: AgentVersionInfo[],
  ): ResolvedVersion {
    const match = versions.find((v) => v.version === versionSpec)
    if (!match) {
      throw new VersionNotFoundError(agentName, versionSpec)
    }

    return this.toResolvedVersion(match)
  }

  private toResolvedVersion(info: AgentVersionInfo): ResolvedVersion {
    let snapshot: AgentSnapshot
    try {
      snapshot = JSON.parse(info.snapshot) as AgentSnapshot
    } catch {
      snapshot = { persona: "", config: {}, skills: [] }
    }

    return {
      version: info.version,
      stage: info.stage,
      snapshot,
      fsPath: `~/.octopus/agent/versions/${info.agent_name}/${info.version}/`,
    }
  }
}
