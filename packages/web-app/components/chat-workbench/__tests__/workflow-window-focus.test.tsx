// packages/web-app/components/chat-workbench/__tests__/workflow-window-focus.test.tsx
//
// 2026-10-30 用户反馈：对话里「打开 DAG」的窗口，日志 tab 点左边通道，右边日志不跟。
// 根因是 WorkflowWindow 没把 focus 受控传给 RunLogConsole（run-window 传了）。
// 这里钉住：日志栏点击 → focus 回写 → 右侧收到聚焦；顺带钉住 macOS 红点关闭。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/lib/api-client', () => ({
  fetchExecutionDetail: vi.fn(async () => ({
    id: 'e1',
    status: 'completed',
    workflow_ref: 'built-in/demo',
    workflow_content: 'steps: []',
    started_at: null,
    completed_at: null,
    steps: [],
  })),
}))
vi.mock('@/components/workspace/workflow-flow-viewer-with-status', () => ({
  WorkflowFlowViewerWithStatus: () => <div data-testid="dag-view" />,
}))
vi.mock('@/components/workspace/run-log/run-log-console', () => ({
  RunLogConsole: ({
    focus,
    onFocusChange,
  }: {
    focus?: string | null
    onFocusChange?: (id: string | null) => void
  }) => (
    <div>
      <span data-testid="log-focus">{focus ?? 'ALL'}</span>
      <button type="button" data-testid="rail-node" onClick={() => onFocusChange?.('ticket-01')}>
        ticket-01
      </button>
    </div>
  ),
}))

import { WorkflowWindow } from '../workflow-window'

beforeEach(() => { vi.clearAllMocks() })

describe('WorkflowWindow', () => {
  it('日志 tab 点左侧通道 → 右侧日志收到聚焦（focus 受控）', async () => {
    const user = userEvent.setup()
    render(
      <WorkflowWindow workspaceId="w1" executionId="e1" title="运行" onClose={() => {}} />,
    )

    await user.click(screen.getByRole('tab', { name: /日志/ }))
    await waitFor(() => expect(screen.getByTestId('log-focus')).toBeTruthy())
    expect(screen.getByTestId('log-focus').textContent).toBe('ALL')

    await user.click(screen.getByTestId('rail-node'))
    expect(screen.getByTestId('log-focus').textContent).toBe('ticket-01')
  })

  it('关闭按钮是 macOS 红点，点击回调 onClose', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<WorkflowWindow workspaceId="w1" executionId="e1" onClose={onClose} />)
    const btn = screen.getByRole('button', { name: '关闭工作流窗口' })
    await user.click(btn)
    expect(onClose).toHaveBeenCalled()
  })
})
