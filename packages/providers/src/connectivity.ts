import type { CustomProviderDef } from '@octopus/shared'

export interface ConnectivityResult {
  provider: string
  model?: string
  success: boolean
  latency?: number
  error?: string
}

const TIMEOUT_MS = 10_000

export async function testConnectivity(
  provider: string,
  model?: string,
  customProvider?: CustomProviderDef,
): Promise<ConnectivityResult> {
  if (customProvider) {
    return testCustomProvider(provider, model, customProvider)
  }
  return testBuiltinProvider(provider, model)
}

async function testBuiltinProvider(provider: string, model?: string): Promise<ConnectivityResult> {
  const start = Date.now()
  try {
    // Dynamic import to avoid circular deps at module load
    const { getProviderAsync } = await import('./registry')
    const p = await getProviderAsync(provider)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

    try {
      const gen = p.sendQuery('ping', process.cwd(), undefined, {
        model,
        abortSignal: controller.signal,
      })
      for await (const _ of gen) { /* consume stream */ }
      return { provider, model, success: true, latency: Date.now() - start }
    } finally {
      clearTimeout(timer)
    }
  } catch (err: unknown) {
    return {
      provider,
      model,
      success: false,
      latency: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

async function testCustomProvider(
  provider: string,
  model: string | undefined,
  def: CustomProviderDef,
): Promise<ConnectivityResult> {
  const start = Date.now()

  // env_key check
  if (def.env_key) {
    const envVal = process.env[def.env_key]
    if (!envVal) {
      return {
        provider,
        model,
        success: false,
        error: `环境变量 ${def.env_key} 未配置`,
      }
    }
  }

  const modelId = model ?? def.models[0]?.id
  if (!modelId) {
    return { provider, success: false, error: 'No model specified and no models in provider definition' }
  }

  const url = `${def.base_url.replace(/\/+$/, '')}/chat/completions`
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (def.env_key && process.env[def.env_key]) {
    headers['Authorization'] = `Bearer ${process.env[def.env_key]}`
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { provider, model, success: false, latency: Date.now() - start, error: `HTTP ${res.status}: ${text.slice(0, 200)}` }
    }
    return { provider, model, success: true, latency: Date.now() - start }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { provider, model, success: false, latency: Date.now() - start, error: msg }
  } finally {
    clearTimeout(timer)
  }
}
