// packages/engine/src/executors/identity-resolver.ts
//
// IdentityResolver — shared execution-identity resolution seam extracted from
// OctopusAgentExecutor (ticket 08). Input: clone code with optional @version
// pin. Output: identity snapshot (persona/config/skills) as ResolvedVersion,
// aligned with AgentExecutor inputs (snapshot.persona → systemPrompt,
// snapshot.skills → skills whitelist; cwd is never an identity input).
//
// Resolution order (spec §执行身份 P1 / D1):
//   1. agent_versions published snapshot (via injected VersionResolver)
//   2. ~/.octopus/agent/built-in/{name}/ directory
//   3. ~/.octopus/agent/clones/{name}/ directory
//   4. readable error naming the candidate paths tried
//

import { VersionResolver } from "@octopus/shared"
import type { ResolvedVersion, VersionStage } from "@octopus/shared"
import { existsSync, readFileSync, readdirSync } from "fs"
import { homedir } from "os"
import { join } from "path"

export interface IdentityResolverDeps {
  /** Published-version provider (server injects the DB-backed row list). */
  versionResolver: VersionResolver
  /** Root for built-in/clones directory probing (defaults to os.homedir(); injectable for tests). */
  homeDir?: string
}

/**
 * Thrown when an identity resolves through neither the published snapshot nor
 * any filesystem candidate. The message names every candidate path tried.
 */
export class IdentityResolveError extends Error {
  constructor(
    readonly ref: string,
    readonly candidatePaths: string[],
    readonly versionResolutionFailure: string,
  ) {
    super(
      `Identity "${ref}" not resolvable: published snapshots failed (${versionResolutionFailure}); ` +
      `no identity directory found. Candidate paths tried: ${candidatePaths.join(", ")}`,
    )
    this.name = "IdentityResolveError"
  }
}

/**
 * Split a clone ref into name + version spec.
 * "task-doer@1.2.0" → { name: "task-doer", versionSpec: "1.2.0" }
 * "task-doer" / "task-doer@" / "@1.0.0" → versionSpec defaults to "latest".
 */
export function parseIdentityRef(ref: string): { name: string; versionSpec: string } {
  const at = ref.indexOf("@")
  if (at > 0 && at < ref.length - 1) {
    return { name: ref.slice(0, at), versionSpec: ref.slice(at + 1) }
  }
  return { name: ref, versionSpec: "latest" }
}

export class IdentityResolver {
  private readonly homeRoot: string

  constructor(private readonly deps: IdentityResolverDeps) {
    this.homeRoot = deps.homeDir ?? homedir()
  }

  /**
   * Resolve the execution identity snapshot for a clone ref.
   * @param ref clone code, optionally with a pinned version: "name" or "name@1.2.0"
   * @param options versionSpec overrides any @version in the ref (octopus_agent passes node.version);
   *                minStage forwarded to published-version resolution
   */
  resolve(ref: string, options?: { versionSpec?: string; minStage?: VersionStage }): ResolvedVersion {
    const { name, versionSpec } = parseIdentityRef(ref)
    const spec = options?.versionSpec ?? versionSpec
    let versionError: unknown
    try {
      return this.deps.versionResolver.resolve(name, spec, options?.minStage)
    } catch (err) {
      // Published snapshot unavailable — fall through to directory probing
      versionError = err
    }

    const builtInDir = join(this.homeRoot, ".octopus", "agent", "built-in", name)
    const clonesDir = join(this.homeRoot, ".octopus", "agent", "clones", name)
    const identity = this.readIdentityFromDir(builtInDir) ?? this.readIdentityFromDir(clonesDir)
    if (identity) return identity

    const reason = versionError instanceof Error ? versionError.message : String(versionError)
    throw new IdentityResolveError(ref, [builtInDir, clonesDir], reason)
  }

  /**
   * Read an identity snapshot from a clone directory (persona.md + config.json + skills/).
   * Same construction as the former OctopusAgentExecutor.resolveFallback: version "current",
   * stage "stable". Returns null when the directory (or its read) is unavailable.
   */
  private readIdentityFromDir(dir: string): ResolvedVersion | null {
    try {
      if (!existsSync(dir)) return null

      const personaPath = join(dir, "persona.md")
      const persona = existsSync(personaPath) ? readFileSync(personaPath, "utf-8") : ""

      const configPath = join(dir, "config.json")
      let config: Record<string, unknown> = {}
      if (existsSync(configPath)) {
        try { config = JSON.parse(readFileSync(configPath, "utf-8")) } catch { /* empty */ }
      }

      const skillsDir = join(dir, "skills")
      let skills: string[] = []
      if (existsSync(skillsDir)) {
        skills = readdirSync(skillsDir).filter((f) => !f.startsWith("."))
      }

      return {
        version: "current",
        stage: "stable",
        snapshot: { persona, config, skills },
        fsPath: dir,
      }
    } catch {
      return null
    }
  }
}
