import type { MessageChunk, TokenUsage, ModelUsageEntry } from '../types'
import { TokenAggregator } from './token-aggregator'

export interface MapperContext {
  messageId: string
  currentToolCallId?: string
  toolStartTimes: Map<string, number>
  tokenAggregator: TokenAggregator
}

export function createMapperContext(): MapperContext {
  return {
    messageId: '',
    toolStartTimes: new Map(),
    tokenAggregator: new TokenAggregator(),
  }
}

function generateMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

export function mapPiEventToChunks(
  event: any,
  ctx: MapperContext,
): MessageChunk | MessageChunk[] | null {
  switch (event.type) {
    case 'message_start': {
      ctx.messageId = generateMessageId()
      return { type: 'message_start', messageId: ctx.messageId }
    }

    case 'message_update': {
      const sub = event.assistantMessageEvent
      if (!sub) return null
      return mapAssistantEvent(sub, ctx)
    }

    case 'message_end': {
      if (!ctx.messageId) {
        ctx.messageId = generateMessageId()
        console.warn('[event-mapper] message_end without message_start, generated temp messageId')
      }
      return [
        { type: 'text_done', messageId: ctx.messageId },
        { type: 'message_stop', messageId: ctx.messageId },
      ]
    }

    case 'tool_execution_start': {
      ctx.currentToolCallId = event.toolCallId
      ctx.toolStartTimes.set(event.toolCallId, Date.now())
      return [
        { type: 'tool_call_start', toolCallId: event.toolCallId, toolName: event.toolName, messageId: ctx.messageId },
        { type: 'tool_call', toolCallId: event.toolCallId, toolName: event.toolName, toolInput: event.input ?? {}, messageId: ctx.messageId },
      ]
    }

    case 'tool_execution_update': {
      const elapsed = ctx.toolStartTimes.has(event.toolCallId)
        ? Math.round((Date.now() - ctx.toolStartTimes.get(event.toolCallId)!) / 1000)
        : 0
      return { type: 'tool_progress', toolCallId: event.toolCallId, elapsedSeconds: elapsed }
    }

    case 'tool_execution_end': {
      const startTime = ctx.toolStartTimes.get(event.toolCallId)
      const duration = startTime ? `${((Date.now() - startTime) / 1000).toFixed(1)}s` : undefined
      ctx.toolStartTimes.delete(event.toolCallId)
      const content = extractToolResultContent(event.result)
      return {
        type: 'tool_result',
        toolCallId: event.toolCallId,
        content,
        isError: event.isError,
        toolDuration: duration,
      }
    }

    case 'agent_end': {
      const tokens = ctx.tokenAggregator.toTokenUsage()
      const modelUsages = ctx.tokenAggregator.toModelUsages()
      const costUsd = ctx.tokenAggregator.totalCost()
      return {
        type: 'result',
        tokens: (tokens.input > 0 || tokens.output > 0) ? tokens : undefined,
        costUsd: costUsd > 0 ? costUsd : undefined,
        modelUsages: modelUsages.length > 0 ? modelUsages : undefined,
      }
    }

    case 'compaction_start':
      return { type: 'status', status: 'compacting' }
    case 'compaction_end':
      return { type: 'status', status: null }
    case 'auto_retry_start':
      return { type: 'status', status: 'requesting' }
    case 'auto_retry_end':
      return { type: 'status', status: null }

    case 'agent_start':
    case 'turn_start':
    case 'turn_end':
    case 'queue_update':
    case 'entry_appended':
    case 'session_info_changed':
    case 'thinking_level_changed':
      return null

    default:
      return null
  }
}

function mapAssistantEvent(event: any, ctx: MapperContext): MessageChunk | null {
  switch (event.type) {
    case 'text_delta':
      return { type: 'text_delta', content: event.delta, messageId: ctx.messageId }
    case 'thinking_start':
      return { type: 'thinking_start', messageId: ctx.messageId }
    case 'thinking_delta':
      return { type: 'thinking', content: event.delta, messageId: ctx.messageId }
    case 'thinking_end':
      return { type: 'thinking_done', messageId: ctx.messageId }
    case 'error':
      return { type: 'error', code: 'stream_error', message: event.reason ?? 'Unknown streaming error' }
    default:
      return null
  }
}

function extractToolResultContent(result: any): string {
  if (!result) return ''
  const content = result.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.filter((c: any) => c.type === 'text').map((c: any) => c.text ?? '').join('')
  }
  return JSON.stringify(content)
}
