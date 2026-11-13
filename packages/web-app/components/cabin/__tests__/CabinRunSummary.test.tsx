// classic-v3 作业详情「运行」省略态：摘要卡 + 「打开运行 →」（作业坞同款运行窗）。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>()
  return { ...actual, fetchExecutionDetail: vi.fn() }
})

import { fetchExecutionDetail } from '@/lib/api-client'
import { CabinRunSummary } from '../modules/CabinRunSummary'

const target = {
  executionId: 'exec-12345678',
  workspaceId: 'ws-1',
  title: 'P3 验证标记',
  workflowRef: 'built-in/matt-spec-dev',
  phaseIndex: 1,
  roundIndex: 2,
  status: 'completed',
}

beforeEach(() => {
  vi.mocked(fetchExecutionDetail).mockReset()
  vi.mocked(fetchExecutionDetail).mockResolvedValue({
    id: 'exec-12345678',
    status: 'completed',
    workflow_ref: 'built-in/matt-spec-dev',
    started_at: '2026-11-13T10:00:00Z',
    completed_at: '2026-11-13T10:06:51Z',
    steps: [
      { stepId: 'ticket-01', stepName: 'ticket-01', status: 'completed' },
      { stepId: 'ship-pr', stepName: 'ship-pr', status: 'completed' },
      { stepId: '__internal', stepName: '__internal', status: 'completed' },
    ],
  } as never)
})

describe('CabinRunSummary — 运行 tab 省略态', () => {
  it('画摘要而不是 DAG：状态 / 工作流 / 节点进度', async () => {
    render(<CabinRunSummary target={target} />)
    await waitFor(() => expect(fetchExecutionDetail).toHaveBeenCalledWith('ws-1', 'exec-12345678'))
    expect(await screen.findByText(/运行完成 · built-in\/matt-spec-dev/)).toBeInTheDocument()
    expect(screen.getByText('2/2 节点')).toBeInTheDocument()
    expect(screen.getByText(/P1 · R2 · exec-123/)).toBeInTheDocument()
    expect(screen.queryByTestId('run-window')).toBeNull()
  })

  it('「打开运行 →」派发作业坞运行窗事件（目标执行随行）', async () => {
    const handler = vi.fn()
    window.addEventListener('octopus:open-run-window', handler)
    render(<CabinRunSummary target={target} />)
    fireEvent.click(await screen.findByTestId('cabin-job-open-run'))
    expect(handler).toHaveBeenCalledTimes(1)
    const event = handler.mock.calls[0][0] as CustomEvent
    expect(event.detail).toMatchObject({
      executionId: 'exec-12345678',
      workspaceId: 'ws-1',
      title: 'P3 验证标记',
    })
    window.removeEventListener('octopus:open-run-window', handler)
  })
})
