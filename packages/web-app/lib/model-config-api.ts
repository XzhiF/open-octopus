import { getServerUrl } from "@/lib/server-config"
import { apiFetch } from "@/lib/api-client"

export interface ModelConfigResponse {
  content: string
  path: string
}

export interface SaveModelConfigResponse {
  success: boolean
  path: string
}

export interface ValidationError {
  path: string
  message: string
  code: string
}

export interface ApiError {
  error: {
    code: string
    message: string
    details?: ValidationError[]
  }
}

export interface ConnectivityResult {
  provider: string
  model?: string
  success: boolean
  latency?: number
  error?: string
}

const base = () => `${getServerUrl()}/api/system`

export async function fetchModelConfig(): Promise<ModelConfigResponse> {
  const res = await apiFetch(`${base()}/models`)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error?.message ?? `HTTP ${res.status}`)
  }
  return res.json()
}

export async function saveModelConfig(
  content: string
): Promise<SaveModelConfigResponse> {
  const res = await apiFetch(`${base()}/models`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    const err = new Error(body.error?.message ?? `HTTP ${res.status}`) as Error & { details?: ValidationError[]; code?: string }
    err.code = body.error?.code
    err.details = body.error?.details
    throw err
  }
  return res.json()
}

export async function testProvider(
  provider: string,
  model?: string
): Promise<ConnectivityResult> {
  const res = await apiFetch(`${base()}/models/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, model }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error?.message ?? `HTTP ${res.status}`)
  }
  return res.json()
}

export async function testAllProviders(): Promise<{ results: ConnectivityResult[] }> {
  const res = await apiFetch(`${base()}/models/test-all`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error?.message ?? `HTTP ${res.status}`)
  }
  return res.json()
}
