import fs from 'fs'
import path from 'path'
import os from 'os'
import { getAgentSkillsDir, getExperiencesDir, getAgentDir } from './paths'

// ── Types ──────────────────────────────────────────────────────────

export interface SkillSearchResult {
  name: string
  path: string
  similarity: number
  source: 'skill_search' | 'local_scan'
}

export interface RepoKnowledge {
  name: string
  path: string
  description: string
  structure: string[]
  matched: boolean
}

export interface MCPService {
  name: string
  description: string
  tools: string[]
  server_url?: string
  enabled: boolean
}

export interface SubsystemAvailability {
  skill_search: boolean
  repo_knowledge: boolean
  mcp_registry: boolean
  evolution_system: boolean
}

// ── SubsystemAdapter ───────────────────────────────────────────────

/**
 * Adapter for existing Octopus subsystems that the Agent can leverage.
 * Maps to PRD Stories I1 (Skill Search), I2 (Repo Knowledge),
 * I3 (MCP Registry), I4 (Evolution System).
 */
export class SubsystemAdapter {
  private org: string
  private orgDir: string
  private availabilityCache: SubsystemAvailability | null = null

  constructor(org: string) {
    this.org = org
    this.orgDir = path.join(os.homedir(), '.octopus', 'orgs', org)
  }

  /**
   * Check availability of all subsystems.
   */
  checkAvailability(): SubsystemAvailability {
    if (this.availabilityCache) return this.availabilityCache

    const availability: SubsystemAvailability = {
      skill_search: this.checkSkillSearchAvailable(),
      repo_knowledge: this.checkRepoKnowledgeAvailable(),
      mcp_registry: this.checkMCPRegistryAvailable(),
      evolution_system: this.checkEvolutionSystemAvailable(),
    }

    this.availabilityCache = availability
    return availability
  }

  // ── I1: Skill Search ──────────────────────────────────────────

  /**
   * Search for existing skills by semantic query.
   * Falls back to local directory scan if Skill Search is unavailable.
   */
  searchSkills(query: string, topK: number = 5): SkillSearchResult[] {
    if (this.checkSkillSearchAvailable()) {
      return this.searchViaSkillSearch(query, topK)
    }
    // Fallback: local SKILL directory scan
    return this.scanLocalSkills(query, topK)
  }

  private checkSkillSearchAvailable(): boolean {
    // Check if the skill-search package exists
    const skillSearchPath = path.join(process.cwd(), 'packages', 'shared', 'src', 'skill-search')
    return fs.existsSync(skillSearchPath)
  }

  private searchViaSkillSearch(query: string, topK: number): SkillSearchResult[] {
    // Delegate to the existing skill-search subsystem
    // In production, this calls the actual Skill Search API
    return this.scanLocalSkills(query, topK)
  }

  private scanLocalSkills(query: string, topK: number): SkillSearchResult[] {
    const results: SkillSearchResult[] = []
    const queryLower = query.toLowerCase()

    // Scan agent skills directory
    const agentSkillsDir = getAgentSkillsDir()
    if (fs.existsSync(agentSkillsDir)) {
      try {
        const entries = fs.readdirSync(agentSkillsDir, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const skillFile = path.join(agentSkillsDir, entry.name, 'SKILL.md')
            if (fs.existsSync(skillFile)) {
              const similarity = this.computeSimilarity(entry.name, queryLower)
              if (similarity > 0.1) {
                results.push({
                  name: entry.name,
                  path: skillFile,
                  similarity,
                  source: 'local_scan',
                })
              }
            }
          }
        }
      } catch {
        // Scan failure is non-fatal
      }
    }

    // Scan core-pack skills
    const corePackDir = path.join(process.cwd(), 'packages', 'core-pack', 'skills')
    if (fs.existsSync(corePackDir)) {
      try {
        const entries = fs.readdirSync(corePackDir, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isDirectory() && !results.find(r => r.name === entry.name)) {
            const similarity = this.computeSimilarity(entry.name, queryLower)
            if (similarity > 0.1) {
              results.push({
                name: entry.name,
                path: path.join(corePackDir, entry.name, 'SKILL.md'),
                similarity,
                source: 'local_scan',
              })
            }
          }
        }
      } catch {
        // Scan failure is non-fatal
      }
    }

    return results
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK)
  }

  private computeSimilarity(skillName: string, query: string): number {
    const nameLower = skillName.toLowerCase()
    const queryTerms = query.split(/\s+/).filter(t => t.length >= 2)
    let matches = 0
    for (const term of queryTerms) {
      if (nameLower.includes(term)) matches++
    }
    return queryTerms.length > 0 ? matches / queryTerms.length : 0
  }

  // ── I2: Repo Knowledge ────────────────────────────────────────

  /**
   * Query Repo Knowledge to find projects matching a description.
   */
  queryRepoKnowledge(description: string): RepoKnowledge[] {
    const indexPath = path.join(this.orgDir, 'repos', 'index.md')
    if (!fs.existsSync(indexPath)) return []

    try {
      const content = fs.readFileSync(indexPath, 'utf-8')
      return this.parseRepoIndex(content, description)
    } catch {
      return []
    }
  }

  private checkRepoKnowledgeAvailable(): boolean {
    const indexPath = path.join(this.orgDir, 'repos', 'index.md')
    return fs.existsSync(indexPath)
  }

  private parseRepoIndex(content: string, description: string): RepoKnowledge[] {
    const results: RepoKnowledge[] = []
    const descLower = description.toLowerCase()

    // Parse repo index entries (## header pattern)
    const sections = content.split(/^## /m).filter(s => s.trim())
    for (const section of sections) {
      const lines = section.split('\n')
      const name = lines[0]?.trim() ?? ''
      if (!name) continue

      // Check if this repo matches the description
      const sectionLower = section.toLowerCase()
      const matched = descLower.split(/\s+/).some(term =>
        term.length >= 2 && sectionLower.includes(term),
      )

      // Extract path from content
      const pathMatch = section.match(/[Pp]ath:\s*(.+)/)
      const repoPath = pathMatch?.[1]?.trim() ?? ''

      // Extract structure
      const structure: string[] = []
      const structMatch = section.match(/结构[：:]\s*\n([\s\S]*?)(?=\n##|\Z)/)
      if (structMatch) {
        const structLines = structMatch[1].split('\n').filter(l => l.trim().startsWith('-'))
        for (const line of structLines.slice(0, 5)) {
          structure.push(line.replace(/^[\s-]+/, '').trim())
        }
      }

      results.push({
        name,
        path: repoPath,
        description: lines.slice(1, 3).join(' ').trim(),
        structure,
        matched,
      })
    }

    return results
  }

  // ── I3: MCP Registry ──────────────────────────────────────────

  /**
   * Query MCP Registry for available services.
   */
  queryMCPRegistry(): MCPService[] {
    const mcpDir = path.join(this.orgDir, 'mcp')
    if (!fs.existsSync(mcpDir)) return []

    try {
      const yamlFiles = fs.readdirSync(mcpDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
      const services: MCPService[] = []

      for (const file of yamlFiles) {
        const content = fs.readFileSync(path.join(mcpDir, file), 'utf-8')
        const parsed = this.parseMCPYaml(content, file)
        services.push(...parsed)
      }

      return services
    } catch {
      return []
    }
  }

  private checkMCPRegistryAvailable(): boolean {
    const mcpDir = path.join(this.orgDir, 'mcp')
    return fs.existsSync(mcpDir)
  }

  private parseMCPYaml(content: string, filename: string): MCPService[] {
    const services: MCPService[] = []

    // Simple YAML parsing for MCP entries
    const blocks = content.split(/^---/m).filter(b => b.trim())
    for (const block of blocks) {
      const nameMatch = block.match(/name:\s*(.+)/)
      const descMatch = block.match(/description:\s*(.+)/)
      const toolsMatch = block.match(/tools:\s*\n((?:\s+-\s+.+\n?)+)/)

      if (nameMatch) {
        const tools: string[] = []
        if (toolsMatch) {
          const toolLines = toolsMatch[1].split('\n').filter(l => l.trim().startsWith('-'))
          for (const line of toolLines) {
            tools.push(line.replace(/^[\s-]+/, '').trim())
          }
        }

        services.push({
          name: nameMatch[1].trim(),
          description: descMatch?.[1]?.trim() ?? '',
          tools,
          enabled: false, // MCP services require user confirmation to enable
        })
      }
    }

    return services
  }

  // ── I4: Evolution System ──────────────────────────────────────

  /**
   * Check if the Evolution System is available.
   */
  private checkEvolutionSystemAvailable(): boolean {
    const evolutionDir = path.join(this.orgDir, 'evolution')
    return fs.existsSync(evolutionDir) || fs.existsSync(path.join(getAgentDir(), 'evolution'))
  }

  /**
   * Write an experience entry (reusing existing evolution format).
   */
  writeExperience(skillName: string, content: string): string {
    const expDir = getExperiencesDir()
    fs.mkdirSync(expDir, { recursive: true })

    const filename = `${skillName}-${new Date().toISOString().replace(/[:.]/g, '-')}.md`
    const fullPath = path.join(expDir, filename)
    const formattedContent = `# ${skillName} 经验\n\n> ${new Date().toISOString()}\n\n${content}\n`
    fs.writeFileSync(fullPath, formattedContent, 'utf-8')

    // Update index
    this.updateExperienceIndex(expDir)

    return fullPath
  }

  /**
   * Search experiences for historical patterns.
   */
  searchExperiences(query: string, topK: number = 3): Array<{ name: string; content: string; score: number }> {
    const expDir = getExperiencesDir()
    if (!fs.existsSync(expDir)) return []

    const results: Array<{ name: string; content: string; score: number }> = []
    const queryLower = query.toLowerCase()

    try {
      const files = fs.readdirSync(expDir).filter(f => f.endsWith('.md'))
      for (const file of files) {
        const fullPath = path.join(expDir, file)
        const content = fs.readFileSync(fullPath, 'utf-8')
        const contentLower = content.toLowerCase()

        // Simple keyword matching
        const terms = queryLower.split(/\s+/).filter(t => t.length >= 2)
        const matches = terms.filter(t => contentLower.includes(t)).length
        const score = terms.length > 0 ? matches / terms.length : 0

        if (score > 0.2) {
          results.push({ name: file, content, score })
        }
      }
    } catch {
      // Search failure is non-fatal
    }

    return results.sort((a, b) => b.score - a.score).slice(0, topK)
  }

  /**
   * Update the experience index file.
   */
  private updateExperienceIndex(expDir: string): void {
    try {
      const files = fs.readdirSync(expDir).filter(f => f.endsWith('.md') && f !== 'index.md')
      const indexPath = path.join(expDir, 'index.md')
      const lines = ['# 经验索引\n', `> 更新时间: ${new Date().toISOString()}\n`]
      for (const file of files) {
        const name = file.replace(/\.md$/, '').replace(/-/g, ' ')
        lines.push(`- [${name}](./${file})`)
      }
      fs.writeFileSync(indexPath, lines.join('\n'), 'utf-8')
    } catch {
      // Index update failure is non-fatal
    }
  }
}

// ── Singleton ───────────────────────────────────────────────────────

const instances = new Map<string, SubsystemAdapter>()

export function getSubsystemAdapter(org: string): SubsystemAdapter {
  let instance = instances.get(org)
  if (!instance) {
    instance = new SubsystemAdapter(org)
    instances.set(org, instance)
  }
  return instance
}
