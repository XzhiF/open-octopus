// S8：到达简报 + 全局特效的 RTL 测试（全部 mock 编队数据，不打真服务）。
// 覆盖：简报 0 按钮、10s 自动收、合并 +N、Esc 收起、到达触发 fx 脉冲/流光/台词、
// 未知 arrival 不编造、edge/pulse 只在 nonce 变化时重放、reduced-motion 不挂载、
// 演示触发器仅 DEV + ?demo=1（PROD 下不存在）。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { CabinAttentionItem } from '@octopus/shared'
import type { CabinJobView } from '@/lib/cabin-api'
import { CockpitContext, type CockpitContextValue } from '@/components/cabin/CockpitProvider'
import { DEFAULT_COCKPIT } from '@/components/cabin/cockpit'
import type { CockpitRow } from '../../fleet/fleet-model'
import { CockpitStateProvider, useCockpitState } from '../../state/CockpitStateProvider'
import { CockpitLayerStack } from '../../state/CockpitLayerStack'
import { CockpitBrief, BRIEF_MS, attentionColor } from '../CockpitBrief'
import { CockpitEffects } from '../CockpitEffects'

const fleet = vi.hoisted(() => ({
  rows: [] as unknown[],
  counts: null as unknown,
  arrivals: [] as string[],
  loading: false,
  error: null as string | null,
  refetch: () => {},
}))

vi.mock('@/components/cockpit/fleet/CockpitFleetProvider', () => ({
  useCockpitFleet: () => fleet,
}))

function attention(
  id: string,
  overrides: Partial<CabinAttentionItem> = {},
): CabinAttentionItem {
  return {
    id,
    job_id: null,
    stage: 'review',
    awaiting: 'person',
    title: `回流 ${id}`,
    task_id: null,
    repo: null,
    wt: null,
    deep_link: null,
    priority: 5,
    ...overrides,
  }
}

function attentionRow(item: CabinAttentionItem): CockpitRow {
  return {
    key: `attn:${item.id}`,
    kind: 'attention',
    cabinId: 'c1',
    cabinName: '舱一',
    item,
  }
}

function Probe() {
  const { fx } = useCockpitState()
  return (
    <div
      data-testid="probe"
      data-edge={fx.edgeNonce}
      data-pulse={fx.pulseNonce}
      data-edge-color={fx.edgeColor}
      data-pulse-color={fx.pulseColor}
      data-said={fx.lastSaid?.line ?? ''}
      data-mood={fx.lastSaid?.mood ?? ''}
      data-feedback={fx.feedbackNonce}
      data-level={fx.feedbackLevel}
      data-feedback-color={fx.feedbackColor}
    />
  )
}

function WindowProbe() {
  const { chatWindow } = useCockpitState()
  return <div data-testid="win" data-open={chatWindow.open ? '1' : '0'} />
}

function SelectionProbe() {
  const { selection } = useCockpitState()
  return <div data-testid="sel" data-key={selection ? `${selection.kind}:${selection.id}` : ''} />
}

function makeCockpit(): CockpitContextValue {
  return {
    prefs: DEFAULT_COCKPIT,
    mood: 'idle',
    moodOverride: null,
    streaming: false,
    setStreaming: vi.fn(),
    setPref: vi.fn(),
    applyPrefs: vi.fn(),
    reset: vi.fn(),
    randomize: vi.fn(),
    setMoodOverride: vi.fn(),
    presenceLine: null,
    presenceDueAt: 0,
    presenceSnoozeUntil: 0,
    dismissPresence: vi.fn(),
    snoozePresence: vi.fn(),
    testPresence: vi.fn(),
    setCrewBusy: vi.fn(),
    setPresenceActive: vi.fn(),
    scene: { key: 'cabin-1' } as unknown as CockpitContextValue['scene'],
  }
}

function FxTriggers() {
  const { fx } = useCockpitState()
  return (
    <>
      <button type="button" onClick={() => fx.edge('var(--pop-red)')}>edge</button>
      <button type="button" onClick={() => fx.pulse('var(--pop-cyan)')}>pulse</button>
      <button type="button" onClick={() => fx.feedback('var(--pop-green)', 'full')}>feedback</button>
      <button type="button" onClick={() => fx.feedback('var(--pop-green)', 'lite')}>feedback-lite</button>
    </>
  )
}

function Harness({ children }: { children?: ReactNode }) {
  return (
    <CockpitContext.Provider value={makeCockpit()}>
      <CockpitStateProvider entryCabinId="c1">
        <CockpitLayerStack>
          {children ?? <CockpitBrief />}
          <Probe />
          <WindowProbe />
          <SelectionProbe />
        </CockpitLayerStack>
      </CockpitStateProvider>
    </CockpitContext.Provider>
  )
}

beforeEach(() => {
  fleet.rows = []
  fleet.arrivals = []
  window.history.replaceState({}, '', '/cabin/c1/cockpit')
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('CockpitBrief · 到达', () => {
  it('到达 → 简报出现：阶段色点/标签/标题/说明，且 0 个按钮', () => {
    fleet.rows = [attentionRow(attention('a1', { title: 'M2 结算对账' }))]
    fleet.arrivals = ['a1']

    render(<Harness />)

    const brief = screen.getByTestId('cockpit-brief')
    expect(brief).toHaveTextContent('M2 结算对账')
    expect(brief).toHaveTextContent('等你验收')
    expect(brief).toHaveTextContent('刚刚 · 汐音整理')
    expect(brief.querySelectorAll('button')).toHaveLength(0)
  })

  it('到达同时触发 fx.pulse / fx.edge / fx.say（颜色取阶段色）', () => {
    fleet.rows = [attentionRow(attention('a1', { title: 'M2 结算对账' }))]
    fleet.arrivals = ['a1']

    render(<Harness />)

    const probe = screen.getByTestId('probe')
    expect(probe.dataset.pulse).toBe('1')
    expect(probe.dataset.edge).toBe('1')
    expect(probe.dataset.pulseColor).toBe('var(--pop-green)')
    expect(probe.dataset.edgeColor).toBe('var(--pop-green)')
    expect(probe.dataset.said).toContain('M2 结算对账')
    expect(probe.dataset.mood).toBe('alert')
    // v13：背景特效信号量（full = 背景层 + 内容之上层），与 pulse/edge 并存
    expect(probe.dataset.feedback).toBe('1')
    expect(probe.dataset.level).toBe('full')
    expect(probe.dataset.feedbackColor).toBe('var(--pop-green)')
  })

  it('点简报任意处 = 激活：选中该作业并打开对话窗，卡片收起', () => {
    fleet.rows = [
      {
        key: 'job:j1',
        kind: 'job',
        cabinId: 'c1',
        cabinName: '舱一',
        job: { id: 'j1', priority: 5 } as CabinJobView,
        attention: attention('a9', { title: '合规审计' }),
        pct: null,
      } as CockpitRow,
    ]
    fleet.arrivals = ['a9']

    render(<Harness />)
    expect(screen.getByTestId('sel').dataset.key).toBe('')

    fireEvent.click(screen.getByTestId('cockpit-brief'))

    expect(screen.getByTestId('sel').dataset.key).toBe('job:j1')
    expect(screen.getByTestId('win').dataset.open).toBe('1')
    expect(screen.queryByTestId('cockpit-brief')).toBeNull()
  })

  it('没有 job_id 的 attention：点开只开对话，不选作业面', () => {
    fleet.rows = [attentionRow(attention('a1'))]
    fleet.arrivals = ['a1']

    render(<Harness />)
    fireEvent.click(screen.getByTestId('cockpit-brief'))

    expect(screen.getByTestId('sel').dataset.key).toBe('attention:a1')
    expect(screen.getByTestId('win').dataset.open).toBe('1')
  })

  it('job 行上挂的 attention 也能定位到 title/stage', () => {
    fleet.rows = [
      {
        key: 'job:j1',
        kind: 'job',
        cabinId: 'c1',
        cabinName: '舱一',
        job: { id: 'j1', priority: 5 } as CabinJobView,
        attention: attention('a9', { title: '合规审计', stage: 'blocked', awaiting: 'person' }),
        pct: null,
      } as CockpitRow,
    ]
    fleet.arrivals = ['a9']

    render(<Harness />)

    const brief = screen.getByTestId('cockpit-brief')
    expect(brief).toHaveTextContent('合规审计')
    expect(brief).toHaveTextContent('等你阻塞')
    expect(attentionColor('blocked')).toBe('var(--pop-red)')
  })

  it('同一批多条到达合并成一张（标题 +N），不叠窗', () => {
    fleet.rows = [
      attentionRow(attention('a1', { title: 'M2 结算对账' })),
      attentionRow(attention('a2', { title: '合规审计', stage: 'answer', awaiting: 'person' })),
      attentionRow(attention('a3', { title: '广告位竞价', stage: 'approval', awaiting: 'person' })),
    ]
    fleet.arrivals = ['a1', 'a2', 'a3']

    render(<Harness />)

    const briefs = screen.getAllByTestId('cockpit-brief')
    expect(briefs).toHaveLength(1)
    expect(briefs[0]).toHaveTextContent('M2 结算对账')
    expect(briefs[0]).toHaveTextContent('+2')
  })

  it('查不到的 arrival id 不编造简报', () => {
    fleet.rows = []
    fleet.arrivals = ['ghost']

    render(<Harness />)

    expect(screen.queryByTestId('cockpit-brief')).toBeNull()
  })

  it('10s 自动收（fake timers）', () => {
    vi.useFakeTimers()
    fleet.rows = [attentionRow(attention('a1'))]
    fleet.arrivals = ['a1']

    render(<Harness />)
    expect(screen.queryByTestId('cockpit-brief')).not.toBeNull()

    act(() => {
      vi.advanceTimersByTime(BRIEF_MS - 1)
    })
    expect(screen.queryByTestId('cockpit-brief')).not.toBeNull()

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.queryByTestId('cockpit-brief')).toBeNull()
  })

  it('Esc 提前收（走 CockpitLayerStack）', () => {
    fleet.rows = [attentionRow(attention('a1'))]
    fleet.arrivals = ['a1']

    render(<Harness />)
    expect(screen.queryByTestId('cockpit-brief')).not.toBeNull()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('cockpit-brief')).toBeNull()
  })

  it('空 tick 不会重复触发 fx（同一批 arrivals 只报一次）', () => {
    fleet.rows = [attentionRow(attention('a1'))]
    fleet.arrivals = ['a1']

    const view = render(<Harness />)
    expect(screen.getByTestId('probe').dataset.pulse).toBe('1')

    fleet.arrivals = []
    view.rerender(<Harness />)
    expect(screen.getByTestId('probe').dataset.pulse).toBe('1')
    expect(screen.getByTestId('probe').dataset.edge).toBe('1')
  })
})

describe('CockpitEffects · 信号量', () => {
  it('初值 nonce 0 不播动画', () => {
    render(<Harness><CockpitEffects /><FxTriggers /></Harness>)

    expect(screen.getByTestId('cockpit-fx')).not.toHaveClass('on')
    expect(screen.getByTestId('cockpit-edgefx')).not.toHaveClass('on')
    expect(screen.getByTestId('cockpit-edgefx').querySelectorAll('i')).toHaveLength(4)
  })

  it('只有 nonce 变化才重放：edge 不动 pulse，普通重渲染不重复触发', () => {
    const view = render(<Harness><CockpitEffects /><FxTriggers /></Harness>)

    fireEvent.click(screen.getByText('edge'))
    const edge = screen.getByTestId('cockpit-edgefx')
    expect(edge).toHaveClass('on')
    expect(edge.dataset.nonce).toBe('1')
    expect(screen.getByTestId('cockpit-fx')).not.toHaveClass('on')

    // 无关重渲染：nonce 与 'on' 状态都不变（不会重放）
    view.rerender(<Harness><CockpitEffects /><FxTriggers /></Harness>)
    expect(screen.getByTestId('cockpit-edgefx').dataset.nonce).toBe('1')

    fireEvent.click(screen.getByText('pulse'))
    expect(screen.getByTestId('cockpit-fx')).toHaveClass('on')
    expect(screen.getByTestId('cockpit-fx').dataset.nonce).toBe('1')
    // pulse 不影响 edge
    expect(screen.getByTestId('cockpit-edgefx').dataset.nonce).toBe('1')
  })

  it('颜色跟随 fx.edgeColor / fx.pulseColor', () => {
    render(<Harness><CockpitEffects /><FxTriggers /></Harness>)

    fireEvent.click(screen.getByText('edge'))
    fireEvent.click(screen.getByText('pulse'))

    expect(screen.getByTestId('cockpit-edgefx').style.getPropertyValue('--ck12-fx'))
      .toBe('var(--pop-red)')
    expect(screen.getByTestId('cockpit-fx').style.getPropertyValue('--ck12-fx'))
      .toBe('var(--pop-cyan)')
  })

  it('feedback full → 背景层（z1）+ 内容之上层（z3）；lite 只留光晕与环', () => {
    render(<Harness><CockpitEffects /><FxTriggers /></Harness>)

    fireEvent.click(screen.getByText('feedback'))
    expect(screen.getByTestId('cockpit-bgfx')).toBeInTheDocument()
    expect(screen.getByTestId('cockpit-bgfx-top')).toBeInTheDocument()
    expect(screen.getByTestId('cockpit-bgfx-top')).not.toHaveClass('is-lite')

    fireEvent.click(screen.getByText('feedback-lite'))
    expect(screen.queryByTestId('cockpit-bgfx')).toBeNull()
    expect(screen.getByTestId('cockpit-bgfx-top')).toHaveClass('is-lite')
  })

  it('prefers-reduced-motion 下不挂载', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))

    render(<Harness><CockpitEffects /><FxTriggers /></Harness>)

    expect(screen.queryByTestId('cockpit-fx')).toBeNull()
    expect(screen.queryByTestId('cockpit-edgefx')).toBeNull()
  })
})

describe('CockpitBrief · 演示触发器', () => {
  it('DEV + ?demo=1 才出现；点击只走 fx + 一张标注「演示」的简报', () => {
    window.history.replaceState({}, '', '/cabin/c1/cockpit?demo=1')

    render(<Harness />)

    const trigger = screen.getByTestId('cockpit-demo-arrival')
    fireEvent.click(trigger)

    const brief = screen.getByTestId('cockpit-brief')
    expect(brief).toHaveTextContent('演示')
    expect(brief).toHaveTextContent('没有写入编队数据')
    expect(brief.querySelectorAll('button')).toHaveLength(0)

    const probe = screen.getByTestId('probe')
    expect(probe.dataset.pulse).toBe('1')
    expect(probe.dataset.edge).toBe('1')
    expect(probe.dataset.said).toContain('演示')
    // 没动编队数据
    expect(fleet.arrivals).toEqual([])
  })

  it('没有 ?demo=1 时不渲染触发器', () => {
    render(<Harness />)
    expect(screen.queryByTestId('cockpit-demo-arrival')).toBeNull()
  })

  it('PROD 构建下不存在（即使带 ?demo=1）', () => {
    window.history.replaceState({}, '', '/cabin/c1/cockpit?demo=1')
    vi.stubEnv('PROD', true)
    vi.stubEnv('DEV', false)

    render(<Harness />)

    expect(screen.queryByTestId('cockpit-demo-arrival')).toBeNull()
    expect(screen.queryByTestId('cockpit-brief')).toBeNull()
  })
})
