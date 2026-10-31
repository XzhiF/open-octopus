// packages/web-app/components/agent/chat/__tests__/decision-card.test.tsx
//
// 2026-10-30 决策卡：选过之后 —— 所选按钮高亮（✓）、其余禁用、卡片标成只读。
// 选择由 ChatTab 写回服务端 metadata（activity.decision），这里只钉渲染契约。

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TuiMessage } from '../TuiTranscript'
import type { AgentMessage } from '@/lib/agent/types'

function eventMessage(activity: AgentMessage['activity']): AgentMessage {
  return {
    id: 'm-launch',
    session_id: 's-1',
    role: 'user',
    content: `[任务工具 · task.launch_proposal] ${activity?.title ?? ''}`,
    created_at: '2026-10-30T02:37:37.603Z',
    is_summary: false,
    is_compressed: false,
    is_edited: false,
    displayType: 'event',
    activity,
  }
}

const ACTIONS = [
  { id: 'launch_now', label: '立即执行' },
  { id: 'enqueue', label: '入列，等我手动触发' },
  { id: 'schedule', label: '定时触发…' },
  { id: 'keep_editing', label: '继续改规格' },
]

describe('决策卡', () => {
  it('未选择：按钮可点、没有已选戳', () => {
    render(<TuiMessage message={eventMessage({
      kind: 'task.launch_proposal', severity: 'info', title: '启动方式待选择',
      taskId: 't-1', actions: ACTIONS,
    })} />)

    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(4)
    for (const b of buttons) expect(b).toBeEnabled()
    expect(screen.getByTestId('activity-event-card').getAttribute('data-decision')).toBe('open')
    expect(screen.queryByTestId('task-card-decision-stamp')).toBeNull()
  })

  it('已选择：所选高亮 ✓，其余禁用，卡片只读', () => {
    render(<TuiMessage message={eventMessage({
      kind: 'task.launch_proposal', severity: 'info', title: '启动方式待选择',
      taskId: 't-1', actions: ACTIONS,
      decision: { id: 'launch_now', label: '立即执行', at: '2026-10-30T02:38:00.000Z' },
    })} />)

    const card = screen.getByTestId('activity-event-card')
    expect(card.getAttribute('data-decision')).toBe('set')
    expect(screen.getByTestId('task-card-decision-stamp').textContent).toContain('已选')

    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(4)
    for (const b of buttons) expect(b).toBeDisabled()
    expect(buttons[0].textContent).toContain('✓')
    expect(buttons[0].textContent).toContain('立即执行')
    expect(buttons[0].className).toContain('text-pop-green')
    expect(buttons[1].textContent).not.toContain('✓')
  })
})
