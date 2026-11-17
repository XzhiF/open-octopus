// S9 关灯组审计（用户硬要求：所有关闭按钮在左，classic 习惯）。
//
// 对**能低成本挂载**的组件做 DOM 顺序断言（不是 CSS order 伪装）：
//   · 聊天浮窗 CockpitChatWindow —— 关闭钮（X 图标）是灯组第一个、也是 header 第一个；
//   · 作业面 CockpitJobHeader —— 关闭钮是 header 第一个可聚焦元素；
//   · 编队抽屉 CockpitFleetRail —— 关闭钮是 aside 第一个可聚焦元素；
//   · 上下文 / 在场 popover —— 关闭钮是弹层 header 第一个可聚焦元素。
//
// 挂载成本高 / 不在 S9 可改范围的，由各自既有测试或 S10 E2E 覆盖（见汇报）：
//   · 立绘控制条 —— crew/__tests__/CockpitCrew.test.tsx 已断言关闭第一；
//   · 模型 popover —— 复用 chat/ComposerModelPopover（无 header 关闭钮，点外部/Esc 收）；
//   · 任务模块窗 —— 共享 WindowTitlebar（座舱内改为方正图标灯组，关闭仍在左）。

import { useEffect, useRef } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ContextUsageData } from '@/lib/agent/types'
import {
  CockpitContext,
  type CockpitContextValue,
} from '@/components/cabin/CockpitProvider'
import { DEFAULT_COCKPIT } from '@/components/cabin/cockpit'
import { CockpitStateProvider, useCockpitState } from '../state/CockpitStateProvider'
import type { CockpitChatApi } from '../state/cockpit-state'
import { CockpitChatWindow } from '../chat/CockpitChatWindow'
import { CockpitFleetRail } from '../rail/CockpitFleetRail'
import { CockpitJobHeader } from '../face/CockpitJobHeader'
import { CockpitContextPopover } from '../bridge/CockpitContextPopover'
import { CockpitPresencePopover } from '../bridge/CockpitPresencePopover'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const cabinState = vi.hoisted(() => ({ value: null as unknown }))
vi.mock('@/components/cabin/cabin-provider', () => ({
  useCabinOptional: () => cabinState.value,
}))

vi.mock('../fleet/CockpitFleetProvider', () => ({
  useCockpitFleet: () => ({
    rows: [],
    counts: null,
    arrivals: [],
    loading: false,
    error: null,
    refetch: () => {},
  }),
}))

const CONTEXT: ContextUsageData = {
  categories: [{ name: '系统提示', tokens: 12000, color: '#D2A8FF' }],
  totalTokens: 12000,
  maxTokens: 200000,
  rawMaxTokens: 200000,
  percentage: 6,
  model: 'pro',
}

const CHAT = {
  model: 'pro',
  effort: 'high',
  contextWindow: '200k',
  streaming: false,
  queueDepth: 0,
  canSend: true,
  contextUsage: CONTEXT,
  usage: null,
  submit: vi.fn(),
  stop: vi.fn(),
  setModel: vi.fn(),
  setEffort: vi.fn(),
  setContext: vi.fn(),
} as unknown as CockpitChatApi

/** header / 容器里第一个可聚焦元素。 */
function focusables(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  )].filter((el) => !el.hasAttribute('disabled'))
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

function OpenWindow() {
  const { chatWindow } = useCockpitState()
  const openRef = useRef(chatWindow.set)
  openRef.current = chatWindow.set
  useEffect(() => {
    openRef.current({ open: true })
  }, [])
  return null
}

beforeEach(() => {
  cabinState.value = null
})

describe('关灯组：关闭按钮在左（DOM 顺序）', () => {
  it('聊天浮窗：✕ 是灯组第一颗，也是 header 第一个可聚焦元素', async () => {
    render(
      <CockpitStateProvider entryCabinId="c1">
        <OpenWindow />
        <CockpitChatWindow />
      </CockpitStateProvider>,
    )
    const root = await screen.findByTestId('cockpit-chat-window')
    await waitFor(() => expect(root.getAttribute('data-open')).toBe('true'))

    const close = screen.getByLabelText('关闭对话窗')
    expect(focusables(root)[0]).toBe(close)
    const lights = root.querySelector('.ck12-comms-lights')
    expect(lights?.firstElementChild).toBe(close)
    // classic 顺序 ✕ → — → 📌（图标版：关闭 / 收起 / 锁定，DOM 顺序即视觉顺序）
    expect([...(lights?.children ?? [])].map((el) => el.getAttribute('aria-label'))).toEqual([
      '关闭对话窗',
      '收起对话窗',
      '锁定位置',
    ])
  })

  it('作业面 header：✕ 是第一个可聚焦元素，也是 h1 的第一个子元素', () => {
    render(
      <CockpitJobHeader
        kind="task"
        title="接入支付宝"
        status="running"
        tab="overview"
        onClose={() => {}}
        onTabChange={() => {}}
      />,
    )
    const header = screen.getByTestId('cockpit-job-header')
    const close = screen.getByTestId('cockpit-job-close')
    expect(focusables(header)[0]).toBe(close)
    expect(header.querySelector('.ck12-jh-h1')?.firstElementChild).toBe(close)
  })

  it('编队抽屉：✕ 是 aside 第一个可聚焦元素，也是 header 第一个子元素', () => {
    cabinState.value = null
    render(
      <CockpitStateProvider entryCabinId="c1">
        <CockpitFleetRail />
      </CockpitStateProvider>,
    )
    const rail = screen.getByTestId('cockpit-fleet-rail')
    const close = screen.getByLabelText('收起编队')
    expect(focusables(rail)[0]).toBe(close)
    expect(rail.querySelector('.ck12-rail-h')?.firstElementChild).toBe(close)
  })

  it('上下文 popover：✕ 是弹层 header 第一个可聚焦元素', async () => {
    render(
      <CockpitStateProvider entryCabinId="c1">
        <CockpitContextPopover
          chat={CHAT}
          usage={null}
          usageStale={false}
          currency={{ currency: 'CNY', rate: 7 } as never}
        />
      </CockpitStateProvider>,
    )
    fireEvent.click(screen.getByTestId('ck12-rig-context'))
    const pop = await screen.findByTestId('ck12-rig-context-pop')
    const close = screen.getByTestId('ck12-rig-context-close')
    expect(focusables(pop)[0]).toBe(close)
    expect(pop.querySelector('.ck12-rig-pop-h')?.firstElementChild).toBe(close)
  })

  it('在场 popover：✕ 是弹层 header 第一个可聚焦元素', async () => {
    render(
      <CockpitContext.Provider value={makeCockpit()}>
        <CockpitStateProvider entryCabinId="c1">
          <CockpitPresencePopover />
        </CockpitStateProvider>
      </CockpitContext.Provider>,
    )
    fireEvent.click(screen.getByTestId('ck12-rig-presence'))
    const pop = await screen.findByTestId('ck12-rig-presence-pop')
    const close = screen.getByTestId('ck12-rig-presence-close')
    expect(focusables(pop)[0]).toBe(close)
    expect(pop.querySelector('.ck12-rig-pop-h')?.firstElementChild).toBe(close)
  })
})
