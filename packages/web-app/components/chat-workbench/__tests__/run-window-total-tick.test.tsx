import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, cleanup } from '@testing-library/react'
import type { TaskView } from '@/lib/tasks-api'

// 走秒这条路径需要「服务端 started_at 在过去 + status=running」的执行。dev DB 里
// 那一轮已经跑完（终态读数本就不该走），所以这里用假定时器把时间轴钉住验证接线：
// 起点取服务端 started_at，tick 只推进 now，不重置起点。
vi.mock('@/lib/tasks-api', () => ({ getTask: vi.fn() }))
vi.mock('@/lib/api-client', () => ({ fetchExecutionDetail: vi.fn(), rerunExecution: vi.fn() }))
vi.mock('@/components/workspace/workflow-flow-viewer-with-status', () => ({ WorkflowFlowViewerWithStatus: () => null }))
vi.mock('@/components/workspace/run-log/run-log-console', () => ({ RunLogConsole: () => null }))

import { getTask } from '@/lib/tasks-api'
import { fetchExecutionDetail } from '@/lib/api-client'
import { RunWindow } from '../run-window'

const STARTED = Date.parse('2026-10-30T12:00:00.000Z')
const NOW = STARTED + 75_000

const task = {
  id: 't1', name: 'T', status: 'running',
} as unknown as TaskView

const detail = (overrides: Record<string, unknown> = {}) => ({
  id: 't1', name: 'T', status: 'running',
  executions: [{
    id: 'e1', workspace_id: 'w1', status: 'running', phase_index: 1, round_index: 1,
    workflow_ref: 'built-in/demo', ...overrides,
  }],
})

const execWire = (overrides: Record<string, unknown> = {}) => ({
  status: 'running',
  workflow_ref: 'built-in/demo',
  workflow_content: 'steps: []',
  steps: [],
  started_at: new Date(STARTED).toISOString(),
  completed_at: null,
  ...overrides,
})

const pill = () => screen.getByTestId('run-total').textContent

/** 挂载 + 冲掉 getTask / fetchExecutionDetail 的 promise（假定时器不会自己放行）。 */
const mount = async () => {
  await act(async () => {
    render(<RunWindow task={task} />)
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}
const tick = async (ms: number) => {
  await act(async () => {
    vi.advanceTimersByTime(ms)
    await Promise.resolve()
  })
}

describe('运行窗口 · 总耗时走秒', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    vi.mocked(getTask).mockResolvedValue(detail() as never)
    vi.mocked(fetchExecutionDetail).mockResolvedValue(execWire() as never)
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('运行中：每过一秒读数加一秒', async () => {
    await mount()
    expect(pill()).toBe('⏱ 1m 15s')
    await tick(1_000)
    expect(pill()).toBe('⏱ 1m 16s')
    await tick(61_000)
    expect(pill()).toBe('⏱ 2m 17s')
  })

  it('跨小时也在走（formatStopwatch 小时档保留秒）', async () => {
    vi.setSystemTime(STARTED + 8 * 3_600_000 + 29 * 60_000 + 12_000)
    await mount()
    expect(pill()).toBe('⏱ 8h 29m 12s')
    await tick(1_000)
    expect(pill()).toBe('⏱ 8h 29m 13s')
  })

  it('关窗重开：新挂载的读数从服务端起点接着算，不归零', async () => {
    await mount()
    expect(pill()).toBe('⏱ 1m 15s')
    await tick(40_000)
    expect(pill()).toBe('⏱ 1m 55s')
    cleanup()
    // 重新挂载（= 用户关掉窗口再点回来），时间轴已前进 10 分钟
    vi.setSystemTime(NOW + 600_000)
    await mount()
    expect(pill()).toBe('⏱ 11m 15s')
  })

  it('终态：读数锁在 completed_at - started_at，再喂时间也不走', async () => {
    vi.mocked(getTask).mockResolvedValue(detail({ status: 'completed' }) as never)
    vi.mocked(fetchExecutionDetail).mockResolvedValue(execWire({
      status: 'completed',
      completed_at: new Date(STARTED + 260_000).toISOString(),
    }) as never)
    await mount()
    expect(pill()).toBe('⏱ 4m 20s')
    await tick(30_000)
    expect(pill()).toBe('⏱ 4m 20s')
  })

  it('排队中（还没有 started_at）：不显示，也不从 0 开始乱走', async () => {
    vi.mocked(getTask).mockResolvedValue(detail({ status: 'pending' }) as never)
    vi.mocked(fetchExecutionDetail).mockResolvedValue(execWire({ status: 'pending', started_at: null }) as never)
    await mount()
    expect(screen.queryByTestId('run-total')).toBeNull()
  })
})
