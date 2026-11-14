// S7 立绘 / 台词 / 在场 RTL：
//   · 点立绘开控制条，关闭按钮是控制条里第一个可聚焦元素；
//   · 画廊 / 在场频率走 cockpit.ts 的真实列表与真实分钟；
//   · presenceLine 变化 → 气泡逐字 + fx.say（ticker 一份），**chat DOM 不出现台词**；
//   · reduced-motion 直接出全文、没有心形动画；
//   · setCrewBusy 跟随 chat.streaming（chat 为 null 时 false）。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useEffect, type ReactNode } from 'react'
import type { MoodKey } from '@/components/cabin/cockpit'
import {
  DEFAULT_COCKPIT,
  PRESENCE_RATES,
  XY_FORMS,
  XY_LINES,
} from '@/components/cabin/cockpit'
import {
  CockpitContext,
  type CockpitContextValue,
} from '@/components/cabin/CockpitProvider'
import type { PresenceLine } from '@/components/cabin/use-xiyin-state'
import type { CockpitChatApi } from '../../state/cockpit-state'
import { CockpitStateProvider, useCockpitState } from '../../state/CockpitStateProvider'
import { CockpitLayerStack } from '../../state/CockpitLayerStack'
import { CockpitTicker } from '../../shell/CockpitTicker'
import { CockpitCrew } from '../CockpitCrew'

vi.mock('@/lib/cabin-audio', () => ({
  cabinAudio: { blip: vi.fn(), chime: vi.fn(), setOn: vi.fn(), resume: vi.fn() },
}))

let said: { line: string; mood?: MoodKey } | null = null

function FxProbe() {
  const { fx } = useCockpitState()
  said = fx.lastSaid
  return null
}

function ChatSeeder({ streaming }: { streaming: boolean }) {
  const { reportChat } = useCockpitState()
  useEffect(() => {
    reportChat({ streaming } as unknown as CockpitChatApi)
  }, [reportChat, streaming])
  return null
}

/** 低优先级层：证明 Esc 先收立绘控制条，再轮到下层。 */
function LowerLayer({ onClose }: { onClose: () => void }) {
  const { layer } = useCockpitState()
  useEffect(() => layer.register('lower-layer', 10, onClose), [layer, onClose])
  return null
}

function makeCockpit(overrides: Partial<CockpitContextValue> = {}): CockpitContextValue {
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
    ...overrides,
  }
}

function tree(cockpit: CockpitContextValue, extra?: ReactNode) {
  return (
    <CockpitContext.Provider value={cockpit}>
      <CockpitStateProvider entryCabinId="c1">
        <CockpitLayerStack>
          <CockpitCrew />
          <CockpitTicker />
          <FxProbe />
          <div data-testid="cockpit-chat-transcript" />
          {extra}
        </CockpitLayerStack>
      </CockpitStateProvider>
    </CockpitContext.Provider>
  )
}

function renderCrew(overrides: Partial<CockpitContextValue> = {}, extra?: ReactNode) {
  const cockpit = makeCockpit(overrides)
  const view = render(tree(cockpit, extra))
  return {
    cockpit,
    rerender: (next: Partial<CockpitContextValue>) =>
      view.rerender(tree(makeCockpit({ ...overrides, ...next }), extra)),
  }
}

function openMenu() {
  fireEvent.click(screen.getByTestId('cockpit-crew-pod'))
  return screen.getByTestId('cockpit-crew-menu')
}

beforeEach(() => {
  said = null
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
  // jsdom 默认没有 matchMedia；测试自己装的那个在用例里撤掉。
  delete (window as unknown as { matchMedia?: unknown }).matchMedia
})

describe('CockpitCrew · 立绘与控制条', () => {
  it('点立绘开控制条：关闭是第一个可聚焦按钮，画廊取 XY_FORMS 全表', () => {
    const { cockpit } = renderCrew()

    const menu = openMenu()
    expect(menu).toBeInTheDocument()
    expect(screen.getByTestId('cockpit-crew-mood')).toHaveTextContent('待命')

    const buttons = within(menu).getAllByRole('button')
    expect(buttons[0]).toBe(screen.getByTestId('cockpit-crew-menu-close'))
    expect(buttons[0]).toHaveAttribute('aria-label', '关闭控制条')
    expect(buttons[0]).toHaveFocus()

    const gallery = within(screen.getByTestId('cockpit-crew-gallery')).getAllByRole('button')
    expect(gallery).toHaveLength(XY_FORMS.length)

    // 在场频率：三档 + 真实分钟区间（默认 active = 3–8 分钟）。
    expect(screen.getByTestId('cockpit-crew-rate-note')).toHaveTextContent(
      `约每 ${PRESENCE_RATES.active.min}–${PRESENCE_RATES.active.max} 分钟一句`,
    )
    fireEvent.click(screen.getByTestId('cockpit-crew-rate-quiet'))
    expect(cockpit.setPref).toHaveBeenCalledWith('presenceRate', 'quiet')
    expect(screen.getByTestId('cockpit-crew-rate-quiet')).toHaveAttribute('title', expect.stringContaining('12–24'))
  })

  it('画廊切换调用 setMoodOverride，Esc 先收控制条再收下层', () => {
    const lowerClose = vi.fn()
    const { cockpit } = renderCrew({}, <LowerLayer onClose={lowerClose} />)
    const menu = openMenu()

    fireEvent.click(menu.querySelector('[data-mood="wink"]') as HTMLElement)
    expect(cockpit.setMoodOverride).toHaveBeenCalledWith('wink')

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('cockpit-crew-menu')).toBeNull()
    expect(lowerClose).not.toHaveBeenCalled()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(lowerClose).toHaveBeenCalledTimes(1)
  })

  it('「互动一下」随机取 XY_LINES + 覆盖心情 + 心形', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.4) // floor(0.4*9)=3 → cheer
    const expected = XY_LINES[3]
    const { cockpit } = renderCrew()

    openMenu()
    fireEvent.click(screen.getByTestId('cockpit-crew-poke'))

    expect(cockpit.setMoodOverride).toHaveBeenCalledWith(expected[1], 3000)
    await waitFor(() =>
      expect(screen.getByTestId('cockpit-crew-speech')).toHaveTextContent(expected[0]),
    )
    expect(screen.getByTestId('cockpit-crew-heart')).toBeInTheDocument()
    expect(said).toEqual(expect.objectContaining({ line: expected[0], mood: expected[1] }))
  })
})

describe('CockpitCrew · 在场台词', () => {
  it('presenceLine 变化 → 气泡 + fx.say；台词不进 chat DOM', async () => {
    const dismissPresence = vi.fn()
    const line: PresenceLine = {
      id: 7,
      text: '收件箱里还有 2 条在流转，我盯着。',
      mood: 'working',
      hold: 9000,
    }
    const { rerender } = renderCrew({ dismissPresence })

    rerender({ presenceLine: line, dismissPresence })

    await waitFor(() =>
      expect(screen.getByTestId('cockpit-crew-speech')).toHaveTextContent(line.text),
    )

    expect(said).toEqual(expect.objectContaining({ line: line.text, mood: 'working' }))
    // ticker 一份
    expect(screen.getByTestId('cockpit-ticker')).toHaveTextContent(line.text)
    // chat DOM 里没有这句台词（只在气泡 + ticker 各出现一次）
    expect(screen.getByTestId('cockpit-chat-transcript')).not.toHaveTextContent(line.text)
    expect((document.body.textContent ?? '').split(line.text)).toHaveLength(3)
    expect(dismissPresence).toHaveBeenCalled()
  })

  it('reduced-motion：打字机直接出全文，互动没有心形', () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia

    vi.spyOn(Math, 'random').mockReturnValue(0) // XY_LINES[0]
    const line: PresenceLine = { id: 1, text: '指挥官，我在。', mood: 'idle', hold: 9000 }
    const { rerender } = renderCrew()

    rerender({ presenceLine: line })

    // 没有逐字过程的等待：effect 直接把全文写进气泡。
    expect(screen.getByTestId('cockpit-crew-speech')).toHaveTextContent(line.text)

    openMenu()
    fireEvent.click(screen.getByTestId('cockpit-crew-poke'))
    expect(screen.getByTestId('cockpit-crew-speech')).toHaveTextContent(XY_LINES[0][0])
    expect(screen.queryByTestId('cockpit-crew-heart')).toBeNull()
  })
})

describe('CockpitCrew · 闸门', () => {
  it('setCrewBusy 跟随 chat.streaming（null → false）', async () => {
    const setCrewBusy = vi.fn()
    const view = render(
      tree(makeCockpit({ setCrewBusy }), <ChatSeeder streaming />),
    )

    await waitFor(() => expect(setCrewBusy).toHaveBeenLastCalledWith(true))
    view.unmount()

    // chat 为 null 的新实例：最后一次上报是 false。
    const idleSetCrewBusy = vi.fn()
    renderCrew({ setCrewBusy: idleSetCrewBusy })
    expect(idleSetCrewBusy).toHaveBeenLastCalledWith(false)
  })
})
