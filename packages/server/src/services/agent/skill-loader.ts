import fs from 'fs'
import path from 'path'
import os from 'os'
import { getAgentSkillsDir } from './paths'

// ── Types ──────────────────────────────────────────────────────

export type SkillSource = 'workspace_installed' | 'local_evolved' | 'builtin' | 'prod'

export interface LoadedSkill {
  name: string
  content: string
  source: SkillSource
  file_path: string
  has_backup: boolean
  description: string
}

export interface SkillSummary {
  name: string
  source: SkillSource
  description: string
  has_backup: boolean
}

// ── SkillLoader ────────────────────────────────────────────────

/**
 * Four-tier skill loading service.
 *
 * Priority order:
 *   0. Workspace installed — `{workspaceDir}/.claude/skills/{name}/SKILL.md`
 *      (highest priority, per-workspace resource management)
 *   1. Local evolved — `~/.octopus/{org}/agent/skills/{name}/SKILL.md`
 *      (has `.bak` file = evolved from builtin)
 *   2. Core-pack builtin — `packages/core-pack/skills/{name}/SKILL.md`
 *   3. Prod copy — `~/.octopus/prod/packages/core-pack/skills/{name}/SKILL.md`
 *
 * Used by SystemPromptAssembler, skill routes, and evolution diff.
 */
export class SkillLoader {
  private org: string
  private workspaceDir?: string
  private agentSkillsDir: string
  private builtinSkillsDir: string
  private prodSkillsDir: string

  constructor(org: string, workspaceDir?: string) {
    this.org = org
    this.workspaceDir = workspaceDir
    this.agentSkillsDir = getAgentSkillsDir()
    this.builtinSkillsDir = path.join(process.cwd(), 'packages', 'core-pack', 'skills')
    this.prodSkillsDir = path.join(os.homedir(), '.octopus', 'prod', 'packages', 'core-pack', 'skills')
  }

  /**
   * Set or update the workspace directory for Tier 0 scanning.
   * Useful when workspace context is not available at construction time.
   */
  setWorkspaceDir(dir: string): void {
    this.workspaceDir = dir
  }

  /**
   * Load a single skill by name, resolving through the three-tier priority.
   * Returns null if skill not found in any tier.
   */
  loadSkill(name: string): LoadedSkill | null {
    // Tier 0: Workspace-installed (highest priority)
    if (this.workspaceDir) {
      const wsPath = path.join(this.workspaceDir, '.claude', 'skills', name, 'SKILL.md')
      if (fs.existsSync(wsPath)) {
        const content = fs.readFileSync(wsPath, 'utf-8')
        return {
          name,
          content,
          source: 'workspace_installed',
          file_path: wsPath,
          has_backup: false,
          description: this.extractDescription(content),
        }
      }
    }

    // Tier 1: Local evolved (next highest priority)
    const localPath = path.join(this.agentSkillsDir, name, 'SKILL.md')
    const bakPath = path.join(this.agentSkillsDir, name, 'SKILL.md.bak')
    if (fs.existsSync(localPath)) {
      const content = fs.readFileSync(localPath, 'utf-8')
      return {
        name,
        content,
        source: fs.existsSync(bakPath) ? 'local_evolved' : 'builtin',
        file_path: localPath,
        has_backup: fs.existsSync(bakPath),
        description: this.extractDescription(content),
      }
    }

    // Tier 2: Core-pack builtin
    const builtinPath = path.join(this.builtinSkillsDir, name, 'SKILL.md')
    if (fs.existsSync(builtinPath)) {
      const content = fs.readFileSync(builtinPath, 'utf-8')
      return {
        name,
        content,
        source: 'builtin',
        file_path: builtinPath,
        has_backup: false,
        description: this.extractDescription(content),
      }
    }

    // Tier 3: Prod copy (lowest priority)
    const prodPath = path.join(this.prodSkillsDir, name, 'SKILL.md')
    if (fs.existsSync(prodPath)) {
      const content = fs.readFileSync(prodPath, 'utf-8')
      return {
        name,
        content,
        source: 'prod',
        file_path: prodPath,
        has_backup: false,
        description: this.extractDescription(content),
      }
    }

    return null
  }

  /**
   * List all available skills across all tiers, deduplicated by name.
   * Higher-priority sources override lower-priority ones.
   */
  listSkills(): SkillSummary[] {
    const skillMap = new Map<string, SkillSummary>()

    // Scan Tier 3 first (lowest priority — overwritten by higher tiers)
    this.scanDirectory(this.prodSkillsDir, 'prod', skillMap)

    // Scan Tier 2 (builtin — overwrites prod)
    this.scanDirectory(this.builtinSkillsDir, 'builtin', skillMap)

    // Scan Tier 1 (local evolved — overwrites all)
    if (fs.existsSync(this.agentSkillsDir)) {
      try {
        const entries = fs.readdirSync(this.agentSkillsDir, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          const skillFile = path.join(this.agentSkillsDir, entry.name, 'SKILL.md')
          const bakFile = path.join(this.agentSkillsDir, entry.name, 'SKILL.md.bak')
          if (fs.existsSync(skillFile)) {
            try {
              const content = fs.readFileSync(skillFile, 'utf-8')
              const source: SkillSource = fs.existsSync(bakFile) ? 'local_evolved' : 'builtin'
              skillMap.set(entry.name, {
                name: entry.name,
                source,
                description: this.extractDescription(content),
                has_backup: fs.existsSync(bakFile),
              })
            } catch { /* skip unreadable */ }
          }
        }
      } catch { /* skip */ }
    }

    // Scan Tier 0: Workspace-installed (highest priority — overwrites all)
    if (this.workspaceDir) {
      const wsSkillsDir = path.join(this.workspaceDir, '.claude', 'skills')
      this.scanDirectory(wsSkillsDir, 'workspace_installed', skillMap)
    }

    return [...skillMap.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * Get the source tier for a skill without loading its full content.
   */
  getSkillSource(name: string): SkillSource | null {
    // Tier 0: Workspace-installed
    if (this.workspaceDir) {
      const wsPath = path.join(this.workspaceDir, '.claude', 'skills', name, 'SKILL.md')
      if (fs.existsSync(wsPath)) return 'workspace_installed'
    }

    const localPath = path.join(this.agentSkillsDir, name, 'SKILL.md')
    if (fs.existsSync(localPath)) {
      const bakPath = path.join(this.agentSkillsDir, name, 'SKILL.md.bak')
      return fs.existsSync(bakPath) ? 'local_evolved' : 'builtin'
    }

    const builtinPath = path.join(this.builtinSkillsDir, name, 'SKILL.md')
    if (fs.existsSync(builtinPath)) return 'builtin'

    const prodPath = path.join(this.prodSkillsDir, name, 'SKILL.md')
    if (fs.existsSync(prodPath)) return 'prod'

    return null
  }

  /**
   * Compare local evolved skill against its builtin counterpart.
   * Returns diff metadata for the evolution UI.
   */
  diffBuiltin(name: string): {
    has_diff: boolean
    builtin_length: number
    local_length: number
    builtin_content?: string
    local_content?: string
  } {
    const builtinPath = path.join(this.builtinSkillsDir, name, 'SKILL.md')
    const localPath = path.join(this.agentSkillsDir, name, 'SKILL.md')

    if (!fs.existsSync(builtinPath)) {
      return { has_diff: false, builtin_length: 0, local_length: 0 }
    }

    const builtin = fs.readFileSync(builtinPath, 'utf-8')

    if (!fs.existsSync(localPath)) {
      return { has_diff: false, builtin_length: builtin.length, local_length: 0 }
    }

    const local = fs.readFileSync(localPath, 'utf-8')
    return {
      has_diff: builtin !== local,
      builtin_length: builtin.length,
      local_length: local.length,
    }
  }

  /**
   * Build a prompt segment for loaded skills.
   * Used by SystemPromptAssembler.buildSkillsSegment().
   * @param includeSkills - Optional whitelist of skill names to include
   */
  buildPromptSegment(includeSkills?: string[]): { content: string; count: number } {
    const skills = this.listSkills()
    const parts: string[] = []

    for (const skill of skills) {
      if (includeSkills && !includeSkills.includes(skill.name)) continue
      // Inject only summary (name + description) — agent loads full content on-demand
      parts.push(`- **${skill.name}**: ${skill.description}`)
    }

    const content = parts.length > 0
      ? `# 可用技能\n\n${parts.join('\n')}`
      : '# 可用技能\n\n（暂无已安装的技能）'

    return { content, count: parts.length }
  }

  // ── Private helpers ─────────────────────────────────────────

  private scanDirectory(
    dir: string,
    source: SkillSource,
    map: Map<string, SkillSummary>,
  ): void {
    if (!fs.existsSync(dir)) return
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const skillFile = path.join(dir, entry.name, 'SKILL.md')
        if (fs.existsSync(skillFile)) {
          try {
            const content = fs.readFileSync(skillFile, 'utf-8')
            map.set(entry.name, {
              name: entry.name,
              source,
              description: this.extractDescription(content),
              has_backup: false,
            })
          } catch { /* skip unreadable */ }
        }
      }
    } catch { /* skip */ }
  }

  /**
   * Extract a short description from SKILL.md content.
   * Looks for the first meaningful line after frontmatter.
   */
  private extractDescription(content: string): string {
    // Skip YAML frontmatter
    const lines = content.split('\n')
    let inFrontmatter = false
    for (const line of lines) {
      if (line.trim() === '---') {
        inFrontmatter = !inFrontmatter
        continue
      }
      if (inFrontmatter) continue

      // Skip empty lines and headers
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue

      return trimmed.slice(0, 120)
    }
    return content.slice(0, 120).replace(/\n/g, ' ').trim()
  }
}

// ── Singleton ──────────────────────────────────────────────────

const instances = new Map<string, SkillLoader>()

export function getSkillLoader(org: string, workspaceDir?: string): SkillLoader {
  const key = workspaceDir ? `${org}:${workspaceDir}` : org
  let instance = instances.get(key)
  if (!instance) {
    instance = new SkillLoader(org, workspaceDir)
    instances.set(key, instance)
  }
  return instance
}
