// packages/web-app/components/agent/chat/__tests__/acceptance-check-card.test.tsx
//
// 聊天里的验收项卡（2026-10-30 用户定稿）：卡片必须信息完整 ——
// 第 x/N、通过标准、怎么验、机器建议、证据；按钮是快捷方式，选过即只读。

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AcceptanceCheckCard } from '../acceptance-check-card'
import type { AgentMessage } from '@/lib/agent/types'

function eventMessage(activity: AgentMessage['activity'], id = 'm-acc'): AgentMessage {
  return {
    id,
    session_id: 's-1',
    role: 'user',
    content: `[任务工具] ${activity?.title ?? ''}`,
    created_at: new Date().toISOString(),
    is_summary: false,
    is_compressed: false,
    is_edited: false,
    displayType: 'event',
    activity,
  }
}

function cardActivity(overrides: Partial<AgentMessage['activity']> = {}): AgentMessage['activity'] {
  return {
    kind: 'task.acceptance_check',
    severity: 'info',
    title: '验收项 1/8 · 精确短语命中',
    message: '',
    taskId: 't-1',
    actions: [
      { id: 'acceptance_pass', label: '✓ 通过' },
      { id: 'acceptance_fail', label: '✕ 不通过' },
      { id: 'acceptance_skip', label: '⊘ 跳过' },
      { id: 'acceptance_open_window', label: '打开验收台' },
    ],
    payload: {
      acceptanceCheck: true,
      itemId: 'plan:03-matcher:1',
      title: '精确短语命中',
      ticket: '03-matcher',
      index: 1,
      total: 8,
      expect: 'match("the quick brown fox", "quick brown fox", 0) 返回 matched=true',
      howTo: [{ kind: 'run', text: '跑匹配器测试', command: 'mvn -B -pl java-common-util -am test' }],
      machine: { verdict: 'pass', why: '20 例全绿', command: 'mvn -B -pl java-common-util -am test' },
      evidence: [{ kind: 'test', label: 'Surefire 20/20' }],
    },
    ...overrides,
  }
}

describe('AcceptanceCheckCard', () => {
  it('renders the full context: index, standard, how-to, machine advice, evidence', () => {
    render(<AcceptanceCheckCard message={eventMessage(cardActivity())} fireAction={vi.fn()} />)
    expect(screen.getByText(/验收项 1\/8/)).toBeTruthy()
    expect(screen.getByText(/通过标准/)).toBeTruthy()
    expect(screen.getByText(/matched=true/)).toBeTruthy()
    expect(screen.getByText(/怎么验/)).toBeTruthy()
    expect(screen.getByText(/mvn -B -pl java-common-util/)).toBeTruthy()
    expect(screen.getByText(/机器建议通过/)).toBeTruthy()
    expect(screen.getByText(/Surefire 20\/20/)).toBeTruthy()
    // 口语通道也写在卡上
    expect(screen.getByText(/也可以直接说/)).toBeTruthy()
  })

  it('dispatches the action id when a verdict button is clicked', () => {
    const fire = vi.fn()
    render(<AcceptanceCheckCard message={eventMessage(cardActivity())} fireAction={fire} />)
    fireEvent.click(screen.getByText('✓ 通过'))
    expect(fire).toHaveBeenCalledWith('acceptance_pass')
  })

  it('goes read-only and shows the recorded choice once decided', () => {
    const activity = cardActivity({
      decision: { id: 'acceptance_fail', label: '不通过', at: new Date().toISOString() },
    })
    render(<AcceptanceCheckCard message={eventMessage(activity)} fireAction={vi.fn()} />)
    expect(screen.getByText(/已选 · 不通过/)).toBeTruthy()
    expect(screen.queryByText(/也可以直接说/)).toBeNull()
    const pass = screen.getByText('✓ 通过').closest('button') as HTMLButtonElement
    expect(pass.disabled).toBe(true)
    // 「打开验收台」仍可点（不再是判定，只是导航）
    const open = screen.getByText('打开验收台').closest('button') as HTMLButtonElement
    expect(open.disabled).toBe(false)
  })
})
