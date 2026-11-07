import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { WorkspaceRun } from '@/lib/api-client'
import { RunPicker, runElapsedMs, runTitle } from '../run-picker'

const run = (overrides: Partial<WorkspaceRun> = {}): WorkspaceRun => ({
  id: 'exec-1',
  workspaceId: 'ws-1',
  workflowRef: 'built-in/matt-spec-dev',
  workflowName: 'matt-spec-dev',
  name: '本轮执行',
  status: 'running',
  triggeredBy: 'task',
  taskId: 't-1',
  phaseIndex: 1,
  roundIndex: 1,
  isSystem: false,
  createdAt: '2026-11-02T10:00:00.000Z',
  startedAt: '2026-11-02T10:00:00.000Z',
  completedAt: null,
  duration: null,
  ...overrides,
})

afterEach(cleanup)

describe('RunPicker — 作业坞运行列表', () => {
  it('进行中在上、终态在下；系统运行打「系统」章', () => {
    render(
      <RunPicker
        workspaceId="ws-1"
        runs={[
          run({ id: 'plan', workflowRef: 'built-in/acceptance-plan', workflowName: 'acceptance-plan', name: 'acceptance-plan-abc-p1-r1', isSystem: true, triggeredBy: 'acceptance-plan' }),
          run({ id: 'done', status: 'completed', workflowRef: 'built-in/e2e', workflowName: 'e2e', name: 'E2E 走查' }),
        ]}
        onPick={() => {}}
      />,
    )

    expect(screen.getByText('进行中')).toBeTruthy()
    // 头部副标题与分组标题都叫「本工作区」
    expect(screen.getAllByText('本工作区').length).toBeGreaterThan(0)
    // 系统工作流的标题走人话映射，不显示 slug
    expect(screen.getByText('验收规划')).toBeTruthy()
    expect(screen.getByText('系统')).toBeTruthy()
    expect(screen.getByText('E2E 走查')).toBeTruthy()
    expect(screen.getByText(/个运行中/)).toBeTruthy()
  })

  it('点一行回传该执行', () => {
    const onPick = vi.fn()
    render(
      <RunPicker
        workspaceId="ws-1"
        runs={[run({ id: 'plan', workflowRef: 'built-in/acceptance-plan', isSystem: true })]}
        onPick={onPick}
      />,
    )
    fireEvent.click(screen.getByTestId('run-picker-row'))
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick.mock.calls[0][0].id).toBe('plan')
  })

  it('行尾 </> 只开 YAML 窗，不额外打开运行窗', () => {
    const onPick = vi.fn()
    const onOpenYaml = vi.fn()
    render(
      <RunPicker
        workspaceId="ws-1"
        runs={[run()]}
        onPick={onPick}
        onOpenYaml={onOpenYaml}
      />,
    )
    fireEvent.click(screen.getByTestId('run-picker-yaml'))
    expect(onOpenYaml).toHaveBeenCalledTimes(1)
    expect(onOpenYaml.mock.calls[0][0].id).toBe('exec-1')
    expect(onPick).not.toHaveBeenCalled()
  })

  it('没有 YAML 回调时不渲染行尾按钮（保留原来的箭头）', () => {
    render(<RunPicker workspaceId="ws-1" runs={[run()]} onPick={() => {}} />)
    expect(screen.queryByTestId('run-picker-yaml')).toBeNull()
  })

  it('空态说明与无工作区降级', () => {
    const { rerender } = render(<RunPicker workspaceId="ws-1" runs={[]} onPick={() => {}} />)
    expect(screen.getByText('本工作区还没有运行。')).toBeTruthy()

    rerender(<RunPicker workspaceId={null} runs={[]} onPick={() => {}} />)
    expect(screen.getByText(/没有工作区/)).toBeTruthy()
  })
})

describe('RunPicker — 读数口径', () => {
  it('运行中从服务端 started_at 起算，终态用 duration', () => {
    const started = Date.parse('2026-11-02T10:00:00.000Z')
    expect(runElapsedMs(run(), started + 48_000)).toBe(48_000)
    expect(runElapsedMs(run({ status: 'completed', duration: 126_000 }), 0)).toBe(126_000)
    expect(
      runElapsedMs(
        run({ status: 'completed', duration: null, completedAt: '2026-11-02T10:02:06.000Z' }),
        0,
      ),
    ).toBe(126_000)
  })

  it('系统运行优先用人话名字，其次 name / workflowName', () => {
    expect(runTitle(run({ isSystem: true, workflowRef: 'built-in/acceptance-plan' }))).toBe('验收规划')
    expect(runTitle(run({ name: 'E2E 走查' }))).toBe('E2E 走查')
    expect(runTitle(run({ name: null, workflowName: 'matt-spec-dev' }))).toBe('matt-spec-dev')
  })
})
