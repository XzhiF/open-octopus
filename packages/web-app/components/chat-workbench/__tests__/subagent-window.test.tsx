import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { SubagentRunDetail } from '@/lib/agent/api'
import { SubagentWindow } from '../subagent-window'

const mockGetSessionSubagent = vi.fn()
vi.mock('@/lib/agent/api', () => ({
  getSessionSubagent: (...args: unknown[]) => mockGetSessionSubagent(...args),
}))

const detail = (overrides: Partial<SubagentRunDetail> = {}): SubagentRunDetail => ({
  id: 'agent-1',
  session_id: 'sess-1',
  parent_tool_use_id: 'tu-1',
  agent_type: 'general-purpose',
  description: '审查登录模块',
  prompt: '审查登录模块的鉴权边界',
  status: 'completed',
  started_at: new Date().toISOString(),
  ended_at: new Date().toISOString(),
  summary: '鉴权边界正常',
  model: 'deepseek-v4-flash',
  input_tokens: 1_200,
  output_tokens: 300,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  tool_uses: 1,
  duration_ms: 2_600,
  step_count: 4,
  steps: [
    { kind: 'thinking', text: '先看鉴权入口' },
    { kind: 'tool_use', toolName: 'Grep', toolUseId: 't1', input: { pattern: 'auth' } },
    { kind: 'tool_result', toolUseId: 't1', content: 'src/auth.ts' },
    { kind: 'text', text: '鉴权边界没问题' },
  ],
  ...overrides,
})

afterEach(() => {
  cleanup()
  mockGetSessionSubagent.mockReset()
})

describe('SubagentWindow — 子代理详情', () => {
  it('渲染指令 prompt、操作日志、最终汇报与 token 汇总', async () => {
    mockGetSessionSubagent.mockResolvedValue({ run: detail() })
    render(<SubagentWindow sessionId="sess-1" agentId="agent-1" />)

    expect(await screen.findByText('主 Agent 的指令')).toBeTruthy()
    expect(screen.getByText('审查登录模块的鉴权边界')).toBeTruthy()
    // thinking / 工具调用 / 工具结果 / 文本
    expect(screen.getByText('先看鉴权入口')).toBeTruthy()
    expect(screen.getByText('Grep')).toBeTruthy()
    expect(screen.getByText('src/auth.ts')).toBeTruthy()
    expect(screen.getByText('鉴权边界没问题')).toBeTruthy()
    // 最终汇报
    expect(screen.getByText('最终汇报')).toBeTruthy()
    expect(screen.getByText('鉴权边界正常')).toBeTruthy()
    // token 脚注（输入 + 输出 = 1.5K）
    expect(document.body.textContent).toContain('输入 1.2K')
    expect(document.body.textContent).toContain('合计 1.5K tok')

    expect(mockGetSessionSubagent).toHaveBeenCalledWith('sess-1', 'agent-1')
  })

  it('没有选中子代理时给出引导语', () => {
    render(<SubagentWindow sessionId="sess-1" agentId={null} />)
    expect(screen.getByText('从作业坞「子代理」列表里选一条查看。')).toBeTruthy()
    expect(mockGetSessionSubagent).not.toHaveBeenCalled()
  })
})
