// 汐音只属于作战舱，而且一舱一份形象状态（2026-11-14 用户口径）：
//   · 舱外（普通对话 / 任务线程 / 会话线程）没有立绘；
//   · 每间舱的立绘来自这间舱自己的派生视图（CabinView）—— A 在跑、B 等人、
//     C 打盹，立绘/心情/徽章各不相同；
//   · 换舱时上一间舱的瞬时态（主动对白 / 心情覆盖 / 静默）不跟过去。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { CabinView } from '@octopus/shared'
import type { CabinDetail } from '@/lib/cabin-api'

vi.mock('@/hooks/use-cabin', () => ({ useCabin: vi.fn() }))
vi.mock('@/lib/cabin-audio', () => ({
  cabinAudio: { blip: vi.fn(), chime: vi.fn(), setOn: vi.fn(), resume: vi.fn() },
}))
vi.mock('@/lib/cabin-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cabin-api')>()
  return {
    ...actual,
    patchCabin: vi.fn().mockResolvedValue({ version: 2, cockpit_prefs: {} }),
    pingCabinActivity: vi.fn().mockResolvedValue({}),
  }
})

import { useCabin } from '@/hooks/use-cabin'
import { CabinProvider } from '../cabin-provider'
import { CockpitProvider, useCockpit } from '../CockpitProvider'
import { CabinCrew } from '../CabinCrew'
import { cabinScene, cabinSceneKey } from '../xiyin-scene'

const mockUseCabin = vi.mocked(useCabin)

const attentionItem = (over: Record<string, unknown> = {}) => ({
  id: 'a1', job_id: 'j1', stage: 'review', awaiting: 'person', title: '验收',
  task_id: 't1', repo: 'r', wt: 'w', deep_link: '', priority: 0,
  ...over,
})

const cabinOf = (id: string, name: string, status: CabinDetail['status'] = 'active') => ({
  id, name, path: `/tmp/${id}`, workspace_id: 'ws-1', main_session_id: 's1',
  requirements: '', status, mainline_strategy: 'clean-main', org: null,
  focused_job_id: null, version: 1, created_at: '', updated_at: '',
  last_active_at: null, archived_at: null, cockpit_prefs: null,
} as unknown as CabinDetail)

const viewOf = (cabin: CabinDetail, over: Record<string, unknown> = {}): CabinView => ({
  cabin,
  attention: [],
  health: { running: 0, queued: 0, dormant: 0, workers: 0, max: 5 },
  iterations: [],
  open_findings: 0,
  ...over,
} as unknown as CabinView)

// A 在跑 · B 等你 · C 打盹（三间舱的实际状态完全不同）
const CABINS: Record<string, CabinDetail> = {
  'cabin-a': cabinOf('cabin-a', 'Aurora'),
  'cabin-b': cabinOf('cabin-b', 'Borealis'),
  'cabin-c': cabinOf('cabin-c', 'Cinder', 'dormant'),
}
const VIEWS: Record<string, CabinView> = {
  'cabin-a': viewOf(CABINS['cabin-a'], { health: { running: 2, queued: 0, dormant: 0, workers: 2, max: 5 } }),
  'cabin-b': viewOf(CABINS['cabin-b'], { attention: [attentionItem({ stage: 'blocked' })] }),
  'cabin-c': viewOf(CABINS['cabin-c']),
}

function mountCabin(cabinId: string) {
  const ui = (
    <CabinProvider cabinId={cabinId}>
      <CockpitProvider>
        <PresenceProbe />
        <CabinCrew />
      </CockpitProvider>
    </CabinProvider>
  )
  return render(ui)
}

function PresenceProbe() {
  const { testPresence, scene, presenceLine } = useCockpit()
  return (
    <>
      <span data-testid="scene-key">{scene.key}</span>
      <span data-testid="line">{presenceLine?.text ?? ''}</span>
      <button type="button" data-testid="probe-presence" onClick={testPresence}>probe</button>
    </>
  )
}

beforeEach(() => {
  cleanup()
  mockUseCabin.mockImplementation(((id: string | null) => ({
    cabin: id ? CABINS[id] ?? null : null,
    view: id ? VIEWS[id] ?? null : null,
    initState: null,
    loading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
  })) as unknown as typeof useCabin)
})

describe('cabinScene：事实只来自这间舱自己', () => {
  it('每间舱一个 key，attention / running / dormant 各算各的', () => {
    const a = cabinScene(CABINS['cabin-a'], VIEWS['cabin-a'], false)
    const b = cabinScene(CABINS['cabin-b'], VIEWS['cabin-b'], false)
    const c = cabinScene(CABINS['cabin-c'], VIEWS['cabin-c'], false)
    expect(a.key).toBe(cabinSceneKey('cabin-a'))
    expect(a.running).toBe(2)
    expect(a.personAttention).toBe(0)
    expect(b.personAttention).toBe(1)
    expect(b.hasBlocked).toBe(true)
    expect(b.firstAttentionTitle).toBe('验收')
    expect(c.dormant).toBe(true)
    // 互相不串：B 的待人不会出现在 A。
    expect(a.attentionTotal).toBe(0)
    expect(c.running).toBe(0)
  })
})

describe('每间舱的立绘跟着自己的状态', () => {
  it('舱 A 运行中 → working 立绘；舱 B 等你 → alert 立绘', () => {
    mountCabin('cabin-a')
    expect(screen.getByTestId('cabin-crew-pod').getAttribute('data-state')).toBe('working')
    expect(screen.getByTestId('cabin-crew-pod').querySelector('img')?.getAttribute('src'))
      .toBe('/cabin/xiyin-working.png')

    cleanup()
    mountCabin('cabin-b')
    expect(screen.getByTestId('cabin-crew-pod').getAttribute('data-state')).toBe('alert')
    expect(screen.getByTestId('cabin-crew-pod').querySelector('img')?.getAttribute('src'))
      .toBe('/cabin/xiyin-alert.png')
    // 徽章 = 这间舱的 attention 数（不是别处借来的）。
    expect(screen.getByTestId('cabin-crew-pod').querySelector('.xyi-count')?.textContent).toBe('1')
  })

  it('舱 C 打盹 → sleep 立绘', () => {
    mountCabin('cabin-c')
    expect(screen.getByTestId('cabin-crew-pod').getAttribute('data-state')).toBe('sleep')
    expect(screen.getByTestId('cabin-crew-pod').querySelector('img')?.getAttribute('src'))
      .toBe('/cabin/xiyin-sleep.png')
  })
})

describe('换舱不带走瞬时态', () => {
  it('舱 A 主动说过话 → 切到舱 C（打盹）：对白清空，心情改由 C 派生', () => {
    const { rerender } = mountCabin('cabin-a')
    fireEvent.click(screen.getByTestId('probe-presence'))
    expect(screen.getByTestId('cabin-crew-dialog').className).toContain('show')

    const ui = (
      <CabinProvider cabinId="cabin-c">
        <CockpitProvider>
          <PresenceProbe />
          <CabinCrew />
        </CockpitProvider>
      </CabinProvider>
    )
    rerender(ui)
    expect(screen.getByTestId('scene-key').textContent).toBe('cabin:cabin-c')
    expect(screen.getByTestId('line').textContent).toBe('')
    expect(screen.getByTestId('cabin-crew-dialog').className).not.toContain('show')
    expect(screen.getByTestId('cabin-crew-pod').getAttribute('data-state')).toBe('sleep')
  })

  it('切到有待办的舱：开口说的是这间舱的数字（不是上一间舱的）', async () => {
    const { rerender } = mountCabin('cabin-a')
    fireEvent.click(screen.getByTestId('probe-presence'))

    const ui = (
      <CabinProvider cabinId="cabin-b">
        <CockpitProvider>
          <PresenceProbe />
          <CabinCrew />
        </CockpitProvider>
      </CabinProvider>
    )
    rerender(ui)
    await waitFor(() => {
      expect(screen.getByTestId('cabin-crew-dialog').textContent).toContain('1 件事等你裁决')
    })
    expect(screen.getByTestId('cabin-crew-pod').getAttribute('data-state')).toBe('alert')
  })
})
