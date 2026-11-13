// packages/web-app/components/cabin/__tests__/CabinChatHost.test.tsx
//
// 舱 chat 的会话边界（2026-11-13 用户反馈）：舱主对话是舱绑定的单线程，不是
// 左栏「会话」里的一行。服务端会话列表已经把它过滤掉；这里钉客户端的两半：
//   1. 左栏 ChatSidebar 拿到的 sessions 里没有舱主会话；
//   2. ChatPane 的 shared.sessions 里仍有它（SSE wake / 作业坞标题要用）——
//      由 CabinChatHost 按 main_session_id 单独取一次补上。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'

const h = vi.hoisted(() => ({
  paneProps: null as null | Record<string, any>,
  sidebarProps: null as null | Record<string, any>,
  getSession: vi.fn(),
  cabin: {
    id: 'cabin-1', name: 'Aurora', path: '/tmp/a', workspace_id: 'ws-1',
    main_session_id: 'sess-cabin', requirements: '', status: 'active',
    mainline_strategy: 'clean-main', org: null, focused_job_id: null, version: 1,
    created_at: '', updated_at: '', last_active_at: null, archived_at: null,
  },
  sessions: [{
    id: 'sess-free', title: '普通对话', clone_name: null, perspective_clone_name: null,
    session_type: 'main', created_at: '', updated_at: '', last_message_at: null, is_active: true,
  }],
}))

vi.mock('../cabin-provider', () => ({
  useCabinContext: () => ({
    cabinId: 'cabin-1',
    cabin: h.cabin,
    view: {
      cabin: h.cabin,
      attention: [],
      health: { running: 0, queued: 0, dormant: 0, workers: 0, max: 4 },
      iterations: [],
      open_findings: 0,
    },
    initState: null,
    loading: false,
    error: null,
    refresh: vi.fn(),
    openWindows: [],
    minimizedWindows: [],
    focusedWindow: null,
    windows: {},
    openModule: vi.fn(),
    closeModule: vi.fn(),
    minimizeModule: vi.fn(),
    focusModule: vi.fn(),
    placeModule: vi.fn(),
    moveModule: vi.fn(),
    resizeModule: vi.fn(),
  }),
}))
vi.mock('../CockpitProvider', () => ({ useCockpit: () => ({ setStreaming: vi.fn() }) }))
vi.mock('../CabinModulesLayer', () => ({
  CabinModulesLayer: () => <div data-testid="modules-layer" />,
}))
vi.mock('../CabinAtmosphere', () => ({ CabinAtmosphere: () => null }))
vi.mock('../CabinCrew', () => ({ CabinCrew: () => null }))
vi.mock('@/components/agent/chat/chat-sidebar', () => ({
  ChatSidebar: (props: Record<string, any>) => {
    h.sidebarProps = props
    return <aside data-testid="chat-sidebar" />
  },
}))
vi.mock('@/components/agent/chat/ChatPane', () => ({
  ChatPane: (props: Record<string, any>) => {
    h.paneProps = props
    return <div data-testid="chat-pane" />
  },
}))
vi.mock('@/components/providers/chat-sessions', () => ({
  useChatSessions: () => ({
    sessions: h.sessions,
    loading: false,
    createNewSession: vi.fn(),
    renameSession: vi.fn(),
    removeSession: vi.fn(),
    updateSessionTitle: vi.fn(),
    refetch: vi.fn(),
  }),
}))
vi.mock('@/hooks/use-chat-tasks', () => ({
  useChatTasks: () => ({ tasks: [], loading: false, refresh: vi.fn() }),
}))
vi.mock('@/hooks/use-running-agents', () => ({ useRunningAgents: () => [] }))
vi.mock('@/hooks/useOrgs', () => ({ useOrgs: () => ({ orgs: [] }) }))
vi.mock('@/hooks/use-workspaces', () => ({ useWorkspaces: () => ({ workspaces: [] }) }))
vi.mock('@/hooks/use-cabins', () => ({ useCabins: () => ({ cabins: [], loading: false }) }))
vi.mock('@/lib/app-navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }))
vi.mock('@/lib/agent/api', () => ({ getSession: h.getSession }))

import { CabinChatHost } from '../CabinChatHost'

describe('CabinChatHost — 舱主会话的会话边界', () => {
  beforeEach(() => {
    h.paneProps = null
    h.sidebarProps = null
    h.getSession.mockReset()
    h.getSession.mockResolvedValue({
      ...h.sessions[0],
      id: 'sess-cabin',
      title: 'Aurora · 舱主对话',
      workspace_id: 'ws-1',
    })
  })

  it('左栏会话列表不含舱主会话，ChatPane 的 shared.sessions 含它', async () => {
    render(<CabinChatHost />)

    await waitFor(() => expect(h.getSession).toHaveBeenCalledWith('sess-cabin'))
    await waitFor(() => {
      expect(h.paneProps?.shared.sessions.map((s: { id: string }) => s.id)).toContain('sess-cabin')
    })

    expect(h.paneProps?.sessionId).toBe('sess-cabin')
    expect(h.sidebarProps?.sessions.map((s: { id: string }) => s.id)).toEqual(['sess-free'])
  })

  // 2026-11-13 用户要求：舱模块段只属于舱主对话。舱内从跳转点打开任务线程时，
  // 作业坞必须退回桌面原样（坞内容与舱隔离），层级仍在舱浮窗之上。
  it('舱内打开任务线程：坞退回原样（不传舱模块），层级仍抬高', async () => {
    render(<CabinChatHost />)
    await waitFor(() => expect(h.paneProps?.sessionId).toBe('sess-cabin'))
    expect((h.paneProps?.dockCabinModules ?? []).length).toBeGreaterThan(0)
    expect(h.paneProps?.dockElevated).toBe(true)

    await act(async () => {
      h.paneProps?.setActiveTask({ id: 'task-1', name: '示例任务' })
    })

    await waitFor(() => expect(h.paneProps?.dockCabinModules).toBeUndefined())
    expect(h.paneProps?.dockCabinMoreModules).toBeUndefined()
    expect(h.paneProps?.dockElevated).toBe(true)
  })
})
