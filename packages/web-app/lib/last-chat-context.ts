// 最近一次聚焦的对话上下文 —— 刷新恢复的单一来源。
//
// 对话桌面（/）没有把 session/task 编进 URL：刷新后 activeSessionId/activeTask
// 都回到初始值，useAgentSessions 会把「最新的 main 会话」当成默认对话。于是
// 正在运行的任务或 task-author 会话会被丢掉 —— 用户得再去侧栏点一次才能看到
// 运行中。这里把最后一次显式选择落盘，启动时按它恢复（会话由 useAgentSessions
// 恢复，任务由 ChatTab 恢复）。

export type LastChatContext =
  | { kind: 'task'; taskId: string }
  | { kind: 'session'; sessionId: string }

export const LAST_CHAT_CONTEXT_KEY = 'octopus.chat.lastContext.v1'

export function readLastChatContext(): LastChatContext | null {
  try {
    const raw = window.localStorage.getItem(LAST_CHAT_CONTEXT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<LastChatContext> | null
    if (!parsed || typeof parsed !== 'object') return null
    if (parsed.kind === 'task' && typeof parsed.taskId === 'string' && parsed.taskId) {
      return { kind: 'task', taskId: parsed.taskId }
    }
    if (parsed.kind === 'session' && typeof parsed.sessionId === 'string' && parsed.sessionId) {
      return { kind: 'session', sessionId: parsed.sessionId }
    }
    return null
  } catch {
    return null
  }
}

/** Persist the focused context; `null` forgets it (new chat / deleted). */
export function writeLastChatContext(value: LastChatContext | null): void {
  try {
    if (!value) {
      window.localStorage.removeItem(LAST_CHAT_CONTEXT_KEY)
      return
    }
    window.localStorage.setItem(LAST_CHAT_CONTEXT_KEY, JSON.stringify(value))
  } catch {
    /* storage unavailable — restore is a convenience, not correctness */
  }
}
