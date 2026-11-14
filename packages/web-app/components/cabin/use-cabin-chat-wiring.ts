'use client'

// S5 提取：舱聊天宿主共用的接线（会话解析 / shared / command / 事件桥）。
//
// CabinChatHost（旧舱，桌面内与 /cabin/:id）与 CockpitChatHost（全域座舱）
// 需要同一套东西：舱主会话钉住 + 主会话元数据补齐 + ChatPaneShared 组装 +
// nonce 指令下发 + `octopus:open-task` / `octopus:cabin-main-chat` 事件桥。
// 抽出来之后两边行为逐字一致；各宿主只负责自己的布局与 ChatPane 外壳。
//
// 舱主对话不是一个「会话」：服务端 listSessions 不返回它，但 chat 底座仍需要
// 它的 workspace/title（SSE wake 订阅、作业坞标题），所以这里单独取一次，
// 只并进喂给 ChatPane 的 shared.sessions，不进左栏的会话列表。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useChatSessions } from '@/components/providers/chat-sessions'
import { useChatTasks } from '@/hooks/use-chat-tasks'
import { useRunningAgents } from '@/hooks/use-running-agents'
import { useOrgs } from '@/hooks/useOrgs'
import { useWorkspaces } from '@/hooks/use-workspaces'
import { getSession } from '@/lib/agent/api'
import type { AgentSession } from '@/lib/agent/types'
import { getTask, type TaskView } from '@/lib/tasks-api'
import { readRememberedTaskOrg, resolveTaskOrg } from '@/lib/task-org'
import type {
  ChatPaneAction,
  ChatPaneCommand,
  ChatPaneShared,
  PendingTaskSession,
} from '@/components/agent/chat/ChatPane'
import { useCabinContext } from './cabin-provider'

export interface CabinChatWiring {
  sessionId: string | null
  setSessionId: (id: string | null) => void
  activeTask: TaskView | null
  setActiveTask: React.Dispatch<React.SetStateAction<TaskView | null>>
  pendingTaskSession: PendingTaskSession | null
  setPendingTaskSession: React.Dispatch<React.SetStateAction<PendingTaskSession | null>>
  command: ChatPaneCommand | null
  issueCommand: (action: ChatPaneAction) => void
  mainSessionId: string | null
  paneSessions: AgentSession[]
  shared: ChatPaneShared
  handleDeleteSession: (id: string) => Promise<void>
  /** 左栏原样用的全局会话/任务/运行态（paneSessions 只喂 ChatPane）。 */
  sessions: AgentSession[]
  sessionsLoading: boolean
  chatTasks: TaskView[]
  chatTasksLoading: boolean
  runningAgents: ReturnType<typeof useRunningAgents>
  renameSession: ReturnType<typeof useChatSessions>['renameSession']
}

export interface CabinChatWiringOptions {
  /** 侧栏宽度（折叠时 0）—— 只参与 shared，不影响任何接线行为。 */
  sidebarWidth: number
}

export function useCabinChatWiring({ sidebarWidth }: CabinChatWiringOptions): CabinChatWiring {
  const { cabin } = useCabinContext()
  const {
    sessions, loading: sessionsLoading, createNewSession, renameSession, removeSession,
    updateSessionTitle, refetch: refetchSessions,
  } = useChatSessions()
  const { tasks: chatTasks, loading: chatTasksLoading, refresh: refreshChatTasks } = useChatTasks()
  const runningAgents = useRunningAgents()
  const { orgs: appOrgs } = useOrgs()
  const { workspaces } = useWorkspaces()

  const [sessionId, setSessionId] = useState<string | null>(null)
  // 舱主会话的元数据（workspace/title）。服务端会话列表不返回它，ChatPane 需要
  // 它来算 SSE wake 订阅与作业坞标题 —— 只喂 chat 底座，不进左栏会话列表。
  const [mainSession, setMainSession] = useState<AgentSession | null>(null)
  const [activeTask, setActiveTask] = useState<TaskView | null>(null)
  const [pendingTaskSession, setPendingTaskSession] = useState<PendingTaskSession | null>(null)
  const [command, setCommand] = useState<ChatPaneCommand | null>(null)
  const nonceRef = useRef(0)

  // 主会话钉住：舱加载完成 / 切换舱时落一次。用户经 select-task 打开任务线程
  // 后不再强拉回来（ChatPane 自己管 sessionId）。
  const mainSessionId = cabin?.main_session_id ?? null
  useEffect(() => {
    setSessionId(mainSessionId)
    setActiveTask(null)
    setPendingTaskSession(null)
  }, [mainSessionId])

  // 舱主会话只在舱里可达（不在会话列表）：按 id 单独取一次元数据。
  useEffect(() => {
    let cancelled = false
    setMainSession(null)
    if (!mainSessionId) return
    getSession(mainSessionId)
      .then((detail) => {
        if (!cancelled) setMainSession(detail)
      })
      .catch(() => {
        // 取不到就不并进去：ChatPane 退回舱自身字段（dock/标题兜底）。
      })
    return () => { cancelled = true }
  }, [mainSessionId])

  // 左栏「会话」段不刷这条列表也行，但任务/会话段的其它会话照常靠它刷新。
  useEffect(() => {
    void refetchSessions()
  }, [refetchSessions])

  // ChatPane 的会话集合：全局列表 + 舱主会话（若服务端列表里还没有）。
  const paneSessions = useMemo(() => {
    if (!mainSession) return sessions
    if (sessions.some((session) => session.id === mainSession.id)) return sessions
    return [mainSession, ...sessions]
  }, [sessions, mainSession])

  const issueCommand = useCallback((action: ChatPaneAction) => {
    nonceRef.current += 1
    setCommand({ ...action, nonce: nonceRef.current })
  }, [])

  const preferredOrg = useMemo(
    () => cabin?.org ?? resolveTaskOrg({
      orgs: appOrgs.map((o) => o.name),
      remembered: readRememberedTaskOrg(),
      recentTaskOrgs: [...chatTasks]
        .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))
        .map((task) => task.repo_group),
    }),
    [cabin?.org, appOrgs, chatTasks],
  )

  const shared = useMemo<ChatPaneShared>(() => ({
    sessions: paneSessions,
    sessionsLoading,
    createNewSession,
    updateSessionTitle,
    refreshSessions: refetchSessions,
    chatTasks,
    chatTasksLoading,
    refreshChatTasks,
    runningAgents,
    appOrgs: appOrgs.map((org) => org.name),
    workspaces,
    preferredOrg,
    sidebarWidth,
  }), [
    paneSessions, sessionsLoading, createNewSession, updateSessionTitle, refetchSessions,
    chatTasks, chatTasksLoading, refreshChatTasks, runningAgents, appOrgs, workspaces,
    preferredOrg, sidebarWidth,
  ])

  // 座舱 attention / 外部入口打开任务：与桌面 ChatTab 同一事件协议。
  useEffect(() => {
    const onOpenTask = (event: Event) => {
      const detail = (event as CustomEvent<{ taskId?: string; view?: 'acceptance' | 'changes' }>).detail
      const taskId = detail?.taskId
      if (!taskId) return
      getTask(taskId)
        .then((task) => {
          issueCommand({
            type: 'select-task',
            task,
            ...(detail?.view === 'acceptance' ? { module: 'acceptance' as const } : {}),
            ...(detail?.view === 'changes' ? { module: 'changes' as const } : {}),
          })
          void refreshChatTasks()
        })
        .catch(() => toast.error('任务不存在或已被删除'))
    }
    window.addEventListener('octopus:open-task', onOpenTask)
    return () => window.removeEventListener('octopus:open-task', onOpenTask)
  }, [issueCommand, refreshChatTasks])

  // 作业详情「去主对话」：回到舱主会话（不从任务线程强拉，只在显式点按时切回）。
  useEffect(() => {
    const onMainChat = () => {
      if (mainSessionId) issueCommand({ type: 'select-session', sessionId: mainSessionId })
    }
    window.addEventListener('octopus:cabin-main-chat', onMainChat)
    return () => window.removeEventListener('octopus:cabin-main-chat', onMainChat)
  }, [issueCommand, mainSessionId])

  const handleDeleteSession = useCallback(async (id: string) => {
    await removeSession(id)
    if (sessionId === id) setSessionId(mainSessionId)
  }, [removeSession, sessionId, mainSessionId])

  return {
    sessionId,
    setSessionId,
    activeTask,
    setActiveTask,
    pendingTaskSession,
    setPendingTaskSession,
    command,
    issueCommand,
    mainSessionId,
    paneSessions,
    shared,
    handleDeleteSession,
    sessions,
    sessionsLoading,
    chatTasks,
    chatTasksLoading,
    runningAgents,
    renameSession,
  }
}
