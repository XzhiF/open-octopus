// S5 · 开/关浮窗不卸载 ChatPane。
//
// 结构：CockpitShell 里 Host / Window / CommandBar 是三个兄弟节点；Host 通过
// 模块级 chat-slots 拿到 Window 的 transcript 挂载点。Window 的 ✕/— 只改
// chatWindow 状态（root display:none），所以挂载点节点不换 → ChatPane 只挂一次。
//
// 这里 ChatPane 用挂载计数器替身（真实 composer/portal 由 composer-portal.test
// 覆盖）；Window / CommandBar / Provider 都是真组件。

import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ mounts: 0, unmounts: 0, reports: [] as string[] }))

vi.mock('@/components/cabin/cabin-provider', () => ({
  useCabinContext: () => ({
    cabinId: 'cabin-1',
    cabin: {
      id: 'cabin-1', name: 'Aurora', path: '/tmp/a', workspace_id: 'ws-1',
      main_session_id: 'sess-1', requirements: '', status: 'active',
    },
    view: null,
    openWindows: [],
    minimizedWindows: [],
    openModule: vi.fn(),
  }),
}))

vi.mock('@/components/cabin/CockpitProvider', () => ({
  useCockpit: () => ({ setStreaming: vi.fn() }),
}))

vi.mock('@/components/cabin/use-cabin-chat-wiring', () => ({
  useCabinChatWiring: () => ({
    sessionId: 'sess-1',
    setSessionId: vi.fn(),
    activeTask: null,
    setActiveTask: vi.fn(),
    pendingTaskSession: null,
    setPendingTaskSession: vi.fn(),
    command: null,
    issueCommand: vi.fn(),
    mainSessionId: 'sess-1',
    paneSessions: [],
    shared: {
      sessions: [], sessionsLoading: false, createNewSession: async () => null,
      updateSessionTitle: vi.fn(), refreshSessions: async () => {},
      chatTasks: [], chatTasksLoading: false, refreshChatTasks: async () => {},
      runningAgents: [], appOrgs: [], workspaces: [], preferredOrg: '', sidebarWidth: 0,
    },
    handleDeleteSession: async () => {},
  }),
}))

vi.mock('@/components/agent/chat/ChatPane', async () => {
  const React = await import('react')
  return {
    ChatPane: (props: { onTelemetry?: (api: unknown) => void }) => {
      React.useEffect(() => {
        h.mounts += 1
        return () => { h.unmounts += 1 }
      }, [])
      React.useEffect(() => {
        props.onTelemetry?.({
          model: 'pro', effort: 'high', contextWindow: '200k', streaming: false,
          queueDepth: 0, canSend: true, contextUsage: null, usage: null,
          submit() {}, stop() {}, setModel() {}, setEffort() {}, setContext() {},
        })
        // 只上报一次：模拟「值没变就不该再报」。
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])
      return React.createElement('div', { 'data-testid': 'chat-pane-mock' })
    },
  }
})

import { CockpitStateProvider, useCockpitState } from '../../state/CockpitStateProvider'
import { CockpitChatHost } from '../CockpitChatHost'
import { CockpitChatWindow } from '../CockpitChatWindow'
import { CockpitCommandBar } from '../CockpitCommandBar'
import { resetChatSlots } from '../chat-slots'

function Controls() {
  const { chatWindow, chat } = useCockpitState()
  return (
    <div>
      <button type="button" onClick={() => chatWindow.set({ open: true })}>open</button>
      <button type="button" onClick={() => chatWindow.set({ open: false })}>close</button>
      <button type="button" onClick={() => chatWindow.set({ mini: true })}>mini</button>
      <span data-testid="telemetry-model">{chat?.model ?? 'null'}</span>
    </div>
  )
}

function renderShell() {
  return render(
    <CockpitStateProvider entryCabinId="cabin-1">
      <Controls />
      <CockpitChatHost entryCabinId="cabin-1" />
      <CockpitChatWindow />
      <CockpitCommandBar entryCabinId="cabin-1" />
    </CockpitStateProvider>,
  )
}

describe('CockpitChatHost / CockpitChatWindow — 全程挂载', () => {
  beforeEach(() => {
    h.mounts = 0
    h.unmounts = 0
    resetChatSlots()
  })

  it('开窗 / 关窗 / 收起来回切，ChatPane 只挂载一次', async () => {
    renderShell()

    // transcript 槽由 Window 注册；Host 拿到后才 portal ChatPane。
    await waitFor(() => expect(screen.getByTestId('chat-pane-mock')).toBeTruthy())
    expect(h.mounts).toBe(1)

    const win = screen.getByTestId('cockpit-chat-window')
    expect(win.getAttribute('data-open')).toBe('false')

    fireEvent.click(screen.getByText('open'))
    await waitFor(() => expect(win.getAttribute('data-open')).toBe('true'))
    fireEvent.click(screen.getByText('close'))
    await waitFor(() => expect(win.getAttribute('data-open')).toBe('false'))
    fireEvent.click(screen.getByText('mini'))
    await waitFor(() => expect(win.getAttribute('data-mini')).toBe('true'))

    expect(h.mounts).toBe(1)
    expect(h.unmounts).toBe(0)
    // 关窗后 transcript 节点仍在（只是 display:none），composer 槽也还在。
    expect(screen.getByTestId('cockpit-chat-transcript')).toBeTruthy()
    expect(screen.getByTestId('cockpit-composer-slot').getAttribute('data-has-composer')).toBe('true')
  })

  it('onTelemetry 透传到 CockpitState（舰桥/底栏读的 chat）', async () => {
    renderShell()
    await waitFor(() => expect(screen.getByTestId('telemetry-model')).toHaveTextContent('pro'))
  })

  it('底栏槽 pointerdown → 展开浮窗（跨 React 树 portal，靠原生 DOM 监听）', async () => {
    renderShell()
    const win = screen.getByTestId('cockpit-chat-window')
    expect(win.getAttribute('data-open')).toBe('false')
    fireEvent.pointerDown(screen.getByTestId('cockpit-composer-slot'))
    await waitFor(() => expect(win.getAttribute('data-open')).toBe('true'))
  })
})
