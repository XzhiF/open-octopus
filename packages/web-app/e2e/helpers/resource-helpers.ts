/**
 * E2E helpers for resource management tests.
 * API-driven install/uninstall bypasses UI to set up test fixtures.
 */
import { request, type APIRequestContext } from "@playwright/test"

const DEFAULT_SERVER = "http://localhost:3001"

function resolveApiBase(): string {
  return process.env.OCTOPUS_SERVER_URL ?? DEFAULT_SERVER
}

export async function installResourceViaApi(
  org: string,
  ref: string,
): Promise<{ name: string; type: string }> {
  const ctx = await request.newContext()
  try {
    const res = await ctx.post(
      `${resolveApiBase()}/api/resources/install?org=${encodeURIComponent(org)}`,
      {
        data: { ref, scope: "org" },
        headers: { "Content-Type": "application/json" },
      },
    )
    if (!res.ok()) {
      const body = await res.json()
      throw new Error(`Install failed: ${res.status()} ${JSON.stringify(body)}`)
    }
    return res.json()
  } finally {
    await ctx.dispose()
  }
}

export async function uninstallResourceViaApi(
  org: string,
  name: string,
  type: string,
): Promise<void> {
  const ctx = await request.newContext()
  try {
    const res = await ctx.post(
      `${resolveApiBase()}/api/resources/uninstall?org=${encodeURIComponent(org)}`,
      {
        data: { name, type },
        headers: { "Content-Type": "application/json" },
      },
    )
    if (!res.ok()) {
      const body = await res.json()
      throw new Error(`Uninstall failed: ${res.status()} ${JSON.stringify(body)}`)
    }
  } finally {
    await ctx.dispose()
  }
}

export async function listResourcesViaApi(org: string): Promise<Array<{ name: string; type: string }>> {
  const ctx = await request.newContext()
  try {
    const res = await ctx.get(
      `${resolveApiBase()}/api/resources?org=${encodeURIComponent(org)}`,
    )
    if (!res.ok()) return []
    const data = await res.json() as { resources: Array<{ name: string; type: string }> }
    return data.resources ?? []
  } finally {
    await ctx.dispose()
  }
}

/** Assert audit records match expected schema shape */
export function assertAuditSchema(records: Array<Record<string, unknown>>): void {
  const required = ["timestamp", "action", "resourceName", "resourceType", "source", "caller"]
  for (const r of records) {
    for (const key of required) {
      if (!(key in r)) throw new Error(`Audit record missing ${key}: ${JSON.stringify(r)}`)
    }
  }
}
