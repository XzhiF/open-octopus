import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import type { CabinView } from '@octopus/shared'

vi.mock('@/lib/server-config', () => ({ getServerUrl: () => 'http://localhost:3001' }))
vi.mock('@/lib/cabin-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cabin-api')>()
  return { ...actual, getCabin: vi.fn(), getCabinInit: vi.fn() }
})
vi.mock('@/lib/sse-manager', () => ({ subscribeSSE: vi.fn() }))

import { getCabin, getCabinInit, CabinApiError } from '@/lib/cabin-api'
import { subscribeSSE } from '@/lib/sse-manager'
import { useCabin } from '../use-cabin'

const mockGetCabin = vi.mocked(getCabin)
const mockGetInit = vi.mocked(getCabinInit)
const mockSubscribe = vi.mocked(subscribeSSE)

const cabinRow = {
  id: 'cabin-1', name: 'Aurora', path: '/tmp/a', workspace_id: 'ws-1', main_session_id: 'sess-1',
  requirements: '', status: 'initializing', mainline_strategy: 'clean-main', org: null,
  focused_job_id: null, version: 1, created_at: '', updated_at: '', last_active_at: null, archived_at: null,
}

const view: CabinView = {
  cabin: cabinRow as never,
  attention: [],
  health: { running: 0, queued: 0, dormant: 0, workers: 0, max: 5 },
  iterations: [],
  open_findings: 0,
}

const listeners = new Map<string, (e: MessageEvent) => void>()

beforeEach(() => {
  vi.clearAllMocks()
  listeners.clear()
  mockSubscribe.mockImplementation((_url, eventType, listener) => {
    listeners.set(eventType, listener)
    return () => { listeners.delete(eventType) }
  })
  mockGetCabin.mockResolvedValue({ cabin: cabinRow as never, view })
  mockGetInit.mockResolvedValue({
    status: 'initializing',
    state: { items: [{ key: 'dir', label: '目录可写', state: 'done' }] },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function fire(eventType: string, data: unknown) {
  const listener = listeners.get(eventType)
  if (!listener) throw new Error(`no listener for ${eventType}`)
  act(() => {
    listener({ data: JSON.stringify(data) } as MessageEvent)
  })
}

describe('useCabin', () => {
  it('loads DTO + derived view + init snapshot on mount', async () => {
    const { result } = renderHook(() => useCabin('cabin-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.cabin?.id).toBe('cabin-1')
    expect(result.current.view).toEqual(view)
    expect(result.current.initState?.items[0].key).toBe('dir')
    expect(mockSubscribe).toHaveBeenCalledWith(
      'http://localhost:3001/api/cabins/cabin-1/events',
      'cabin_status',
      expect.any(Function),
    )
  })

  it('folds cabin_init_progress into initState immediately', async () => {
    const { result } = renderHook(() => useCabin('cabin-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    fire('cabin_init_progress', {
      cabin_id: 'cabin-1',
      items: [
        { key: 'dir', label: '目录可写', state: 'done' },
        { key: 'git', label: 'git 可用', state: 'running' },
      ],
    })
    expect(result.current.initState?.items).toHaveLength(2)
    expect(result.current.initState?.items[1].state).toBe('running')
  })

  it('ignores progress frames for another cabin', async () => {
    const { result } = renderHook(() => useCabin('cabin-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    fire('cabin_init_progress', { cabin_id: 'cabin-OTHER', items: [] })
    expect(result.current.initState?.items).toHaveLength(1)
  })

  it('cabin_status triggers a coalesced refetch', async () => {
    const { result } = renderHook(() => useCabin('cabin-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    const callsBefore = mockGetCabin.mock.calls.length
    mockGetCabin.mockResolvedValue({
      cabin: { ...cabinRow, status: 'active' } as never,
      view: { ...view, cabin: { ...cabinRow, status: 'active' } as never },
    })
    fire('cabin_status', { cabin_id: 'cabin-1', status: 'active' })
    await waitFor(() => expect(mockGetCabin.mock.calls.length).toBeGreaterThan(callsBefore))
    await waitFor(() => expect(result.current.cabin?.status).toBe('active'))
  })

  it('404 surfaces as not-found error', async () => {
    mockGetCabin.mockRejectedValue(new CabinApiError('cabin not found', 404))
    const { result } = renderHook(() => useCabin('missing'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe('not-found')
    expect(result.current.cabin).toBeNull()
  })
})