import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AgentMessage } from '@/lib/agent/types'

vi.mock('@/lib/api-client', () => ({ fetchRuntimeIncident: vi.fn() }))

import { fetchRuntimeIncident } from '@/lib/api-client'
import { IncidentCard } from '../incident-card'

const message = (payload: Record<string, unknown> = {}) =>
  ({
    id: 'm-incident',
    role: 'user',
    content: '[运行事件 · stupid_retry] same error twice',
    created_at: new Date().toISOString(),
    displayType: 'event',
    activity: {
      kind: 'workflow.incident',
      severity: 'warn',
      title: '运行事件 · stupid_retry',
      message: 'same error twice',
      workspaceId: 'ws-1',
      executionId: 'exec-1',
      nodeId: 'build',
      status: 'dispatched',
      payload: {
        incident: true,
        incidentId: 'inc-1',
        incidentKind: 'stupid_retry',
        allowedActions: ['retry', 'escalate'],
        ...payload,
      },
    },
  }) as unknown as AgentMessage

const incident = (overrides: Record<string, unknown> = {}) => ({
  id: 'inc-1',
  executionId: 'exec-1',
  workspaceId: 'ws-1',
  nodeId: 'build',
  phase: 'before_retry',
  severity: 'warning',
  kind: 'stupid_retry',
  status: 'dispatched',
  summary: 'same error twice',
  evidence: [],
  contextRef: 'x',
  allowedActions: ['retry', 'escalate'],
  createdAt: Date.now(),
  ...overrides,
})

const mount = async (payload: Record<string, unknown> = {}) => {
  render(<IncidentCard message={message(payload)} />)
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}

describe('IncidentCard — 运行事件卡', () => {
  beforeEach(() => {
    vi.mocked(fetchRuntimeIncident).mockResolvedValue(incident() as never)
  })
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('显示事件证据摘要、节点与分派状态', async () => {
    await mount()
    const card = await screen.findByTestId('incident-card')
    expect(card.getAttribute('data-incident-status')).toBe('dispatched')
    expect(card.textContent).toContain('same error twice')
    expect(card.textContent).toContain('node · build')
    expect(card.textContent).toContain('Agent 处理中')
  })

  it('waiting_human：选项按钮把人选发回对话（不直接改执行）', async () => {
    vi.mocked(fetchRuntimeIncident).mockResolvedValue(
      incident({ status: 'waiting_human' }) as never,
    )
    const listener = vi.fn()
    window.addEventListener('octopus:incident-choice', listener)
    await mount({ options: ['继续重试', '中止执行'] })
    await waitFor(() => expect(screen.getByTestId('incident-options')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: '继续重试' }))
    expect(listener).toHaveBeenCalledTimes(1)
    const detail = (listener.mock.calls[0][0] as CustomEvent).detail
    expect(detail).toMatchObject({ incidentId: 'inc-1', option: '继续重试' })
    window.removeEventListener('octopus:incident-choice', listener)
  })

  it('resolved：终态只读，不再展示选项', async () => {
    vi.mocked(fetchRuntimeIncident).mockResolvedValue(
      incident({ status: 'resolved', decision: { type: 'retry' } }) as never,
    )
    await mount({ options: ['继续重试'] })
    await waitFor(() =>
      expect(screen.getByTestId('incident-card').getAttribute('data-incident-status')).toBe('resolved'),
    )
    expect(screen.queryByTestId('incident-options')).toBeNull()
    expect(screen.getByTestId('incident-card').textContent).toContain('已处理')
  })

  it('unowned：如实显示「无负责人」', async () => {
    vi.mocked(fetchRuntimeIncident).mockResolvedValue(
      incident({ status: 'unowned' }) as never,
    )
    await mount()
    await waitFor(() =>
      expect(screen.getByTestId('incident-card').textContent).toContain('无负责人'),
    )
  })
})
