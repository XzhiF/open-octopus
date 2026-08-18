import { getServerUrl } from "@/lib/server-config"
import type {
  Demand,
  DemandStatus,
  DemandPriority,
  CreateDemandInput,
  UpdateDemandInput,
} from "@octopus/shared"

// Re-export shared types for convenience
export type {
  Demand,
  DemandStatus,
  DemandPriority,
  CreateDemandInput,
  UpdateDemandInput,
}

// ============ Helpers ============

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error?.message ?? body.error ?? `HTTP ${res.status}`)
  }
  return res.json()
}

const BASE = "/api/task-board"

function buildUrl(path: string, params?: Record<string, unknown>): string {
  const url = new URL(`${getServerUrl()}${BASE}${path}`)
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value))
      }
    }
  }
  return url.toString()
}

// ============ Filter params ============

export interface ListDemandsParams {
  status?: string
  priority?: string
  createdAtFrom?: string
  createdAtTo?: string
  page?: number
  pageSize?: number
}

// ============ Demands CRUD ============

export async function listDemands(
  params?: ListDemandsParams,
  signal?: AbortSignal
): Promise<{ demands: Demand[]; total: number }> {
  const res = await fetch(buildUrl("/demands", params as Record<string, unknown>), { signal })
  return handleResponse<{ demands: Demand[]; total: number }>(res)
}

export async function createDemand(input: CreateDemandInput): Promise<Demand> {
  const res = await fetch(`${getServerUrl()}${BASE}/demands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  const data = await handleResponse<{ demand: Demand }>(res)
  return data.demand
}

export async function getDemand(id: string, signal?: AbortSignal): Promise<Demand> {
  const res = await fetch(`${getServerUrl()}${BASE}/demands/${id}`, { signal })
  const data = await handleResponse<{ demand: Demand }>(res)
  return data.demand
}

export async function updateDemand(
  id: string,
  input: UpdateDemandInput
): Promise<Demand> {
  const res = await fetch(`${getServerUrl()}${BASE}/demands/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  const data = await handleResponse<{ demand: Demand }>(res)
  return data.demand
}

export async function deleteDemand(id: string): Promise<{ success: boolean }> {
  const res = await fetch(`${getServerUrl()}${BASE}/demands/${id}`, {
    method: "DELETE",
  })
  return handleResponse<{ success: boolean }>(res)
}

// ============ Lifecycle Actions ============

export async function markDemandReady(id: string): Promise<Demand> {
  const res = await fetch(`${getServerUrl()}${BASE}/demands/${id}/ready`, {
    method: "POST",
  })
  const data = await handleResponse<{ demand: Demand }>(res)
  return data.demand
}

export async function retryDemand(id: string): Promise<Demand> {
  const res = await fetch(`${getServerUrl()}${BASE}/demands/${id}/retry`, {
    method: "POST",
  })
  const data = await handleResponse<{ demand: Demand }>(res)
  return data.demand
}

// ============ Pool Endpoints ============

export async function getPoolStatus(): Promise<Record<string, number>> {
  const res = await fetch(`${getServerUrl()}${BASE}/pool/status`)
  return handleResponse<Record<string, number>>(res)
}

export async function getPoolQueue(): Promise<{ demands: Demand[] }> {
  const res = await fetch(`${getServerUrl()}${BASE}/pool/queue`)
  return handleResponse<{ demands: Demand[] }>(res)
}
