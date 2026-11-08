// 对话分屏（2026-11-08）：左右两栏、右栏选择器、L/R 标记、退出保留焦点栏、
// 窄屏自动退出。这里走 <ChatTab/> 真组件，只用 mock 把网络/重面板挡掉。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

const viewportBox = vi.hoisted(() => ({ breakpoint: 'wide' as 'wide' | 'medium' | 'narrow' }))
const splitStore = vi.hoisted(() => {
  const key = 'octopus.chat.split.v1'
  return {
    enable() {
      localStorage.setItem(key, JSON.stringify({
        enabled: true, ratio: 0.5, focused: 'left', left: null, right: null,
      }))
    },
    stored(): Record<string, unknown> | null {
      const raw = localStorage.getItem(key)
      return raw ? JSON.parse(raw) as Record<string, unknown> : null
    },
  }
})

vi.mock('@/lib/agent/api', () => ({
  listClones: vi.fn().mockResolvedValue({ clones: [], total: 0 }),
  listSkills: vi.fn().mockResolvedValue({ skills: [] }),
  setSessionRole: vi.fn().mockResolvedValue({ active_expert: null }),
  getSessionRole: vi.fn().mockResolvedValue({ active_expert: null, active_kind: 'agent', expert: null, clone: null }),
  listSessions: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  createSession: vi.fn(),
  updateSession: vi.fn(),
  deleteSession: vi.fn(),
  getSession: vi.fn(),
  getSessionRunning: vi.fn().mockResolvedValue({ running: false }),
  getSessionSlashCommands: vi.fn().mockResolvedValue({ commands: [] }),
  chatStream: vi.fn(),
  stopChat: vi.fn().mockResolvedValue({ success: true }),
  createCloneSession: vi.fn(),
  cloneChatStream: vi.fn(),
  stopCloneChat: vi.fn(),
  getCloneSession: vi.fn(),
  getCloneSessionRunning: vi.fn().mockResolvedValue({ running: false }),
  recordCardDecision: vi.fn().mockResolvedValue({}),
  listSessionSubagents: vi.fn().mockResolvedValue({ items: [] }),
}))

vi.mock('@/hooks/useAgentChat', () => ({
  useAgentChat: () => ({
    messages: [],
    streaming: false,
    streamContent: '',
    streamThinking: '',
    streamTimeline: [],
    isThinking: false,
    toolCalls: [],
    pendingConfirm: null,
    error: null,
    statusMessage: '',
    backgroundTasks: [],
    contextUsage: null,
    slashCommands: [],
    sendMessage: vi.fn(),
    stopGenerate: vi.fn(),
    handleConfirm: vi.fn(),
    loadMessages: vi.fn(),
    steer: vi.fn(),
    steeringRef: { current: false },
    resumeStreaming: false,
    checkAndResume: vi.fn(),
    streamingSessionId: null,
    turnStartedAt: null,
  }),
}))

const SESSIONS = [
  {
    id: 's-a', title: '会话 A', clone_name: null, perspective_clone_name: null,
    session_type: 'main', created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z',
    last_message_at: '2026-11-01T00:00:00Z', is_active: true, workspace_id: null, cwd: null,
  },
  {
    id: 's-b', title: '会话 B', clone_name: null, perspective_clone_name: null,
    session_type: 'main', created_at: '2026-11-02T00:00:00Z', updated_at: '2026-11-02T00:00:00Z',
    last_message_at: '2026-11-02T00:00:00Z', is_active: true, workspace_id: null, cwd: null,
  },
]

vi.mock('@/components/providers/chat-sessions', async () => {
  const React = await import('react')
  return {
    useChatSessions: () => {
      const [activeSessionId, setActiveSessionId] = React.useState<string | null>('s-a')
      return {
        sessions: SESSIONS,
        activeSessionId,
        setActiveSessionId,
        loading: false,
        createNewSession: async () => null,
        renameSession: async () => {},
        removeSession: async () => {},
        updateSessionTitle: () => {},
        refetch: async () => {},
      }
    },
  }
})

vi.mock('@/hooks/use-viewport', () => ({
  useViewport: () => ({
    width: viewportBox.breakpoint === 'wide' ? 1440 : 900,
    height: 900,
    breakpoint: viewportBox.breakpoint,
  }),
}))

vi.mock('@/hooks/useSessionUsage', () => ({ useSessionUsage: () => null }))
vi.mock('@/hooks/useSessionLedger', () => ({ useSessionLedger: () => ({ aggregates: null, calls: [] }) }))
vi.mock('@/hooks/useTaskUsage', () => ({ useTaskUsage: () => null }))
vi.mock('@/hooks/use-chat-tasks', () => ({
  useChatTasks: () => ({ tasks: [], loading: false, refresh: vi.fn(async () => {}) }),
}))
vi.mock('@/hooks/use-running-agents', () => ({ useRunningAgents: () => [] }))
vi.mock('@/hooks/useOrgs', () => ({ useOrgs: () => ({ orgs: [], loading: false, error: null, refetch: vi.fn() }) }))
vi.mock('@/hooks/use-workspaces', () => ({
  useWorkspaces: () => ({ workspaces: [], selectedId: '', setSelectedId: vi.fn(), loading: false }),
}))
vi.mock('@/components/chat-workbench/inspector-activity', () => ({
  useActivitySnapshot: () => ({ count: 0, items: [] }),
}))
vi.mock('@/components/chat-workbench/task-modules-layer', () => ({
  TaskModulesLayer: () => null,
}))
vi.mock('@/components/workspace/workspace-explorer-dock', () => ({
  WorkspaceExplorerDock: () => <div data-testid="dock" />,
}))

import { ChatTab } from '../ChatTab'
import { resetChatSplitForTests } from '@/lib/chat-split'

const panes = () => Array.from(document.querySelectorAll<HTMLElement>('[data-chat-pane]'))

beforeEach(() => {
  localStorage.clear()
  resetChatSplitForTests()
  viewportBox.breakpoint = 'wide'
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ items: [], groups: [], tasks: [], orgs: [], total: 0 }),
  })))
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetChatSplitForTests()
})

describe('ChatTab — 分屏', () => {
  it('默认单栏，没有分隔线', async () => {
    render(<ChatTab />)
    await waitFor(() => expect(panes().length).toBe(1))
    expect(screen.queryByTestId('chat-split-divider')).not.toBeInTheDocument()
  })

  it('开启后渲染左右两栏，右栏先给会话选择器', async () => {
    splitStore.enable()
    render(<ChatTab />)

    await waitFor(() => expect(panes().length).toBe(2))
    expect(screen.getByTestId('chat-split-divider')).toBeInTheDocument()
    expect(screen.getByTestId('pane-picker-new')).toBeInTheDocument()
    expect(screen.getByTestId('pane-chip-left')).toBeInTheDocument()
    expect(screen.getByTestId('pane-chip-right')).toBeInTheDocument()
    // 左栏沿用全局 activeSessionId（s-a）
    expect(within(panes()[0]).getByText('会话 A')).toBeInTheDocument()
  })

  it('从选择器打开会话 → 右栏接管、侧栏行标 R', async () => {
    splitStore.enable()
    render(<ChatTab />)
    await waitFor(() => expect(panes().length).toBe(2))

    const options = await screen.findAllByTestId('pane-picker-session')
    // 选择器按最近消息倒序：s-b（11-02）在前
    fireEvent.click(options[0])

    await waitFor(() => {
      expect(screen.queryByTestId('pane-picker-new')).not.toBeInTheDocument()
    })
    expect(document.querySelector('[data-session-id="s-b"]')?.getAttribute('data-pane')).toBe('right')
    expect(within(panes()[1]).getByText('会话 B')).toBeInTheDocument()
  })

  it('选择器里点「已在左栏」的会话 = 聚焦左栏，不重复打开', async () => {
    splitStore.enable()
    render(<ChatTab />)
    await waitFor(() => expect(panes().length).toBe(2))

    const occupied = document.querySelector<HTMLElement>('[data-testid="pane-picker-session"][data-occupied="true"]')
    expect(occupied).not.toBeNull()
    fireEvent.click(occupied!)

    await waitFor(() => expect(panes()[0].getAttribute('data-focused')).toBe('true'))
    expect(screen.getByTestId('pane-picker-new')).toBeInTheDocument()
    expect(document.querySelector('[data-session-id="s-a"]')?.getAttribute('data-pane')).toBe('left')
  })

  it('退出分屏 = 保留焦点栏：焦点在右时右栏内容搬到剩下的一栏', async () => {
    splitStore.enable()
    render(<ChatTab />)
    await waitFor(() => expect(panes().length).toBe(2))

    const options = await screen.findAllByTestId('pane-picker-session')
    fireEvent.click(options[0])
    await waitFor(() => expect(within(panes()[1]).getByText('会话 B')).toBeInTheDocument())

    // 点右栏 → 焦点切到右栏
    fireEvent.pointerDown(panes()[1])
    fireEvent.click(within(panes()[1]).getByLabelText('退出分屏（保留当前焦点栏）'))

    await waitFor(() => expect(panes().length).toBe(1))
    await waitFor(() => {
      const saved = splitStore.stored()
      expect(saved?.enabled).toBe(false)
      expect(saved?.left).toBe('s-b')
      expect(saved?.right).toBeNull()
    })
    expect(document.querySelector('[data-session-id="s-b"]')?.getAttribute('aria-current')).toBe('page')
  })

  it('焦点在空的右栏时退出分屏，保留左栏内容（不清成空白）', async () => {
    splitStore.enable()
    render(<ChatTab />)
    await waitFor(() => expect(panes().length).toBe(2))

    fireEvent.pointerDown(panes()[1])
    fireEvent.click(within(panes()[1]).getByLabelText('退出分屏（保留当前焦点栏）'))
    await waitFor(() => expect(panes().length).toBe(1))
    await waitFor(() => {
      const saved = splitStore.stored()
      expect(saved?.enabled).toBe(false)
      expect(saved?.left).toBe('s-a')
    })
    expect(document.querySelector('[data-session-id="s-a"]')?.getAttribute('aria-current')).toBe('page')
  })

  it('窄屏自动退出分屏，开关写回 false', async () => {
    viewportBox.breakpoint = 'narrow'
    splitStore.enable()
    render(<ChatTab />)

    await waitFor(() => expect(panes().length).toBe(1))
    await waitFor(() => expect(splitStore.stored()?.enabled).toBe(false))
  })

  it('焦点栏切换对侧栏可见：点击右栏后 active 行跟着变', async () => {
    splitStore.enable()
    render(<ChatTab />)
    await waitFor(() => expect(panes().length).toBe(2))

    fireEvent.pointerDown(panes()[1])
    await waitFor(() => {
      expect(panes()[0].getAttribute('data-focused')).toBeNull()
      expect(panes()[1].getAttribute('data-focused')).toBe('true')
    })
  })
})
