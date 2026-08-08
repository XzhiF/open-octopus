// Harness configuration API client
// Calls GET/PUT /api/workspaces/:id/harness/config

import { getServerUrl } from "@/lib/server-config"
import { apiFetch } from "@/lib/api-client"

export interface HarnessConfigResponse {
  config: string
  version: number
  source: "db" | "defaults"
}

export interface SaveHarnessConfigResponse {
  success: true
  version: number
}

export interface HarnessValidationError {
  path: string
  message: string
  code: string
}

// Use a fixed workspace ID since harness config is global (singleton)
const WORKSPACE_ID = "default"

const base = () => `${getServerUrl()}/api/workspaces/${WORKSPACE_ID}/harness`

export async function fetchHarnessConfig(): Promise<HarnessConfigResponse> {
  const res = await apiFetch(`${base()}/config`)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error?.message ?? body.error ?? `HTTP ${res.status}`)
  }
  return res.json()
}

export async function saveHarnessConfig(
  config: string
): Promise<SaveHarnessConfigResponse> {
  const res = await apiFetch(`${base()}/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    const err = new Error(body.error?.message ?? body.error ?? `HTTP ${res.status}`) as Error & {
      details?: HarnessValidationError[]
      code?: string
    }
    err.code = body.error?.code
    err.details = body.error?.details
    throw err
  }
  return res.json()
}
