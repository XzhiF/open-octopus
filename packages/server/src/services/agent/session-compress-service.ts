import { AgentSessionDAO } from '../../db/dao'

// ── Types ──────────────────────────────────────────────────────────

export interface CompressionResult {
  compressed_count: number
  summary_content: string
  original_message_count: number
  retained_message_count: number
  total_tokens_estimate: number
}

export interface CompressionConfig {
  threshold_messages: number
  threshold_tokens: number
  retain_recent: number
  summary_max_tokens: number
  model_context_window: number
  target_usage_percent: number
}

// ── Constants ───────────────────────────────────────────────────────

const DEFAULT_CONFIG: CompressionConfig = {
  threshold_messages: 50,
  threshold_tokens: 80000,
  retain_recent: 10,
  summary_max_tokens: 200,
  model_context_window: 200000,
  target_usage_percent: 60,
}

const CHARS_PER_TOKEN = 4

// ── SessionCompressService ─────────────────────────────────────────

/**
 * Compresses long conversation contexts to avoid exceeding model context windows.
 * Summarizes early messages while retaining recent ones verbatim.
 * Maps to PRD Story C5: "长会话上下文自动压缩".
 */
export class SessionCompressService {
  private org: string
  private config: CompressionConfig

  constructor(org: string, private dao: AgentSessionDAO, config?: Partial<CompressionConfig>) {
    this.org = org
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Check if a session needs compression.
   */
  needsCompression(sessionId: string): boolean {
    try {
      const result = this.dao.countUncompressedMessages(sessionId)

      const messageCount = result.count
      const tokenEstimate = Math.ceil(result.total_chars / CHARS_PER_TOKEN)

      return (
        messageCount >= this.config.threshold_messages ||
        tokenEstimate >= this.config.threshold_tokens
      )
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[SessionCompress] needsCompression failed for ${sessionId}: ${msg}`)
      return false
    }
  }

  /**
   * Compress a session: summarize early messages, mark originals as compressed,
   * insert summary message.
   */
  async compressSession(sessionId: string): Promise<CompressionResult> {
    // Get all non-compressed messages ordered by creation time
    const messages = this.dao.findUncompressedMessagesOrdered(sessionId)

    if (messages.length <= this.config.retain_recent) {
      return {
        compressed_count: 0,
        summary_content: '',
        original_message_count: messages.length,
        retained_message_count: messages.length,
        total_tokens_estimate: 0,
      }
    }

    // Split: early messages to compress, recent messages to retain
    const compressCount = messages.length - this.config.retain_recent
    const toCompress = messages.slice(0, compressCount)
    const toRetain = messages.slice(compressCount)

    // Generate summary from early messages
    const summary = this.generateSummary(toCompress)

    // Mark early messages as compressed
    const compressIds = toCompress.map(m => m.id)
    dao.markMessagesCompressed(compressIds)

    // Insert summary message
    const summaryId = crypto.randomUUID()
    const now = new Date().toISOString()
    dao.insertSummaryMessage(summaryId, sessionId, summary, now)

    // Calculate token estimate for the compressed context
    const retainedChars = toRetain.reduce((sum, m) => sum + m.content.length, 0) + summary.length
    const totalTokensEstimate = Math.ceil(retainedChars / CHARS_PER_TOKEN)

    return {
      compressed_count: compressCount,
      summary_content: summary,
      original_message_count: messages.length,
      retained_message_count: toRetain.length + 1, // +1 for summary
      total_tokens_estimate: totalTokensEstimate,
    }
  }

  /**
   * Generate a summary from a list of messages.
   * In production, this would use Claude SDK for high-quality summarization.
   * For now, uses a deterministic extraction-based approach.
   */
  private generateSummary(messages: Array<{ role: string; content: string; created_at: string }>): string {
    const parts: string[] = []

    // Extract key information from messages
    const userMessages = messages.filter(m => m.role === 'user')
    const assistantMessages = messages.filter(m => m.role === 'assistant')

    // Date range
    const firstDate = messages[0]?.created_at ?? ''
    const lastDate = messages[messages.length - 1]?.created_at ?? ''
    parts.push(`会话摘要 (${firstDate.split('T')[0]} ~ ${lastDate.split('T')[0]})`)
    parts.push(`共 ${messages.length} 条消息 (${userMessages.length} 用户, ${assistantMessages.length} 助手)`)
    parts.push('')

    // Extract topics from user messages
    const topics = this.extractTopics(userMessages.map(m => m.content))
    if (topics.length > 0) {
      parts.push('主要话题:')
      for (const topic of topics.slice(0, 5)) {
        parts.push(`- ${topic}`)
      }
      parts.push('')
    }

    // Key actions/decisions from assistant messages
    const decisions = this.extractDecisions(assistantMessages.map(m => m.content))
    if (decisions.length > 0) {
      parts.push('关键决策/操作:')
      for (const d of decisions.slice(0, 5)) {
        parts.push(`- ${d}`)
      }
    }

    const summary = parts.join('\n')

    // Enforce token limit
    const maxChars = this.config.summary_max_tokens * CHARS_PER_TOKEN
    if (summary.length > maxChars) {
      return summary.slice(0, maxChars) + '\n...[摘要已截断]'
    }

    return summary
  }

  /**
   * Extract key topics from user messages.
   */
  private extractTopics(contents: string[]): string[] {
    const topics = new Set<string>()
    const patterns = [
      /(?:给|为|对|在)\s*(\S{2,10})\s*(?:加|添加|创建|实现|修复|开发|配置)/g,
      /(?:add|create|implement|fix|develop|configure)\s+(\S{2,20})/gi,
    ]

    for (const content of contents) {
      for (const pattern of patterns) {
        const matches = content.matchAll(pattern)
        for (const match of matches) {
          if (match[1]) topics.add(match[1].trim())
        }
      }
    }

    return [...topics]
  }

  /**
   * Extract key decisions from assistant messages.
   */
  private extractDecisions(contents: string[]): string[] {
    const decisions: string[] = []
    const patterns = [
      /(?:已|已经|完成|成功)\s*(.{5,50}?)[。.!！]/g,
      /(?:created|completed|implemented|fixed|deployed)\s+(.{5,50}?)[.!]/gi,
    ]

    for (const content of contents) {
      for (const pattern of patterns) {
        const matches = content.matchAll(pattern)
        for (const match of matches) {
          if (match[1]) decisions.push(match[1].trim())
        }
      }
    }

    return decisions
  }

  /**
   * Get the compressed context for a session (summary + recent messages).
   * Used when sending context to the Claude SDK.
   */
  getCompressedContext(sessionId: string): {
    summary: string | null
    recent_messages: Array<{ role: string; content: string }>
    total_tokens_estimate: number
  } {
    // Get the most recent summary
    const summaryRow = this.dao.findSummaryMessage(sessionId)

    // Get recent non-compressed messages
    const recentMessages = this.dao.findRecentActiveMessages(sessionId, this.config.retain_recent)

    const summary = summaryRow?.content ?? null
    const totalChars = (summary?.length ?? 0) + recentMessages.reduce((sum, m) => sum + m.content.length, 0)

    return {
      summary,
      recent_messages: recentMessages.reverse(), // Chronological order
      total_tokens_estimate: Math.ceil(totalChars / CHARS_PER_TOKEN),
    }
  }

  /**
   * Check if the compressed context fits within the target usage percentage.
   */
  fitsWithinBudget(sessionId: string): boolean {
    const context = this.getCompressedContext(sessionId)
    const targetTokens = this.config.model_context_window * (this.config.target_usage_percent / 100)
    return context.total_tokens_estimate <= targetTokens
  }
}

// ── Singleton ───────────────────────────────────────────────────────

const instances = new Map<string, SessionCompressService>()
let _dao: AgentSessionDAO | null = null

export function initSessionCompressService(dao: AgentSessionDAO): void {
  _dao = dao
  instances.clear()
}

export function getSessionCompressService(org: string): SessionCompressService {
  if (!_dao) {
    throw new Error('SessionCompressService not initialized. Call initSessionCompressService() first.')
  }
  let instance = instances.get(org)
  if (!instance) {
    instance = new SessionCompressService(org, _dao)
    instances.set(org, instance)
  }
  return instance
}
