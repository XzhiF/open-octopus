import type { MessageChunk } from '../types'
import { randomUUID } from 'crypto'

type MC = MessageChunk

export class MapperState {
  messageId = ''
  private toolStartTimes = new Map<string, number>()
  private textBuffer = ''

  ensureMsgId(): void {
    if (!this.messageId) this.messageId = randomUUID()
  }

  setToolStart(id: string): void {
    this.toolStartTimes.set(id, Date.now())
  }

  getToolDuration(id: string): string | undefined {
    const start = this.toolStartTimes.get(id)
    if (!start) return undefined
    return `${((Date.now() - start) / 1000).toFixed(1)}s`
  }

  hasToolStart(id: string): boolean {
    return this.toolStartTimes.has(id)
  }

  appendText(text: string): void {
    this.textBuffer += text
  }

  getTextBuffer(): string {
    return this.textBuffer
  }

  resetTextBuffer(): void {
    this.textBuffer = ''
  }
}

const EVENT_MAP: Record<string, (e: any, ctx: MapperState) => MC | MC[] | null> = {
  message_start: (_e, ctx) => {
    ctx.ensureMsgId()
    return { type: 'message_start', messageId: ctx.messageId }
  },

  message_update: (e, ctx) => {
    ctx.ensureMsgId()
    const sub = e.assistantMessageEvent
    if (!sub) return null
    return mapAssistantEvent(sub, ctx)
  },

  message_end: (_e, ctx) => {
    ctx.ensureMsgId()
    return [
      { type: 'text_done', messageId: ctx.messageId },
      { type: 'message_stop', messageId: ctx.messageId },
    ]
  },

  tool_execution_start: (e, ctx) => {
    ctx.ensureMsgId()
    const id = e.toolCallId ?? e.id
    ctx.setToolStart(id)
    return [
      { type: 'tool_call_start', toolCallId: id, toolName: e.toolName, messageId: ctx.messageId },
      { type: 'tool_call', toolCallId: id, toolName: e.toolName, toolInput: e.args ?? e.input, messageId: ctx.messageId },
    ]
  },

  tool_execution_update: (e, _ctx) => {
    return { type: 'tool_progress', toolCallId: e.toolCallId ?? e.id, elapsedSeconds: e.elapsedSeconds ?? 0 }
  },

  tool_execution_end: (e, ctx) => {
    const id = e.toolCallId ?? e.id
    const duration = ctx.getToolDuration(id)
    const output = e.result ?? e.output
    return {
      type: 'tool_result',
      toolCallId: id,
      toolName: e.toolName ?? 'unknown',
      content: typeof output === 'string' ? output : JSON.stringify(output ?? ''),
      isError: e.isError ?? false,
      toolDuration: duration,
    }
  },

  agent_end: (e, ctx) => {
    ctx.ensureMsgId()
    const lastMsg = e.messages?.[e.messages.length - 1]
    const textParts = lastMsg?.content?.filter((c: any) => c.type === 'text') ?? []
    const finalText = textParts.map((c: any) => c.text).join('')
    return [
      { type: 'text_done', messageId: ctx.messageId },
      { type: 'message_stop', messageId: ctx.messageId },
      { type: 'result', content: finalText || ctx.getTextBuffer() },
    ]
  },

  compaction_start: () => ({ type: 'status', status: 'compacting' as const }),
  compaction_end: () => ({ type: 'status', status: null }),

  auto_retry_start: () => ({ type: 'status', status: 'requesting' as const }),
  auto_retry_end: () => ({ type: 'status', status: null }),

  agent_start: () => null,
  turn_start: () => null,
  turn_end: () => null,
  queue_update: () => null,
  entry_appended: () => null,
  session_info_changed: () => null,
  thinking_level_changed: () => null,
}

export function mapAssistantEvent(e: any, ctx: MapperState): MC | MC[] | null {
  switch (e.type) {
    case 'text_delta':
      ctx.appendText(e.delta ?? '')
      return { type: 'text_delta', content: e.delta ?? '', messageId: ctx.messageId }
    case 'thinking_start':
      return { type: 'thinking_start', messageId: ctx.messageId }
    case 'thinking_delta':
      return { type: 'thinking', content: e.delta ?? '', messageId: ctx.messageId }
    case 'thinking_end':
      return { type: 'thinking_done', messageId: ctx.messageId }
    default:
      return null
  }
}

export function mapPiEventToChunks(event: any, ctx: MapperState): MC | MC[] | null {
  const handler = EVENT_MAP[event.type]
  if (!handler) return null
  try {
    return handler(event, ctx)
  } catch {
    return null
  }
}
