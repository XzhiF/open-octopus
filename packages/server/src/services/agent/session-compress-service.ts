import { AgentSessionDAO } from '../../db/dao'
import type { TokenUsageDAO } from '../../db/dao/token-usage-dao'
import type { TokenUsage } from '@octopus/shared'
import { recordLlmCall } from '../llm-call-ledger'
// 票04 默认压缩 LLM —— 与 clone-runtime / chat-routes / global-chat 一致使用静态
// getProvider 导入。动态 await import('@octopus/providers') 在打包后的 server 里会
// 命中另一份 registry 实例（其 factories Map 为空），导致 getProvider('claude')
// 抛 Unknown provider（E2E 票走查实测）。静态导入共享 index.ts registerProvider 的实例。
import { getProvider } from '@octopus/providers'
import { getAgentDir } from './paths'

// ── Types ──────────────────────────────────────────────────────────

export interface CompressionResult {
  compressed_count: number
  summary_content: string
  original_message_count: number
  retained_message_count: number
  /**
   * chars/4 口径估算 —— KD24：只服务阈值/预算判断（needsCompression /
   * fitsWithinBudget），永不流向任何记账路径；账本只收厂商真值（result chunk）。
   */
  total_tokens_estimate: number
}

/**
 * 票04 (KD24)：压缩 LLM 调用的注入 seam —— server 侧消费 provider result chunk 后交回
 * 真值 usage + 摘要文本。返回 null / 缺 usage 视为失败（不落账、走确定性回退）。
 */
export interface CompressionLlmResult {
  text: string
  model: string | null
  usage?: Pick<TokenUsage, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheCreationTokens"> | null
}
export type CompressionLlmCall = (prompt: string) => Promise<CompressionLlmResult | null>

export interface SessionCompressDeps {
  /** 缺省 = 保持改造前的确定性摘要（不产 LLM 调用，也就没有可入账的账）。 */
  llm?: CompressionLlmCall
  /** 落账用的 DAO（经票01 共用 helper recordLlmCall 写 llm_calls）。 */
  tokenDao?: TokenUsageDAO
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
  private llm?: CompressionLlmCall
  private tokenDao?: TokenUsageDAO

  constructor(org: string, private dao: AgentSessionDAO, config?: Partial<CompressionConfig>, deps?: SessionCompressDeps) {
    this.org = org
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.llm = deps?.llm
    this.tokenDao = deps?.tokenDao
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

    // ── 票04 (KD24/US3)：压缩调用走 provider seam（sendQuery），摘要取 result chunk
    // 真值。LLM 失败/缺 usage → 确定性摘要回退，且绝不落半行（AC3）。无 seam = 行为与
    // 改造前完全一致（本来就没有 LLM 调用，也就没有账）。
    const llmStartedAt = Date.now()
    let summary: string
    let llmOutcome: CompressionLlmResult | null = null
    if (this.llm) {
      try {
        const outcome = await this.llm(this.buildCompressionPrompt(toCompress))
        if (outcome?.usage) {
          llmOutcome = outcome
          summary = outcome.text || this.generateSummary(toCompress)
        } else {
          summary = this.generateSummary(toCompress)
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[SessionCompress] LLM summary failed for ${sessionId}, fallback to extraction: ${msg}`)
        summary = this.generateSummary(toCompress)
      }
    } else {
      summary = this.generateSummary(toCompress)
    }

    // Mark early messages as compressed
    const compressIds = toCompress.map(m => m.id)
    this.dao.markMessagesCompressed(compressIds)

    // Insert summary message
    const summaryId = crypto.randomUUID()
    const now = new Date().toISOString()
    this.dao.insertSummaryMessage(summaryId, sessionId, summary, now)

    // 入账恰在压缩落定之后：一条真实 LLM 调用 = 一行 session_compress（KD23 一行一调用）。
    // 记账异常不反噬压缩结果（旁路记账），但必须出声。
    if (llmOutcome) {
      try {
        this.recordCompressionCall(sessionId, llmOutcome, llmStartedAt)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[SessionCompress] billing ledger write failed for ${sessionId}: ${msg}`)
      }
    }

    // Calculate token estimate for the compressed context —— 仅预算/阈值语义（KD24），不进账
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
   * 票04：压缩 prompt —— 让 LLM 摘要早期消息。纯文本输出（summary_max_tokens 约束口径
   * 沿用既有配置）。
   */
  private buildCompressionPrompt(messages: Array<{ role: string; content: string }>): string {
    const lines = messages.map(m => `${m.role}: ${m.content}`).join('\n')
    return `请把以下对话历史（共 ${messages.length} 条）压缩成摘要，保留话题、关键决策与事实，不超过 ${this.config.summary_max_tokens} tokens，只输出摘要正文：\n\n${lines}`
  }

  /**
   * 票04 (KD24/US3)：压缩调用经票01 共用 helper 入账 —— source_path='session_compress'，
   * 归属被压缩会话（KD17：session_id + org 如实；无执行链路 → node/execution NULL，v47 列
   * 可空）。token 用厂商真值（result chunk usage），cost 走 phase 1 同一计费链路（KD25）。
   */
  private recordCompressionCall(sessionId: string, outcome: CompressionLlmResult, startedAt: number): void {
    if (!this.tokenDao || !outcome.usage) return
    recordLlmCall({
      id: crypto.randomUUID(),
      sourcePath: 'session_compress',
      nodeExecutionId: null,
      executionId: null,
      turnIndex: 0,
      callIndex: 0,
      model: outcome.model,
      usage: outcome.usage,
      timestamp: startedAt,
      durationMs: Math.max(0, Date.now() - startedAt),
      org: this.org,
      sessionId,
    }, this.tokenDao)
  }

  /**
   * Generate a summary from a list of messages.
   * 票04 起为**回退路径**：配置了 provider seam 时优先走 LLM 真值摘要（compressSession）；
   * LLM 失败/未注入时保持这里的历史行为（确定性抽取，不产 LLM 调用、不落账）。
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
let _tokenDao: TokenUsageDAO | null = null

export function initSessionCompressService(dao: AgentSessionDAO, tokenDao?: TokenUsageDAO): void {
  _dao = dao
  _tokenDao = tokenDao ?? null
  instances.clear()
}

export function getSessionCompressService(org: string): SessionCompressService {
  if (!_dao) {
    throw new Error('SessionCompressService not initialized. Call initSessionCompressService() first.')
  }
  let instance = instances.get(org)
  if (!instance) {
    // Read config dynamically when creating the instance
    const { getConfigManager } = require('./config-manager')
    const config = getConfigManager().getConfig(org)
    instance = new SessionCompressService(org, _dao, {
      threshold_messages: config.memory.session_compress_threshold_messages,
    }, {
      // 票04：生产默认接 provider seam（sendQuery → result chunk 真值 → 入账）。
      llm: providerCompressionLlm,
      tokenDao: _tokenDao ?? undefined,
    })
    instances.set(org, instance)
  }
  return instance
}

/**
 * 票04 默认压缩 LLM —— 经 provider seam（KD22：记账只在 server 消费 result chunk 处做，
 * 本函数只回真值，不碰 DB）。result chunk 缺 usage 时返回 null（无真值不入账，失败语义）。
 */
async function providerCompressionLlm(prompt: string): Promise<CompressionLlmResult | null> {
  const provider = getProvider('claude')
  let text = ''
  let outcome: CompressionLlmResult | null = null
  for await (const chunk of provider.sendQuery(prompt, getAgentDir(), undefined, {
    systemPrompt: { type: 'preset', preset: 'claude_code', append: '你是会话摘要器，只输出摘要正文。' },
  })) {
    if (chunk.type === 'text_delta') {
      text += chunk.content
    } else if (chunk.type === 'result' && chunk.usage) {
      const u = chunk.usage
      outcome = {
        text: chunk.content || text,
        model: chunk.modelUsages?.[0]?.model ?? null,
        usage: {
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cacheReadTokens: u.cacheReadTokens,
          cacheCreationTokens: u.cacheCreationTokens,
        },
      }
    }
  }
  return outcome
}
