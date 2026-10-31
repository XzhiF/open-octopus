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

  it('跑完定格：标题转「本轮执行完成」、圈 ✓、子工作流聚合回父节点', async () => {
    const started = new Date(Date.now() - 6 * 60_000).toISOString()
    const completed = new Date(Date.now() - 60_000).toISOString()
    ;(getTask as Mock).mockResolvedValue({
      id: 't-done', name: '跑完的任务', status: 'running',
      executions: [{
        id: 'e-done', status: 'completed', workflow_ref: 'built-in/matt-spec-dev',
        name: null, phase_index: 1, round_index: 1, workspace_id: 'w-3',
        started_at: started, completed_at: completed, created_at: started, error_summary: null,
      }],
    })
    ;(fetchExecutionDetail as Mock).mockResolvedValue({
      id: 'e-done', status: 'completed', workflow_ref: 'built-in/matt-spec-dev',
      started_at: started, completed_at: completed,
      steps: [
        { stepId: '__engine_init__', stepName: '', status: 'completed', duration: 4 },
        { stepId: 'spec-resolve', stepName: '', status: 'completed', duration: 1, startedAt: started, completedAt: started },
        { stepId: 'ticket-dag', stepName: '', status: 'completed', duration: 166, startedAt: started, completedAt: completed },
        { stepId: 'ticket-dag:ticket-01', stepName: '', status: 'completed', duration: 44 },
        { stepId: 'ticket-dag:ticket-02', stepName: '', status: 'completed', duration: 44 },
        { stepId: 'code-review', stepName: '', status: 'completed', duration: 153, startedAt: completed, completedAt: completed },
        { stepId: 'ship-pr', stepName: '', status: 'skipped', startedAt: completed, completedAt: completed },
      ],
    })

    render(<TaskStatusCard message={eventMessage({
      kind: 'task.status', title: '任务开始执行', status: 'running',
      taskId: 't-done', executionId: 'e-done', workspaceId: 'w-3',
      phaseIndex: 1, roundIndex: 1,
    }, 'm-done')} />)

    // 「开始执行」的标题跟着结束态走，徽章也不再是「已结束」。
    await waitFor(() => expect(screen.getByText('本轮执行完成')).toBeTruthy())
    const card = screen.getByTestId('activity-event-card')
    expect(card.getAttribute('data-card-tone')).toBe('done')
    expect(screen.getByText('已完成')).toBeTruthy()
    expect(screen.queryByText('任务开始执行')).toBeNull()
    // 子工作流聚合：父节点带 2/2，子节点不再单独占位；内部节点隐藏。
    expect(screen.getByText('ticket-dag')).toBeTruthy()
    expect(screen.getByText('2/2')).toBeTruthy()
    expect(screen.queryByText('ticket-dag:ticket-01')).toBeNull()
    expect(screen.queryByText('__engine_init__')).toBeNull()
    expect(screen.getByText('code-review')).toBeTruthy()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('执行失败：标题「本轮执行失败」、红圈 ✕，失败节点红字', async () => {
    const started = new Date(Date.now() - 3 * 60_000).toISOString()
    const completed = new Date(Date.now() - 30_000).toISOString()
    ;(getTask as Mock).mockResolvedValue({
      id: 't-fail', name: '失败的任务', status: 'running',
      executions: [{
        id: 'e-fail', status: 'failed', workflow_ref: 'built-in/matt-spec-dev',
        name: null, phase_index: 1, round_index: 1, workspace_id: 'w-4',
        started_at: started, completed_at: completed, created_at: started, error_summary: null,
      }],
    })
    ;(fetchExecutionDetail as Mock).mockResolvedValue({
      id: 'e-fail', status: 'failed', workflow_ref: 'built-in/matt-spec-dev',
      started_at: started, completed_at: completed,
      steps: [
        { stepId: 'spec-resolve', stepName: '', status: 'completed', duration: 1, startedAt: started, completedAt: started },
        { stepId: 'code-review', stepName: '', status: 'failed', startedAt: completed, completedAt: completed },
        { stepId: 'ship-pr', stepName: '', status: 'pending' },
      ],
    })

    render(<TaskStatusCard message={eventMessage({
      kind: 'task.status', title: '任务开始执行', status: 'running',
      taskId: 't-fail', executionId: 'e-fail', workspaceId: 'w-4',
      phaseIndex: 1, roundIndex: 1,
    }, 'm-fail')} />)

    await waitFor(() => expect(screen.getByText('本轮执行失败')).toBeTruthy())
    const card = screen.getByTestId('activity-event-card')
    expect(card.getAttribute('data-card-tone')).toBe('failed')
    expect(screen.getByText('失败')).toBeTruthy()
    expect(screen.getByText('code-review')).toBeTruthy()
    expect(card.textContent).toContain('✕')
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

  it('末 phase 通过 · 待归档：收尾只读卡，提示在对话里说「归档」', async () => {
    ;(getTask as Mock).mockResolvedValue({
      id: 't-park',
      name: '待归档任务',
      status: 'awaiting_archive',
      executions: [],
    })

    render(<TaskStatusCard message={eventMessage({
      kind: 'task.status', title: '末 phase 已通过 · 待归档', status: 'awaiting_archive',
      taskId: 't-park',
      message: '任务：待归档任务 · 归档尚未启动',
    }, 'm-park')} />)

    await waitFor(() => expect(screen.getByText(/在主 Chat 说「归档」开始归档/)).toBeTruthy())
    const card = screen.getByTestId('activity-event-card')
    expect(card.getAttribute('data-card-tone')).toBe('settled')
    expect(card.textContent).toContain('待归档')
    expect(card.textContent).toContain('暂不归档')
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })
})
