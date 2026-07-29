import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
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
   * Record a daily memory entry with linked session summary.
   * Called by the Agent via `record_daily` tool — writes to daily file AND
   * inserts a summary message into the messages table for FTS searchability.
   *
   * @param cloneDir Optional clone directory. If provided, writes to clone's
   *   memory/daily/ directory instead of main agent's. Source field is derived
   *   from the clone directory name.
   */
  recordDaily(org: string, content: string, sessionId: string, cloneDir?: string): { ok: boolean; date: string } {
    const today = new Date().toISOString().split('T')[0]
    const dailyDir = cloneDir
      ? path.join(cloneDir, 'memory', 'daily')
      : this.getDailyDir()
    const filePath = path.join(dailyDir, `${today}.md`)
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

    // 1. Append to daily file
    const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : ''
    const time = new Date().toTimeString().split(' ')[0]
    const appended = existing + `\n### ${time}\n${content}\n`
    fs.writeFileSync(filePath, appended, 'utf-8')

    // 2. Insert summary message into messages table (for FTS search)
    //    Source: clone name (from dir basename) or 'main'
    const source = cloneDir ? path.basename(cloneDir) : 'main'
    try {
      const summaryId = crypto.randomUUID()
      const now = new Date().toISOString()
      this.dao.insertSummaryMessage(summaryId, sessionId, content, now, source)

      // 3. Rebuild FTS index to include the new summary
      try {
        this.dao.rebuildFtsIndex()
      } catch {
        // FTS rebuild failure is non-fatal — daily file is the primary store
      }
    } catch {
      // DB insert failure is non-fatal — daily file is the primary store
    }

    return { ok: true, date: today }
  }

  /**
   * Count unarchived daily memory files.
   * Used by SystemPromptAssembler to detect when archiving is needed.
   */
  countDailyFiles(): number {
    const dailyDir = this.getDailyDir()
    if (!fs.existsSync(dailyDir)) return 0
    try {
      return fs.readdirSync(dailyDir)
        .filter(f => f.endsWith('.md'))
        .length
    } catch {
      return 0
    }
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
   *
   * @param source Optional source filter. When provided, only returns results
   *   from the specified source ('main' or clone-name).
   */
  searchMemory(org: string, query: string, topK: number = 3, source?: string): MemorySearchResult[] {
    const results: MemorySearchResult[] = []

    // ── 1. FTS5 search on session_memory_fts (PRD C3) ────────────
    try {
      const ftsRows = this.dao.searchSessionMemory(query, topK, source)

      for (const row of ftsRows) {
        results.push({
          session_id: row.session_id,
          summary: row.summary,
          score: 0,
          session_title: row.session_title,
          created_at: row.created_at,
          source: row.source,
        })
      }
    } catch {
      // FTS degraded: fallback handled inside searchSessionMemory
    }

    // ── 2. Text search on long-term + daily memory files ─────────
    // When source filter is provided, only search the corresponding directory
    const dirsToSearch: Array<{ dir: string; label: string; source: string }> = []

    if (!source || source === 'main') {
      dirsToSearch.push({
        dir: getAgentDir(),
        label: 'main',
        source: 'main',
      })
    }

    // If no source filter or source is a clone name, search clone directories
    if (source && source !== 'main') {
      // Search specific clone directory
      const { getCloneDir: getUserCloneDir, getBuiltInCloneDir } = require('./paths')
      const cloneDirs = [
        getUserCloneDir(source),
        getBuiltInCloneDir(source),
      ]
      for (const cloneDir of cloneDirs) {
        if (require('fs').existsSync(cloneDir)) {
          dirsToSearch.push({ dir: cloneDir, label: source, source })
        }
      }
    } else if (!source) {
      // No source filter: search all clone directories too
      const { getClonesDir, getBuiltInClonesDir } = require('./paths')
      const fs = require('fs')
      for (const baseDirFn of [getClonesDir, getBuiltInClonesDir]) {
        const baseDir = baseDirFn()
        if (!fs.existsSync(baseDir)) continue
        try {
          const clones = fs.readdirSync(baseDir, { withFileTypes: true })
            .filter((d: { isDirectory: () => boolean }) => d.isDirectory())
            .map((d: { name: string }) => d.name)
          for (const cloneName of clones) {
            dirsToSearch.push({
              dir: path.join(baseDir, cloneName),
              label: cloneName,
              source: cloneName,
            })
          }
        } catch { /* skip */ }
      }
    }

    for (const { dir: baseDir, source: dirSource } of dirsToSearch) {
      if (!fs.existsSync(baseDir)) continue

      // Determine memory paths for this directory
      const ltPath = dirSource === 'main'
        ? this.getMemoryPath('long-term')
        : path.join(baseDir, 'memory', 'long-term.md')
      const dailyDir = dirSource === 'main'
        ? this.getDailyDir()
        : path.join(baseDir, 'memory', 'daily')

      // Search long-term
      if (fs.existsSync(ltPath)) {
        const content = fs.readFileSync(ltPath, 'utf-8')
        if (content.toLowerCase().includes(query.toLowerCase())) {
          results.push({
            session_id: `long-term-${dirSource}`,
            summary: this.extractMatchingSnippet(content, query),
            score: 0,
            session_title: dirSource === 'main' ? '长期记忆' : `${dirSource} 长期记忆`,
            created_at: fs.statSync(ltPath).mtime.toISOString(),
            source: dirSource,
          })
        }
      }

      // Search daily files
      if (fs.existsSync(dailyDir)) {
        const files = fs.readdirSync(dailyDir).filter((f) => f.endsWith('.md'))
        for (const file of files) {
          const filePath = path.join(dailyDir, file)
          const content = fs.readFileSync(filePath, 'utf-8')
          if (content.toLowerCase().includes(query.toLowerCase())) {
            results.push({
              session_id: `daily-${dirSource}-${file}`,
              summary: this.extractMatchingSnippet(content, query),
              score: 0,
              session_title: dirSource === 'main'
                ? `工作记忆 (${file.replace('.md', '')})`
                : `${dirSource} 工作记忆 (${file.replace('.md', '')})`,
              created_at: fs.statSync(filePath).mtime.toISOString(),
              source: dirSource,
            })
          }
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
   * Refine long-term memory: consolidate redundant entries, trim to budget.
   * Backs up before modifying (PRD J5).
   *
   * @param cloneDir Optional clone directory. If provided, refines the clone's
   *   long-term memory instead of main agent's.
   */
  refineLongTerm(org: string, cloneDir?: string): { refined: boolean; before_tokens: number; after_tokens: number; backup_path: string } {
    const filePath = cloneDir
      ? path.join(cloneDir, 'memory', 'long-term.md')
      : this.getMemoryPath('long-term')
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

  /**
   * Read all daily memory files (newest first), each with a date field.
   */
  readDailyAll(org: string): MemoryContent[] {
    const dailyDir = this.getDailyDir()
    if (!fs.existsSync(dailyDir)) return []

    const files = fs.readdirSync(dailyDir)
      .filter(f => f.endsWith('.md'))
      .sort()
      .reverse()

    return files.map(file => {
      const filePath = path.join(dailyDir, file)
      const content = fs.readFileSync(filePath, 'utf-8')
      const stat = fs.statSync(filePath)
      return {
        content,
        layer: 'daily' as MemoryLayer,
        date: file.replace('.md', ''),
        token_count: this.estimateTokens(content),
        last_modified: stat.mtime.toISOString(),
      }
    }).filter(item => item.content.trim().length > 0)
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
