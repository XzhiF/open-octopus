// Read-only API for the dock 「调试」 inspector.
//
// Kept in its own module (not lib/agent/api.ts) so the debug window's data
// source is explicit and test doubles for the broader agent API cannot leave
// the dock with a half-mocked export.
import { getServerUrl } from '@/lib/server-config'
import type { TurnDebugDetail, TurnDebugListResponse } from './debug-types'

const BASE = () => `${getServerUrl()}/api/agent`

async function requestDebug<T>(url: string): Promise<T> {
  const res = await fetch(`${BASE()}${url}`, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer agent',
    },
  })
  if (!res.ok) {
    let message = `请求失败 (${res.status})`
    try {
      const body = await res.json() as { error?: { message?: string } }
      if (body?.error?.message) message = body.error.message
    } catch { /* non-JSON error body */ }
    throw new Error(message)
  }
  return res.json() as Promise<T>
}

export function listSessionDebugTurns(sessionId: string) {
  return requestDebug<TurnDebugListResponse>(`/debug/sessions/${sessionId}/turns`)
}

export function getSessionDebugTurn(sessionId: string, turnIndex: number) {
  return requestDebug<TurnDebugDetail>(`/debug/sessions/${sessionId}/turns/${turnIndex}`)
}