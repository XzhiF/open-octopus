import { Agent, type AgentEvent } from '@earendil-works/pi-agent-core'
import { streamSimple } from '@earendil-works/pi-ai/compat'
import type { Model, Context, AssistantMessageEvent } from '@earendil-works/pi-ai'

import type { IAgentProvider, SendQueryOptions, MessageChunk, TokenUsage } from '../types'

// ═══════════════════════════════════════════════════
// Model factory
// ═══════════════════════════════════════════════════

export interface PiModelConfig {
  id: string
  name: string
  provider: string
  baseUrl: string
  api?: string
  reasoning?: boolean
  contextWindow?: number
  maxTokens?: number
}

const DEFAULT_MODELS: Record<string, PiModelConfig> = {
  'qwen3-max': {
    id: 'qwen3-max',
    name: 'Qwen Max',
    provider: 'dashscope',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
  'qwen3-coder': {
    id: 'qwen3-coder-plus',
    name: 'Qwen Coder',
    provider: 'dashscope',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
  'claude-sonnet-4-5': {
    id: 'claude-sonnet-4-5-20250514',
    name: 'Claude Sonnet 4.5',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    api: 'anthropic-messages',
  },
}

function buildModel(config: PiModelConfig): Model<any> {
  return {
    id: config.id,
    name: config.name,
    api: config.api ?? 'openai-completions',
    provider: config.provider as any,
    baseUrl: config.baseUrl,
    reasoning: config.reasoning ?? false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindow ?? 32768,
    maxTokens: config.maxTokens ?? 4096,
  } as any
}

function resolveModel(modelId?: string): Model<any> {
  if (!modelId) return buildModel(DEFAULT_MODELS['qwen3-max'])
  const config = DEFAULT_MODELS[modelId]
  if (config) return buildModel(config)
  // Fallback: assume OpenAI-compatible with custom id
  return buildModel({
    id: modelId,
    name: modelId,
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
  })
}

// ═══════════════════════════════════════════════════
// API key resolution
// ═══════════════════════════════════════════════════

const PROVIDER_ENV_KEYS: Record<string, string[]> = {
  dashscope: ['DASHSCOPE_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'],
  openai: ['OPENAI_API_KEY'],
}

function resolveApiKey(provider: string, env?: Record<string, string>): string | undefined {
  const keys = PROVIDER_ENV_KEYS[provider] ?? []
  for (const key of keys) {
    const fromEnv = env?.[key] ?? process.env[key]
    if (fromEnv) return fromEnv
  }
  // Generic fallback
  return env?.API_KEY ?? process.env.API_KEY
}

// ═══════════════════════════════════════════════════
// AsyncGenerator bridge for subscribe-based events
// ═══════════════════════════════════════════════════

interface QueueItem<T> {
  value?: T
  done: boolean
  error?: unknown
}

function createEventBridge<T>() {
  const queue: QueueItem<T>[] = []
  let resolve: ((item: QueueItem<T>) => void) | null = null

  function push(value: T) {
    if (resolve) {
      const r = resolve
      resolve = null
      r({ value, done: false })
    } else {
      queue.push({ value, done: false })
    }
  }

  function end() {
    if (resolve) {
      const r = resolve
      resolve = null
      r({ done: true })
    } else {
      queue.push({ done: true })
    }
  }

  function fail(error: unknown) {
    if (resolve) {
      const r = resolve
      resolve = null
      r({ done: true, error })
    } else {
      queue.push({ done: true, error })
    }
  }

  async function* iterator(): AsyncGenerator<T> {
    while (true) {
      if (queue.length > 0) {
        const item = queue.shift()!
        if (item.error) throw item.error
        if (item.done) return
        yield item.value!
      } else {
        const item = await new Promise<QueueItem<T>>((r) => { resolve = r })
        if (item.error) throw item.error
        if (item.done) return
        yield item.value!
      }
    }
  }

  return { push, end, fail, iterator }
}

// ═══════════════════════════════════════════════════
// AgentEvent → MessageChunk mapping
// ═══════════════════════════════════════════════════

function extractTextFromContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((c: any) => c.type === 'text')
    .map((c: any) => c.text ?? '')
    .join('')
}

function mapAgentEvent(
  event: AgentEvent,
  messageIdRef: { current: string },
): MessageChunk | null {
  switch (event.type) {
    case 'agent_start':
      return null // No direct mapping; agent lifecycle is internal

    case 'agent_end': {
      // Extract final result from last assistant message
      const lastAssistant = event.messages
        .filter((m: any) => m.role === 'assistant')
        .pop()
      const text = lastAssistant
        ? extractTextFromContent((lastAssistant as any).content)
        : undefined

      // Sum usage from all assistant messages
      let totalInput = 0
      let totalOutput = 0
      for (const msg of event.messages) {
        if ((msg as any).role === 'assistant' && (msg as any).usage) {
          totalInput += (msg as any).usage.input ?? 0
          totalOutput += (msg as any).usage.output ?? 0
        }
      }

      const tokens: TokenUsage | undefined = (totalInput > 0 || totalOutput > 0)
        ? { input: totalInput, output: totalOutput, total: totalInput + totalOutput }
        : undefined

      return {
        type: 'result',
        content: text || undefined,
        tokens,
      }
    }

    case 'turn_start':
      return null

    case 'turn_end':
      return null

    case 'message_start': {
      messageIdRef.current = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
      return { type: 'message_start', messageId: messageIdRef.current }
    }

    case 'message_update': {
      const sub = event.assistantMessageEvent
      return mapAssistantEvent(sub, messageIdRef.current)
    }

    case 'message_end': {
      return { type: 'message_delta', stopReason: 'end_turn', messageId: messageIdRef.current }
    }

    case 'tool_execution_start':
      return {
        type: 'tool_call_start',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        messageId: messageIdRef.current,
      }

    case 'tool_execution_update':
      return null // Partial tool results not mapped

    case 'tool_execution_end': {
      const resultContent = event.result?.content
      const text = Array.isArray(resultContent)
        ? resultContent
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text ?? '')
            .join('')
        : typeof resultContent === 'string'
          ? resultContent
          : JSON.stringify(resultContent ?? '')
      return {
        type: 'tool_result',
        toolCallId: event.toolCallId,
        content: text,
        isError: event.isError,
      }
    }

    default:
      return null
  }
}

function mapAssistantEvent(
  event: AssistantMessageEvent,
  messageId: string,
): MessageChunk | null {
  switch (event.type) {
    case 'start':
      return null // Already handled by message_start

    case 'text_delta':
      return { type: 'text_delta', content: event.delta, messageId }

    case 'thinking_delta':
      return { type: 'thinking', content: event.delta, messageId }

    case 'thinking_start':
      return { type: 'thinking_start', messageId }

    case 'thinking_end':
      return { type: 'thinking_done', messageId }

    case 'toolcall_start':
      return {
        type: 'tool_call_start',
        toolCallId: (event as any).toolCallId ?? `tool-${Date.now()}`,
        toolName: (event as any).toolName ?? 'unknown',
        messageId,
      }

    case 'toolcall_delta':
      return null // Partial tool call input not mapped

    case 'toolcall_end': {
      const tc = event as any
      return {
        type: 'tool_call',
        toolCallId: tc.toolCallId ?? `tool-${Date.now()}`,
        toolName: tc.toolName ?? 'unknown',
        toolInput: tc.input ?? {},
        messageId,
      }
    }

    case 'done':
      return null // Handled at agent_end level

    case 'error':
      return {
        type: 'error',
        code: 'stream_error',
        message: (event as any).reason ?? 'Unknown streaming error',
      }

    default:
      return null
  }
}

// ═══════════════════════════════════════════════════
// PiSDKProvider
// ═══════════════════════════════════════════════════

export class PiSDKProvider implements IAgentProvider {
  getType(): string {
    return 'pi'
  }

  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: SendQueryOptions,
  ): AsyncGenerator<MessageChunk> {
    const model = resolveModel(options?.model)
    const apiKey = resolveApiKey((model as any).provider, options?.env)

    if (!apiKey) {
      yield {
        type: 'error',
        code: 'missing_api_key',
        message: `No API key found for provider ${(model as any).provider}. Set the appropriate environment variable.`,
      }
      return
    }

    const messageIdRef = { current: '' }
    const bridge = createEventBridge<MessageChunk>()

    const agent = new Agent({
      streamFn: (m, ctx, opts) => streamSimple(m, ctx, { ...opts, apiKey }),
      getApiKey: async () => apiKey,
    })

    agent.state.model = model

    if (options?.systemPrompt) {
      const sp = typeof options.systemPrompt === 'string'
        ? options.systemPrompt
        : options.systemPrompt.append ?? ''
      agent.state.systemPrompt = sp
    }

    // Subscribe and map events to MessageChunks
    agent.subscribe((event: AgentEvent) => {
      const chunk = mapAgentEvent(event, messageIdRef)
      if (chunk) bridge.push(chunk)
      if (event.type === 'agent_end') bridge.end()
    })

    // Run agent prompt (non-blocking — events flow through subscribe)
    const runPromise = agent.prompt(prompt).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      bridge.push({ type: 'error', code: 'agent_error', message })
      bridge.end()
    })

    // Yield chunks as they arrive
    yield* bridge.iterator()

    // Ensure the run completed
    await runPromise
  }
}
