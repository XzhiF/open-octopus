import fs from 'fs'
import path from 'path'
import type { MemoryContent, MemorySearchResult } from '@octopus/shared'
import { getAgentDir, getDailyMemoryDir, getLongTermMemoryPath, getAgentMemoryDir } from './paths'
import { AgentSessionDAO } from '../../db/dao'

// ── Types ──────────────────────────────────────────────────────

export type MemoryLayer = 'long-term' | 'daily' | 'session'

export interface MemoryWriteResult {
  ok: boolean
  token_count: number
}

// ── MemoryService ─────────────────────────────────────────────

export class MemoryService {
  constructor(private dao: AgentSessionDAO) {}

  /**
   * Read memory content for a layer.
   */
  readMemory(org: string, layer: MemoryLayer): MemoryContent {
    const filePath = this.getMemoryPath(layer)

    if (!fs.existsSync(filePath)) {
      return { content: '', layer, token_count: 0, last_modified: new Date().toISOString() }
    }

    const content = fs.readFileSync(filePath, 'utf-8')
    const stat = fs.statSync(filePath)
    return {
      content,
      layer,
      token_count: this.estimateTokens(content),
      last_modified: stat.mtime.toISOString(),
    }
  }

  /**
   * Write memory content with optional conflict detection.
   * If expectedLastModified is provided and doesn't match file mtime, throws MEMORY_CONFLICT.
   */
  writeMemory(org: string, layer: MemoryLayer, content: string, expectedLastModified?: string): MemoryWriteResult & { conflict?: boolean; server_content?: string } {
    const filePath = this.getMemoryPath(layer)
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

    // Conflict detection: check if file was modified since client last read it
    if (expectedLastModified && fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath)
      const serverModified = stat.mtime.toISOString()
      // Compare timestamps — if server has a newer mtime, there's a conflict
      if (new Date(serverModified).getTime() > new Date(expectedLastModified).getTime()) {
        const serverContent = fs.readFileSync(filePath, 'utf-8')
        const err = new Error('Memory was modified by another process (e.g., archive). Please reload and try again.') as Error & { code: string; serverContent: string }
        err.code = 'MEMORY_CONFLICT'
        err.serverContent = serverContent
        throw err
      }
    }

    fs.writeFileSync(filePath, content, 'utf-8')
    return { ok: true, token_count: this.estimateTokens(content) }
  }

  /**
   * Append to daily memory (today's file).
   */
  appendDaily(org: string, content: string): MemoryWriteResult {
    const today = new Date().toISOString().split('T')[0]
    const filePath = path.join(this.getDailyDir(), `${today}.md`)
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

    const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : ''
    const time = new Date().toTimeString().split(' ')[0]
    const appended = existing + `\n### ${time}\n${content}\n`
    fs.writeFileSync(filePath, appended, 'utf-8')

    return { ok: true, token_count: this.estimateTokens(appended) }
  }

  /**
   * Search across memory layers.
   * - Session memory: FTS5 search via session_memory_fts with LIKE fallback (PRD C3)
   * - Long-term + daily: text search with snippet extraction
   */
  searchMemory(org: string, query: string, topK: number = 3): MemorySearchResult[] {
    const results: MemorySearchResult[] = []

    // ── 1. FTS5 search on session_memory_fts (PRD C3) ────────────
    try {
      const ftsRows = this.dao.searchSessionMemory(query, topK)

      for (const row of ftsRows) {
        results.push({
          session_id: row.session_id,
          summary: row.summary,
          session_title: row.session_title,
          created_at: row.created_at,
        })
      }
    } catch {
      // FTS degraded: fallback handled inside searchSessionMemory
    }

    // ── 2. Text search on long-term + daily memory files ─────────
    const baseDir = getAgentDir()
    if (!fs.existsSync(baseDir)) return results

    // Search long-term
    const longTermPath = this.getMemoryPath('long-term')
    if (fs.existsSync(longTermPath)) {
      const content = fs.readFileSync(longTermPath, 'utf-8')
      if (content.toLowerCase().includes(query.toLowerCase())) {
        results.push({
          session_id: 'long-term',
          summary: this.extractMatchingSnippet(content, query),
          session_title: '长期记忆',
          created_at: fs.statSync(longTermPath).mtime.toISOString(),
        })
      }
    }

    // Search daily files
    const dailyDir = this.getDailyDir()
    if (fs.existsSync(dailyDir)) {
      const files = fs.readdirSync(dailyDir).filter((f) => f.endsWith('.md'))
      for (const file of files) {
        const filePath = path.join(dailyDir, file)
        const content = fs.readFileSync(filePath, 'utf-8')
        if (content.toLowerCase().includes(query.toLowerCase())) {
          results.push({
            session_id: `daily-${file}`,
            summary: this.extractMatchingSnippet(content, query),
            session_title: `工作记忆 (${file.replace('.md', '')})`,
            created_at: fs.statSync(filePath).mtime.toISOString(),
          })
        }
      }
    }

    return results
  }

  /**
   * Rebuild FTS indexes from source data.
   * Maps to PRD P2.2 rebuildFtsIndex.
   */
  rebuildFtsIndex(org: string): { indexed_count: number } {
    try {
      const indexedCount = this.dao.rebuildFtsIndex()
      return { indexed_count: indexedCount }
    } catch {
      // Table may not exist yet
      return { indexed_count: 0 }
    }
  }

  /**
   * Read recent work memory (daily files from the last N days).
   * Used by orchestrator for context assembly (Story C1, M3).
   */
  readRecentWorkMemory(org: string, days: number = 3): string {
    const dailyDir = this.getDailyDir()
    if (!fs.existsSync(dailyDir)) return ''

    try {
      const files = fs.readdirSync(dailyDir)
        .filter(f => f.endsWith('.md'))
        .sort()
        .reverse()
        .slice(0, days)

      const contents: string[] = []
      for (const file of files) {
        const filePath = path.join(dailyDir, file)
        const content = fs.readFileSync(filePath, 'utf-8').trim()
        if (content) {
          contents.push(`## ${file.replace('.md', '')}\n${content}`)
        }
      }
      return contents.join('\n\n')
    } catch {
      return ''
    }
  }

  /**
   * Append a structured work memory entry to today's daily file.
   * Used by orchestrator to record task executions (Story B1, C4).
   */
  appendWorkMemory(org: string, entry: { timestamp: string; task: string; result: string }): MemoryWriteResult {
    const today = new Date().toISOString().split('T')[0]
    const filePath = path.join(this.getDailyDir(), `${today}.md`)
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

    const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : ''
    const time = entry.timestamp.split('T')[1]?.split('.')[0] ?? new Date().toTimeString().split(' ')[0]
    const appended = existing + `\n### ${time} ${entry.task}\n${entry.result}\n`
    fs.writeFileSync(filePath, appended, 'utf-8')

    return { ok: true, token_count: this.estimateTokens(appended) }
  }

  /**
   * P4.6: Search memory with execution scope filter.
   * If memoryScope contains 'execution:{workflow_name}', filter to only return
   * data for that workflow from execution_archive + experience_index.
   */
  searchWithScope(
    org: string,
    query: string,
    memoryScope: string[],
    topK: number = 3,
  ): {
    results: MemorySearchResult[]
    executionArchives: Array<{ workflow_name: string; status: string; cost_usd: number }>
    experiences: Array<{ type: string; title: string; content: string }>
  } {
    const executionArchives: Array<{ workflow_name: string; status: string; cost_usd: number }> = []
    const experiences: Array<{ type: string; title: string; content: string }> = []

    // Parse execution scope filters
    const workflowFilters = memoryScope
      .filter(s => s.startsWith('execution:'))
      .map(s => s.replace('execution:', ''))

    // If we have execution scope, filter execution_archive + experience_index
    if (workflowFilters.length > 0) {
      try {
        const db = (this.dao as any).db
        if (db) {
          for (const wf of workflowFilters) {
            // Query execution_archive for this workflow
            const archives = db.prepare(
              `SELECT workflow_name, status, total_cost_usd as cost_usd
               FROM execution_archive
               WHERE workflow_name LIKE ? AND workspace_id IN (
                 SELECT id FROM workspaces WHERE org = ?
               )
               ORDER BY created_at DESC LIMIT 10`
            ).all(`%${wf}%`, org) as Array<{ workflow_name: string; status: string; cost_usd: number }>
            executionArchives.push(...archives)

            // Query experience_index for this workflow
            const exps = db.prepare(
              `SELECT type, title, content FROM experience_index
               WHERE workflow_name LIKE ? AND status = 'active'
               ORDER BY relevance_score DESC LIMIT 10`
            ).all(`%${wf}%`) as Array<{ type: string; title: string; content: string }>
            experiences.push(...exps)
          }
        }
      } catch {
        // DB may not have these tables yet — non-fatal
      }
    }

    // Standard memory search
    const results = this.searchMemory(org, query, topK)

    return { results, executionArchives, experiences }
  }

  /**
   * P4.6: Merge clone experiences into main agent memory.
   * Reads experience entries from the clone directory and writes them
   * to the main agent's long-term memory.
   */
  mergeCloneExperiences(org: string, cloneName: string, cloneDir: string): {
    merged_count: number
    merged_entries: string[]
  } {
    const mergedEntries: string[] = []
    const cloneExperienceDir = path.join(cloneDir, 'memory')

    if (!fs.existsSync(cloneExperienceDir)) {
      return { merged_count: 0, merged_entries: [] }
    }

    try {
      // Read clone's long-term memory
      const cloneLtPath = path.join(cloneExperienceDir, 'long-term.md')
      if (fs.existsSync(cloneLtPath)) {
        const content = fs.readFileSync(cloneLtPath, 'utf-8')
        const agentLtPath = getLongTermMemoryPath()
        const existing = fs.existsSync(agentLtPath) ? fs.readFileSync(agentLtPath, 'utf-8') : ''
        const section = `\n\n## 分身经验归档: ${cloneName}\n${content}`
        fs.writeFileSync(agentLtPath, `${existing}${section}`, 'utf-8')
        mergedEntries.push(`long-term: ${content.length} chars`)
      }

      // Read clone's daily memory files and append to main daily
      const cloneDailyDir = path.join(cloneExperienceDir, 'daily')
      if (fs.existsSync(cloneDailyDir)) {
        const dailyFiles = fs.readdirSync(cloneDailyDir).filter(f => f.endsWith('.md'))
        for (const file of dailyFiles) {
          const dailyContent = fs.readFileSync(path.join(cloneDailyDir, file), 'utf-8')
          if (dailyContent.trim()) {
            this.appendDaily(org, `[分身 ${cloneName}] ${dailyContent}`)
            mergedEntries.push(`daily/${file}`)
          }
        }
      }
    } catch {
      // Non-fatal: partial merge is acceptable
    }

    return { merged_count: mergedEntries.length, merged_entries: mergedEntries }
  }

  /**
   * Refine long-term memory: consolidate redundant entries, trim to budget.
   * Backs up before modifying (PRD J5).
   */
  refineLongTerm(org: string): { refined: boolean; before_tokens: number; after_tokens: number; backup_path: string } {
    const filePath = this.getMemoryPath('long-term')
    if (!fs.existsSync(filePath)) {
      return { refined: false, before_tokens: 0, after_tokens: 0, backup_path: '' }
    }

    const content = fs.readFileSync(filePath, 'utf-8')
    const beforeTokens = this.estimateTokens(content)

    // Backup before modification (PRD J5: backup long-term.md.bak)
    const backupPath = `${filePath}.bak`
    fs.writeFileSync(backupPath, content, 'utf-8')

    // Parse sections
    const sections = this.parseMarkdownSections(content)

    // Consolidate: merge duplicate entries within each section
    const refinedSections = sections.map(section => {
      const uniqueLines = this.deduplicateLines(section.lines)
      // Cap each section to reasonable size
      const maxLines = section.name === '经验教训' ? 20 : 15
      return {
        ...section,
        lines: uniqueLines.slice(0, maxLines),
      }
    })

    // Rebuild content
    const refinedContent = refinedSections
      .map(s => s.lines.length > 0 ? `${s.header}\n${s.lines.join('\n')}` : s.header)
      .join('\n\n')

    fs.writeFileSync(filePath, refinedContent, 'utf-8')
    const afterTokens = this.estimateTokens(refinedContent)

    return { refined: true, before_tokens: beforeTokens, after_tokens: afterTokens, backup_path: backupPath }
  }

  /**
   * Check if agent should auto-enter safe mode due to inactivity (PRD H2).
   * Compares last activity date against config inactive_days_threshold.
   */
  checkInactivitySafeMode(org: string): { should_enable: boolean; last_active: string | null; days_inactive: number } {
    let lastActive: string | null = null
    try {
      const row = this.dao.findLatestMessageTimestamp()
      lastActive = row?.last_at ?? null
    } catch {
      // Table may not exist
    }

    // Also check daily memory files
    const dailyDir = this.getDailyDir()
    if (fs.existsSync(dailyDir)) {
      const files = fs.readdirSync(dailyDir).filter(f => f.endsWith('.md')).sort()
      if (files.length > 0) {
        const lastFile = files[files.length - 1]
        const fileDate = lastFile.replace('.md', '')
        if (!lastActive || fileDate > lastActive.split('T')[0]) {
          lastActive = `${fileDate}T00:00:00.000Z`
        }
      }
    }

    if (!lastActive) {
      return { should_enable: false, last_active: null, days_inactive: 0 }
    }

    const daysSince = Math.floor(
      (Date.now() - new Date(lastActive).getTime()) / (1000 * 60 * 60 * 24)
    )

    // Default threshold is 14 days (PRD H2)
    const threshold = 14
    return {
      should_enable: daysSince >= threshold,
      last_active: lastActive,
      days_inactive: daysSince,
    }
  }

  // ── Private helpers ─────────────────────────────────────────

  private parseMarkdownSections(content: string): Array<{ header: string; name: string; lines: string[] }> {
    const sections: Array<{ header: string; name: string; lines: string[] }> = []
    let currentSection: { header: string; name: string; lines: string[] } | null = null

    for (const line of content.split('\n')) {
      if (line.startsWith('## ')) {
        if (currentSection) sections.push(currentSection)
        currentSection = { header: line, name: line.replace('## ', '').trim(), lines: [] }
      } else if (currentSection && line.trim()) {
        currentSection.lines.push(line)
      }
    }
    if (currentSection) sections.push(currentSection)

    // If no sections found, treat as single section
    if (sections.length === 0) {
      sections.push({ header: '', name: 'default', lines: content.split('\n').filter(l => l.trim()) })
    }
    return sections
  }

  private deduplicateLines(lines: string[]): string[] {
    const seen = new Set<string>()
    return lines.filter(line => {
      const normalized = line.replace(/^[-*•]\s*/, '').trim().toLowerCase()
      if (!normalized || seen.has(normalized)) return false
      seen.add(normalized)
      return true
    })
  }

  private getAgentDir(): string {
    return getAgentDir()
  }

  private getDailyDir(): string {
    return getDailyMemoryDir()
  }

  private getMemoryPath(layer: MemoryLayer): string {
    switch (layer) {
      case 'long-term':
        return getLongTermMemoryPath()
      case 'daily': {
        const today = new Date().toISOString().split('T')[0]
        return path.join(getDailyMemoryDir(), `${today}.md`)
      }
      case 'session':
        return path.join(getAgentMemoryDir(), 'session-memory.md')
    }
  }

  private estimateTokens(text: string): number {
    // CJK-aware: ~1.5 tokens per CJK char, ~0.75 tokens per ASCII word
    const cjkChars = (text.match(/[一-鿿㐀-䶿]/g) || []).length
    const asciiWords = text.replace(/[一-鿿㐀-䶿]/g, '').split(/\s+/).filter(Boolean).length
    return Math.ceil(cjkChars * 1.5 + asciiWords * 0.75)
  }

  private extractMatchingSnippet(content: string, query: string, contextLines = 2): string {
    const lines = content.split('\n')
    const lowerQuery = query.toLowerCase()
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(lowerQuery)) {
        const start = Math.max(0, i - contextLines)
        const end = Math.min(lines.length, i + contextLines + 1)
        return lines.slice(start, end).join('\n')
      }
    }
    return content.slice(0, 200)
  }
}

// Singleton
let memoryServiceInstance: MemoryService | null = null

export function initMemoryService(dao: AgentSessionDAO): MemoryService {
  memoryServiceInstance = new MemoryService(dao)
  return memoryServiceInstance
}

export function getMemoryService(): MemoryService {
  if (!memoryServiceInstance) {
    throw new Error('MemoryService not initialized. Call initMemoryService() first.')
  }
  return memoryServiceInstance
}
