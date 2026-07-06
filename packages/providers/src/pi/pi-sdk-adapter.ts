/**
 * Pi SDK API isolation layer (I8-I10, S18).
 * All @earendil-works/* calls go through this module.
 * Pi SDK version upgrades only need to modify this file.
 *
 * Note: provider.ts should NOT directly import @earendil-works/* (TC-044).
 */

let piModule: typeof import('@earendil-works/pi-coding-agent') | null = null

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
    registerProvidersFromEnv(modelRegistry, opts.filteredEnv)
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
    ...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
    ...(opts.extensions ? { extensions: opts.extensions } : {}),
    ...(opts.customTools ? { customTools: opts.customTools } : {}),
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
 * - Built-in providers (in Pi SDK catalog): register with API key only
 * - Extra providers (EXTRA_PROVIDERS): register with full config (baseUrl + models)
 */
function registerProvidersFromEnv(registry: any, env: Record<string, string>): void {
  for (const [envKey, providerName] of Object.entries(PROVIDER_ENV_KEYS)) {
    const apiKey = env[envKey]
    if (!apiKey) continue

    try {
      const extra = EXTRA_PROVIDERS[providerName]
      if (extra) {
        // Non-builtin provider — needs full config with models
        registry.registerProvider(providerName, { ...extra, apiKey })
      } else {
        // Built-in provider — API key is enough
        registry.registerProvider(providerName, { apiKey })
      }
    } catch {
      // Provider registration may fail — skip silently
    }
  }
}

export function subscribeEvents(
  session: any,
  callback: (event: any) => void,
): () => void {
  return session.subscribe(callback)
}

export async function promptSession(session: any, prompt: string, options?: { model?: any }): Promise<void> {
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

export async function findSession(cwd: string, id: string): Promise<SessionResult | null> {
  try {
    const pi = await getPiModule()
    if (pi.SessionManager) {
      const sessions = await pi.SessionManager.list(cwd)
      const match = sessions?.find((s: any) => s.id?.startsWith(id))
      if (match) {
        const session = await pi.SessionManager.open(match.path)
        return { session, sessionId: match.id, modelRegistry: null }
      }
    }
  } catch {
    // Session restore not available
  }
  return null
}
