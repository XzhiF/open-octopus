'use client'

// 会话身份（v59：身份 = 分身）的读取 / 切换，单一实现。
//
// 三处宿主共用：主对话（agent 会话）、task-author（clone 会话）、任务台
// （task 会话）。切换是 append-only 角色卡：对后续每一轮生效。
// 与 @ 委派（一次性子代理会诊）是两件事，别混。

import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import * as agentApi from '@/lib/agent/api'
import { getTaskChatRole, setTaskChatRole } from '@/lib/tasks-api'

export type IdentityScope =
  | { kind: 'agent'; sessionId: string | null }
  | { kind: 'clone'; cloneName: string; sessionId: string | null }
  | { kind: 'task'; taskId: string | null }

interface RoleState {
  active_expert: string | null
  clone?: { id: string; display_name: string } | null
  expert?: { name: string } | null
}

export interface SessionIdentity {
  /** 当前长期身份的 clone name；null = 基础身份。 */
  activeName: string | null
  /** 当前身份的展示名；null = 基础身份。 */
  label: string | null
  /** 切换长期身份（null = 恢复基础）。成功返回 true。 */
  switchTo: (cloneName: string | null) => Promise<boolean>
}

export function useSessionIdentity(scope: IdentityScope): SessionIdentity {
  const [role, setRole] = useState<RoleState | null>(null)

  // 依赖只取原始值：调用方每轮都会新建 scope 对象，用对象进 deps 会无限重取。
  const kind = scope.kind
  const sessionId = scope.kind === 'task' ? null : scope.sessionId
  const cloneName = scope.kind === 'clone' ? scope.cloneName : null
  const taskId = scope.kind === 'task' ? scope.taskId : null
  const enabled = kind === 'task' ? !!taskId : !!sessionId

  const load = useCallback(async () => {
    if (!enabled) {
      setRole(null)
      return
    }
    try {
      const next = kind === 'task'
        ? await getTaskChatRole(taskId!)
        : kind === 'clone'
          ? await agentApi.getCloneSessionRole(cloneName!, sessionId!)
          : await agentApi.getSessionRole(sessionId!)
      setRole(next as RoleState)
    } catch {
      setRole(null)
    }
  }, [enabled, kind, taskId, cloneName, sessionId])

  useEffect(() => {
    void load()
  }, [load])

  const switchTo = useCallback(async (next: string | null): Promise<boolean> => {
    if (!enabled) return false
    try {
      const state = kind === 'task'
        ? await setTaskChatRole(taskId!, next)
        : kind === 'clone'
          ? await agentApi.setCloneSessionRole(cloneName!, sessionId!, next)
          : await agentApi.setSessionRole(sessionId!, next)
      setRole(state as RoleState)
      toast.success(next ? '已切换分身身份 · 下一条消息生效' : '已恢复基础身份')
      return true
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '切换分身身份失败')
      return false
    }
  }, [enabled, kind, taskId, cloneName, sessionId])

  return useMemo(() => ({
    activeName: role?.active_expert ?? null,
    label: role?.clone?.display_name ?? role?.expert?.name ?? null,
    switchTo,
  }), [role?.active_expert, role?.clone?.display_name, role?.expert?.name, switchTo])
}
