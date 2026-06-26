// packages/server/src/services/knowledge-files.ts
// KnowledgeFilesService — Phase 3 of Execution Memory: Experience Extraction & Indexing.
// Generates markdown knowledge files from experience_index, organized by project and type.
// Files are written to ~/.octopus/orgs/{org}/knowledge/{project}/

import fs from 'fs'
import path from 'path'
import os from 'os'
import type { ExperienceDAO } from "../db/dao/experience-dao"

export class KnowledgeFilesService {
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private experienceDAO: ExperienceDAO) {}

  /**
   * Update knowledge markdown files for a project.
   * Debounced: concurrent calls within 1s only execute once.
   */
  updateKnowledgeFiles(org: string, project: string): void {
    const key = `${org}/${project}`
    const existing = this.debounceTimers.get(key)
    if (existing) clearTimeout(existing)

    this.debounceTimers.set(key, setTimeout(() => {
      this.debounceTimers.delete(key)
      this._doUpdate(org, project).catch(err => {
        console.error(`[KnowledgeFiles] update failed for ${key}:`, err)
      })
    }, 1000))
  }

  private async _doUpdate(org: string, project: string): Promise<void> {
    const experiences = this.experienceDAO.getByProject(project, 'active')

    // Group by type
    const groups: Record<string, typeof experiences> = {
      bug: [], pattern: [], cost: [], failure: [],
    }
    for (const exp of experiences) {
      const type = exp.type as keyof typeof groups
      if (groups[type]) groups[type].push(exp)
    }

    // Sort by relevance_score DESC, limit 50 per type
    for (const type of Object.keys(groups)) {
      groups[type].sort((a, b) => b.relevance_score - a.relevance_score)
      groups[type] = groups[type].slice(0, 50)
    }

    // Write files to ~/.octopus/orgs/{org}/knowledge/{project}/
    const dir = path.join(os.homedir(), '.octopus', 'orgs', org, 'knowledge', project)
    fs.mkdirSync(dir, { recursive: true })

    const fileMap: Record<string, string> = {
      bug: 'bugs.md',
      pattern: 'patterns.md',
      cost: 'costs.md',
      failure: 'failures.md',
    }

    for (const [type, filename] of Object.entries(fileMap)) {
      const items = groups[type] || []
      const content = this.renderMarkdown(type, items)
      fs.writeFileSync(path.join(dir, filename), content, 'utf-8')
    }
  }

  private renderMarkdown(type: string, items: Array<{
    title: string
    content: string
    keywords: string | null
    created_at: string
    relevance_score: number
  }>): string {
    const header = `# ${type.charAt(0).toUpperCase() + type.slice(1)} Lessons\n\n`
    if (items.length === 0) return header + '_No active lessons._\n'

    const sections = items.map(item => {
      let keywords = ''
      try {
        const kw = JSON.parse(item.keywords || '[]')
        if (Array.isArray(kw) && kw.length > 0) keywords = `\n\n**Keywords:** ${kw.join(', ')}`
      } catch { /* ignore parse errors */ }
      return `## ${item.title}\n\n${item.content}${keywords}\n\n_Score: ${item.relevance_score.toFixed(2)} | ${item.created_at}_`
    })

    return header + sections.join('\n\n---\n\n')
  }

  destroy(): void {
    for (const timer of this.debounceTimers.values()) clearTimeout(timer)
    this.debounceTimers.clear()
  }
}
