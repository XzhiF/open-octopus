import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { TaskView } from '@/lib/tasks-api'

// 指定执行路径：运行窗要能渲染 task_id=NULL 的系统运行（验收规划），
// 不依赖 getTask 的 executions 列表；失败系统运行不给「重跑」。
vi.mock('@/lib/tasks-api', () => ({ getTask: vi.fn() }))
vi.mock('@/lib/api-client', () => ({
  fetchExecutionDetail: vi.fn(),
  fetchExecutionIncidents: vi.fn(async () => []),
  cancelExecution: vi.fn(),
  rerunExecution: vi.fn(),
}))
vi.mock('@/components/workspace/workflow-flow-viewer-with-status', () => ({
  WorkflowFlowViewerWithStatus: () => null,
}))
vi.mock('@/components/workspace/run-log/run-log-console', () => ({ RunLogConsole: () => null }))

import { getTask } from '@/lib/tasks-api'
import { cancelExecution, fetchExecutionDetail } from '@/lib/api-client'
import { RunWindow } from '../run-window'

const task = { id: 't1', name: 'T', status: 'awaiting_review' } as unknown as TaskView

const target = {
  executionId: 'plan-exec',
  workspaceId: 'ws-1',
  title: '验收规划',
  workflowRef: 'built-in/acceptance-plan',
  phaseIndex: 1,
  roundIndex: 1,
  status: 'running',
  system: true,
}

const execWire = (overrides: Record<string, unknown> = {}) => ({
  status: 'running',
  workflow_ref: 'built-in/acceptance-plan',
  workflow_content: 'steps: []',
  steps: [],
  started_at: '2026-11-02T10:00:00.000Z',
  completed_at: null,
  ...overrides,
})

const mount = async (props: Record<string, unknown> = {}) => {
  await act(async () => {
    render(<RunWindow task={task} runTarget={target} {...props} />)
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}

describe('运行窗口 · 指定执行（作业坞运行列表）', () => {
  beforeEach(() => {
    vi.mocked(getTask).mockResolvedValue({ id: 't1', executions: [] } as never)
    vi.mocked(fetchExecutionDetail).mockResolvedValue(execWire() as never)
    vi.mocked(cancelExecution).mockResolvedValue({ ok: true } as never)
  })
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('直接拉 target 的执行详情，不依赖任务当前轮', async () => {
    await mount()
    expect(getTask).not.toHaveBeenCalled()
    expect(fetchExecutionDetail).toHaveBeenCalledWith('ws-1', 'plan-exec')
    expect(screen.getByTestId('run-window')).toBeTruthy()
    expect(screen.getByText('系统')).toBeTruthy()
    expect(screen.getByText('built-in/acceptance-plan')).toBeTruthy()
  })

  it('自由对话（没有任务）也能打开指定执行的运行窗', async () => {
    await mount({ task: null })
    expect(getTask).not.toHaveBeenCalled()
    expect(fetchExecutionDetail).toHaveBeenCalledWith('ws-1', 'plan-exec')
    expect(screen.getByTestId('run-window')).toBeTruthy()
  })

  it('指定执行不给「重跑」（系统运行重跑会被误解成业务重跑）', async () => {
    vi.mocked(fetchExecutionDetail).mockResolvedValue(
      execWire({ status: 'failed' }) as never,
    )
    await mount({ runTarget: { ...target, status: 'failed' } })
    expect(screen.queryByTestId('run-rerun')).toBeNull()
  })

  it('running 时中止直接走执行接口', async () => {
    await mount()
    fireEvent.click(screen.getByTestId('run-abort'))
    expect(cancelExecution).toHaveBeenCalledWith('ws-1', 'plan-exec')
  })

  it('头部 YAML 按钮回传当前执行目标（不改变运行窗本身）', async () => {
    const onOpenYaml = vi.fn()
    await mount({ onOpenYaml })
    fireEvent.click(screen.getByTestId('run-yaml'))
    expect(onOpenYaml).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        executionId: 'plan-exec',
        workflowRef: 'built-in/acceptance-plan',
        phaseIndex: 1,
        roundIndex: 1,
        status: 'running',
        from: 'run',
      }),
    )
  })

  it('「事件」页签展示 runtime supervision 的只读时间线', async () => {
    const { fetchExecutionIncidents } = await import('@/lib/api-client')
    vi.mocked(fetchExecutionIncidents).mockResolvedValue([
      {
        id: 'inc-1',
        executionId: 'plan-exec',
        workspaceId: 'ws-1',
        nodeId: 'spec-resolve',
        phase: 'before_retry',
        severity: 'warning',
        kind: 'stupid_retry',
        status: 'dispatched',
        summary: '同一错误重复失败',
        evidence: [],
        contextRef: 'x',
        allowedActions: ['retry', 'escalate'],
        createdAt: Date.now(),
      },
    ] as never)

    await mount()
    fireEvent.click(screen.getByTestId('run-view-incidents'))
    expect(await screen.findByTestId('incident-timeline')).toBeTruthy()
    expect(screen.getByTestId('incident-row').textContent).toContain('同一错误重复失败')
    expect(screen.getByTestId('run-view-incidents').textContent).toContain('事件 (1)')
  })
})
