// S7 立绘 / 台词 / 在场 + v13 汐音设置 RTL：
//   · v13：**点立绘 = 跟她说话**（打开对话窗），不再弹控制条；
//   · 设置搬到 HUD「◐ 汐音」→ CockpitCrewSettings：在场节奏（秒级）/ 特效强度 /
//     说一句 / 互动一下 / 表情画廊；
//   · presenceLine 变化 → 气泡逐字 + fx.say（ticker 一份），**chat DOM 不出现台词**；
//   · reduced-motion 直接出全文、没有心形动画；
//   · setCrewBusy 跟随 chat.streaming（chat 为 null 时 false）。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useEffect, type ReactNode } from 'react'
import { cabinAudio } from '@/lib/cabin-audio'
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
import { CockpitCrew } from '../CockpitCrew'
import { CockpitCrewSettings } from '../CockpitCrewSettings'
import { requestCrewPoke, resetCrewPoke, subscribeCrewPoke } from '../crew-events'
import { CHAT_DONE, CHAT_LISTEN, CHAT_WAIT_EARLY } from '../chat-reactions'

vi.mock('@/lib/cabin-audio', () => ({
  cabinAudio: { blip: vi.fn(), chime: vi.fn(), setOn: vi.fn(), resume: vi.fn() },
}))

let said: { line: string; mood?: MoodKey } | null = null

function FxProbe() {
  const { fx } = useCockpitState()
  said = fx.lastSaid
  return null
}

function WindowProbe() {
  const { chatWindow } = useCockpitState()
  return (
    <div
      data-testid="win"
      data-open={chatWindow.open ? '1' : '0'}
      data-mini={chatWindow.mini ? '1' : '0'}
    />
  )
}

function ChatSeeder({ streaming }: { streaming: boolean }) {
  const { reportChat } = useCockpitState()
  useEffect(() => {
    reportChat({ streaming } as unknown as CockpitChatApi)
  }, [reportChat, streaming])
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
          <FxProbe />
          <WindowProbe />
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
    unmount: () => view.unmount(),
    rerender: (next: Partial<CockpitContextValue>) =>
      view.rerender(tree(makeCockpit({ ...overrides, ...next }), extra)),
  }
}

beforeEach(() => {
  said = null
  resetCrewPoke()
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
  delete (window as unknown as { matchMedia?: unknown }).matchMedia
})

describe('CockpitCrew · v13 点立绘 = 说话', () => {
  it('点立绘打开对话窗（不再有控制条）', () => {
    renderCrew()
    expect(screen.queryByTestId('cockpit-crew-menu')).toBeNull()
    expect(screen.getByTestId('win').dataset.open).toBe('0')

    fireEvent.click(screen.getByTestId('cockpit-crew-pod'))

    expect(screen.getByTestId('win').dataset.open).toBe('1')
    expect(screen.queryByTestId('cockpit-crew-menu')).toBeNull()
  })

  it('点气泡也打开对话窗', () => {
    const line: PresenceLine = { id: 1, text: '指挥官，我在。', mood: 'idle', hold: 9000 }
    const { rerender } = renderCrew()
    rerender({ presenceLine: line })

    fireEvent.click(screen.getByTestId('cockpit-crew-speech'))
    expect(screen.getByTestId('win').dataset.open).toBe('1')
  })

  // v13.1 · 点击即时反馈（对齐 classic 点立绘的手感）
  it('点立绘同一拍就给反馈：表情 + 台词 + 星光 + 涟漪，然后才开窗', async () => {
    const { cockpit } = renderCrew()

    fireEvent.click(screen.getByTestId('cockpit-crew-pod'))

    // 表情立即换（首点 = 招呼句 wink）
    expect(cockpit.setMoodOverride).toHaveBeenCalledWith('wink', expect.any(Number))
    // 触感：6 颗星光 + 一圈涟漪 + 点击音
    expect(screen.getAllByTestId('cockpit-crew-spark')).toHaveLength(6)
    expect(screen.getByTestId('cockpit-crew-tapring')).toBeInTheDocument()
    expect(cabinAudio.blip).toHaveBeenCalled()
    // 台词逐字打完（不打进 chat DOM）
    await waitFor(() =>
      expect(screen.getByTestId('cockpit-crew-speech')).toHaveTextContent('我在。你说。'),
    )
    expect(screen.getByTestId('cockpit-chat-transcript')).not.toHaveTextContent('我在。你说。')
    // 开窗仍然是这一拍的正事
    expect(screen.getByTestId('win').dataset.open).toBe('1')
  })

  it('900ms 内连点只重复触感，不重开打字机；过了节流就轮播下一句', async () => {
    const { cockpit } = renderCrew()
    const pod = screen.getByTestId('cockpit-crew-pod')

    fireEvent.click(pod)
    fireEvent.click(pod)

    // 台词只起了一次（表情 override 只有一次），星光却叠了两批
    expect(cockpit.setMoodOverride).toHaveBeenCalledTimes(1)
    expect(screen.getAllByTestId('cockpit-crew-spark')).toHaveLength(12)

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000)
    fireEvent.click(pod)

    // 对话窗已开 → 走 XY_LINES 顺序轮播
    expect(cockpit.setMoodOverride).toHaveBeenCalledTimes(2)
    await waitFor(
      () => expect(screen.getByTestId('cockpit-crew-speech')).toHaveTextContent('指挥官，我在。'),
      { timeout: 3000 },
    )
  })

  it('reduced-motion 下点击：台词照出，星光/涟漪不出', () => {
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

    renderCrew()
    fireEvent.click(screen.getByTestId('cockpit-crew-pod'))

    expect(screen.getByTestId('cockpit-crew-speech')).toHaveTextContent('我在。你说。')
    expect(screen.queryAllByTestId('cockpit-crew-spark')).toHaveLength(0)
    expect(screen.getByTestId('win').dataset.open).toBe('1')
  })

  it('「互动一下」由设置面发信号，立绘执行：台词 + 表情 + 心形', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.4) // floor(0.4*9)=3
    const expected = XY_LINES[3]
    const { cockpit, unmount } = renderCrew()

    act(() => requestCrewPoke())

    expect(cockpit.setMoodOverride).toHaveBeenCalledWith(expected[1], 3000)
    await waitFor(() =>
      expect(screen.getByTestId('cockpit-crew-speech')).toHaveTextContent(expected[0]),
    )
    expect(screen.getByTestId('cockpit-crew-heart')).toBeInTheDocument()
    expect(said).toEqual(expect.objectContaining({ line: expected[0], mood: expected[1] }))
    unmount()
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
    expect(screen.getByTestId('cockpit-chat-transcript')).not.toHaveTextContent(line.text)
    expect((document.body.textContent ?? '').split(line.text)).toHaveLength(2)
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
    const { rerender, unmount } = renderCrew()

    rerender({ presenceLine: line })
    expect(screen.getByTestId('cockpit-crew-speech')).toHaveTextContent(line.text)

    act(() => requestCrewPoke())
    expect(screen.getByTestId('cockpit-crew-speech')).toHaveTextContent(XY_LINES[0][0])
    expect(screen.queryByTestId('cockpit-crew-heart')).toBeNull()
    unmount()
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

    const idleSetCrewBusy = vi.fn()
    renderCrew({ setCrewBusy: idleSetCrewBusy })
    expect(idleSetCrewBusy).toHaveBeenLastCalledWith(false)
  })
})

describe('CockpitCrew · 对话联动（2026-11-16）', () => {
  it('送出消息（streaming true）→ 思考表情 + 等待气泡 + 回复中秒表', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0) // waitingLine(0) = CHAT_WAIT_EARLY[0]
    const view = render(tree(makeCockpit(), <ChatSeeder streaming />))

    await waitFor(() =>
      expect(screen.getByTestId('cockpit-crew-mood')).toHaveTextContent('回复中'),
    )
    const pod = screen.getByTestId('cockpit-crew-pod')
    expect(pod.dataset.state).toBe(CHAT_WAIT_EARLY[0].mood)
    expect(pod.dataset.phase).toBe('waiting')
    expect(screen.getByTestId('cockpit-crew-pod').textContent).toContain('回复中')
    await waitFor(() =>
      expect(screen.getByTestId('cockpit-crew-speech')).toHaveTextContent(CHAT_WAIT_EARLY[0].text),
    )
    expect(screen.getByTestId('cockpit-crew-wait-dots')).toBeInTheDocument()

    view.unmount()
  })

  it('回答结束（streaming true → false）→ 收尾表情 +「回完了」+ 星光', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0) // doneLine = CHAT_DONE[0]（cheer）
    const view = render(tree(makeCockpit(), <ChatSeeder streaming />))
    await waitFor(() =>
      expect(screen.getByTestId('cockpit-crew-mood')).toHaveTextContent('回复中'),
    )

    view.rerender(tree(makeCockpit(), <ChatSeeder streaming={false} />))

    await waitFor(() =>
      expect(screen.getByTestId('cockpit-crew-mood')).toHaveTextContent('庆祝'),
    )
    expect(screen.getByTestId('cockpit-crew-pod').dataset.state).toBe(CHAT_DONE[0].mood)
    expect(screen.getByTestId('cockpit-crew-pod').dataset.phase).toBe('done')
    await waitFor(() =>
      expect(screen.getByTestId('cockpit-crew-speech')).toHaveTextContent(CHAT_DONE[0].text),
    )
    expect(screen.getAllByTestId('cockpit-crew-spark').length).toBeGreaterThan(0)

    view.unmount()
  })

  it('用户输入草稿 → 倾听表情 +「我在听」+ 呼吸点；清空即退', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0) // listenLine = CHAT_LISTEN[0]
    const view = render(
      tree(
        makeCockpit(),
        <div data-testid="cockpit-composer-slot"><textarea data-testid="composer" /></div>,
      ),
    )
    const input = screen.getByTestId('composer')

    fireEvent.input(input, { target: { value: '帮我看看这个任务' } })

    await waitFor(() =>
      expect(screen.getByTestId('cockpit-crew-mood')).toHaveTextContent('倾听'),
    )
    expect(screen.getByTestId('cockpit-crew-pod').dataset.state).toBe(CHAT_LISTEN[0].mood)
    expect(screen.getByTestId('cockpit-crew-listening')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByTestId('cockpit-crew-speech')).toHaveTextContent(CHAT_LISTEN[0].text),
    )

    fireEvent.input(input, { target: { value: '' } })
    await waitFor(() =>
      expect(screen.queryByTestId('cockpit-crew-listening')).toBeNull(),
    )

    view.unmount()
  })

  it('正在回复时不进倾听态（回复中优先）', async () => {
    const view = render(
      tree(
        makeCockpit(),
        <>
          <ChatSeeder streaming />
          <div data-testid="cockpit-composer-slot"><textarea data-testid="composer" /></div>
        </>,
      ),
    )

    fireEvent.input(screen.getByTestId('composer'), { target: { value: '排队一条' } })

    await waitFor(() =>
      expect(screen.getByTestId('cockpit-crew-mood')).toHaveTextContent('回复中'),
    )
    expect(screen.queryByTestId('cockpit-crew-listening')).toBeNull()
    expect(screen.getByTestId('cockpit-crew-pod').dataset.phase).toBe('waiting')

    view.unmount()
  })
})

// ── v13 汐音设置 ────────────────────────────────────────────────────
function renderSettings(overrides: Partial<CockpitContextValue> = {}) {
  const cockpit = makeCockpit(overrides)
  const onClose = vi.fn()
  render(
    <CockpitContext.Provider value={cockpit}>
      <CockpitStateProvider entryCabinId="c1">
        <CockpitLayerStack>
          <CockpitCrewSettings open anchor={null} onClose={onClose} />
        </CockpitLayerStack>
      </CockpitStateProvider>
    </CockpitContext.Provider>,
  )
  return { cockpit, onClose }
}

describe('CockpitCrewSettings · v13', () => {
  it('在场节奏是秒级三档 + 关闭开关；默认活跃 30 秒', () => {
    const { cockpit } = renderSettings()

    const panel = screen.getByTestId('cockpit-crew-settings')
    expect(panel).toHaveTextContent('30 秒')
    expect(screen.getByTestId('cockpit-crew-rate-note')).toHaveTextContent('静默 30 秒')

    fireEvent.click(screen.getByTestId('cockpit-crew-rate-quiet'))
    expect(cockpit.setPref).toHaveBeenCalledWith('presenceRate', 'quiet')
    expect(PRESENCE_RATES.quiet.seconds).toBe(300)

    fireEvent.click(screen.getByTestId('cockpit-crew-presence-toggle'))
    expect(cockpit.setPref).toHaveBeenCalledWith('presenceOn', false)
  })

  it('特效强度三档写进 prefs；说一句 / 互动 / 表情都走既有动作', () => {
    const { cockpit } = renderSettings()

    fireEvent.click(screen.getByTestId('cockpit-crew-fx-lite'))
    expect(cockpit.setPref).toHaveBeenCalledWith('fxLevel', 'lite')

    fireEvent.click(screen.getByTestId('cockpit-crew-say'))
    expect(cockpit.testPresence).toHaveBeenCalled()

    const onPoke = vi.fn()
    const unsubscribe = subscribeCrewPoke(onPoke)
    fireEvent.click(screen.getByTestId('cockpit-crew-poke'))
    expect(onPoke).toHaveBeenCalledTimes(1)
    unsubscribe()

    const gallery = within(screen.getByTestId('cockpit-crew-gallery')).getAllByRole('button')
    expect(gallery).toHaveLength(XY_FORMS.length)
    fireEvent.click(gallery[0])
    expect(cockpit.setMoodOverride).toHaveBeenCalledWith(XY_FORMS[0].k)
  })

  it('Esc 关设置面（走同一层栈）', () => {
    const { onClose } = renderSettings()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})