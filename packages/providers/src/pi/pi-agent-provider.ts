import type { IAgentProvider, SendQueryOptions, MessageChunk, SystemPromptInput } from '../types'
import type { LLMCallRecord } from '../llm-call-tracker'
import { LLMCallTracker } from '../llm-call-tracker'
import { AsyncEventBridge } from './async-event-bridge'
import { mapPiEventToChunks, createMapperContext } from './event-mapper'
import { resolveModel } from './model-resolver'
import { SessionCache } from './session-cache'
import { injectSkills } from './extensions/skills-injector'
import { createSubAgentTools } from './extensions/sub-agent-tool'
import { ProviderError, ProviderErrorCode } from '../shared/error-types'

/**
 * Resolve system prompt from various input formats.
 * Exported for direct unit testing.
 */
export function resolveSystemPrompt(input?: SystemPromptInput): string | undefined {
  if (!input) return undefined
  if (typeof input === 'string') return input || undefined
  if (input.type === 'preset') return input.append || undefined
  return undefined
}

export class PiAgentProvider implements IAgentProvider {
  private sessionCache: SessionCache
  private llmCallTracker = new LLMCallTracker()

  constructor() {
    this.sessionCache = new SessionCache({
      createSession: async (cwd, options) => this.createPiSession(cwd, options),
      findSession: async (resumeId) => this.findPiSession(resumeId),
    })
  }

  getType(): string {
    return 'pi'
  }

  getLLMCalls(): LLMCallRecord[] {
    return this.llmCallTracker.getLLMCalls()
  }

  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: SendQueryOptions,
  ): AsyncGenerator<MessageChunk> {
    // Pre-abort check
    if (options?.abortSignal?.aborted) {
      yield { type: 'error', code: ProviderErrorCode.ABORTED, message: '请求已取消' }
      return
    }

    const bridge = new AsyncEventBridge<MessageChunk>()
    const mapperCtx = createMapperContext()
    this.llmCallTracker.reset()

    // Skills injection
    let enrichedPrompt = prompt
    if (options?.skills?.length) {
      enrichedPrompt = injectSkills(enrichedPrompt, options.skills)
    }

    // System prompt override
    const systemPrompt = resolveSystemPrompt(options?.systemPrompt)
    if (systemPrompt) {
      enrichedPrompt = `${systemPrompt}\n\n---\n\n${enrichedPrompt}`
    }

    try {
      const session = await this.sessionCache.getOrCreate(cwd, resumeSessionId, options) as any

      if (!session) {
        yield { type: 'error', code: ProviderErrorCode.SESSION_CREATE_FAILED, message: 'Failed to create session' }
        return
      }

      // Abort listener
      const abortHandler = () => {
        try { session.abort() } catch { /* best-effort */ }
        bridge.close()
      }
      options?.abortSignal?.addEventListener('abort', abortHandler, { once: true })

      // Subscribe to Pi events → bridge
      const onEvent = (event: any) => {
        const chunks = mapPiEventToChunks(event, mapperCtx)
        if (chunks) {
          if (Array.isArray(chunks)) {
            for (const c of chunks) bridge.push(c)
          } else {
            bridge.push(chunks)
          }
        }
        if (event.type === 'message_start') {
          this.llmCallTracker.onMessageStart(mapperCtx.messageId, event.model)
        }
        if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
          this.llmCallTracker.onTextDelta()
        }
      }

      if (typeof session.subscribe === 'function') {
        session.subscribe(onEvent)
      }

      // Sub-agent tools
      if (options?.agents) {
        const subTools = createSubAgentTools({
          agents: options.agents as any,
          createSession: (cwd, opts) => this.createPiSession(cwd, opts),
          cwd,
          parentSignal: options.abortSignal,
        })
        if (typeof session.addTools === 'function') {
          session.addTools(subTools)
        }
      }

      // Budget control via shouldStopAfterTurn
      const promptOptions: any = {}
      if (options?.maxBudgetUsd) {
        promptOptions.shouldStopAfterTurn = () => {
          return mapperCtx.tokenAggregator.totalCost() > options.maxBudgetUsd!
        }
      }

      const runPromise = session.prompt(enrichedPrompt, promptOptions).then(() => {
        bridge.close()
      }).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        bridge.push({ type: 'error', code: 'agent_error', message })
        bridge.close()
      })

      yield* bridge
      await runPromise

      options?.abortSignal?.removeEventListener('abort', abortHandler)
    } catch (err) {
      if (err instanceof ProviderError) {
        yield { type: 'error', code: err.code, message: err.message }
      } else {
        yield { type: 'error', code: 'unknown_error', message: err instanceof Error ? err.message : String(err) }
      }
    }
  }

  dispose(): void {
    this.sessionCache.dispose()
  }

  // ── Private helpers ──

  private async createPiSession(cwd: string, options?: any): Promise<any> {
    const { createAgentSession, DefaultResourceLoader, ModelRegistry, AuthStorage } = await import('@earendil-works/pi-coding-agent')

    const agentDir = `${cwd}/.pi-agent`
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true,
    } as any)

    const env = { ...process.env, ...options?.env }
    const authStorage = AuthStorage.inMemory()
    const registry = ModelRegistry.inMemory(authStorage)

    // Register providers from environment
    this.registerEnvProviders(registry, env)

    const model = options?.model ? resolveModel(options.model, registry) : undefined

    return createAgentSession({
      cwd,
      modelRegistry: registry,
      resourceLoader,
      model: model ?? undefined,
    } as any)
  }

  private async findPiSession(resumeId: string): Promise<any> {
    try {
      const { SessionManager } = await import('@earendil-works/pi-coding-agent')
      // SessionManager.list is static — needs cwd, which we don't have here.
      // ponytail: basic resume — upgrade when we have cwd context in findSession
      return null
    } catch {
      return null
    }
  }

  private registerEnvProviders(registry: any, env: Record<string, string | undefined>): void {
    const PROVIDER_ENV_MAP: Record<string, string[]> = {
      anthropic: ['ANTHROPIC_API_KEY'],
      openai: ['OPENAI_API_KEY'],
      google: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
      dashscope: ['DASHSCOPE_API_KEY'],
      deepseek: ['DEEPSEEK_API_KEY'],
    }

    for (const [provider, envKeys] of Object.entries(PROVIDER_ENV_MAP)) {
      for (const key of envKeys) {
        const apiKey = env[key]
        if (apiKey) {
          try {
            registry.registerProvider(provider, { apiKey })
          } catch { /* provider not in Pi registry, skip */ }
          break
        }
      }
    }
  }
}
