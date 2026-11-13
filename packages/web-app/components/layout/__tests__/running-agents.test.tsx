// header 右上角「运行中」指示（2026-11-04）：
//   · chat 生成流（旧的 Bot chip）行为不变；
//   · 工作流执行 chip 与它并列 —— 工作流 Agent 节点不注册 chat 流，只能靠
//     /api/agent/executions/running；点 chip 打开该执行的 DAG/日志浮窗。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { RunningAgentSession, RunningExecution } from '@/lib/agent/api'

const mockAgents = vi.fn<() => RunningAgentSession[]>(() => [])
const mockExecutions = vi.fn<() => RunningExecution[]>(() => [])
const mockCabins = vi.fn<() => Array<{ id: string; main_session_id: string | null }>>(() => [])
const setActiveSessionId = vi.fn()
const openCabin = vi.fn()
const minimizeAll = vi.fn()
const focusDesktop = vi.fn()

vi.mock('@/hooks/use-running-agents', () => ({ useRunningAgents: () => mockAgents() }))
vi.mock('@/hooks/use-running-executions', () => ({ useRunningExecutions: () => mockExecutions() }))
vi.mock('@/hooks/use-cabins', () => ({ useCabins: () => ({ cabins: mockCabins(), loading: false }) }))
vi.mock('@/components/providers/chat-sessions', () => ({
  useChatSessions: () => ({ setActiveSessionId }),
}))
vi.mock('@/components/cabin/cabin-mode', () => ({
  useCabinMode: () => ({ openCabin }),
}))
vi.mock('@/lib/desktop-windows', () => ({
  useDesktopWindows: () => ({ minimizeAll, focusDesktop }),
}))

import { RunningAgents } from '../running-agents'

const agent = (id: string, title = `会话 ${id}`): RunningAgentSession => ({
  id,
  title,
  clone_name: null,
  session_type: 'main',
  started_at: '2026-11-04T01:00:00.000Z',
  stream_count: 1,
})

const run = (id: string, overrides: Partial<RunningExecution> = {}): RunningExecution => ({
  id,
  workspaceId: 'ws-1',
  title: 'MySQL 落库',
  workflowRef: 'built-in/matt-spec-dev',
  workflowName: 'matt-spec-dev',
  taskId: 't-1',
  taskName: 'MySQL 落库',
  phaseIndex: 2,
  roundIndex: 1,
  status: 'running',
  startedAt: '2026-11-04T01:36:16.000Z',
  ...overrides,
})

describe('RunningAgents — 运行中工作流+Agent 指示', () => {
  beforeEach(() => {
    mockAgents.mockReturnValue([])
    mockExecutions.mockReturnValue([])
    mockCabins.mockReturnValue([])
    vi.clearAllMocks()
  })
  afterEach(() => cleanup())

  it('都为空时不渲染', () => {
    const { container } = render(<RunningAgents />)
    expect(container.firstChild).toBeNull()
  })

  it('执行 chip 带任务名与 P/R 坐标；点击打开该执行的 DAG 浮窗', () => {
    mockExecutions.mockReturnValue([run('exec-1')])
    const onOpen = vi.fn()
    window.addEventListener('octopus:open-workflow', onOpen)

    const { container } = render(<RunningAgents />)
    const chip = container.querySelector('[data-running-execution="exec-1"]') as HTMLElement
    expect(chip).toBeTruthy()
    expect(chip.getAttribute('title')).toBe('MySQL 落库 · P2 · R1 · 运行中')

    fireEvent.click(chip)
    expect(minimizeAll).toHaveBeenCalled()
    expect(focusDesktop).toHaveBeenCalled()
    const detail = (onOpen.mock.calls[0][0] as CustomEvent).detail
    expect(detail).toEqual({
      workspaceId: 'ws-1',
      executionId: 'exec-1',
      title: 'MySQL 落库 · P2 · R1',
    })
    window.removeEventListener('octopus:open-workflow', onOpen)
  })

  it('系统运行（验收规划）用人话名，不显示坐标当任务名', () => {
    mockExecutions.mockReturnValue([
      run('plan-exec', {
        title: 'acceptance-plan',
        taskName: null,
        workflowRef: 'built-in/acceptance-plan',
        workflowName: 'acceptance-plan',
        phaseIndex: null,
        roundIndex: null,
      }),
    ])
    const { container } = render(<RunningAgents />)
    const chip = container.querySelector('[data-running-execution="plan-exec"]') as HTMLElement
    expect(chip.getAttribute('title')).toBe('验收规划 · 运行中')
  })

  it('chat Agent chip 行为不变：点击切到会话', () => {
    mockAgents.mockReturnValue([agent('s-1')])
    const { container } = render(<RunningAgents />)
    const chip = container.querySelector('[data-running-agent="s-1"]') as HTMLElement
    expect(chip.getAttribute('title')).toBe('会话 s-1 · 运行中')
    fireEvent.click(chip)
    expect(setActiveSessionId).toHaveBeenCalledWith('s-1')
    expect(minimizeAll).toHaveBeenCalled()
    expect(focusDesktop).toHaveBeenCalled()
  })

  // 2026-11-13：舱主对话不是会话列表里的行，点它的运行 chip 应该回到舱，
  // 而不是把一个没有会话元数据的普通 chat 拉到台前。
  it('舱主会话 chip → 打开对应工作舱（不切普通会话）', () => {
    mockAgents.mockReturnValue([agent('sess-cabin', 'Aurora · 舱主对话')])
    mockCabins.mockReturnValue([{ id: 'cabin-1', main_session_id: 'sess-cabin' }])
    const { container } = render(<RunningAgents />)
    const chip = container.querySelector('[data-running-agent="sess-cabin"]') as HTMLElement
    fireEvent.click(chip)
    expect(openCabin).toHaveBeenCalledWith('cabin-1')
    expect(setActiveSessionId).not.toHaveBeenCalled()
    expect(minimizeAll).toHaveBeenCalled()
    expect(focusDesktop).toHaveBeenCalled()
  })

  // 2026-11-04：agent 收轮等后台 shell 时，chip 要说清在跑什么（后台等待期间
  // 内存流仍在注册表里，所以 chip 会一直亮着）。
  it('chat Agent chip 带「后台：在跑什么」', () => {
    mockAgents.mockReturnValue([
      { ...agent('s-2'), background_tasks: [{ id: 'bg-1', description: 'mvn spring-boot:run' }] },
    ])
    const { container } = render(<RunningAgents />)
    const chip = container.querySelector('[data-running-agent="s-2"]') as HTMLElement
    expect(chip.getAttribute('title')).toBe('会话 s-2 · 后台：mvn spring-boot:run · 运行中')
    expect(chip.getAttribute('aria-label')).toContain('后台：mvn spring-boot:run')
  })

  it('执行向在最右，合并上限 6 个，超出显示 +N', () => {
    mockExecutions.mockReturnValue([run('e1'), run('e2'), run('e3')])
    mockAgents.mockReturnValue([agent('a1'), agent('a2'), agent('a3'), agent('a4')])
    const { container } = render(<RunningAgents />)

    expect(container.querySelectorAll('[data-running-execution]')).toHaveLength(3)
    expect(container.querySelectorAll('[data-running-agent]')).toHaveLength(3)
    expect(screen.getByText('+1')).toBeTruthy()
  })
})
