import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('@/lib/server-config', () => ({ getServerUrl: () => 'http://localhost:3001' }))
vi.mock('@/hooks/use-cabin', () => ({ useCabin: vi.fn() }))
vi.mock('@/lib/cabin-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cabin-api')>()
  return { ...actual, pingCabinActivity: vi.fn().mockResolvedValue({ status: 'active' }) }
})

import { useCabin } from '@/hooks/use-cabin'
import { CabinProvider, useCabinContext } from '../cabin-provider'

const mockUseCabin = vi.mocked(useCabin)

function cabinState(status: 'initializing' | 'active') {
  return {
    cabin: {
      id: 'cabin-1', name: 'Aurora', path: '/tmp/a', workspace_id: 'ws-1', main_session_id: 'sess-1',
      requirements: '', status, mainline_strategy: 'clean-main', org: null,
      version: 1, created_at: '', updated_at: '', last_active_at: null,
      archived_at: null,
    },
    view: null,
    initState: null,
    loading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
  }
}

function Probe() {
  const { openWindows, openModule } = useCabinContext()
  return (
    <>
      <div data-testid="open-windows">{openWindows.join(',')}</div>
      <button type="button" onClick={() => openModule('overview')}>open-overview</button>
    </>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockUseCabin.mockReturnValue(cabinState('initializing'))
})

describe('CabinProvider — 初始化完成不抢焦点', () => {
  it('initializing → active 不再自动打开概览窗', () => {
    const { rerender } = render(
      <CabinProvider cabinId="cabin-1"><Probe /></CabinProvider>,
    )
    expect(screen.getByTestId('open-windows').textContent).toBe('')

    mockUseCabin.mockReturnValue(cabinState('active'))
    rerender(<CabinProvider cabinId="cabin-1"><Probe /></CabinProvider>)
    expect(screen.getByTestId('open-windows').textContent).toBe('')
  })

  it('概览仍可由人从作业坞打开', () => {
    mockUseCabin.mockReturnValue(cabinState('active'))
    render(<CabinProvider cabinId="cabin-1"><Probe /></CabinProvider>)
    fireEvent.click(screen.getByText('open-overview'))
    expect(screen.getByTestId('open-windows').textContent).toBe('overview')
  })
})
