// 新建作战舱右页（CabinCreateHero）接管对话区时，左栏导航必须先收起它。
//
// 2026-11-16 用户实测：进「新建作战舱」页后，点左栏会话 / 任务 / 「新建对话」
// 都没反应 —— 右页把 ChatPane 整块卸掉了，指令发给不存在的栏就被吞掉。
// 这里锁住：任何导航都会先 onCloseDraft（草稿仍留在左栏），再落到 ChatPane。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { useState } from 'react'

const viewportBox = vi.hoisted(() => ({ breakpoint: 'wide' as 'wide' | 'medium' | 'narrow' }))

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
  injectChat: vi.fn().mockResolvedValue({ injected: true }),
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

import { ChatTab, type ChatTabCabinBridge } from '../ChatTab'
import { emptyCabinDraft } from '@/lib/cabin-draft'
import { resetChatSplitForTests } from '@/lib/chat-split'
import { readLastChatContext } from '@/lib/last-chat-context'

const DRAFT = { ...emptyCabinDraft(), requirements: '做一个电商后台' }

function Harness({ onCloseDraft }: { onCloseDraft: () => void }) {
  const [draftOpen, setDraftOpen] = useState(true)
  const bridge: ChatTabCabinBridge = {
    cabins: [],
    draft: DRAFT,
    draftOpen,
    onSelectCabin: vi.fn(),
    onCreateCabin: vi.fn(),
    onUpdateDraft: vi.fn(),
    onCloseDraft: () => { onCloseDraft(); setDraftOpen(false) },
    onCancelDraft: vi.fn(),
    onRenameCabin: vi.fn(),
    onDeleteCabin: vi.fn(),
    onCabinCreated: vi.fn(),
  }
  return <ChatTab cabinBridge={bridge} />
}

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

describe('ChatTab — 新建作战舱页接管时的导航', () => {
  it('新建页打开 → 没有 ChatPane；点左栏会话 → 先收起新建页再开会话', async () => {
    const onCloseDraft = vi.fn()
    render(<Harness onCloseDraft={onCloseDraft} />)

    expect(await screen.findByTestId('cabin-create-hero')).toBeInTheDocument()
    expect(panes()).toHaveLength(0)

    fireEvent.click(document.querySelector('[data-session-id="s-b"]')!)

    await waitFor(() => expect(onCloseDraft).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByTestId('cabin-create-hero')).not.toBeInTheDocument())
    await waitFor(() => expect(panes()).toHaveLength(1))
    // 收起新建页后 ChatPane 才挂载；指令不能丢，要真的把会话切过去。
    await waitFor(() => {
      expect(readLastChatContext()).toMatchObject({ kind: 'session', sessionId: 's-b' })
    })
  })

  it('跨应用的「新建任务」事件同样先收起新建页（指令不再被吞掉）', async () => {
    const onCloseDraft = vi.fn()
    render(<Harness onCloseDraft={onCloseDraft} />)

    await screen.findByTestId('cabin-create-hero')
    fireEvent(window, new Event('octopus:new-task'))

    await waitFor(() => expect(onCloseDraft).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByTestId('cabin-create-hero')).not.toBeInTheDocument())
    expect(panes()).toHaveLength(1)
  })
})
