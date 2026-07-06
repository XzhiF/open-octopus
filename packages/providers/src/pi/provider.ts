import type { IAgentProvider, SendQueryOptions, MessageChunk, SystemPromptInput } from '../types'
import type { LLMCallRecord } from '../llm-call-tracker'
import { LLMCallTracker } from '../llm-call-tracker'
import { AsyncEventBridge } from './async-bridge'
import { mapPiEventToChunks, MapperState } from './event-mapper'
import { TokenAggregator } from './token-aggregator'
import { SessionCache } from './session-cache'
import { buildSessionEnv } from './security'
import { resolveModel } from './model-resolver'
import { enhancePromptWithSkills, parseVarsUpdate } from './prompt-enhancer'
import { createOctopusHooks } from './extensions/octopus-hooks'
import { toSubAgentTool } from './extensions/sub-agent-tool'
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

/** S-8: Resolve SystemPromptInput to a plain string for Pi SDK session creation. */
export function resolveSystemPrompt(input: SystemPromptInput | undefined): string | undefined {
  if (!input) return undefined
  if (typeof input === 'string') return input
  // preset: inject Octopus identity + any user append text
  // Pi SDK has its own default system prompt; we append identity via appendSystemPrompt
  const octopusIdentity = 'When asked about your identity, model, or who you are: you are an Octopus AI model (pro-max/pro/se tier), powered by the Octopus platform. Do not claim to be Claude, GPT, or any other model.'
  const userAppend = input.append ? `\n\n${input.append}` : ''
  return octopusIdentity + userAppend
}

export class PiAgentProvider implements IAgentProvider {
  private sessionCache: SessionCache
  private llmTracker = new LLMCallTracker()

  constructor() {
    this.sessionCache = new SessionCache(async (cwd, resumeSessionId, opts) => {
      const extensions: any[] = [createOctopusHooks()]
      if (opts?.subAgentTools) {
        for (const tool of opts.subAgentTools) {
          extensions.push(tool)
        }
      }
      if (resumeSessionId) {
        const restored = await PiSdk.findSession(cwd, resumeSessionId)
        if (restored) return restored
        console.warn(`[PiProvider] Session '${resumeSessionId}' not found, creating new session`)
      }
      return PiSdk.createSession({
        cwd,
        filteredEnv: opts?.filteredEnv ?? {},
        systemPrompt: opts?.systemPrompt,
        extensions,
      })
    })
  }

  getType(): string {
    return 'pi'
  }

  getLLMCalls(): LLMCallRecord[] {
    return this.llmTracker.getLLMCalls()
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

    // S15: Build sub-agent tools if agents are provided
    const subAgentTools: any[] = []
    if (options?.agents) {
      for (const [name, def] of Object.entries(options.agents)) {
        subAgentTools.push(toSubAgentTool(name, def, cwd))
      }
    }

    // Reset tracker for this query
    this.llmTracker.reset()

    // Create bridge with event mapper
    const mapperState = new MapperState()
    const tokenAgg = new TokenAggregator()
    let sessionResult: PiSdk.SessionResult | null = null

    const bridge = new AsyncEventBridge<any, MessageChunk>((event) => {
      // Track message lifecycle for LLMCallTracker (S19)
      if (event.type === 'message_start') {
        const msgId = event.messageId ?? event.id ?? mapperState.messageId
        this.llmTracker.onMessageStart(msgId, options?.model)
      } else if (event.type === 'message_update') {
        const sub = event.assistantMessageEvent
        if (sub?.type === 'text_delta' || sub?.type === 'thinking_delta') {
          this.llmTracker.onTextDelta()
        }
      } else if (event.type === 'message_end') {
        this.llmTracker.onMessageDelta(event.stopReason)
        this.llmTracker.onMessageStop(mapperState.messageId)
      }

      // Aggregate token usage from agent_end
      if (event.type === 'agent_end' && event.usage) {
        tokenAgg.add(options?.model ?? 'unknown', event.usage)
      }

      const chunks = mapPiEventToChunks(event, mapperState)
      if (chunks === null) return null

      // BL-3: Enrich result chunk with tokens/costUsd/sessionId
      const arr = Array.isArray(chunks) ? chunks : [chunks]
      const enriched = arr.map(chunk => {
        if (chunk.type === 'result') {
          const tokenUsage = tokenAgg.toTokenUsage()
          const modelUsages = tokenAgg.toModelUsages()
          return {
            ...chunk,
            sessionId: sessionResult?.sessionId,
            tokens: (tokenUsage.total ?? 0) > 0 ? tokenUsage : undefined,
            costUsd: tokenAgg.totalCost() || undefined,
            modelUsages: modelUsages.length > 0 ? modelUsages : undefined,
          }
        }
        return chunk
      })
      return Array.isArray(chunks) ? enriched : enriched[0]
    })

    // Abort handling
    const abortHandler = () => {
      bridge.end()
    }
    options?.abortSignal?.addEventListener('abort', abortHandler, { once: true })

    try {
      // S-8: Resolve systemPrompt from options
      const resolvedSystemPrompt = resolveSystemPrompt(options?.systemPrompt)

      // Step 1: Get or create session (with extensions S14/S15 and filteredEnv)
      const sr = await this.sessionCache.getOrCreate(cwd, resumeSessionId, {
        filteredEnv,
        subAgentTools,
        systemPrompt: resolvedSystemPrompt,
      })
      sessionResult = sr

      // S13: Resolve model via alias registry
      const resolvedModel = resolveModel(options?.model, sr.modelRegistry)

      // S11: Enhance prompt with skills if provided
      let effectivePrompt = prompt
      if (options?.skills && options.skills.length > 0) {
        // Skill contents would be loaded from the resource loader; pass empty for now
        // as the Pi SDK handles skill injection via its own resource loader
        effectivePrompt = enhancePromptWithSkills(prompt, {
          skills: options.skills,
          skillContents: {},
        })
      }

      // Step 2: Subscribe to events (push → bridge)
      let budgetExceeded = false
      const unsub = PiSdk.subscribeEvents(sr.session, (event: any) => {
        if (budgetExceeded) return // stop processing after budget limit
        bridge.push(event)

        // S08-6: Best-effort budget enforcement — check after each agent_end
        if (options?.maxBudgetUsd && event.type === 'agent_end' && event.usage) {
          if (tokenAgg.totalCost() >= options.maxBudgetUsd) {
            budgetExceeded = true
            bridge.end()
          }
        }
      })

      // Step 3: Fire-and-forget prompt (ADR-1: parallel with bridge consumer)
      PiSdk.promptSession(sr.session, effectivePrompt, {
        model: resolvedModel,
      }).then(
        () => { unsub(); bridge.end() },
        (err: unknown) => { unsub(); bridge.fail(err instanceof Error ? err : new Error(String(err))) },
      )

      // Step 4: Yield chunks in real-time (parallel with promptSession)
      yield* bridge.generator()

      // S08-6: If budget was exceeded during streaming, emit warning
      if (budgetExceeded) {
        yield {
          type: 'error',
          code: 'budget_exceeded',
          message: `Budget limit exceeded. Accumulated cost $${tokenAgg.totalCost().toFixed(6)} >= maxBudgetUsd $${options!.maxBudgetUsd}. Increase maxBudgetUsd or reduce usage.`,
        }
      }

      // S15: Parse vars_update from accumulated agent text output
      if (options?.varsUpdate !== false) {
        const agentText = mapperState.getTextBuffer()
        if (agentText) {
          const varsUpdate = parseVarsUpdate(agentText)
          if (Object.keys(varsUpdate).length > 0) {
            yield {
              type: 'status',
              status: null,
              varsUpdate,
            }
          }
        }
      }
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
