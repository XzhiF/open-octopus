import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { AgentMessage } from '@/lib/agent/types'

vi.mock('@/lib/api-client', () => ({ fetchExecutionDetail: vi.fn() }))

import { fetchExecutionDetail } from '@/lib/api-client'
import { WorkflowRunCard } from '../workflow-run-card'

const STARTED = Date.parse('2026-11-02T10:00:00.000Z')
const NOW = STARTED + 48_000

const message = {
  id: 'm-1',
  role: 'user',
  content: '[工作流运行 · running] 工作流运行 · 验收规划',
  created_at: new Date(STARTED).toISOString(),
  displayType: 'event',
  activity: {
    kind: 'workflow.started',
    severity: 'info',
    title: '工作流运行 · 验收规划',
    message: 'built-in/acceptance-plan · P1 · R1',
    workspaceId: 'ws-1',
    taskId: 't-1',
    executionId: 'plan-exec',
    status: 'running',
    phaseIndex: 1,
    roundIndex: 1,
    payload: {
      workflowRun: true,
      system: true,
      workflowRef: 'built-in/acceptance-plan',
      workflowName: '验收规划',
      phaseIndex: 1,
      roundIndex: 1,
    },
  },
} as unknown as AgentMessage

const wire = (overrides: Record<string, unknown> = {}) => ({
  status: 'running',
  workflow_ref: 'built-in/acceptance-plan',
  workflow_content: 'steps: []',
  steps: [
    { stepId: 'manifest', stepName: 'manifest', status: 'completed', startedAt: null, completedAt: null },
    { stepId: 'plan', stepName: 'plan', status: 'running', startedAt: null, completedAt: null },
  ],
  started_at: new Date(STARTED).toISOString(),
  completed_at: null,
  ...overrides,
})

const mount = async () => {
  await act(async () => {
    render(<WorkflowRunCard message={message} />)
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}

describe('WorkflowRunCard — 通用工作流运行卡', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    vi.mocked(fetchExecutionDetail).mockResolvedValue(wire() as never)
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('运行中：系统章 + 走表 + 当前节点', async () => {
    await mount()
    expect(screen.getByTestId('workflow-run-card').getAttribute('data-workflow-run-status')).toBe('running')
    expect(screen.getByText('工作流运行 · 验收规划')).toBeTruthy()
    expect(screen.getByText('系统')).toBeTruthy()
    expect(screen.getByText('⏱ 00:48')).toBeTruthy()
    expect(screen.getByText('plan 运行中')).toBeTruthy()
    expect(screen.getByText('1/2 节点')).toBeTruthy()
  })

  it('同一张卡原地走完：完成态定格用时', async () => {
    vi.mocked(fetchExecutionDetail).mockResolvedValue(
      wire({ status: 'completed', completed_at: new Date(STARTED + 126_000).toISOString() }) as never,
    )
    await mount()
    expect(screen.getByText('工作流完成 · 验收规划')).toBeTruthy()
    expect(screen.getByText('用时 02:06')).toBeTruthy()
    expect(screen.getByTestId('workflow-run-card').getAttribute('data-workflow-run-status')).toBe('completed')
  })

  it('失败态红框；拉取失败降级为「状态未知」且不阻塞', async () => {
    vi.mocked(fetchExecutionDetail).mockResolvedValue(wire({ status: 'failed' }) as never)
    await mount()
    expect(screen.getByText('工作流失败 · 验收规划')).toBeTruthy()
    expect(screen.getByTestId('workflow-run-card').getAttribute('data-workflow-run-status')).toBe('failed')

    cleanup()
    vi.mocked(fetchExecutionDetail).mockRejectedValue(new Error('offline'))
    await mount()
    expect(screen.getByText('状态未知')).toBeTruthy()
    expect(screen.getByText('打开 DAG →')).toBeTruthy()
  })

  it('「打开 DAG」派发指定执行', async () => {
    await mount()
    const seen: CustomEvent[] = []
    const handler = (event: Event) => seen.push(event as CustomEvent)
    window.addEventListener('octopus:open-workflow', handler)
    fireEvent.click(screen.getByText('打开 DAG →'))
    window.removeEventListener('octopus:open-workflow', handler)
    expect(seen[0]?.detail).toMatchObject({ workspaceId: 'ws-1', executionId: 'plan-exec' })
  })
})
