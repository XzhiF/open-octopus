// packages/web-app/components/agent/chat/__tests__/task-status-card.test.tsx
//
// 2026-10-30 对话里的运行卡：
//   · 执行中的卡自己走表（服务端 started_at 起算）、显示进度与当前节点，且没有按钮；
//   · 本轮完成 · 待验收的卡是收尾只读卡（降噪、无按钮、带「在作业坞·验收」提示）。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import type { Mock } from 'vitest'
import { TaskStatusCard } from '../task-status-card'
import type { AgentMessage } from '@/lib/agent/types'
import { getTask } from '@/lib/tasks-api'
import { fetchExecutionDetail } from '@/lib/api-client'

vi.mock('@/lib/tasks-api', () => ({ getTask: vi.fn() }))
vi.mock('@/lib/api-client', () => ({ fetchExecutionDetail: vi.fn() }))

function eventMessage(activity: AgentMessage['activity'], id = 'm-1'): AgentMessage {
  return {
    id,
    session_id: 's-1',
    role: 'user',
    content: `[任务状态] ${activity?.title ?? ''}`,
    created_at: new Date().toISOString(),
    is_summary: false,
    is_compressed: false,
    is_edited: false,
    displayType: 'event',
    activity,
  }
}

beforeEach(() => { vi.clearAllMocks() })

describe('TaskStatusCard', () => {
  it('执行中：计时 / 进度 / 当前节点都在，且没有动作按钮', async () => {
    const started = new Date(Date.now() - 90_000).toISOString()
    ;(getTask as Mock).mockResolvedValue({
      id: 't-run',
      name: '运行中的任务',
      status: 'running',
      executions: [{
        id: 'e-run', status: 'running', workflow_ref: 'matt-spec-dev',
        name: null, phase_index: 1, round_index: 1, workspace_id: 'w-1',
        started_at: started, completed_at: null, created_at: started, error_summary: null,
      }],
    })
    ;(fetchExecutionDetail as Mock).mockResolvedValue({
      id: 'e-run', status: 'running', workflow_ref: 'matt-spec-dev',
      started_at: started, completed_at: null,
      steps: [
        { stepId: 'n1', stepName: 'spec-resolve', status: 'completed', duration: 1 },
        { stepId: 'n2', stepName: 'ticket-01', status: 'completed', duration: 55 },
        { stepId: 'n3', stepName: 'code-review', status: 'running' },
        { stepId: 'n4', stepName: 'e2e-verify', status: 'pending' },
      ],
    })

    render(<TaskStatusCard message={eventMessage({
      kind: 'task.status', title: '任务开始执行', status: 'running',
      taskId: 't-run', executionId: 'e-run', workspaceId: 'w-1',
      phaseIndex: 1, roundIndex: 1,
    })} />)

    await waitFor(() => {
      expect(screen.getByTestId('activity-event-card').textContent).toContain('2/4 节点 · 50%')
    })
    expect(screen.getByTestId('activity-event-card').getAttribute('data-card-tone')).toBe('live')
    expect(screen.getByText('执行中')).toBeTruthy()
    expect(screen.getByText('matt-spec-dev')).toBeTruthy()
    expect(screen.getByText('P1 · R1')).toBeTruthy()
    expect(screen.getByText('code-review')).toBeTruthy()
    expect(screen.getByText(/⏱/)).toBeTruthy()
    // 运行卡只有读数，没有按钮（操作走主 chat / 作业坞）。
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('本轮完成 · 待验收：收尾只读卡 —— 降噪、无按钮、提示去作业坞', async () => {
    const started = new Date(Date.now() - 10 * 60_000).toISOString()
    const completed = new Date(Date.now() - 4 * 60_000).toISOString()
    ;(getTask as Mock).mockResolvedValue({
      id: 't-review',
      name: '待验收任务',
      status: 'awaiting_review',
      executions: [{
        id: 'e-review', status: 'completed', workflow_ref: 'matt-spec-dev',
        name: null, phase_index: 1, round_index: 1, workspace_id: 'w-2',
        started_at: started, completed_at: completed, created_at: started, error_summary: null,
      }],
    })
    ;(fetchExecutionDetail as Mock).mockResolvedValue({
      id: 'e-review', status: 'completed', workflow_ref: 'matt-spec-dev',
      started_at: started, completed_at: completed, steps: [],
    })

    render(<TaskStatusCard message={eventMessage({
      kind: 'task.review', title: '本轮完成 · 待验收', status: 'awaiting_review',
      taskId: 't-review', executionId: 'e-review', workspaceId: 'w-2',
      message: '任务：待验收任务 · P1R1',
    }, 'm-review')} />)

    await waitFor(() => expect(screen.getByText(/在作业坞「验收」处理/)).toBeTruthy())
    const card = screen.getByTestId('activity-event-card')
    expect(card.getAttribute('data-card-tone')).toBe('settled')
    expect(screen.getByText('本轮完成 · 待验收')).toBeTruthy()
    expect(screen.getByText(/任务：待验收任务 · P1R1/)).toBeTruthy()
    expect(screen.getByText(/用时 06:00/)).toBeTruthy()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })
})
