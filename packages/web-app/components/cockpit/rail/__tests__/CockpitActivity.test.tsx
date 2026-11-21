// 右栏「活动」（v22 十四轮 · 2026-11-21 用户）：
//   · 有运行中的子代理 / 后台作业才出按钮，徽标 = 运行中总数；
//   · 点开 = inbox 同款浮层（子代理 / 后台作业两组）；
//   · 点一条 → 左侧大详情窗；子代理复用作业坞 SubagentWindow（指令 / 日志 / token）；
//   · Esc 先收详情，再收浮层。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { BackgroundTaskInfo, SubagentRunSummary } from '@/lib/agent/api'
import { CockpitStateProvider } from '../../state/CockpitStateProvider'
import { CockpitLayerStack } from '../../state/CockpitLayerStack'
import { CockpitRightRail } from '../CockpitRightRail'
import { CockpitActivityProvider } from '../activity-feed'
import { CockpitActivityWindow } from '../CockpitActivityWindow'

const api = vi.hoisted(() => ({
  listSessionSubagents: vi.fn(),
  getSessionRunning: vi.fn(),
  getSessionSubagent: vi.fn(),
}))

vi.mock('@/lib/agent/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agent/api')>()
  return { ...actual, ...api }
})

vi.mock('@/components/cabin/cabin-provider', () => ({
  useCabinOptional: () => ({
    cabinId: 'c1',
    cabin: { name: '舱一', main_session_id: 'sess-main', cwd_git: false },
  }),
}))

vi.mock('@/lib/billing-currency', () => ({
  useBillingCurrency: () => ({ currency: 'USD', rate: 1 }),
}))

vi.mock('../../fleet/CockpitFleetProvider', () => ({
  useCockpitFleet: () => ({
    rows: [],
    mainSessionId: 'sess-main',
    counts: null,
    arrivals: [],
    loading: false,
    error: null,
    refetch: () => {},
  }),
}))

vi.mock('../../chat/use-cockpit-threads', () => ({
  useCockpitThreads: () => ({
    threads: [],
    byKey: new Map(),
    active: { key: 'main', kind: 'main', ref: null, short: '主对话', state: 'queue' },
    visible: [],
  }),
}))

vi.mock('sonner', () => ({ toast: vi.fn() }))

function run(over: Partial<SubagentRunSummary> = {}): SubagentRunSummary {
  return {
    id: 'sa-1',
    session_id: 'sess-main',
    parent_tool_use_id: null,
    agent_type: 'Explore',
    description: '对账差异定位',
    prompt: '在 ledger 项目里定位 M2 结算对账的金额差异。只读，不改文件。',
    status: 'running',
    started_at: new Date(Date.now() - 62_000).toISOString(),
    ended_at: null,
    summary: null,
    model: 'qwen3.7-plus',
    input_tokens: 1_200,
    output_tokens: 800,
    cache_read_tokens: 400,
    cache_creation_tokens: 0,
    tool_uses: 2,
    duration_ms: null,
    step_count: 4,
    cost_usd: 0.01,
    cost_complete: 1,
    ...over,
  }
}

const BG: BackgroundTaskInfo = {
  id: 'bg-1',
  description: 'pnpm vitest run src/settlement',
  taskType: 'local_bash',
}

function ui() {
  return (
    <CockpitStateProvider entryCabinId="c1">
      <CockpitLayerStack>
        <CockpitActivityProvider>
          <CockpitRightRail />
          <CockpitActivityWindow />
        </CockpitActivityProvider>
      </CockpitLayerStack>
    </CockpitStateProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  api.listSessionSubagents.mockResolvedValue({ runs: [] })
  api.getSessionRunning.mockResolvedValue({ running: true, partial: false, background_tasks: [] })
  api.getSessionSubagent.mockResolvedValue({
    run: {
      ...run(),
      steps: [
        { kind: 'thinking', text: '先看 reconcile.test.ts 的失败断言。' },
        { kind: 'tool_use', toolUseId: 't1', toolName: 'Bash', input: { command: 'pnpm vitest run src/settlement' } },
        { kind: 'tool_result', toolUseId: 't1', content: '3 failed · expected 1 got 2' },
      ],
    },
  })
})

describe('CockpitRightRail · 活动', () => {
  it('运行中的子代理 / 后台作业 → 按钮带计数，点开是 inbox 同款浮层', async () => {
    api.listSessionSubagents.mockResolvedValue({
      runs: [run(), run({ id: 'sa-done', status: 'completed', ended_at: new Date().toISOString() })],
    })
    api.getSessionRunning.mockResolvedValue({
      running: true,
      partial: false,
      background_tasks: [BG],
    })
    render(ui())

    const button = await screen.findByTestId('cockpit-menu-activity')
    expect(button).toHaveTextContent('活动')
    expect(await screen.findByTestId('cockpit-menu-activity-count')).toHaveTextContent('2')

    fireEvent.click(button)
    const pop = screen.getByTestId('cockpit-activity-popover')
    expect(pop).toHaveTextContent('子代理')
    expect(pop).toHaveTextContent('后台作业')
    expect(pop.querySelector('.ck12-ip-total')).toHaveTextContent('2')
    expect(pop).toHaveTextContent('子代理 1/2 · 后台 1')

    expect(within(pop).getByTestId('cockpit-activity-row-subagent-sa-1')).toHaveTextContent('对账差异定位')
    expect(within(pop).getByTestId('cockpit-activity-row-background-bg-1')).toHaveTextContent(BG.description)
  })

  it('点运行中的子代理 → 左侧大窗复用作业坞 SubagentWindow；Esc 先收详情再收浮层', async () => {
    api.listSessionSubagents.mockResolvedValue({ runs: [run()] })
    render(ui())

    await screen.findByTestId('cockpit-menu-activity-count')
    fireEvent.click(screen.getByTestId('cockpit-menu-activity'))
    fireEvent.click(screen.getByTestId('cockpit-activity-row-subagent-sa-1'))

    const win = await screen.findByTestId('cockpit-activity-window')
    expect(win).toHaveTextContent('活动详情')
    expect(win).toHaveTextContent('子代理 · 运行中 · 只读')
    expect(win.className).toContain('ck12-actwin')

    const sub = await screen.findByTestId('subagent-window')
    await waitFor(() => expect(sub).toHaveTextContent('主 Agent 的指令'))
    expect(sub).toHaveTextContent('在 ledger 项目里定位 M2')
    expect(api.getSessionSubagent).toHaveBeenCalledWith('sess-main', 'sa-1')
    // 一级浮层仍在，选中的行高亮。
    const pop = screen.getByTestId('cockpit-activity-popover')
    expect(pop.className).toContain('is-detail')
    expect(pop.querySelector('[data-testid="cockpit-activity-row-subagent-sa-1"]')?.className).toContain('is-on')

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('cockpit-activity-window')).toBeNull())
    expect(screen.getByTestId('cockpit-activity-popover')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('cockpit-activity-popover')).toBeNull())
  })

  it('点后台作业 → 详情给启动命令；不伪造终端输出', async () => {
    api.listSessionSubagents.mockResolvedValue({ runs: [] })
    api.getSessionRunning.mockResolvedValue({
      running: true,
      partial: false,
      background_tasks: [BG],
    })
    render(ui())

    await screen.findByTestId('cockpit-menu-activity-count')
    fireEvent.click(screen.getByTestId('cockpit-menu-activity'))
    fireEvent.click(screen.getByTestId('cockpit-activity-row-background-bg-1'))

    const win = await screen.findByTestId('cockpit-activity-window')
    expect(win).toHaveTextContent('后台作业 · 运行中 · 只读')
    expect(win).toHaveTextContent('⌁ 启动命令')
    expect(win).toHaveTextContent(BG.description)
    expect(win).toHaveTextContent('run_in_background')
    expect(win).toHaveTextContent('服务端不存终端输出')
    expect(screen.queryByTestId('subagent-window')).toBeNull()
  })

  it('只有后台作业在跑也能出按钮（活动不限于子代理）', async () => {
    api.getSessionRunning.mockResolvedValue({
      running: true,
      partial: false,
      background_tasks: [BG],
    })
    render(ui())

    const button = await screen.findByTestId('cockpit-menu-activity')
    expect(await screen.findByTestId('cockpit-menu-activity-count')).toHaveTextContent('1')
    fireEvent.click(button)
    const pop = screen.getByTestId('cockpit-activity-popover')
    expect(pop).toHaveTextContent('子代理 0/0 · 后台 1')
    expect(pop).toHaveTextContent('本会话还没有子代理')
  })

  it('没有运行中活动（只有已结束子代理）→ 按钮常住，点开还能回看已结束的子代理', async () => {
    api.listSessionSubagents.mockResolvedValue({
      runs: [run({ id: 'sa-old', status: 'completed', ended_at: new Date().toISOString() })],
    })
    render(ui())

    const button = await screen.findByTestId('cockpit-menu-activity')
    expect(screen.queryByTestId('cockpit-menu-activity-count')).toBeNull()
    fireEvent.click(button)

    expect(await screen.findByTestId('cockpit-activity-row-subagent-sa-old')).toHaveTextContent('已完成')
    expect(screen.getByTestId('cockpit-activity-popover')).toHaveTextContent('没有后台程序在跑')
  })

  it('完全没有活动 → 按钮常住，点开是空态而不是什么都不发生', async () => {
    render(ui())

    const button = await screen.findByTestId('cockpit-menu-activity')
    expect(screen.queryByTestId('cockpit-menu-activity-count')).toBeNull()
    fireEvent.click(button)

    const pop = screen.getByTestId('cockpit-activity-popover')
    expect(pop).toHaveTextContent('本会话还没有子代理')
    expect(pop).toHaveTextContent('没有后台程序在跑')
    expect(pop).toHaveTextContent('当前没有后台活动')
  })
})
