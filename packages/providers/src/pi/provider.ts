import type { IAgentProvider, SendQueryOptions, MessageChunk } from '../types'
import type { LLMCallRecord } from '../llm-call-tracker'
import { AsyncEventBridge } from './async-bridge'
import { mapPiEventToChunks, MapperState } from './event-mapper'
import { TokenAggregator } from './token-aggregator'
import { SessionCache } from './session-cache'
import { buildSessionEnv } from './security'
import { classifyProviderError } from '../errors'
import * as PiSdk from './pi-sdk-adapter'

const PROVIDER_ENV_MAP: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  dashscope: 'DASHSCOPE_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  xai: 'XAI_API_KEY',
  groq: 'GROQ_API_KEY',
  together: 'TOGETHER_API_KEY',
  fireworks: 'FIREWORKS_API_KEY',
}

function extractProvider(model: string | undefined): string | undefined {
  if (!model) return undefined
  const slash = model.indexOf('/')
  return slash > 0 ? model.slice(0, slash) : undefined
}

export class PiAgentProvider implements IAgentProvider {
  private sessionCache: SessionCache
  private llmCalls: LLMCallRecord[] = []

  constructor() {
    this.sessionCache = new SessionCache(async (cwd, resumeSessionId) => {
      if (resumeSessionId) {
        const restored = await PiSdk.findSession(cwd, resumeSessionId)
        if (restored) return restored
        console.warn(`[PiProvider] Session '${resumeSessionId}' not found, creating new session`)
      }
      return PiSdk.createSession({ cwd, filteredEnv: {} })
    })
  }

  getType(): string {
    return 'pi'
  }

  getLLMCalls(): LLMCallRecord[] {
    return [...this.llmCalls]
  }

  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: SendQueryOptions,
  ): AsyncGenerator<MessageChunk> {
    // E-1: API Key pre-check
    const providerName = extractProvider(options?.model)
    if (providerName) {
      const envVar = PROVIDER_ENV_MAP[providerName]
      if (envVar) {
        const env = buildSessionEnv(options)
        if (!env[envVar]) {
          yield {
            type: 'error',
            code: 'auth_missing',
            message: `API key not found. Set ${envVar} environment variable for ${providerName} provider.`,
          }
          return
        }
      }
    }

    // Pre-aborted signal check
    if (options?.abortSignal?.aborted) {
      yield { type: 'error', code: 'aborted', message: 'Request was aborted before execution started.' }
      return
    }

    // Build safe env
    const filteredEnv = buildSessionEnv(options)

    // Create bridge with event mapper
    const mapperState = new MapperState()
    const tokenAgg = new TokenAggregator()
    const bridge = new AsyncEventBridge<any, MessageChunk>((event) => {
      if (event.type === 'agent_end' && event.usage) {
        tokenAgg.add(options?.model ?? 'unknown', event.usage)
      }
      return mapPiEventToChunks(event, mapperState)
    })

    // Abort handling
    const abortHandler = () => {
      bridge.end()
    }
    options?.abortSignal?.addEventListener('abort', abortHandler, { once: true })

    try {
      // Step 1: Get or create session
      const sr = await this.sessionCache.getOrCreate(cwd, resumeSessionId)

      // Step 2: Subscribe to events (push → bridge)
      const unsub = PiSdk.subscribeEvents(sr.session, (event: any) => {
        bridge.push(event)
      })

      // Step 3: Fire-and-forget prompt (ADR-1: parallel with bridge consumer)
      PiSdk.promptSession(sr.session, prompt, {
        model: options?.model ? sr.modelRegistry?.getModel?.(
          extractProvider(options.model)!,
          options.model.slice(options.model.indexOf('/') + 1),
        ) : undefined,
      }).then(
        () => { unsub(); bridge.end() },
        (err: unknown) => { unsub(); bridge.fail(err instanceof Error ? err : new Error(String(err))) },
      )

      // Step 4: Yield chunks in real-time (parallel with promptSession)
      yield* bridge.generator()
    } catch (err: unknown) {
      const classified = classifyProviderError(err, {
        provider: providerName,
        envKeyName: providerName ? PROVIDER_ENV_MAP[providerName] : undefined,
      })
      yield { type: 'error', code: classified.code, message: classified.message }
    } finally {
      options?.abortSignal?.removeEventListener('abort', abortHandler)
    }
  }

  dispose(): void {
    this.sessionCache.dispose()
  }
}
