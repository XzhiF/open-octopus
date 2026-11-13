import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { AgentMessage } from '@/lib/agent/types'
import type { CabinInitItem } from '@octopus/shared'

vi.mock('@/lib/server-config', () => ({ getServerUrl: () => 'http://localhost:3001' }))
vi.mock('@/hooks/use-cabin', () => ({ useCabin: vi.fn() }))
vi.mock('@/lib/cabin-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cabin-api')>()
  return { ...actual, retryCabinInit: vi.fn() }
})

import { useCabin } from '@/hooks/use-cabin'
import { retryCabinInit } from '@/lib/cabin-api'
import { CabinInitGateCard } from '../CabinInitGateCard'
import { CabinProvider, useCabinContext } from '../cabin-provider'

const mockUseCabin = vi.mocked(useCabin)
const mockRetry = vi.mocked(retryCabinInit)

function items(states: Array<Partial<CabinInitItem> & { key: string; state: CabinInitItem['state'] }>): CabinInitItem[] {
  return states.map((s) => ({ label: s.key, ...s }))
}

function gateMessage(status: 'running' | 'done' | 'failed', snapshot: CabinInitItem[]): AgentMessage {
  return {
    id: 'm-1',
    session_id: 'sess-1',
    role: 'user',
    content: `[舱初始化 · ${status}] 舱初始化 · Aurora`,
    created_at: '2026-11-12T00:00:00Z',
    is_summary: false,
    is_compressed: false,
    is_edited: false,
    displayType: 'event',
    activity: {
      kind: 'cabin.init',
      severity: status === 'failed' ? 'warn' : 'info',
      title: '舱初始化 · Aurora',
      status,
      taskId: null,
      payload: { cabinInit: true, cabinId: 'cabin-1', status, items: snapshot },
    },
  } as AgentMessage
}

function mockCabinState(initItems: CabinInitItem[], status = 'initializing') {
  mockUseCabin.mockReturnValue({
    cabin: {
      id: 'cabin-1', name: 'Aurora', path: '/tmp/a', workspace_id: 'ws-1', main_session_id: 'sess-1',
      requirements: '', status: status as never, mainline_strategy: 'clean-main', org: null,
      focused_job_id: null, version: 1, created_at: '', updated_at: '', last_active_at: null, archived_at: null,
    },
    view: null,
    initState: { items: initItems },
    loading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
  })
}

function ViewProbe() {
  const { openWindows } = useCabinContext()
  return <div data-testid="view-probe">{openWindows.join(',')}</div>
}

beforeEach(() => {
  vi.clearAllMocks()
  mockUseCabin.mockReturnValue({
    cabin: null, view: null, initState: null, loading: false, error: null, refresh: vi.fn(),
  })
})

describe('CabinInitGateCard — static snapshot (outside the cabin shell)', () => {
  it('renders the failed gate with error, fix hint and retry button', () => {
    const snapshot = items([
      { key: 'dir', state: 'done' },
      { key: 'clone', state: 'failed', error: 'git auth failed', fix_hint: '检查 org 仓库注册表', deep_link: 'repos' },
      { key: 'mainline', state: 'pending' },
    ])
    render(<CabinInitGateCard message={gateMessage('failed', snapshot)} />)
    const card = screen.getByTestId('cabin-init-gate-card')
    expect(card.dataset.status).toBe('failed')
    expect(screen.getByText('git auth failed')).toBeInTheDocument()
    expect(screen.getByText('检查 org 仓库注册表')).toBeInTheDocument()
    expect(screen.getByTestId('cabin-gate-retry')).toBeInTheDocument()
    // 壳外没有导航目标：去修按钮不渲染
    expect(screen.queryByTestId('cabin-gate-fix-clone')).not.toBeInTheDocument()
  })

  it('retry calls the API for the payload cabinId', async () => {
    mockRetry.mockResolvedValue({ ok: true, status: 'initializing' })
    const snapshot = items([{ key: 'git', state: 'failed', error: 'no git' }])
    render(<CabinInitGateCard message={gateMessage('failed', snapshot)} />)
    fireEvent.click(screen.getByTestId('cabin-gate-retry'))
    await waitFor(() => expect(mockRetry).toHaveBeenCalledWith('cabin-1'))
  })

  it('done snapshot renders the ready stamp and no retry', () => {
    const snapshot = items([{ key: 'dir', state: 'done' }, { key: 'git', state: 'done' }])
    render(<CabinInitGateCard message={gateMessage('done', snapshot)} />)
    expect(screen.getByTestId('cabin-init-gate-card').dataset.status).toBe('done')
    expect(screen.getByText('舱已就绪')).toBeInTheDocument()
    expect(screen.queryByTestId('cabin-gate-retry')).not.toBeInTheDocument()
  })
})

describe('CabinInitGateCard — live overlay inside CabinProvider', () => {
  it('prefers live initState over the message snapshot', () => {
    const snapshot = items([{ key: 'dir', state: 'running' }])
    mockCabinState(items([
      { key: 'dir', state: 'done' },
      { key: 'git', state: 'running' },
      { key: 'clone', state: 'pending' },
    ]))
    render(
      <CabinProvider cabinId="cabin-1">
        <CabinInitGateCard message={gateMessage('running', snapshot)} />
      </CabinProvider>,
    )
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    expect(screen.getByTestId('cabin-init-gate-card').dataset.status).toBe('running')
    expect(rows[0].dataset.gateState).toBe('done')
    expect(rows[1].dataset.gateState).toBe('running')
  })

  it('live all-done flips the card to done even if the snapshot said running', () => {
    mockCabinState(items([{ key: 'dir', state: 'done' }, { key: 'git', state: 'done' }]), 'active')
    render(
      <CabinProvider cabinId="cabin-1">
        <CabinInitGateCard message={gateMessage('running', items([{ key: 'dir', state: 'running' }]))} />
      </CabinProvider>,
    )
    expect(screen.getByTestId('cabin-init-gate-card').dataset.status).toBe('done')
  })

  it('去修 routes the failed item deep_link to a cabin module window', () => {
    mockCabinState(items([
      { key: 'clone', state: 'failed', error: 'boom', deep_link: 'repos' },
    ]))
    render(
      <CabinProvider cabinId="cabin-1">
        <ViewProbe />
        <CabinInitGateCard message={gateMessage('failed', [])} />
      </CabinProvider>,
    )
    expect(screen.getByTestId('view-probe').textContent).toBe('')
    fireEvent.click(screen.getByTestId('cabin-gate-fix-clone'))
    expect(screen.getByTestId('view-probe').textContent).toBe('engineering')
  })

  it('ignores live state from a different cabin', () => {
    mockCabinState(items([{ key: 'dir', state: 'done' }]))
    render(
      <CabinProvider cabinId="cabin-OTHER">
        <CabinInitGateCard message={gateMessage('failed', items([{ key: 'dir', state: 'failed', error: 'x' }]))} />
      </CabinProvider>,
    )
    expect(screen.getByTestId('cabin-init-gate-card').dataset.status).toBe('failed')
  })
})