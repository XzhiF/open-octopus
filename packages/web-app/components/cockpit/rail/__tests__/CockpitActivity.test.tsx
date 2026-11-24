// 右栏「活动」（v22 十四轮 · 2026-11-21 用户）：
//   · 有运行中的子代理 / 后台作业才出按钮，徽标 = 运行中总数；
//   · 点开 = inbox 同款浮层（子代理 / 后台作业两组）；
//   · 点一条 → 左侧大详情窗；子代理复用作业坞 SubagentWindow（指令 / 日志 / token）；
//   · Esc 先收详情，再收浮层。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { BackgroundRunInfo, BackgroundTaskInfo, SubagentRunSummary } from '@/lib/agent/api'
import { CockpitStateProvider } from '../../state/CockpitStateProvider'
import { CockpitLayerStack } from '../../state/CockpitLayerStack'
import { CockpitRightRail } from '../CockpitRightRail'
import { CockpitActivityProvider } from '../activity-feed'
import { CockpitActivityWindow } from '../CockpitActivityWindow'
import { CockpitActivityLogWindow } from '../CockpitActivityLogWindow'
import { resetActivityLog, setActivityLogOpen } from '../activity-log-store'

const api = vi.hoisted(() => ({
  listSessionSubagents: vi.fn(),
  getSessionRunning: vi.fn(),
  getSessionSubagent: vi.fn(),
  listSessionBackgroundRuns: vi.fn(),
  getBackgroundOutput: vi.fn(),
  stopBackgroundTask: vi.fn(),
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
  resetActivityLog()
  api.listSessionSubagents.mockResolvedValue({ runs: [] })
  api.getSessionRunning.mockResolvedValue({ running: true, partial: false, background_tasks: [] })
  api.listSessionBackgroundRuns.mockResolvedValue({ runs: [] })
  api.getBackgroundOutput.mockResolvedValue({
    output: '[web] ➜  Local:   http://localhost:3000/\n[server] listening on :3001\n[server] SQLite ready',
    total_bytes: 96,
    truncated: false,
    source: 'live',
  })
  api.stopBackgroundTask.mockResolvedValue({ success: true })
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
    expect(pop).toHaveTextContent('子代理 1/2 · 后台 1/1')

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

  it('点后台作业 → 启动命令 / 识别端口 / 日志尾 / 停止作业（二次确认）', async () => {
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
    // 2026-11-24 用户 #1：日志尾从 SDK 实时读，端口从输出识别。
    expect(await screen.findByTestId('cockpit-act-output')).toHaveTextContent('listening on')
    expect(win).toHaveTextContent('localhost:3001')
    expect(screen.queryByTestId('subagent-window')).toBeNull()

    // 停止作业：先出确认层，确认后才真的调服务端。
    fireEvent.click(screen.getByTestId('cockpit-act-stop'))
    fireEvent.click(await screen.findByTestId('cockpit-act-stop-confirm'))
    await waitFor(() => expect(api.stopBackgroundTask).toHaveBeenCalledWith('sess-main', 'bg-1'))
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
    expect(pop).toHaveTextContent('子代理 0/0 · 后台 1/1')
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

function bgRow(over: Partial<BackgroundRunInfo> = {}): BackgroundRunInfo {
  return {
    id: 'row-1',
    session_id: 'sess-main',
    task_id: 'bg-1',
    run_id: 'r1',
    description: BG.description,
    task_type: 'local_bash',
    status: 'running',
    summary: null,
    output_file: null,
    started_at: new Date(Date.now() - 150_000).toISOString(),
    ended_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...over,
  }
}

function logUi() {
  return (
    <CockpitStateProvider entryCabinId="c1">
      <CockpitLayerStack>
        <CockpitActivityProvider>
          <CockpitActivityLogWindow />
        </CockpitActivityProvider>
      </CockpitLayerStack>
    </CockpitStateProvider>
  )
}

describe('more → 活动日志大窗（2026-11-24 用户 #1）', () => {
  it('运行中置顶 + 已结束留档；筛选与搜索；Esc 关窗', async () => {
    api.getSessionRunning.mockResolvedValue({
      running: true,
      partial: false,
      background_tasks: [BG],
    })
    api.listSessionBackgroundRuns.mockResolvedValue({
      runs: [
        bgRow(),
        bgRow({
          id: 'row-2',
          task_id: 'bg-old',
          run_id: 'r2',
          description: 'docker compose up',
          status: 'completed',
          summary: 'exit 0',
          ended_at: new Date(Date.now() - 60_000).toISOString(),
        }),
        bgRow({
          id: 'row-3',
          task_id: 'bg-fail',
          run_id: 'r3',
          description: 'pnpm build',
          status: 'failed',
          ended_at: new Date(Date.now() - 30_000).toISOString(),
        }),
      ],
    })

    setActivityLogOpen(true)
    render(logUi())

    const list = await screen.findByTestId('cockpit-actlog-list')
    await waitFor(() => expect(list).toHaveTextContent('docker compose up'))
    expect(list).toHaveTextContent(BG.description)
    expect(list).toHaveTextContent('已完成')
    expect(list).toHaveTextContent('失败')
    // 运行中置顶：第一条是 pnpm vitest…（bg-1）。
    const rows = [...list.querySelectorAll<HTMLElement>('[data-testid^="cockpit-actlog-row-"]')]
    expect(rows[0].textContent).toContain(BG.description.trim())

    // 搜索 docker → 只剩已结束那一条。
    fireEvent.change(screen.getByTestId('cockpit-actlog-search'), { target: { value: 'docker' } })
    await waitFor(() => expect(list).not.toHaveTextContent(BG.description))

    // 点选中行 → 右侧详情读 output 文件留档（已结束）。
    fireEvent.click(screen.getByTestId('cockpit-actlog-row-background-bg-old'))
    const detail = await screen.findByTestId('cockpit-actlog-detail')
    expect(detail).toHaveTextContent('已结束 · 留档只读')
    expect(await screen.findByTestId('cockpit-act-output')).toHaveTextContent('listening on')

    // Esc 关窗。
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('cockpit-activity-log')).toBeNull())
  })

  it('筛选「子代理」：只剩子代理行', async () => {
    api.listSessionSubagents.mockResolvedValue({
      runs: [run({ id: 'sa-1', description: '对账差异定位' })],
    })
    api.getSessionRunning.mockResolvedValue({
      running: true,
      partial: false,
      background_tasks: [BG],
    })
    api.listSessionBackgroundRuns.mockResolvedValue({ runs: [bgRow()] })

    setActivityLogOpen(true)
    render(logUi())

    const list = await screen.findByTestId('cockpit-actlog-list')
    await waitFor(() => expect(list).toHaveTextContent('对账差异定位'))
    expect(list).toHaveTextContent(BG.description)

    fireEvent.click(screen.getByTestId('cockpit-actlog-filter-subagent'))
    await waitFor(() => expect(list).not.toHaveTextContent(BG.description))
    expect(list).toHaveTextContent('对账差异定位')
  })
})
