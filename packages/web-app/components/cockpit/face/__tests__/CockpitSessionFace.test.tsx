// 会话详情面（2026-11-25 用户）：六项基础页签、默认「对接」、任务书/结论、
// 子代理角标。数据请求全部 mock（不打真服务）。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { CabinDelegationView } from '@/lib/cabin-api'
import type { SubagentRunSummary } from '@/lib/agent/api'

vi.mock('@/lib/server-config', () => ({ getServerUrl: () => 'http://localhost:3001' }))
vi.mock('@/lib/billing-currency', () => ({
  useBillingCurrency: () => ({ currency: 'CNY', rate: 7 }),
}))
vi.mock('@/lib/cabin-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cabin-api')>()
  return { ...actual, getCabinFile: vi.fn(async () => ({ path: '', content: '' })) }
})
vi.mock('@/lib/agent/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agent/api')>()
  return {
    ...actual,
    listSessionSubagents: vi.fn(async () => ({ runs: [] })),
    getSessionRunning: vi.fn(async () => ({ background_tasks: [] })),
    listSessionBackgroundRuns: vi.fn(async () => ({ runs: [] })),
  }
})
vi.mock('@/lib/agent/debug-api', () => ({
  listSessionDebugTurns: vi.fn(async () => ({ session_id: 's-1', total: 0, turns: [] })),
  getSessionDebugTurn: vi.fn(),
}))

import { listSessionSubagents } from '@/lib/agent/api'
import { CockpitSessionFace } from '../CockpitSessionFace'

function delegation(over: Partial<CabinDelegationView> = {}): CabinDelegationView {
  return {
    id: 'd1',
    cabin_id: 'c1',
    title: '收银台对接',
    intent_text: '新旧接口的返回字段对一下，差异列给我。',
    brief: {
      goal: '给出差异清单',
      done_when: ['3 个新增字段', '2 个语义变更'],
      autonomy: 'checkpoint',
    },
    autonomy: 'checkpoint',
    state: 'running',
    doer_session_id: 's-9f2a1234',
    result_summary: null,
    created_at: '2026-11-25T09:38:00.000Z',
    updated_at: '2026-11-25T09:47:00.000Z',
    ended_at: null,
    handle: 'D1',
    color: 2,
    ...over,
  }
}

function subagentRun(over: Partial<SubagentRunSummary> = {}): SubagentRunSummary {
  return {
    id: 'sa-1',
    session_id: 's-9f2a1234',
    parent_tool_use_id: null,
    agent_type: 'Explore',
    description: '返回字段语义比对',
    prompt: null,
    status: 'completed',
    started_at: '2026-11-25T09:40:00.000Z',
    ended_at: '2026-11-25T09:42:00.000Z',
    summary: null,
    model: 'qwen3.7-plus',
    input_tokens: 1000,
    output_tokens: 500,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    tool_uses: 3,
    duration_ms: 120_000,
    step_count: 4,
    cost_usd: 0.02,
    cost_complete: 1,
    ...over,
  }
}

beforeEach(() => {
  vi.mocked(listSessionSubagents).mockResolvedValue({ runs: [] })
})

describe('CockpitSessionFace — 会话六页签', () => {
  it('页签固定六项（对接 / 文件 / 运行 / 调试 / 消耗 / 子代理），首签「对接」', async () => {
    render(
      <CockpitSessionFace
        cabinId="c1"
        delegation={delegation()}
        cabinName="账务核心"
        tab="relay"
        onTabChange={() => {}}
        onClose={() => {}}
      />,
    )
    for (const label of ['对接', '文件', '运行', '调试', '消耗', '子代理']) {
      expect(screen.getByRole('tab', { name: new RegExp(`^${label}`) })).toBeInTheDocument()
    }
    expect(screen.queryByTestId('cockpit-tab-changes')).toBeNull()
    expect(screen.queryByTestId('cockpit-tab-accept')).toBeNull()
    expect(screen.queryByTestId('cockpit-tab-archive')).toBeNull()
    expect(screen.queryByTestId('cockpit-tab-project')).toBeNull()
    expect(screen.getByTestId('cockpit-tab-relay')).toHaveAttribute('aria-selected', 'true')
    // 副行：舱名 · 会话 <短 id>
    expect(screen.getByTestId('cockpit-job-header').textContent).toContain('账务核心 · 会话 s-9f2a12')
    await screen.findByTestId('cockpit-session-relay')
  })

  it('对接页签：派发原文 + 任务书 + 结论；「去会话对话」回调打开 chat 窗', async () => {
    const onOpenChat = vi.fn()
    render(
      <CockpitSessionFace
        cabinId="c1"
        delegation={delegation({ result_summary: '差异清单：3 新增 / 2 语义变更' })}
        tab="relay"
        onTabChange={() => {}}
        onClose={() => {}}
        onOpenChat={onOpenChat}
      />,
    )
    expect(screen.getByTestId('cockpit-session-intent').textContent).toContain('返回字段')
    expect(screen.getByTestId('cockpit-session-brief').textContent).toContain('给出差异清单')
    expect(screen.getByTestId('cockpit-session-brief').textContent).toContain('3 个新增字段')
    expect(screen.getByTestId('cockpit-session-result').textContent).toContain('3 新增 / 2 语义变更')
    fireEvent.click(screen.getByTestId('cockpit-session-chat'))
    expect(onOpenChat).toHaveBeenCalledTimes(1)
    await screen.findByTestId('cockpit-session-relay')
  })

  it('落到任务口径页签（changes / accept / archive / project）时兜回「对接」', async () => {
    render(
      <CockpitSessionFace
        cabinId="c1"
        delegation={delegation()}
        tab="changes"
        onTabChange={() => {}}
        onClose={() => {}}
      />,
    )
    expect(screen.getByTestId('cockpit-tab-relay')).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByTestId('cockpit-tab-changes')).toBeNull()
    await screen.findByTestId('cockpit-session-relay')
  })

  it('点页签走受控回调；子代理角标 = 本会话活动条数', async () => {
    vi.mocked(listSessionSubagents).mockResolvedValue({ runs: [subagentRun()] })
    const onTabChange = vi.fn()
    render(
      <CockpitSessionFace
        cabinId="c1"
        delegation={delegation()}
        tab="relay"
        onTabChange={onTabChange}
        onClose={() => {}}
      />,
    )
    fireEvent.click(screen.getByTestId('cockpit-tab-usage'))
    expect(onTabChange).toHaveBeenCalledWith('usage')
    fireEvent.click(screen.getByTestId('cockpit-tab-agents'))
    expect(onTabChange).toHaveBeenCalledWith('agents')

    await waitFor(() => {
      expect(screen.getByTestId('cockpit-tab-agents').querySelector('.n')?.textContent).toBe('1')
    })
  })

  it('子代理页签：空会话活动给明确空态', async () => {
    render(
      <CockpitSessionFace
        cabinId="c1"
        delegation={delegation()}
        tab="agents"
        onTabChange={() => {}}
        onClose={() => {}}
      />,
    )
    expect(await screen.findByTestId('cockpit-job-agents-empty')).toBeInTheDocument()
  })

  it('载入态：委派还没接上时画载入头（关闭仍是第一可聚焦元素）', () => {
    const { container } = render(
      <CockpitSessionFace
        cabinId="c1"
        delegation={null}
        tab="relay"
        onTabChange={() => {}}
        onClose={() => {}}
      />,
    )
    expect(container.textContent).toContain('载入会话')
    expect(screen.getByTestId('cockpit-job-close')).toBeInTheDocument()
  })
})

// v23（2026-11-27 用户）：人自开的会话与汐音委派同一本账（origin=user）——
// 同一张六页签面；「对接」只留第一条原话（没有任务书），提示这不是汐音派的。
describe('CockpitSessionFace — 人自开会话（origin=user）', () => {
  it('六页签同形、默认落「对接」；只有原话、没有任务书', async () => {
    render(
      <CockpitSessionFace
        cabinId="c1"
        delegation={delegation({
          origin: 'user',
          title: '整理限流阈值',
          intent_text: '帮我整理一下限流阈值',
          brief: null,
          autonomy: 'checkpoint',
        })}
        cabinName="账务核心"
        tab="relay"
        onTabChange={() => {}}
        onClose={() => {}}
      />,
    )
    for (const label of ['对接', '文件', '运行', '调试', '消耗', '子代理']) {
      expect(screen.getByRole('tab', { name: new RegExp(`^${label}`) })).toBeInTheDocument()
    }
    expect(screen.queryByTestId('cockpit-tab-accept')).toBeNull()
    expect(screen.getByTestId('cockpit-tab-relay')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('cockpit-job-header').textContent).toContain('整理限流阈值')

    const relay = await screen.findByTestId('cockpit-session-relay')
    expect(relay.textContent).toContain('你自己开的')
    expect(screen.getByTestId('cockpit-session-intent').textContent).toContain('限流阈值')
    expect(screen.queryByTestId('cockpit-session-brief')).toBeNull()
  })

  it('「去会话对话」：走 onOpenChat（回到它自己的独立 chat 窗）', async () => {
    const onOpenChat = vi.fn()
    render(
      <CockpitSessionFace
        cabinId="c1"
        delegation={delegation({ origin: 'user', brief: null })}
        tab="relay"
        onTabChange={() => {}}
        onClose={() => {}}
        onOpenChat={onOpenChat}
      />,
    )
    fireEvent.click(await screen.findByTestId('cockpit-session-chat'))
    expect(onOpenChat).toHaveBeenCalledTimes(1)
  })
})
