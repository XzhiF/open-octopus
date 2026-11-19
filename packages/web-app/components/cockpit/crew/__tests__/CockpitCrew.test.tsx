// S7 立绘 / 台词 / 在场 + v13 汐音设置 RTL：
//   · v13：**点立绘 = 跟她说话**（打开对话窗），不再弹控制条；
//   · 设置搬到 HUD「◐ 汐音」→ CockpitCrewSettings：在场节奏（秒级）/ 特效强度 /
//     说一句 / 互动一下 / 表情画廊；
//   · presenceLine 变化 → 气泡逐字 + fx.say（ticker 一份），**chat DOM 不出现台词**；
//   · reduced-motion 直接出全文、没有心形动画；
//   · setCrewBusy 跟随 chat.streaming（chat 为 null 时 false）。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useEffect, useRef, type ReactNode } from 'react'
import { cabinAudio } from '@/lib/cabin-audio'
import type { MoodKey } from '@/components/cabin/cockpit'
import {
  DEFAULT_COCKPIT,
  PRESENCE_RATES,
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
import { CockpitCrewSettings, CockpitCrewSettingsLayer } from '../CockpitCrewSettings'
import { requestCrewPoke, resetCrewPoke, subscribeCrewPoke } from '../crew-events'
import { resetCrewSettings, setCrewSettingsOpen } from '../crew-settings'
import { resetCrewAgentInfoCache } from '../use-crew-agent-info'
import { CLIPS } from '../pose-model'
import { CHAT_DONE, CHAT_LISTEN, CHAT_WAIT_EARLY } from '../chat-reactions'

vi.mock('@/lib/cabin-audio', () => ({
  cabinAudio: { blip: vi.fn(), chime: vi.fn(), setOn: vi.fn(), resume: vi.fn() },
}))

// 待办轮播 / 清单提醒的数据源（与右栏同一份 collectInbox 输入）。
const fleetState = vi.hoisted(() => ({ rows: [] as unknown[] }))
vi.mock('../../fleet/CockpitFleetProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../fleet/CockpitFleetProvider')>()
  return {
    ...actual,
    useCockpitFleet: () => ({
      rows: fleetState.rows,
      mainSessionId: null,
      counts: null,
      arrivals: [],
      loading: false,
      error: null,
      refetch: () => {},
    }),
  }
})

// 2026-11-19 用户 #7：AGENT 档案的三条真源（只覆写这三个，其余走真实模块）。
vi.mock('@/lib/agent/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agent/api')>()
  return {
    ...actual,
    getCloneFile: vi.fn(async () => ({
      content: '# 舱调度者\n\n你是全能舱主：能调度，也能直接写业务代码。',
      path: 'persona.md',
      size: 40,
      readonly: true,
    })),
    listSkills: vi.fn(async () => ({
      items: [{ name: 'octo-wiki' }, { name: 'octo-dev-copilot' }],
    })),
    listMcpServers: vi.fn(async () => ({
      servers: [
        { server: 'octopus-cabin', label: '舱调度', description: 'x', when: 'x', tools: [{ name: 'a', description: 'a' }] },
        { server: 'octopus-workflow', label: '工作流', description: 'x', when: 'x', tools: [{ name: 'b', description: 'b' }] },
        { server: 'octopus-memory', label: '记忆', description: 'x', when: 'x', tools: [] },
        // 不是她主对话挂的 server —— 必须被过滤掉。
        { server: 'octopus-task', label: '任务', description: 'x', when: 'x', tools: [] },
      ],
    })),
  }
})

import type { CabinAttentionItem } from '@octopus/shared'
import type { CockpitRow } from '../../fleet/fleet-model'

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

/** v21 三轮：通讯台默认展开（输入框在台里）；这些用例先把它收起，再验证
 *  「点立绘 = 开窗」的语义。 */
function WindowCloser() {
  const { chatWindow } = useCockpitState()
  const setRef = useRef(chatWindow.set)
  setRef.current = chatWindow.set
  useEffect(() => { setRef.current({ open: false }) }, [])
  return null
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
          <WindowCloser />
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
  fleetState.rows = []
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
  it('点立绘同一拍就给反馈：表情 + 台词 + 星光，然后才开窗（无描边涟漪）', async () => {
    const { cockpit } = renderCrew()

    fireEvent.click(screen.getByTestId('cockpit-crew-pod'))

    // 表情立即换（首点 = 招呼句 wink）
    expect(cockpit.setMoodOverride).toHaveBeenCalledWith('wink', expect.any(Number))
    // 触感：6 颗星光 + 点击音；v21 四轮起立绘周边不再出现描边涟漪。
    expect(screen.getAllByTestId('cockpit-crew-spark')).toHaveLength(6)
    expect(screen.queryByTestId('cockpit-crew-tapring')).toBeNull()
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

  it('reduced-motion 下点击：台词照出，星光不出', () => {
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
function renderSettings(
  overrides: Partial<CockpitContextValue> = {},
  tab: 'profile' | 'settings' = 'profile',
) {
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
  // 2026-11-19 用户：档案改成上 tab 下内容；在场/特效/互动在「互动」页。
  if (tab === 'settings') fireEvent.click(screen.getByTestId('cockpit-crew-tab-settings'))
  return { cockpit, onClose }
}

describe('CockpitCrewSettings · v13', () => {
  it('在场节奏是秒级三档 + 关闭开关；默认活跃 30 秒', () => {
    const { cockpit } = renderSettings({}, 'settings')

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
    const { cockpit } = renderSettings({}, 'settings')

    fireEvent.click(screen.getByTestId('cockpit-crew-fx-lite'))
    expect(cockpit.setPref).toHaveBeenCalledWith('fxLevel', 'lite')

    fireEvent.click(screen.getByTestId('cockpit-crew-say'))
    expect(cockpit.testPresence).toHaveBeenCalled()

    const onPoke = vi.fn()
    const unsubscribe = subscribeCrewPoke(onPoke)
    fireEvent.click(screen.getByTestId('cockpit-crew-poke'))
    expect(onPoke).toHaveBeenCalledTimes(1)
    unsubscribe()

    // 用户 2026-11-19：素材是 13 支片段，画廊必须 13 张；点卡带 clip 下标就地演。
    const gallery = within(screen.getByTestId('cockpit-crew-gallery')).getAllByRole('button')
    expect(gallery).toHaveLength(CLIPS.length)
    expect(CLIPS).toHaveLength(13)
    const poses: Array<{ pose?: string; clip?: number }> = []
    const onPose = (event: Event) => {
      poses.push((event as CustomEvent<{ pose?: string; clip?: number }>).detail)
    }
    window.addEventListener('octopus:crew-pose', onPose)
    fireEvent.click(gallery[5])
    window.removeEventListener('octopus:crew-pose', onPose)
    expect(poses).toHaveLength(1)
    expect(poses[0]).toMatchObject({ pose: CLIPS[5].pose, clip: 5, ms: 2600 })
    expect(cockpit.setMoodOverride).not.toHaveBeenCalled()
  })

  it('Esc 关设置面（走同一层栈）', () => {
    const { onClose } = renderSettings()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  // 2026-11-19 用户 #7：面板是她是谁（AGENT 档案），不是只有在场开关；
  // 二改（用户：技能多）改成上 tab 下内容 —— 资料 / 人格 / 技能 / 工具 / 互动。
  it('AGENT 档案：资料页 + 人格 / 技能 / 工具三个 tab', async () => {
    renderSettings()
    const panel = screen.getByTestId('cockpit-crew-settings')
    const agent = within(panel).getByTestId('cockpit-crew-agent')
    expect(agent).toHaveTextContent('舱调度者')
    expect(agent).toHaveTextContent('cabin-orchestrator')
    expect(agent).toHaveTextContent('隔离记忆')

    await waitFor(() => expect(agent).toHaveTextContent('2 项'))
    expect(agent).toHaveTextContent('3 套 MCP')

    // tab 头写真实计数：技能 2 / 工具 3
    expect(within(panel).getByTestId('cockpit-crew-tab-skills')).toHaveTextContent('2')
    expect(within(panel).getByTestId('cockpit-crew-tab-tools')).toHaveTextContent('3')

    fireEvent.click(within(panel).getByTestId('cockpit-crew-agent-persona'))
    expect(screen.getByTestId('cockpit-crew-agent-persona-text')).toHaveTextContent('全能舱主')

    fireEvent.click(within(panel).getByTestId('cockpit-crew-tab-skills'))
    const skillChips = screen.getByTestId('cockpit-crew-agent-skill-chips')
    expect(skillChips).toHaveTextContent('octo-wiki')
    expect(skillChips).toHaveTextContent('octo-dev-copilot')

    fireEvent.click(within(panel).getByTestId('cockpit-crew-tab-tools'))
    const toolChips = screen.getByTestId('cockpit-crew-agent-tool-chips')
    expect(toolChips).toHaveTextContent('舱调度')
    expect(toolChips).toHaveTextContent('工作流')
    expect(toolChips).toHaveTextContent('记忆')
    // octopus-task 不在她主对话的挂载集里 —— 不能拿来充数。
    expect(toolChips).not.toHaveTextContent('任务')
    // 每个 server 的真实工具名也在（cabin 只有 a，workflow 只有 b）。
    expect(toolChips).toHaveTextContent('a')
    expect(toolChips).toHaveTextContent('b')
  })
})

describe('CockpitCrewSettingsLayer · 更多 → ♡ 汐音', () => {
  beforeEach(() => {
    resetCrewSettings()
    resetCrewAgentInfoCache()
  })
  afterEach(() => resetCrewSettings())

  function renderLayer() {
    render(
      <CockpitContext.Provider value={makeCockpit()}>
        <CockpitStateProvider entryCabinId="c1">
          <CockpitLayerStack>
            <CockpitCrewSettingsLayer />
          </CockpitLayerStack>
        </CockpitStateProvider>
      </CockpitContext.Provider>,
    )
  }

  it('store 打开 → 面板出现，并让她做动作（octopus:crew-pose）', async () => {
    const onPose = vi.fn()
    window.addEventListener('octopus:crew-pose', onPose as EventListener)
    try {
      renderLayer()
      expect(screen.queryByTestId('cockpit-crew-settings')).toBeNull()

      act(() => { setCrewSettingsOpen(true) })

      expect(await screen.findByTestId('cockpit-crew-settings')).toBeInTheDocument()
      expect(onPose).toHaveBeenCalled()
      const detail = (onPose.mock.calls[0][0] as CustomEvent<{ pose: string }>).detail
      expect(detail.pose).toBe('ready')
    } finally {
      window.removeEventListener('octopus:crew-pose', onPose as EventListener)
    }
  })
})
describe('CockpitCrew · v21 ready 报到（真实事件驱动）', () => {
  const sprite = () => screen.getByTestId('cockpit-pose-sprite')

  it('首次进舱保持待命，不播报到（design 31 §3.5：开机=待命）', () => {
    renderCrew()
    expect(sprite()).toHaveAttribute('data-pose', 'idle')
    expect(screen.getByTestId('cockpit-crew-speech')).not.toHaveTextContent('舰桥接管')
  })

  it('从休眠唤醒（mood sleep → idle）→ 报到', async () => {
    const { rerender } = renderCrew({ mood: 'sleep' })
    expect(sprite()).toHaveAttribute('data-pose', 'sleep')

    rerender({ mood: 'idle' })

    expect(sprite()).toHaveAttribute('data-pose', 'ready')
    // 台词逐字打出，等打字机推进到「舰桥接管」这一拍。
    await waitFor(() =>
      expect(screen.getByTestId('cockpit-crew-speech')).toHaveTextContent('舰桥接管'),
    )
  })

  it('接管另一间舱（scene.key 变化）→ 报到；同舱内不变则不播', () => {
    const { rerender } = renderCrew()
    expect(sprite()).toHaveAttribute('data-pose', 'idle')

    rerender({ scene: { key: 'cabin-2' } as unknown as CockpitContextValue['scene'] })
    expect(sprite()).toHaveAttribute('data-pose', 'ready')
  })
})

describe('CockpitCrew · v22.1 待命自走轮播', () => {
  const sprite = () => screen.getByTestId('cockpit-pose-sprite')

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('真空闲 12s 后换一支日常片段，姿态语义仍是待命', () => {
    renderCrew()
    expect(sprite()).toHaveAttribute('data-pose', 'idle')
    expect(sprite()).toHaveAttribute('data-clip', '6')

    act(() => { vi.advanceTimersByTime(12_000) })

    expect(sprite()).toHaveAttribute('data-pose', 'idle')
    expect(sprite().getAttribute('data-clip')).not.toBe('6')
  })

  it('作业/动作期间不自走（片段跟随真实状态）', () => {
    renderCrew({ mood: 'working' })
    expect(sprite()).toHaveAttribute('data-clip', '12')

    act(() => { vi.advanceTimersByTime(12_000) })

    expect(sprite()).toHaveAttribute('data-pose', 'working')
    expect(sprite()).toHaveAttribute('data-clip', '12')
  })
})

// 2026-11-19 用户：有需要我处理的任务时，她一直循环同一支摇头动作，显得呆；
// 希望等得久时穿插别的动作，并且头顶时不时报一条真实清单。
describe('CockpitCrew · 等你在场（有待办）', () => {
  const sprite = () => screen.getByTestId('cockpit-pose-sprite')

  function attentionRow(id: string, over: Partial<CabinAttentionItem> = {}): CockpitRow {
    return {
      key: `attn:${id}`,
      kind: 'attention',
      cabinId: 'c1',
      cabinName: '舱一',
      item: {
        id,
        job_id: null,
        stage: 'review',
        awaiting: 'person',
        title: `事项 ${id}`,
        task_id: null,
        repo: null,
        wt: null,
        deep_link: null,
        ...over,
      },
    }
  }

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('等待时片段在 alert 与日常动作之间穿插（姿态语义仍是警觉）', () => {
    fleetState.rows = [attentionRow('a1', { stage: 'review', title: 'M2 · 结算对账' })]
    renderCrew({ mood: 'alert' })

    expect(sprite()).toHaveAttribute('data-pose', 'alert')
    expect(sprite()).toHaveAttribute('data-clip', '3')

    // 首拍 4.2–6s：换成第一支日常动作。
    act(() => { vi.advanceTimersByTime(6_500) })
    expect(sprite()).toHaveAttribute('data-pose', 'alert')
    expect(sprite()).toHaveAttribute('data-clip', '6')

    // 下一拍 5.2–7.8s：回到 alert 主拍。
    act(() => { vi.advanceTimersByTime(8_000) })
    expect(sprite()).toHaveAttribute('data-pose', 'alert')
    expect(sprite()).toHaveAttribute('data-clip', '3')

    // 第三拍：换到另一支动作 —— 不能只在 04 ↔ 07 两支之间来回（真机回归）。
    act(() => { vi.advanceTimersByTime(8_000) })
    expect(sprite()).toHaveAttribute('data-pose', 'alert')
    expect(sprite()).toHaveAttribute('data-clip', '8')
  })

  it('待办一直在：头顶气泡隔一阵报真实清单（标题来自编队行）', () => {
    fleetState.rows = [attentionRow('a1', { stage: 'review', title: 'M2 · 结算对账' })]
    renderCrew({ mood: 'alert' })

    expect(screen.getByTestId('cockpit-crew-speech')).not.toHaveTextContent('结算对账')

    act(() => { vi.advanceTimersByTime(9_000) })
    // 提醒在 7s 落库 → React 落地后打字机才起 interval：再推进一拍让它打完。
    act(() => { vi.advanceTimersByTime(800) })

    const speech = screen.getByTestId('cockpit-crew-speech')
    expect(speech.className).toContain('show')
    expect(speech).toHaveTextContent('结算对账')
    expect(speech).toHaveTextContent('验收')
  })

  it('在场关闭时不打扰（只有动作穿插，不乱说话）', () => {
    fleetState.rows = [attentionRow('a1', { stage: 'review', title: 'M2 · 结算对账' })]
    renderCrew({ mood: 'alert', prefs: { ...DEFAULT_COCKPIT, presenceOn: false } })

    act(() => { vi.advanceTimersByTime(20_000) })

    expect(screen.getByTestId('cockpit-crew-speech')).not.toHaveTextContent('结算对账')
    // 动作穿插不依赖在场开关（立绘本来就在场）。
    expect(sprite()).toHaveAttribute('data-pose', 'alert')
  })

  it('没有待办时不自作多情：不报清单，片段走原 pose 首选', () => {
    renderCrew({ mood: 'alert' })

    act(() => { vi.advanceTimersByTime(20_000) })

    expect(screen.getByTestId('cockpit-crew-speech')).not.toHaveTextContent('结算对账')
  })
})
