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
}

export interface SessionResult {
  session: any
  sessionId: string
  modelRegistry: any
}

export async function createSession(opts: SessionOptions): Promise<SessionResult> {
  const pi = await getPiModule()
  const piAi = await import('@earendil-works/pi-ai') as any

  const authStorage = piAi.AuthStorage.inMemory()
  const modelRegistry = piAi.ModelRegistry.inMemory(authStorage)

  if (opts.filteredEnv) {
    registerProvidersFromEnv(modelRegistry, opts.filteredEnv)
  }

  const resourceLoader = new (pi.DefaultResourceLoader as any)({
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
  })

  const session = await pi.createAgentSession({
    cwd: opts.cwd,
    modelRegistry,
    resourceLoader,
    ...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
    ...(opts.extensions ? { extensions: opts.extensions } : {}),
  } as any)

  return {
    session,
    sessionId: (session as any).id ?? `session-${Date.now()}`,
    modelRegistry,
  }
}

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

function registerProvidersFromEnv(registry: any, env: Record<string, string>): void {
  for (const [envKey, providerName] of Object.entries(PROVIDER_ENV_KEYS)) {
    const apiKey = env[envKey]
    if (apiKey) {
      try {
        registry.registerProvider(providerName, { apiKey })
      } catch {
        // Provider registration may fail for unknown providers — skip silently
      }
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
