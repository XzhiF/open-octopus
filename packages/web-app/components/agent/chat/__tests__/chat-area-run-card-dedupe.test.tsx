// 2026-11-14：同一次 execution 的运行卡在 chat 里只画一张完整节点摘要。
//
// 背景：舱任务的「任务开始执行」「任务已继续运行」都带同一个 executionId，旧路由
// 还会把它们塞进舱 chat —— 结果是两张一模一样的「本轮执行失败 · 8/10 节点」卡。
// 现在后到的同 execution 运行卡降级成轻量转场卡（只报状态与坐标）。

import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { ChatArea } from '../ChatArea'
import type { AgentMessage } from '@/lib/agent/types'
import { getTask } from '@/lib/tasks-api'
import { fetchExecutionDetail } from '@/lib/api-client'

vi.mock('@/lib/tasks-api', () => ({ getTask: vi.fn() }))
vi.mock('@/lib/api-client', () => ({ fetchExecutionDetail: vi.fn() }))

const baseProps = {
  streaming: false,
  streamContent: '',
  streamThinking: '',
  isThinking: false,
  toolCalls: [],
  pendingConfirm: null,
  error: null,
  statusMessage: '',
  onSend: vi.fn(),
  onStop: vi.fn(),
  onConfirm: vi.fn(),
  hasSession: true,
  currentModel: 'pro',
  onModelChange: vi.fn(),
  tui: true,
}

function statusMessage(id: string, title: string, createdAt: string): AgentMessage {
  return {
    id,
    session_id: 's-1',
    role: 'user',
    content: `[任务状态] ${title}`,
    created_at: createdAt,
    is_summary: false,
    is_compressed: false,
    is_edited: false,
    displayType: 'event',
    activity: {
      kind: 'task.status',
      title,
      status: 'running',
      taskId: 't-1',
      executionId: 'e-1',
      workspaceId: 'w-1',
      phaseIndex: 1,
      roundIndex: 1,
      message: '任务：示例任务 · P1 · R1',
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  // jsdom 没有 scrollIntoView；ChatTimeline 的贴底跟随会调它。
  Element.prototype.scrollIntoView = vi.fn()
})

describe('ChatArea — 同一 execution 的运行卡去重', () => {
  it('开始执行保留完整节点摘要，继续运行降级成转场卡', async () => {
    ;(getTask as Mock).mockResolvedValue({
      id: 't-1',
      name: '示例任务',
      status: 'running',
      executions: [{
        id: 'e-1', status: 'failed', workflow_ref: 'built-in/matt-spec-dev',
        name: null, phase_index: 1, round_index: 1, workspace_id: 'w-1',
        started_at: new Date(Date.now() - 60_000).toISOString(),
        completed_at: new Date().toISOString(), created_at: '', error_summary: null,
      }],
    })
    ;(fetchExecutionDetail as Mock).mockResolvedValue({
      id: 'e-1', status: 'failed', workflow_ref: 'built-in/matt-spec-dev',
      started_at: new Date(Date.now() - 60_000).toISOString(),
      completed_at: new Date().toISOString(),
      steps: [
        { stepId: 'n1', stepName: 'spec-resolve', status: 'completed', duration: 1 },
        { stepId: 'n2', stepName: 'ship-pr', status: 'failed' },
      ],
    })

    render(<ChatArea
      {...baseProps}
      messages={[
        statusMessage('m-start', '任务开始执行', '2026-11-13T00:07:35.683Z'),
        statusMessage('m-resume', '任务已继续运行', '2026-11-13T23:50:25.932Z'),
      ]}
    />)

    await waitFor(() => expect(screen.getAllByTestId('activity-event-card')).toHaveLength(2))
    const cards = screen.getAllByTestId('activity-event-card')
    const full = cards.filter((c) => c.textContent?.includes('节点 ·'))
    const transfer = cards.filter((c) => c.textContent?.includes('运行窗看节点明细'))
    expect(full).toHaveLength(1)
    expect(transfer).toHaveLength(1)
    expect(full[0].textContent).toContain('本轮执行失败')
    expect(transfer[0].textContent).toContain('任务已继续运行')
  })
})
