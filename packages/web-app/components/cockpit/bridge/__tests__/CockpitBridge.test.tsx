// S6 · 舰桥 RTL：
//   · chat === null → 每项「未就绪」并禁用（不是 `--`）；
//   · 读数来自 S5 telemetry（model / contextUsage / usage）与 getCabinUsage；
//   · 上下文弹层：构成 + 本舱按主体 + 「压缩上下文」走真的 submit('/compact')；
//   · getCabinUsage 失败保留上一次成功值（useCabinUsage）；
//   · 弹层打开时 Esc 由 bridge-pop（priority 90）先收，不落到聊天浮窗 / 作业面；
//   · ⌘⇧M 循环三个真别名，单独按 m 不抢输入。
//
// 数据全部来自 fixture 或 mock，不触网。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { useEffect, type ReactNode } from 'react'
import type { LlmUsageAggregates } from '@octopus/shared'
import type { ContextUsageData } from '@/lib/agent/types'
import type { CabinUsagePayload } from '@/lib/cabin-api'
import {
  CockpitContext,
  type CockpitContextValue,
} from '@/components/cabin/CockpitProvider'
import { DEFAULT_COCKPIT } from '@/components/cabin/cockpit'
import { CockpitStateProvider, useCockpitState } from '../../state/CockpitStateProvider'
import { CockpitLayerStack } from '../../state/CockpitLayerStack'
import type { CockpitChatApi } from '../../state/cockpit-state'
import { CockpitBridge } from '../CockpitBridge'
import { nextBridgeModel } from '../rig-model'
import { useCabinUsage } from '../use-cabin-usage'

vi.mock('@/lib/cabin-audio', () => ({
  cabinAudio: { blip: vi.fn(), chime: vi.fn(), setOn: vi.fn(), resume: vi.fn() },
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

vi.mock('@/lib/billing-currency', () => ({
  useBillingCurrency: () => ({ currency: 'CNY', rate: 7 }),
}))

vi.mock('@/lib/cabin-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cabin-api')>()
  return { ...actual, getCabinUsage: vi.fn() }
})

import { getCabinUsage } from '@/lib/cabin-api'
import { toast } from 'sonner'

const getUsageMock = vi.mocked(getCabinUsage)

const CONTEXT: ContextUsageData = {
  categories: [
    { name: '系统提示', tokens: 12000, color: '#D2A8FF' },
    { name: '线程历史', tokens: 42000, color: '#4FD1D9' },
  ],
  totalTokens: 84000,
  maxTokens: 200000,
  rawMaxTokens: 200000,
  percentage: 42,
  model: 'pro',
}

const USAGE: LlmUsageAggregates = {
  totalCalls: 42,
  usage: { inputTokens: 12400, outputTokens: 3100, cacheReadTokens: 0, cacheCreationTokens: 0 },
  totals: { tokens: 15500, cost: { usd: 0.5, complete: true }, cacheHitRate: null },
  modelBreakdown: {},
}

const ZERO = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }

function cabinUsage(): CabinUsagePayload {
  return {
    summary: {
      totalCalls: 4,
      usage: ZERO,
      totals: { tokens: 0, cost: { usd: null, complete: true }, cacheHitRate: null },
    },
    byJob: [
      {
        job_id: 'j1',
        kind: 'task',
        label: '任务 A',
        ref_id: 't1',
        totalCalls: 3,
        usage: { ...ZERO, inputTokens: 1000 },
        totals: { tokens: 1000, cost: { usd: 0.5, complete: true }, cacheHitRate: null },
      },
    ],
    subagents: {
      count: 1,
      usage: { ...ZERO, inputTokens: 200 },
      tokens: 200,
      cost: { usd: 0.1, complete: true },
      runs: [],
    },
    grand: {
      totalCalls: 42,
      usage: { ...ZERO, inputTokens: 12400, outputTokens: 3100 },
      totals: { tokens: 15500, cost: { usd: 1.28, complete: true }, cacheHitRate: null },
    },
    timing: { duration_ms: 12 },
  }
}

function chatApi(over: Partial<CockpitChatApi> = {}): CockpitChatApi {
  return {
    model: 'pro',
    effort: 'high',
    contextWindow: '200k',
    streaming: false,
    queueDepth: 0,
    canSend: true,
    contextUsage: CONTEXT,
    usage: USAGE,
    submit: vi.fn(),
    stop: vi.fn(),
    setModel: vi.fn(),
    setEffort: vi.fn(),
    setContext: vi.fn(),
    ...over,
  }
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

function ChatSeeder({ api }: { api: CockpitChatApi | null }) {
  const { reportChat } = useCockpitState()
  useEffect(() => {
    reportChat(api)
  }, [api, reportChat])
  return null
}

/** 低优先级层：证明 Esc 先收 popover，再轮到下面。 */
function LowerLayer({ onClose }: { onClose: () => void }) {
  const { layer } = useCockpitState()
  useEffect(() => layer.register('lower-layer', 10, onClose), [layer, onClose])
  return null
}

/** 直接调 closeTop：不依赖 Radix 的 document 键盘监听，验证 bridge-pop 的注册与优先级。 */
function CloseTopProbe() {
  const { layer } = useCockpitState()
  return (
    <button type="button" data-testid="close-top" onClick={() => layer.closeTop()}>
      close-top
    </button>
  )
}

async function renderBridge({
  api,
  cockpit = makeCockpit(),
  onLowerClose = () => {},
}: {
  api: CockpitChatApi | null
  cockpit?: CockpitContextValue
  onLowerClose?: () => void
}) {
  const view = render(
    <CockpitContext.Provider value={cockpit}>
      <CockpitStateProvider entryCabinId="c1">
        <CockpitLayerStack>
          <ChatSeeder api={api} />
          <CockpitBridge />
          <LowerLayer onClose={onLowerClose} />
          <CloseTopProbe />
        </CockpitLayerStack>
      </CockpitStateProvider>
    </CockpitContext.Provider>,
  )
  // 让 useCabinUsage 的首次 30s 轮询 promise 在 act 内落定，避免测试噪声。
  await act(async () => {
    await Promise.resolve()
  })
  return view
}

async function openContext() {
  fireEvent.click(screen.getByTestId('ck12-rig-context'))
  return screen.findByTestId('ck12-rig-context-pop')
}

beforeEach(() => {
  vi.clearAllMocks()
  getUsageMock.mockResolvedValue(cabinUsage())
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('CockpitBridge · 未就绪', () => {
  it('chat === null 时每项都显示「未就绪」并禁用，不用 -- 占位', async () => {
    await renderBridge({ api: null })

    expect(screen.getByTestId('ck12-rig-model-off')).toBeDisabled()
    expect(screen.getByTestId('ck12-rig-context-off')).toBeDisabled()
    expect(screen.getByTestId('ck12-rig-presence-off')).toBeDisabled()
    expect(screen.getByTestId('ck12-rig-tokens-off')).toHaveTextContent(/↑\s*未就绪\s*↓\s*未就绪/)
    expect(screen.getByTestId('ck12-rig-cost-off')).toHaveTextContent(/未就绪/)
    expect(screen.queryByText('--')).toBeNull()
    // 未就绪时不渲染任何 popover 触发器。
    expect(screen.queryByTestId('ck12-rig-context')).toBeNull()
    expect(screen.queryByTestId('ck12-rig-presence')).toBeNull()
  })
})

describe('CockpitBridge · 读数来自 telemetry', () => {
  it('模型 / 上下文 / token / 本舱 ¥ 都取真值', async () => {
    await renderBridge({ api: chatApi() })

    await waitFor(() => {
      expect(screen.getByTestId('ck12-rig-tokens')).toHaveTextContent(/↑\s*12\.4K\s*↓\s*3\.1K/)
    })
    expect(screen.getByTestId('ck12-rig-tokens')).toHaveTextContent('回合结束更新')
    expect(screen.getByTestId('ck12-rig-model')).toHaveTextContent('pro')
    expect(screen.getByTestId('ck12-rig-context')).toHaveTextContent(/42%/)
    // getCabinUsage 的 USD → 展示币种换算（hook 返回 CNY / 7）。
    await waitFor(() => {
      expect(screen.getByTestId('ck12-rig-cost')).toHaveTextContent(/¥8\.96/)
    })
  })

  it('token 缺失时显示「—」，不编 0', async () => {
    await renderBridge({ api: chatApi({ usage: null, contextUsage: null }) })

    await waitFor(() => {
      expect(screen.getByTestId('ck12-rig-tokens')).toHaveTextContent(/↑\s*—\s*↓\s*—/)
    })
    expect(screen.getByTestId('ck12-rig-context')).toHaveTextContent('未就绪')
  })
})

describe('CockpitBridge · 上下文弹层', () => {
  it('构成 / 本舱按主体 / 子代理单列，压缩走 submit(\'/compact\') 且不伪造本地变化', async () => {
    const api = chatApi()
    await renderBridge({ api })
    const pop = await openContext()

    expect(within(pop).getByText(/系统提示/)).toBeInTheDocument()
    expect(within(pop).getByText(/线程历史/)).toBeInTheDocument()
    expect(within(pop).getByTestId('ck12-rig-usage-rows')).toHaveTextContent('任务 A')
    expect(within(pop).getByTestId('ck12-rig-usage-subagents')).toHaveTextContent('子代理 · 1')
    expect(within(pop).getByTestId('ck12-rig-context-note')).toHaveTextContent('回合结束更新')

    fireEvent.click(within(pop).getByTestId('ck12-rig-compact'))

    expect(api.submit).toHaveBeenCalledTimes(1)
    expect(api.submit).toHaveBeenCalledWith('/compact')
    expect(toast.success).toHaveBeenCalledWith('已请汐音压缩上下文')
    // 不伪造本地数字：上下文读数保持 telemetry 原值。
    expect(screen.getByTestId('ck12-rig-context')).toHaveTextContent(/42%/)
    await waitFor(() => expect(screen.queryByTestId('ck12-rig-context-pop')).toBeNull())
  })
})

describe('CockpitBridge · Esc 层栈', () => {
  it('bridge-pop 以 priority 90 注册：layer.closeTop 先收弹层，不落到下层', async () => {
    const lowerClose = vi.fn()
    await renderBridge({ api: chatApi(), onLowerClose: lowerClose })
    await openContext()

    fireEvent.click(screen.getByTestId('close-top'))

    await waitFor(() => expect(screen.queryByTestId('ck12-rig-context-pop')).toBeNull())
    expect(lowerClose).not.toHaveBeenCalled()
  })

  it('Radix 弹层打开时 Esc 先收弹层，再轮到下层', async () => {
    const lowerClose = vi.fn()
    await renderBridge({ api: chatApi(), onLowerClose: lowerClose })
    const pop = await openContext()

    // 真实浏览器里 Esc 的目标是弹层内聚焦元素；Radix 在 document 上收键，
    // CockpitLayerStack 在 Radix 弹层打开时会让行（isRadixLayerOpen）。
    fireEvent.keyDown(pop, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByTestId('ck12-rig-context-pop')).toBeNull())
    expect(lowerClose).not.toHaveBeenCalled()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(lowerClose).toHaveBeenCalledTimes(1)
  })
})

describe('CockpitBridge · ⌘⇧M', () => {
  it('循环三个别名；单独按 m 不抢输入', async () => {
    const api = chatApi({ model: 'pro' })
    await renderBridge({ api })
    await waitFor(() => expect(screen.getByTestId('ck12-rig-model')).toBeInTheDocument())

    fireEvent.keyDown(window, { key: 'm', metaKey: true, shiftKey: true })
    expect(api.setModel).toHaveBeenCalledWith('se')

    fireEvent.keyDown(window, { key: 'm' })
    expect(api.setModel).toHaveBeenCalledTimes(1)

    expect(nextBridgeModel('se')).toBe('pro-max')
    expect(nextBridgeModel('pro-max')).toBe('pro')
    expect(nextBridgeModel('unknown-model')).toBe('pro-max')
  })
})

describe('CockpitBridge · 在场', () => {
  it('开关 / 真实分钟频率 / 现在说一句都写回 CockpitProvider', async () => {
    const cockpit = makeCockpit()
    await renderBridge({ api: chatApi(), cockpit })

    fireEvent.click(screen.getByTestId('ck12-rig-presence'))
    const pop = await screen.findByTestId('ck12-rig-presence-pop')

    expect(pop).toHaveTextContent('12–24 分钟')
    expect(pop).toHaveTextContent('6–16 分钟')
    expect(pop).toHaveTextContent('3–8 分钟')

    fireEvent.click(within(pop).getByTestId('ck12-rig-presence-switch'))
    expect(cockpit.setPref).toHaveBeenCalledWith('presenceOn', false)

    fireEvent.click(within(pop).getByTestId('ck12-rig-rate-active'))
    expect(cockpit.setPref).toHaveBeenCalledWith('presenceRate', 'active')

    fireEvent.click(within(pop).getByTestId('ck12-rig-presence-say'))
    expect(cockpit.testPresence).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByTestId('ck12-rig-presence-pop')).toBeNull())
  })
})

describe('useCabinUsage', () => {
  it('失败保留上一次成功值，并把 stale 置真', async () => {
    getUsageMock.mockReset()
    getUsageMock
      .mockResolvedValueOnce(cabinUsage())
      .mockRejectedValue(new Error('usage down'))

    // 200ms 轮询：第一次成功与下一次失败的断言之间不会抢跑。
    const { result, unmount } = renderHook(() => useCabinUsage('c1', 200))

    await waitFor(() => expect(result.current.usage).not.toBeNull())
    expect(result.current.usage?.grand.totals.cost.usd).toBe(1.28)
    expect(result.current.stale).toBe(false)

    // 让下一次 30s→200ms 轮询失败：旧值仍在，不被清空。
    await waitFor(() => expect(result.current.stale).toBe(true))
    expect(result.current.usage?.grand.totals.cost.usd).toBe(1.28)

    unmount()
  })
})
