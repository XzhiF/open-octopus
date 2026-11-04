import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SubagentRunSummary } from '@/lib/agent/api'
import { SubagentListPane } from '../subagent-list-pane'

const run = (overrides: Partial<SubagentRunSummary> = {}): SubagentRunSummary => ({
  id: 'agent-1',
  session_id: 'sess-1',
  parent_tool_use_id: 'tu-1',
  agent_type: 'general-purpose',
  description: '审查登录模块',
  prompt: '审查登录模块的鉴权边界',
  status: 'running',
  started_at: new Date(Date.now() - 5_000).toISOString(),
  ended_at: null,
  summary: null,
  model: 'deepseek-v4-flash',
  input_tokens: 1_200,
  output_tokens: 300,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  tool_uses: 3,
  duration_ms: null,
  step_count: 5,
  ...overrides,
})

afterEach(cleanup)

describe('SubagentListPane — 作业坞子代理列表', () => {
  it('运行中置顶、完成留档，并显示步数 / token 读数', () => {
    render(
      <SubagentListPane
        sessionId="sess-1"
        runs={[
          run({ id: 'done-1', description: '已结束的子代理', status: 'completed', ended_at: new Date().toISOString(), duration_ms: 2_000 }),
          run({ id: 'live-1', description: '运行中的子代理' }),
        ]}
        onPick={() => {}}
      />,
    )

    expect(screen.getAllByText('运行中').length).toBeGreaterThan(0)
    expect(screen.getByText('已结束')).toBeTruthy()
    expect(screen.getByText('1 个运行中')).toBeTruthy()
    expect(screen.getByText('运行中的子代理')).toBeTruthy()
    expect(screen.getByText('已结束的子代理')).toBeTruthy()
    expect(screen.getAllByText(/1\.5K tok/).length).toBeGreaterThan(0)
  })

  it('点一条打开详情', () => {
    const onPick = vi.fn()
    render(<SubagentListPane sessionId="sess-1" runs={[run()]} onPick={onPick} />)
    fireEvent.click(screen.getAllByTestId('subagent-row')[0])
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'agent-1' }))
  })

  it('没有子代理时给出空态', () => {
    render(<SubagentListPane sessionId="sess-1" runs={[]} onPick={() => {}} />)
    expect(screen.getByText('本会话还没有子代理。')).toBeTruthy()
  })
})
