import fs from 'fs'
import path from 'path'
import os from 'os'

/** Valid org name: alphanumeric, hyphens, underscores, dots. No path separators. */
const ORG_NAME_REGEX = /^[a-zA-Z0-9._-]{1,64}$/

/** Reserved directory names that must be rejected even if they match the regex. */
const RESERVED_ORG_NAMES = new Set(['.', '..', 'db', 'prod', 'ports', 'orgs'])

export interface OrgContext {
  /** From CLI --org flag */
  cliOrg?: string
  /** From HTTP header X-Octopus-Org */
  headerOrg?: string
  /** From environment variable OCTOPUS_ORG */
  envOrg?: string
  /** From current working directory (workspace → org inference) */
  cwdOrg?: string
  /** Default org from config.yaml */
  defaultOrg?: string
}

export class OrgValidationError extends Error {
  code = 'INVALID_ORG_NAME'
  constructor(org: string) {
    super(`Invalid organization name: '${org}'. Must match ${ORG_NAME_REGEX}`)
    this.name = 'OrgValidationError'
  }
}

export class OrgNotFoundError extends Error {
  code = 'ORG_NOT_FOUND'
  constructor(org: string) {
    super(`Organization '${org}' not found (directory ~/.octopus/orgs/${org}/ does not exist)`)
    this.name = 'OrgNotFoundError'
  }
}

export class OrgResolver {
  /**
   * Validate that an org name is safe and does not contain path traversal sequences.
   */
  validateOrgName(org: string): void {
    if (!ORG_NAME_REGEX.test(org) || RESERVED_ORG_NAMES.has(org)) {
      throw new OrgValidationError(org)
    }
  }

  /**
   * Resolve org from context using priority chain:
   * CLI --org > HTTP header X-Octopus-Org > ENV OCTOPUS_ORG > cwd > config default_org
   *
   * Throws OrgValidationError if the org name is invalid.
   * Throws OrgNotFoundError if resolved org directory doesn't exist.
   */
  resolveOrg(context: OrgContext): string {
    const candidates = [
      context.cliOrg,
      context.headerOrg,
      context.envOrg ?? process.env.OCTOPUS_ORG,
      context.cwdOrg ?? this.inferOrgFromCwd(),
      context.defaultOrg,
    ].filter((v): v is string => !!v && v.length > 0)

    for (const org of candidates) {
      this.validateOrgName(org)
      if (this.orgExists(org)) {
        return org
      }
    }

    // If we had candidates but none existed, report the first one
    if (candidates.length > 0) {
      throw new OrgNotFoundError(candidates[0])
    }

    throw new OrgNotFoundError('(none)')
  }

  /**
   * Check if an org directory exists at ~/.octopus/{org}/
   * Includes path containment check to prevent traversal.
   */
  orgExists(org: string): boolean {
    const base = path.join(os.homedir(), '.octopus', 'orgs')
    const orgDir = path.resolve(base, org)
    // Path containment: resolved path must be under the base directory
    if (!orgDir.startsWith(base + path.sep) && orgDir !== base) {
      return false
    }
    return fs.existsSync(orgDir)
  }

  /**
   * List all available orgs by scanning ~/.octopus/ directories.
   */
  listOrgs(): string[] {
    const base = path.join(os.homedir(), '.octopus', 'orgs')
    if (!fs.existsSync(base)) return []

    return fs.readdirSync(base, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'db' && d.name !== 'prod' && d.name !== 'ports' && ORG_NAME_REGEX.test(d.name))
      .map(d => d.name)
  }

  /**
   * Infer org from current working directory.
   * Looks for ~/.octopus/{org}/ pattern in cwd path.
   */
  private inferOrgFromCwd(): string | null {
    const cwd = process.cwd()
    const base = path.join(os.homedir(), '.octopus', 'orgs')
    if (cwd.startsWith(base)) {
      const relative = cwd.slice(base.length + 1) // +1 for separator
      const parts = relative.split(path.sep)
      if (parts.length > 0 && parts[0]) {
        return parts[0]
      }
    }
    return null
  }
}

// Singleton
let orgResolverInstance: OrgResolver | null = null

export function getOrgResolver(): OrgResolver {
  if (!orgResolverInstance) {
    orgResolverInstance = new OrgResolver()
  }
  return orgResolverInstance
}
