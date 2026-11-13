import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { CabinView } from '@octopus/shared'
import type { KcFindingView } from '@/lib/knowledge/knowledge-center-api'

vi.mock('@/lib/server-config', () => ({ getServerUrl: () => 'http://localhost:3001' }))
vi.mock('@/hooks/use-cabin', () => ({ useCabin: vi.fn() }))
vi.mock('@/lib/billing-currency', () => ({ useBillingCurrency: () => ({ currency: 'CNY', rate: 7 }) }))
vi.mock('@/lib/cabin-audio', () => ({ cabinAudio: { blip: vi.fn(), chime: vi.fn(), setOn: vi.fn(), resume: vi.fn() } }))
vi.mock('@/lib/cabin-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cabin-api')>()
  return {
    ...actual,
    patchCabin: vi.fn(),
    pingCabinActivity: vi.fn(),
    getCabinFindings: vi.fn(),
    archiveCabin: vi.fn(),
    dormantCabin: vi.fn(),
    wakeCabin: vi.fn(),
    reopenCabin: vi.fn(),
  }
})
vi.mock('@/lib/tasks-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tasks-api')>()
  return { ...actual, listTasks: vi.fn(), getTask: vi.fn() }
})

import { useCabin } from '@/hooks/use-cabin'
import { patchCabin, getCabinFindings, archiveCabin, pingCabinActivity } from '@/lib/cabin-api'
import { listTasks } from '@/lib/tasks-api'
import { CabinProvider } from '../cabin-provider'
import { CockpitProvider, useCockpit } from '../CockpitProvider'
import { CabinTuning } from '../modules/CabinTuning'
import { CabinGallery } from '../modules/CabinGallery'
import { CabinArchive } from '../modules/CabinArchive'
import { CabinCrew } from '../CabinCrew'
import {
  buildPresenceLine, deriveMood, normalizePrefs, presenceGap, presenceGate, randomPrefs, DEFAULT_COCKPIT, THEMES,
} from '../cockpit'

const mockUseCabin = vi.mocked(useCabin)

function makeView(overrides: Partial<CabinView> = {}): CabinView {
  return {
    cabin: {
      id: 'cabin-1', name: 'Aurora', path: '/tmp/a', workspace_id: 'ws-1', main_session_id: 'sess-1',
      requirements: '', status: 'active', mainline_strategy: 'clean-main', org: null,
      focused_job_id: null, version: 1, created_at: '', updated_at: '', last_active_at: null, archived_at: null,
    },
    attention: [],
    health: { running: 0, queued: 0, dormant: 0, workers: 0, max: 5 },
    iterations: [],
    open_findings: 0,
    ...overrides,
  }
}

function mockCabin(view: CabinView) {
  mockUseCabin.mockReturnValue({
    cabin: view.cabin as never,
    view,
    initState: null,
    loading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
  })
}

function renderCabin(ui: React.ReactNode, view: CabinView) {
  mockCabin(view)
  return render(
    <CabinProvider cabinId="cabin-1">
      <CockpitProvider>{ui}</CockpitProvider>
    </CabinProvider>,
  )
}

/** 在场测试探针：从 provider 里直接触发一条主动搭话。 */
function PresenceProbe() {
  const { testPresence } = useCockpit()
  return <button type="button" data-testid="probe-presence" onClick={testPresence}>probe</button>
}

function finding(id: string, over: Partial<KcFindingView> = {}): KcFindingView {
  return {
    id, kind: 'term-conflict', severity: 'major', status: 'open', title: `术语冲突 ${id}`,
    detail: { old: '旧词', new: '新词' }, pages: [], rawRef: '', source: 'wiki', createdAt: '', updatedAt: '',
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(patchCabin).mockResolvedValue({ ...makeView().cabin, version: 2, cockpit_prefs: {} } as never)
  vi.mocked(pingCabinActivity).mockResolvedValue({ ...makeView().cabin, status: 'active' } as never)
  vi.mocked(getCabinFindings).mockResolvedValue([])
  vi.mocked(listTasks).mockResolvedValue({ items: [], total: 0 } as never)
})

describe('cockpit 纯派生（K3 mood / prefs 规整）', () => {
  it('deriveMood：手动 mood > 瞬时 override > 状态机', () => {
    const base = { prefsMood: 'auto' as const, override: null, status: 'active' as const, personAttention: 0, running: 0, streaming: false, hasBlocked: false }
    expect(deriveMood(base)).toBe('idle')
    expect(deriveMood({ ...base, prefsMood: 'cheer' })).toBe('cheer')
    expect(deriveMood({ ...base, override: 'wink' })).toBe('wink')
    expect(deriveMood({ ...base, status: 'initializing' })).toBe('boot')
    expect(deriveMood({ ...base, personAttention: 2 })).toBe('alert')
    expect(deriveMood({ ...base, hasBlocked: true })).toBe('worried')
    expect(deriveMood({ ...base, running: 1 })).toBe('working')
    expect(deriveMood({ ...base, streaming: true })).toBe('thinking')
    expect(deriveMood({ ...base, status: 'dormant' })).toBe('sleep')
    expect(deriveMood({ ...base, status: 'archived' })).toBe('sleep')
  })
  it('normalizePrefs：malformed → 默认；范围钳制；枚举校验', () => {
    expect(normalizePrefs(null)).toEqual(DEFAULT_COCKPIT)
    const clamped = normalizePrefs({ theme: 'nope', autonomy: 'xxx', glow: 99, particles: -5 })
    expect(clamped.theme).toBe('terminal') // 非法枚举 → 默认
    expect(clamped.autonomy).toBe('auto')
    expect(clamped.glow).toBe(2) // 钳到上限
    expect(clamped.particles).toBe(0) // 钳到下限
    const p = normalizePrefs({ theme: 'luna', autonomy: 'observe', glow: 1.5, dormantMinutes: 0 })
    expect(p.theme).toBe('luna'); expect(p.autonomy).toBe('observe'); expect(p.glow).toBe(1.5); expect(p.dormantMinutes).toBe(0)
  })
  it('randomPrefs：主题合法 + 数值在范围内', () => {
    const p = randomPrefs()
    expect(p.theme in THEMES).toBe(true)
    expect(p.glow).toBeGreaterThanOrEqual(0); expect(p.glow).toBeLessThanOrEqual(2)
    expect(p.charScale).toBeGreaterThanOrEqual(0.6); expect(p.charScale).toBeLessThanOrEqual(1.5)
  })
})

describe('在场纯派生（classic-v4）', () => {
  it('presenceGap：落在档位区间（分钟）', () => {
    expect(presenceGap('active', () => 0)).toBe(3 * 60_000)
    expect(presenceGap('active', () => 1)).toBe(8 * 60_000)
    expect(presenceGap('quiet', () => 0.5)).toBe(18 * 60_000)
  })
  it('presenceGate：关闭/静默/后台/流式/忙碌/输入/空闲/免打扰', () => {
    const base = { on: true, now: 1_000_000, snoozedUntil: 0, hidden: false, streaming: false, busy: false, editing: false, lastUserAt: 800_000, idleMs: 60_000, hour: 10 }
    expect(presenceGate(base)).toBe('ok')
    expect(presenceGate({ ...base, on: false })).toBe('off')
    expect(presenceGate({ ...base, snoozedUntil: 2_000_000 })).toBe('snooze')
    expect(presenceGate({ ...base, hidden: true })).toBe('hidden')
    expect(presenceGate({ ...base, streaming: true })).toBe('streaming')
    expect(presenceGate({ ...base, busy: true })).toBe('busy')
    expect(presenceGate({ ...base, editing: true })).toBe('typing')
    expect(presenceGate({ ...base, now: 850_000 })).toBe('busy') // 60s 内动过
    expect(presenceGate({ ...base, hour: 23 })).toBe('quiet')
    expect(presenceGate({ ...base, hour: 7 })).toBe('quiet')
  })
  it('buildPresenceLine：事实优先、每三轮夹闲聊、闲聊不连发', () => {
    const base = {
      personAttention: 0, attentionTotal: 0, queued: 0, running: 0, dormant: false,
      hour: 10, n: 0, rnd: () => 0,
    }
    const two = buildPresenceLine({ ...base, personAttention: 2 })
    expect(two.mood).toBe('alert'); expect(two.open).toBe('overview'); expect(two.text).toContain('2 件')
    expect(buildPresenceLine({ ...base, personAttention: 1, firstAttentionTitle: '审查' }).text).toContain('审查')
    expect(buildPresenceLine({ ...base, attentionTotal: 3 }).open).toBe('queue')
    expect(buildPresenceLine({ ...base, queued: 3 }).open).toBe('queue')
    expect(buildPresenceLine({ ...base, running: 2 }).open).toBe('missions')
    expect(buildPresenceLine({ ...base, dormant: true }).mood).toBe('sleep')
    // n=2 → 夹一条闲聊（不再是「需要你」）
    expect(buildPresenceLine({ ...base, personAttention: 2, n: 2 }).open).not.toBe('overview')
    // 闲聊不与上一句重复
    const p0 = buildPresenceLine({ ...base, n: 2, rnd: () => 0 })
    const p1 = buildPresenceLine({ ...base, n: 2, rnd: () => 0, lastText: p0.text })
    expect(p1.text).not.toBe(p0.text)
  })
  it('normalizePrefs：在场字段校验 + 默认', () => {
    const p = normalizePrefs({ presenceOn: 'yes', presenceRate: 'x' })
    expect(p.presenceOn).toBe(DEFAULT_COCKPIT.presenceOn)
    expect(p.presenceRate).toBe(DEFAULT_COCKPIT.presenceRate)
    const q = normalizePrefs({ presenceOn: false, presenceRate: 'quiet' })
    expect(q.presenceOn).toBe(false); expect(q.presenceRate).toBe('quiet')
  })
})

describe('C11 打盹（互动即醒）', () => {
  it('进舱即报到：CabinProvider 打 activity 心跳（不靠点唤醒按钮）', async () => {
    mockCabin(makeView())
    render(<CabinProvider cabinId="cabin-1"><div /></CabinProvider>)
    await waitFor(() => expect(pingCabinActivity).toHaveBeenCalledWith('cabin-1', expect.any(Number)))
  })
  it('键鼠在高频事件下按 5 分钟节流，不打请求风暴', async () => {
    mockCabin(makeView())
    render(<CabinProvider cabinId="cabin-1"><div /></CabinProvider>)
    await waitFor(() => expect(pingCabinActivity).toHaveBeenCalledTimes(1))
    fireEvent.keyDown(window)
    fireEvent.pointerMove(window)
    expect(pingCabinActivity).toHaveBeenCalledTimes(1)
  })
  it('打盹中任意键鼠立刻叫醒（不受节流）', async () => {
    const v = makeView()
    v.cabin.status = 'dormant'
    mockCabin(v)
    render(<CabinProvider cabinId="cabin-1"><div /></CabinProvider>)
    await waitFor(() => expect(pingCabinActivity).toHaveBeenCalledTimes(1))
    fireEvent.keyDown(window)
    await waitFor(() => expect(pingCabinActivity).toHaveBeenCalledTimes(2))
  })
})

describe('CabinTuning（舱面调校）', () => {
  it('渲染六主题 + 自决段 + 音效开关 + 休眠阈值', () => {
    renderCabin(<CabinTuning />, makeView())
    expect(screen.getByTestId('cabin-tuning-body')).toBeTruthy()
    for (const k of Object.keys(THEMES)) expect(screen.getByTestId(`tuning-theme-${k}`)).toBeTruthy()
    expect(screen.getByTestId('tuning-autonomy-off')).toBeTruthy()
    expect(screen.getByTestId('tuning-autonomy-auto')).toBeTruthy()
    expect(screen.getByTestId('tuning-dormant')).toBeTruthy()
    expect(screen.getByTestId('tuning-mood')).toBeTruthy()
  })
  it('点主题 → 乐观高亮 + 防抖持久化 patchCabin（整列 spread）', async () => {
    renderCabin(<CabinTuning />, makeView())
    fireEvent.click(screen.getByTestId('tuning-theme-luna'))
    expect(screen.getByTestId('tuning-theme-luna').className).toContain('on')
    await waitFor(() => expect(patchCabin).toHaveBeenCalled(), { timeout: 2000 })
    const arg = vi.mocked(patchCabin).mock.calls[0][2]
    expect((arg.cockpit_prefs as { theme: string }).theme).toBe('luna')
  })
  it('点自决 observe → 段高亮（行为键写入 prefs）', async () => {
    renderCabin(<CabinTuning />, makeView())
    fireEvent.click(screen.getByTestId('tuning-autonomy-observe'))
    expect(screen.getByTestId('tuning-autonomy-observe').className).toContain('on')
    await waitFor(() => expect(patchCabin).toHaveBeenCalled(), { timeout: 2000 })
    const arg = vi.mocked(patchCabin).mock.calls.at(-1)![2]
    expect((arg.cockpit_prefs as { autonomy: string }).autonomy).toBe('observe')
  })
})

describe('CabinGallery（立绘画廊）', () => {
  it('渲染九种表情立绘', () => {
    renderCabin(<CabinGallery />, makeView())
    expect(screen.getByTestId('cabin-gallery-body')).toBeTruthy()
    for (const k of ['idle', 'working', 'alert', 'happy', 'sleep', 'thinking', 'cheer', 'wink', 'worried']) {
      expect(screen.getByTestId(`gallery-card-${k}`)).toBeTruthy()
    }
  })
  it('点表情 → 汐音瞬时切换形态（当前卡高亮）', () => {
    renderCabin(<CabinGallery />, makeView())
    fireEvent.click(screen.getByTestId('gallery-card-cheer'))
    expect(screen.getByTestId('gallery-card-cheer').getAttribute('data-on')).toBe('true')
  })
})

describe('CabinArchive（归档台）', () => {
  it('渲染沉淀 metrics + open findings + 生命周期按钮', async () => {
    vi.mocked(getCabinFindings).mockResolvedValue([finding('f1')])
    renderCabin(<CabinArchive />, makeView({ open_findings: 1 }))
    expect(screen.getByTestId('cabin-archive-body')).toBeTruthy()
    expect(screen.getByTestId('archive-metrics')).toBeTruthy()
    expect(screen.getByTestId('archive-action-dormant')).toBeTruthy()
    expect(screen.getByTestId('archive-action-archive')).toBeTruthy()
    await waitFor(() => expect(screen.getByTestId('archive-findings')).toBeTruthy())
    expect(screen.getByText('术语冲突 f1')).toBeTruthy()
    expect(screen.getByText('旧「旧词」→ 新「新词」')).toBeTruthy()
  })
  it('点封存 → archiveCabin + refresh', async () => {
    vi.mocked(archiveCabin).mockResolvedValue(makeView().cabin as never)
    renderCabin(<CabinArchive />, makeView())
    fireEvent.click(screen.getByTestId('archive-action-archive'))
    await waitFor(() => expect(archiveCabin).toHaveBeenCalledWith('cabin-1'))
  })
  it('运行中 → 休眠按钮禁用（守卫）', () => {
    renderCabin(<CabinArchive />, makeView({ health: { running: 1, queued: 0, dormant: 0, workers: 1, max: 5 } }))
    expect(screen.getByTestId('archive-action-dormant')).toBeDisabled()
  })
})

describe('CabinCrew（汐音浮舱）', () => {
  it('渲染立绘浮舱 + 状态徽章 + 助理菜单', () => {
    renderCabin(<CabinCrew />, makeView())
    const pod = screen.getByTestId('cabin-crew-pod')
    expect(pod.getAttribute('data-state')).toBe('idle')
    expect(screen.getByTestId('cabin-crew-menu')).toBeTruthy()
    expect(pod.querySelector('img')?.getAttribute('src')).toBe('/cabin/xiyin-idle.png')
  })
  it('点击立绘 → 互动对白显示', () => {
    renderCabin(<CabinCrew />, makeView())
    fireEvent.click(screen.getByTestId('cabin-crew-frame'))
    expect(screen.getByTestId('cabin-crew-dialog').className).toContain('show')
  })
  it('待人 attention → alert 形态 + 徽章计数', () => {
    renderCabin(<CabinCrew />, makeView({
      attention: [{ id: 'a1', job_id: 'j1', stage: 'review', awaiting: 'person', title: '验收', task_id: 't1', repo: 'r', wt: 'w', deep_link: '', priority: 0 }],
    }))
    expect(screen.getByTestId('cabin-crew-pod').getAttribute('data-state')).toBe('alert')
  })
})

describe('助理菜单 v4（助理菜单重设计 + 在场）', () => {
  it('打开菜单：6 色块 + 随机 + 画廊无角标 + 无「互动一下」', () => {
    renderCabin(<CabinCrew />, makeView())
    fireEvent.click(screen.getByTestId('cabin-crew-menu'))
    const hub = screen.getByTestId('cabin-crew-hub')
    expect(hub.className).toContain('open')
    expect(hub.querySelectorAll('.ch-theme').length).toBe(6)
    expect(hub.querySelector('.ch-random')).toBeTruthy()
    const items = Array.from(hub.querySelectorAll('.ch-item'))
    const gallery = items.find((el) => (el.textContent || '').includes('立绘画廊'))
    expect(gallery).toBeTruthy()
    expect(gallery?.querySelector('.cb')).toBeNull()
    expect(items.some((el) => (el.textContent || '').includes('互动一下'))).toBe(false)
    expect(items.some((el) => (el.textContent || '').includes('在场 开'))).toBe(true)
  })
  it('统计数字可点；点色调即换主题', () => {
    renderCabin(<CabinCrew />, makeView({ health: { running: 2, queued: 0, dormant: 0, workers: 2, max: 5 } }))
    fireEvent.click(screen.getByTestId('cabin-crew-menu'))
    expect(screen.getByTestId('crew-stat-run').textContent).toContain('2')
    expect(screen.getByTestId('crew-stat-person')).toBeTruthy()
    expect(screen.getByTestId('crew-stat-queue')).toBeTruthy()
    fireEvent.click(screen.getByTestId('crew-theme-crimson'))
    expect(screen.getByTestId('crew-theme-crimson').className).toContain('on')
  })
  it('在场：provider 派发 → 主动对话（可静 30 分）', () => {
    renderCabin(<><PresenceProbe /><CabinCrew /></>, makeView())
    fireEvent.click(screen.getByTestId('probe-presence'))
    const dlg = screen.getByTestId('cabin-crew-dialog')
    expect(dlg.className).toContain('show')
    expect(dlg.textContent).toContain('主动')
    expect(screen.getByTestId('cabin-presence-snooze')).toBeTruthy()
    fireEvent.click(screen.getByTestId('cabin-presence-snooze'))
    expect(screen.getByTestId('cabin-crew-dialog').className).not.toContain('show')
  })
})