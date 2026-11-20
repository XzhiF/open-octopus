'use client'

// 用户 #18：关浏览器 / 窗口时，如果本舱还有 agent 在工作 ——
//   ① 先弹确认（浏览器原生「离开此网站？」/ 桌面壳自己的对话框）；
//   ② 确认之后，先把这些会话的生成停掉，再让页面走。
//
// 平台限制：beforeunload 里不能 await，页面没有任何「确认之后、销毁之前」的回调。
// 所以拆成两半：
//   · beforeunload 只负责拦截（preventDefault + returnValue）—— 浏览器据此弹确认，
//     用户点「取消」就什么都不发生；
//   · pagehide 只在**真的**离开时才触发（确认取消不触发），用 keepalive fetch
//     逐个 POST /sessions/:id/stop —— 请求在文档销毁后仍然送达，服务端按既有
//     中断机制把这一轮收成 interrupted（已产出的内容照常落盘）。
//
// 桌面壳：Chromium 对「渲染层拦了 unload」默认**静默取消关闭**，什么都不提示。
// packages/desktop/src/main.ts 里补了 will-prevent-unload → 真确认框。

import { useEffect, useMemo, useRef, useState } from 'react'
import { getServerUrl } from '@/lib/server-config'
import { listRunningSessions } from '@/lib/agent/api'
import { useCockpitState } from '../state/CockpitStateProvider'
import { useCockpitThreads } from '../chat/use-cockpit-threads'

/** 轮询间隔。比编队（10s）快一拍：关窗时漏判 = 没拦住，宁可多问几个小请求。 */
export const CLOSE_GUARD_POLL_MS = 4_000

/** 全局内存流列表 → 只留本舱线程里的会话。 */
export function runningInCabin(
  running: readonly { id: string }[],
  sessionIds: readonly (string | null | undefined)[],
): string[] {
  const wanted = new Set(sessionIds.filter((id): id is string => !!id))
  return running.map((item) => item.id).filter((id) => wanted.has(id))
}

/**
 * 页面销毁时用的停流请求。keepalive 是这里唯一的意义：
 * 没有它，fetch 会在文档被拆掉的瞬间被取消，服务端收不到。
 * 不带 Content-Type（无 body）—— 少一个触发预检的理由。
 */
export function stopSessionOnExit(sessionId: string): void {
  try {
    void fetch(`${getServerUrl()}/api/agent/sessions/${encodeURIComponent(sessionId)}/stop`, {
      method: 'POST',
      keepalive: true,
      headers: { Authorization: 'Bearer agent' },
    }).catch(() => { /* 页面正在销毁，尽力而为 */ })
  } catch {
    // 同上：守卫本身不能把关闭流程搞挂。
  }
}

/**
 * 本舱「正在工作」的会话 id 列表（空数组 = 无需拦截）。
 *
 * 两个来源取并集：
 *   · 4s 轮询 /api/agent/sessions/running ∩ 本舱线程会话（后台线程在跑时，
 *     人可能正在看主对话）；
 *   · 当前 ChatPane 的 streaming 电平（秒级即时，补轮询空档：刚按回车就关窗）。
 */
export function useCockpitCloseGuard(): number {
  const { chat } = useCockpitState()
  const { threads, active } = useCockpitThreads()

  // 原始运行集：不在这里就与舱取交集 —— 线程列表晚到时也能立刻算对。
  const [runningAll, setRunningAll] = useState<readonly string[]>([])

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const { items } = await listRunningSessions(200)
        if (!cancelled) setRunningAll(items.map((item) => item.id))
      } catch {
        // 拿不到 / 超时：沿用上一拍，不因为一次抖动把守卫摘掉。
      }
    }
    void tick()
    const timer = window.setInterval(() => { void tick() }, CLOSE_GUARD_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  const working = useMemo(() => {
    const ids = runningInCabin(
      runningAll.map((id) => ({ id })),
      threads.map((thread) => thread.sessionId),
    )
    const set = new Set(ids)
    // 轮询空档的即时信号：当前台正在生成，就算这一拍还没捞到也要拦。
    if (chat?.streaming && active?.sessionId) set.add(active.sessionId)
    return [...set]
  }, [runningAll, threads, chat?.streaming, active?.sessionId])

  // pagehide 里读最新值（监听器不随 working 每次变化重装）。
  const workingRef = useRef<readonly string[]>(working)
  workingRef.current = working
  const activeGuard = working.length > 0

  useEffect(() => {
    if (!activeGuard) return

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      // 现代浏览器忽略自定义文案，只认「有没有拦」；returnValue 是旧内核兜底。
      event.preventDefault()
      event.returnValue = ''
    }
    const onPageHide = (event: PageTransitionEvent) => {
      // 进 bfcache 不是真离开：页面还活着，agent 该继续跑。
      if (event.persisted) return
      for (const id of workingRef.current) stopSessionOnExit(id)
    }

    window.addEventListener('beforeunload', onBeforeUnload)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      window.removeEventListener('pagehide', onPageHide)
    }
  }, [activeGuard])

  return working.length
}
