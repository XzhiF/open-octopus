/**
 * Pi SDK API isolation layer (I8-I10, S18).
 * All @earendil-works/* calls go through this module.
 * Pi SDK version upgrades only need to modify this file.
 *
 * Note: provider.ts should NOT directly import @earendil-works/* (TC-044).
 */

import { priceFor } from '@octopus/shared'

let piModule: typeof import('@earendil-works/pi-coding-agent') | null = null

/**
 * pi 注册表的 cost 单位是 USD/MTok（与 shared pricing 同单位，免换算）。
 * 全 0 价（EXTRA_PROVIDERS 硬编码 / models.yaml 没填）→ 尝试从 shared 价表补
 * （内置 Claude 档 + models.yaml overlay）；仍查不到保持 0 —— pi SDK 会算出
 * 0 成本，token-aggregator 处按未定价归一为 undefined（C2）。
 * shared 的 cacheCreation 对应 pi 侧的 cacheWrite 命名。
 */
function resolvePiCost(
  cost: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | undefined,
  modelId: string,
): { input: number; output: number; cacheRead: number; cacheWrite: number } {
  const direct = {
    input: cost?.input ?? 0,
    output: cost?.output ?? 0,
    cacheRead: cost?.cacheRead ?? 0,
    cacheWrite: cost?.cacheWrite ?? 0,
  }
  if (direct.input || direct.output || direct.cacheRead || direct.cacheWrite) return direct
  const tier = priceFor(modelId)
  if (!tier) return direct
  return { input: tier.input, output: tier.output, cacheRead: tier.cacheRead, cacheWrite: tier.cacheCreation }
}

async function getPiModule() {
  if (!piModule) {
    piModule = await import('@earendil-works/pi-coding-agent')
  }
  return piModule
}

export interface SessionOptions {
  cwd: string
  filteredEnv?: Record<string, string>
  systemPrompt?: string
  extensions?: any[]
  customTools?: any[]
  /** Skill name filter — undefined = all discovered skills, [] = none, ["a","b"] = only those */
  skills?: string[]
  /** Allowed tool names (Pi SDK lowercase names: "read", "bash", etc.) — undefined = all tools */
  tools?: string[]
  /**
   * Pre-opened SessionManager for resuming an existing session.
   * When provided, createAgentSession adopts its resumed state (messages,
   * thinking level, model) instead of creating a new session file.
   * Used by findSession() to reconstruct a usable AgentSession (ticket 13).
   */
  sessionManager?: any
  /** Custom provider definitions from models.yaml custom_providers */
  customProviders?: Record<string, {
    base_url: string
    api?: string
    env_key?: string
    models: Array<{
      id: string
      name?: string
      context_window?: number
      max_tokens?: number
      reasoning?: boolean
      cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
    }>
  }>
}

export interface SessionResult {
  session: any
  sessionId: string
  modelRegistry: any
}

export async function createSession(opts: SessionOptions): Promise<SessionResult> {
  const pi = await getPiModule()

  // AuthStorage and ModelRegistry are from pi-coding-agent, not pi-ai
  const authStorage = (pi as any).AuthStorage.inMemory()
  const modelRegistry = (pi as any).ModelRegistry.inMemory(authStorage)

  if (opts.filteredEnv) {
    registerProvidersFromEnv(modelRegistry, opts.filteredEnv, opts.customProviders)
  }

  const resourceLoader = new (pi.DefaultResourceLoader as any)({
    cwd: opts.cwd,
    agentDir: `${opts.cwd}/.claude`,
    noExtensions: true,
    noSkills: false,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
  })

  // Must call reload() — createAgentSession only auto-reloads when it creates
  // its own resourceLoader. Since we pass a custom one, we must trigger scanning.
  await resourceLoader.reload()

  // Filter skills by name (aligns with Claude Agent SDK's `skills` parameter behavior)
  // undefined = all discovered skills visible; [] = none; ["a","b"] = only those
  if (opts.skills !== undefined) {
    const allowedNames = new Set(opts.skills)
    resourceLoader.skills = (resourceLoader.skills ?? []).filter(
      (s: any) => allowedNames.has(s.name)
    )
  }

  const result = await pi.createAgentSession({
    cwd: opts.cwd,
    modelRegistry,
    resourceLoader,
    // ticket 13: when resuming, pass the pre-opened SessionManager so the
    // new AgentSession adopts the resumed state (messages/thinking/model)
    // instead of creating a fresh session file.
    ...(opts.sessionManager ? { sessionManager: opts.sessionManager } : {}),
    ...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
    ...(opts.extensions ? { extensions: opts.extensions } : {}),
    ...(opts.customTools ? { customTools: opts.customTools } : {}),
    ...(opts.tools ? { tools: opts.tools } : {}),
  } as any)

  // createAgentSession returns { session: AgentSession, extensionsResult, ... }
  const agentSession = (result as any).session ?? result

  // Inject custom system prompt into resource loader so _rebuildSystemPrompt picks it up.
  // Setting agent.state.systemPrompt directly gets overwritten by _rebuildSystemPrompt.
  if (opts.systemPrompt) {
    const originalGetSystemPrompt = resourceLoader.getSystemPrompt?.bind(resourceLoader)
    resourceLoader.getSystemPrompt = () => {
      const base = originalGetSystemPrompt?.() ?? ''
      return base ? base + '\n\n' + opts.systemPrompt : opts.systemPrompt!
    }
    // Trigger rebuild so the current state picks up the new prompt
    if ((agentSession as any)._rebuildSystemPrompt) {
      (agentSession as any)._baseSystemPrompt = (agentSession as any)._rebuildSystemPrompt(
        (agentSession as any).getActiveToolNames?.() ?? []
      )
      ;(agentSession as any).agent.state.systemPrompt = (agentSession as any)._baseSystemPrompt
    }
  }

  return {
    session: agentSession,
    sessionId: (agentSession as any).sessionId ?? `session-${Date.now()}`,
    modelRegistry,
  }
}

/** Env var → provider name mapping. */
const PROVIDER_ENV_KEYS: Record<string, string> = {
  ANTHROPIC_API_KEY: 'anthropic',
  OPENAI_API_KEY: 'openai',
  GOOGLE_API_KEY: 'google',
  DASHSCOPE_API_KEY: 'dashscope',
  DEEPSEEK_API_KEY: 'deepseek',
  MISTRAL_API_KEY: 'mistral',
  XAI_API_KEY: 'xai',
  GROQ_API_KEY: 'groq',
  TOGETHER_API_KEY: 'together',
  FIREWORKS_API_KEY: 'fireworks',
}

/**
 * Extra provider definitions for providers NOT in Pi SDK's built-in catalog.
 * Built-in providers (anthropic, openai, etc.) only need an API key.
 * Non-builtin providers need baseUrl + model definitions.
 *
 * To add a new provider: add an entry here with its baseUrl, api type, and models.
 */
const EXTRA_PROVIDERS: Record<string, {
  name: string
  baseUrl: string
  api: string
  models: Array<{
    id: string; name: string; api: string; reasoning: boolean
    input: ('text' | 'image')[]
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
    contextWindow: number; maxTokens: number
  }>
}> = {
  dashscope: {
    name: 'DashScope',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    api: 'openai-completions',
    models: [
      { id: 'qwen3.7-max', name: 'Qwen 3.7 Max', api: 'openai-completions', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 16384 },
      { id: 'qwen3.7-plus', name: 'Qwen 3.7 Plus', api: 'openai-completions', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 16384 },
      { id: 'qwen3.6-plus', name: 'Qwen 3.6 Plus', api: 'openai-completions', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 16384 },
      { id: 'qwen3-max', name: 'Qwen 3 Max', api: 'openai-completions', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 8192 },
    ],
  },
}

/**
 * Register all available providers into the ModelRegistry.
 * Priority: customProviders (YAML) > EXTRA_PROVIDERS (hardcoded) > built-in (API key only)
 */
function registerProvidersFromEnv(
  registry: any,
  env: Record<string, string>,
  customProviders?: SessionOptions['customProviders'],
): void {
  // 1. Built-in providers — API key is enough
  for (const [envKey, providerName] of Object.entries(PROVIDER_ENV_KEYS)) {
    const apiKey = env[envKey]
    if (!apiKey) continue

    try {
      const extra = EXTRA_PROVIDERS[providerName]
      if (extra) {
        registry.registerProvider(providerName, {
          ...extra,
          models: extra.models.map(mm => ({ ...mm, cost: resolvePiCost(mm.cost, mm.id) })),
          apiKey,
        })
      } else {
        registry.registerProvider(providerName, { apiKey })
      }
    } catch {
      // Provider registration may fail — skip silently
    }
  }

  // 2. Custom providers from models.yaml — override any with same name
  if (customProviders) {
    for (const [providerName, config] of Object.entries(customProviders)) {
      const envKey = config.env_key ?? `${providerName.toUpperCase()}_API_KEY`
      const apiKey = env[envKey]
      if (!apiKey) continue

      try {
        const api = config.api ?? 'openai-completions'
        registry.registerProvider(providerName, {
          name: providerName,
          baseUrl: config.base_url,
          api,
          apiKey,
          models: config.models.map(m => ({
            id: m.id,
            name: m.name ?? m.id,
            api,
            reasoning: m.reasoning ?? false,
            input: ['text'] as ('text' | 'image')[],
            cost: resolvePiCost(m.cost, m.id),
            contextWindow: m.context_window ?? 32768,
            maxTokens: m.max_tokens ?? 8192,
          })),
        })
      } catch {
        // Registration may fail — skip silently
      }
    }
  }
}

/**
 * Register custom providers from models.yaml into an existing modelRegistry.
 * Called on every sendQuery to ensure cached sessions have up-to-date providers.
 */
export function ensureCustomProvidersRegistered(
  registry: any,
  env: Record<string, string>,
  customProviders?: SessionOptions['customProviders'],
): void {
  if (!customProviders) return
  for (const [providerName, config] of Object.entries(customProviders)) {
    const envKey = config.env_key ?? `${providerName.toUpperCase()}_API_KEY`
    const apiKey = env[envKey]
    if (!apiKey) continue

    // Skip if already registered (avoid redundant work)
    try {
      const existing = registry.listProviders?.()
      if (existing?.includes(providerName)) continue
    } catch { /* no listProviders — proceed */ }

    try {
      const api = config.api ?? 'openai-completions'
      registry.registerProvider(providerName, {
        name: providerName,
        baseUrl: config.base_url,
        api,
        apiKey,
        models: config.models.map(m => ({
          id: m.id,
          name: m.name ?? m.id,
          api,
          reasoning: m.reasoning ?? false,
          input: ['text'] as ('text' | 'image')[],
          cost: resolvePiCost(m.cost, m.id),
          contextWindow: m.context_window ?? 32768,
          maxTokens: m.max_tokens ?? 8192,
        })),
      })
    } catch {
      // Registration may fail — skip silently
    }
  }
}

export function subscribeEvents(
  session: any,
  callback: (event: any) => void,
): () => void {
  return session.subscribe(callback)
}

export async function promptSession(
  session: any,
  prompt: string,
  options?: { model?: any; thinkingLevel?: string },
): Promise<void> {
  await session.prompt(prompt, options)
}

export function abortSession(session: any): void {
  try {
    session.abort()
  } catch {
    // Session may already be completed
  }
}

export function disposeSession(session: any): void {
  try {
    session.dispose()
  } catch {
    // Session may already be disposed
  }
}

/**
 * Find a persisted session by id (prefix match) and reconstruct a usable
 * AgentSession from it (ticket 13).
 *
 * Pre-fix bug (SPIKE S2): this returned the bare SessionManager (file handle)
 * from `SessionManager.open(...)`. provider.ts:284/298 then called
 * `session.subscribe`/`session.prompt` on it — both undefined on SessionManager
 * → TypeError on every resumed clone chat turn 2+.
 *
 * Fix: open the SessionManager to get the resumed state, then rebuild an
 * AgentSession via createAgentSession with `options.sessionManager = <opened>`.
 * This produces an AgentSession carrying subscribe/prompt/abort/dispose AND
 * the resumed history, with the same extensions/systemPrompt/customTools
 * wiring as a fresh session (no AC4 regression).
 *
 * @param cwd Working directory (used to locate the session dir)
 * @param id Session id (prefix match against SessionManager.list)
 * @param opts SessionOptions to apply when reconstructing the AgentSession
 *   (extensions, customTools, systemPrompt, skills, customProviders,
 *   filteredEnv). When omitted, a minimal cwd-only reconstruction is used.
 */
export async function findSession(
  cwd: string,
  id: string,
  opts?: SessionOptions,
): Promise<SessionResult | null> {
  try {
    const pi = await getPiModule()
    if (!pi.SessionManager) return null
    const sessions = await pi.SessionManager.list(cwd)
    const match = sessions?.find((s: any) => s.id?.startsWith(id))
    if (!match) return null
    // Reopen the session file to recover persisted state (messages, thinking
    // level, model). SessionManager is a file handle, NOT an AgentSession —
    // it lacks subscribe/prompt/abort/dispose.
    const sessionManager = await pi.SessionManager.open(match.path)
    // Reconstruct an AgentSession that adopts the resumed SessionManager.
    // Routed through createSession so extensions/systemPrompt/customTools/
    // modelRegistry/resourceLoader wiring matches a fresh session.
    const reconstructed = await createSession({
      cwd,
      filteredEnv: opts?.filteredEnv,
      systemPrompt: opts?.systemPrompt,
      extensions: opts?.extensions,
      customTools: opts?.customTools,
      skills: opts?.skills,
      tools: opts?.tools,
      customProviders: opts?.customProviders,
      sessionManager,
    })
    // Preserve the canonical session id from the SessionInfo (the reopened
    // SessionManager carries the same id, but createSession's sessionId
    // extraction already reads it from the AgentSession — keep match.id as
    // the source of truth to match the pre-fix return shape).
    return {
      session: reconstructed.session,
      sessionId: reconstructed.sessionId ?? match.id,
      modelRegistry: reconstructed.modelRegistry,
    }
  } catch {
    // Session restore not available
  }
  return null
}
