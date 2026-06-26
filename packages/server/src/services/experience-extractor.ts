// packages/server/src/services/experience-extractor.ts
// ExperienceExtractor — Phase 3 of Execution Memory: Experience Extraction & Indexing.
// Extracts structured lessons from archived executions using LLM analysis,
// writes to experience_index and updates lessons_learned on execution_archive.

import { randomUUID } from "crypto"
import type { ExperienceDAO } from "../db/dao/experience-dao"
import type { ArchiveDAO } from "../db/dao/archive-dao"
import type { ExperienceIndexRow } from "../db/types-archive"

interface ExtractedLesson {
  type: "bug" | "pattern" | "cost" | "failure"
  title: string
  content: string
  project: string | null
  package: string | null
  file_pattern: string | null
  keywords: string[]
}

interface ExtractionResult {
  lessons_learned: string
  items: ExtractedLesson[]
}

export class ExperienceExtractor {
  private retryQueue: Array<{ archiveId: string; attempt: number; nextRetryAt: number }> = []
  private retryTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private experienceDAO: ExperienceDAO,
    private archiveDAO: ArchiveDAO,
  ) {
    // Start retry processor — checks every 60s for items ready to retry
    this.retryTimer = setInterval(() => this.processRetryQueue(), 60000)
  }

  destroy(): void {
    if (this.retryTimer) { clearInterval(this.retryTimer); this.retryTimer = null }
  }

  /**
   * Extract lessons from an archived execution.
   * Threshold check: skip if cost < $1 AND status is completed (not failed).
   */
  async extractLessons(archiveId: string): Promise<void> {
    const archive = this.archiveDAO.findById(archiveId)
    if (!archive) return

    // Threshold: skip low-cost successful executions
    if (archive.total_cost_usd < 1 && archive.status === 'completed') {
      return
    }

    try {
      const result = await this.callLLM(archive)

      // Write lessons_learned back to execution_archive
      if (result.lessons_learned) {
        this.archiveDAO.updateLessonsLearned(archiveId, result.lessons_learned)
      }

      // Write structured items to experience_index
      for (const item of result.items) {
        const row: ExperienceIndexRow = {
          id: randomUUID(),
          type: item.type,
          title: item.title,
          content: item.content,
          project: item.project,
          package: item.package,
          file_pattern: item.file_pattern,
          keywords: JSON.stringify(item.keywords),
          status: 'active',
          relevance_score: this.computeRelevance(item, archive),
          use_count: 0,
          workflow_name: archive.workflow_name,
          execution_id: archive.id,
          resolved_at: null,
          resolved_by: null,
          org: archive.org,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }
        this.experienceDAO.insertExperience(row)

        // Supersede old entries with same project+file_pattern+type
        if (item.project && item.file_pattern) {
          this.experienceDAO.supersede(item.project, item.file_pattern, item.type, row.id)
        }
      }
    } catch (err) {
      console.error(`[ExperienceExtractor] LLM extraction failed for ${archiveId}:`, err)
      this.enqueueRetry(archiveId)
    }
  }

  private computeRelevance(item: ExtractedLesson, archive: { status: string; total_cost_usd: number }): number {
    let score = 0.5
    if (archive.status === 'failed') score += 0.2
    if (item.type === 'bug') score += 0.1
    if (item.type === 'failure') score += 0.15
    if (archive.total_cost_usd > 10) score += 0.1
    return Math.min(1.0, score)
  }

  private async callLLM(archive: {
    workflow_name: string
    status: string
    total_cost_usd: number
    duration_ms: number | null
    node_summary: string | null
    error_message: string | null
  }): Promise<ExtractionResult> {
    // Parse node_summary for context
    let nodeSummary: Array<{ nodeId: string; type: string; status: string }> = []
    try { nodeSummary = JSON.parse(archive.node_summary || '[]') } catch { /* ignore parse errors */ }

    const failedNodes = nodeSummary.filter((n) => n.status === 'failed')
    const context = {
      workflow_name: archive.workflow_name,
      status: archive.status,
      cost_usd: archive.total_cost_usd,
      duration_ms: archive.duration_ms,
      failed_nodes: failedNodes.map((n) => ({ nodeId: n.nodeId, type: n.type })),
      error_message: archive.error_message,
    }

    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      return this.fallbackExtraction(context)
    }

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 2048,
          system: `You are an experience extraction system. Analyze execution data and extract structured lessons.
Return JSON with format:
{
  "lessons_learned": "Brief summary text",
  "items": [
    {
      "type": "bug|pattern|cost|failure",
      "title": "Short descriptive title",
      "content": "Detailed description of the lesson",
      "project": "project name or null",
      "package": "package name or null",
      "file_pattern": "file pattern or null",
      "keywords": ["keyword1", "keyword2"]
    }
  ]
}
Only extract meaningful lessons. Return empty items array if nothing noteworthy.`,
          messages: [{
            role: 'user',
            content: `Analyze this execution:
Workflow: ${context.workflow_name}
Status: ${context.status}
Cost: $${context.cost_usd}
Duration: ${context.duration_ms ?? 0}ms
Failed nodes: ${JSON.stringify(context.failed_nodes)}
Error: ${context.error_message || 'none'}`
          }]
        }),
      })

      if (!response.ok) {
        const errorText = await response.text()
        console.warn(`[ExperienceExtractor] Anthropic API error: ${response.status} ${errorText}`)
        return this.fallbackExtraction(context)
      }

      const data = await response.json() as {
        content?: Array<{ type: string; text?: string }>
      }
      const text = data.content?.[0]?.type === 'text' ? (data.content[0].text ?? '') : ''
      return this.parseExtractionResult(text)
    } catch (err) {
      console.warn('[ExperienceExtractor] Anthropic API call failed, using fallback:', err)
      return this.fallbackExtraction(context)
    }
  }

  private parseExtractionResult(text: string): ExtractionResult {
    try {
      // Try to parse as JSON
      const json = JSON.parse(text) as {
        lessons_learned?: string
        items?: Array<{
          type?: string
          title?: string
          content?: string
          project?: string | null
          package?: string | null
          file_pattern?: string | null
          keywords?: unknown
        }>
      }
      return {
        lessons_learned: json.lessons_learned || '',
        items: (json.items || []).map((item) => ({
          type: (item.type || 'pattern') as ExtractedLesson['type'],
          title: item.title || 'Untitled',
          content: item.content || '',
          project: item.project || null,
          package: item.package || null,
          file_pattern: item.file_pattern || null,
          keywords: Array.isArray(item.keywords) ? item.keywords as string[] : [],
        }))
      }
    } catch {
      // Try to extract JSON block from text
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        try {
          return this.parseExtractionResult(jsonMatch[0])
        } catch { /* fallthrough */ }
      }
      return { lessons_learned: text.slice(0, 500), items: [] }
    }
  }

  /**
   * Pattern-based fallback when LLM is unavailable.
   * Extracts basic lessons from failed executions.
   */
  private fallbackExtraction(context: {
    workflow_name: string
    status: string
    error_message: string | null
    failed_nodes: Array<{ nodeId: string; type: string }>
  }): ExtractionResult {
    const items: ExtractedLesson[] = []

    if (context.status === 'failed' && context.error_message) {
      items.push({
        type: 'failure',
        title: `${context.workflow_name} failed: ${context.error_message.slice(0, 80)}`,
        content: `Workflow "${context.workflow_name}" failed with error: ${context.error_message}`,
        project: null,
        package: null,
        file_pattern: null,
        keywords: [context.workflow_name, 'failure'],
      })
    }

    for (const node of context.failed_nodes || []) {
      items.push({
        type: 'bug',
        title: `Node ${node.nodeId} failed in ${context.workflow_name}`,
        content: `Node "${node.nodeId}" (type: ${node.type}) failed during execution of "${context.workflow_name}"`,
        project: null,
        package: null,
        file_pattern: null,
        keywords: [node.nodeId, node.type, context.workflow_name],
      })
    }

    const lessons = items.length > 0
      ? `Execution ${context.status}: ${items.length} issue(s) detected`
      : ''

    return { lessons_learned: lessons, items }
  }

  private enqueueRetry(archiveId: string): void {
    const existing = this.retryQueue.find(r => r.archiveId === archiveId)
    if (existing) {
      if (existing.attempt >= 3) return // max 3 retries
      existing.attempt++
      const delays = [60000, 300000, 1800000] // 1m, 5m, 30m
      existing.nextRetryAt = Date.now() + (delays[existing.attempt - 1] ?? 1800000)
    } else {
      this.retryQueue.push({ archiveId, attempt: 1, nextRetryAt: Date.now() + 60000 })
    }
  }

  private processRetryQueue(): void {
    const now = Date.now()
    const ready = this.retryQueue.filter(r => r.nextRetryAt <= now)
    this.retryQueue = this.retryQueue.filter(r => r.nextRetryAt > now)

    for (const item of ready) {
      this.extractLessons(item.archiveId).catch(err => {
        console.error(`[ExperienceExtractor] retry failed for ${item.archiveId}:`, err)
        this.enqueueRetry(item.archiveId)
      })
    }
  }
}
