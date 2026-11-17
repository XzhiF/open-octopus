'use client'

// v20（design 29 §3.3/§7）：线程活动接线 —— 未读 / 本地同步回执 / 委派 relay 报信。
//
//   · 未读：10s 比对会话 last_message_at 与「上次看见」；只有线程不可见
//     （主通讯台没在看它、也没有非最小化弹出窗）才累加 —— 与原型 pushMsg 同规则；
//   · 直连同步：在非主线程发送（composer ⏎ / 发送按钮）→ 主对话落本地 sys 回执
//     「同步：您直接对「X」交代了…」；真转录不写假行，回执只走 overlay；
//   · 决断消项：监听 octopus:author-ask-answered（真实提交管线发的）→ 主对话
//     sys 回执「✓ #handle 按「choice」交代下去」+ 不可见时未读；
//   · 委托 relay：编队新增 delegation 线程 = 汐音真派单 → 该线程报信 + flash。
//
// 挂载即生效（CockpitSurface），返回 null。

import { useEffect, useRef } from 'react'
import { useChatSessions } from '@/components/providers/chat-sessions'
import { isThreadVisible, MAIN_THREAD_KEY } from '../fleet/threads-model'
import { useCockpitState } from '../state/CockpitStateProvider'
import { useChatSlot } from './chat-slots'
import { useCockpitThreads } from './use-cockpit-threads'

const POLL_MS = 10_000

export function CockpitThreadActivity() {
  const { sessions } = useChatSessions()
  const { threads: api, chatWindow, wins, fx, markArrival } = useCockpitState()
  const { threads, byKey } = useCockpitThreads()
  const composerSlot = useChatSlot('composer')
  const seenRef = useRef<Record<string, string>>({})
  const prevKeysRef = useRef<Set<string> | null>(null)

  const view = { activeThread: api.activeThread, chatWindow, windows: wins.windows }

  // ── 可见即消未读 + 记「上次看见」─────────────────────────────────────
  useEffect(() => {
    const key = api.activeThread
    if (!isThreadVisible(key, view)) return
    const thread = byKey.get(key)
    const last = thread?.sessionId
      ? sessions.find((s) => s.id === thread.sessionId)?.last_message_at ?? null
      : null
    if (last) seenRef.current[key] = last
    api.activateThread(key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api.activeThread, chatWindow.open, chatWindow.mini, chatWindow.docked, wins.windows, sessions, byKey])

  // ── 10s 未读轮询 ────────────────────────────────────────────────────
  useEffect(() => {
    const tick = () => {
      for (const thread of threads) {
        if (!thread.sessionId || thread.key === MAIN_THREAD_KEY) continue
        const last = sessions.find((s) => s.id === thread.sessionId)?.last_message_at ?? null
        if (!last) continue
        const seen = seenRef.current[thread.key]
        if (seen == null) {
          seenRef.current[thread.key] = last
          continue
        }
        if (last > seen) {
          seenRef.current[thread.key] = last
          if (!isThreadVisible(thread.key, view)) api.bumpUnread(thread.key)
        }
      }
    }
    tick()
    const timer = window.setInterval(tick, POLL_MS)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, threads, api, chatWindow, wins.windows])

  // ── 决断消项 → 主对话 sys 回执 ───────────────────────────────────────
  useEffect(() => {
    const onAnswered = (event: Event) => {
      const detail = (event as CustomEvent<{ handle?: string; choice?: string }>).detail
      if (!detail?.choice) return
      const handle = detail.handle ? `${detail.handle} ` : ''
      api.pushReceipt(MAIN_THREAD_KEY, `✓ ${handle}按「${detail.choice}」交代下去`)
      if (!isThreadVisible(MAIN_THREAD_KEY, view)) api.bumpUnread(MAIN_THREAD_KEY)
    }
    window.addEventListener('octopus:author-ask-answered', onAnswered)
    return () => window.removeEventListener('octopus:author-ask-answered', onAnswered)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, chatWindow, wins.windows, api.activeThread])

  // ── 直连发送 → 主对话「同步：」回执 ──────────────────────────────────
  useEffect(() => {
    if (!composerSlot) return
    const noteSend = () => {
      const key = api.activeThread
      if (key === MAIN_THREAD_KEY) return
      const thread = byKey.get(key)
      if (!thread) return
      const text = composerSlot.querySelector('textarea')?.value.trim() ?? ''
      const snippet = text.length > 24 ? `${text.slice(0, 24)}…` : text
      api.pushReceipt(MAIN_THREAD_KEY, `同步：您直接对「${thread.short}」交代了${snippet ? `：${snippet}` : '…'}`)
      if (!isThreadVisible(MAIN_THREAD_KEY, view)) api.bumpUnread(MAIN_THREAD_KEY)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return
      if (event.isComposing) return
      noteSend()
    }
    const onClick = (event: MouseEvent) => {
      const button = (event.target as HTMLElement | null)?.closest('button')
      if (!button) return
      if (/发送|send/i.test(button.getAttribute('aria-label') ?? '')) noteSend()
    }
    composerSlot.addEventListener('keydown', onKey, true)
    composerSlot.addEventListener('click', onClick, true)
    return () => {
      composerSlot.removeEventListener('keydown', onKey, true)
      composerSlot.removeEventListener('click', onClick, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composerSlot, api, byKey, chatWindow, wins.windows, api.activeThread])

  // ── 新委派线程 = 汐音真 relay → 报信 + flash ─────────────────────────
  useEffect(() => {
    const keys = new Set(threads.filter((t) => t.kind === 'delegation').map((t) => t.key))
    const prev = prevKeysRef.current
    prevKeysRef.current = keys
    if (!prev) return
    for (const key of keys) {
      if (prev.has(key)) continue
      const thread = byKey.get(key)
      if (!thread) continue
      markArrival(key)
      fx.edge('var(--ck-a)')
      api.pushReceipt(key, '⌁ 汐音已 relay：委派进编队，doer 接手')
      if (!isThreadVisible(key, view)) api.bumpUnread(key)
      window.dispatchEvent(new CustomEvent('octopus:crew-pose', { detail: { pose: 'command', ms: 2600 } }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads, byKey, markArrival, fx, api])

  return null
}
