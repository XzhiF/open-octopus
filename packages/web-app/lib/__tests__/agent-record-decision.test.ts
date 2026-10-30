// packages/web-app/lib/__tests__/agent-record-decision.test.ts
//
// 决策卡选择写回：POST /api/agent/messages/:id/decision（服务端落 metadata）。

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/server-config', () => ({ getServerUrl: () => 'http://localhost:3001' }))

import { recordCardDecision } from '../agent/api'

describe('recordCardDecision', () => {
  it('POST 到消息的 decision 端点并带上 Authorization', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ ok: true, activity: {} }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    await recordCardDecision('m 1', { actionId: 'launch_now', label: '立即执行' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://localhost:3001/api/agent/messages/m%201/decision')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer agent')
    expect(JSON.parse(String(init.body))).toEqual({ actionId: 'launch_now', label: '立即执行' })
    vi.unstubAllGlobals()
  })

  it('反思条目带 entryId', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ ok: true, activity: {} }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    await recordCardDecision('m-2', { actionId: 'skip', entryId: 'refl-1' })

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ actionId: 'skip', entryId: 'refl-1' })
    vi.unstubAllGlobals()
  })
})
