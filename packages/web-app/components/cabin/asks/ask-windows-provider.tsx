'use client'

// 问答窗集合状态（design 26 §5.2 / §5.5）。
//
// 数据源是 CabinProvider.view.attention（唯一事实源）：
//   · `asks` = 过滤后的「等你答」行，给 cockpit 编队 / classic 编队渲染；
//   · 打开时**快照**信封（attention 刷新不清空窗内输入）；
//   · `answeredIds` 是乐观集合 —— 提交成功立刻消项，不等下一次刷新；
//   · 别处答掉（attention 项消失）时已开窗保留，标记 external 显示「已在别处答过」。
//
// 随舱重挂：Provider 挂在 CabinProvider 的 key=cabinId 之下，换舱整体重置。

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { CabinAttentionItem, CabinAskEnvelope } from '@octopus/shared'
import { nextZ } from '../z-order'
import { pendingAsks, type PendingAsk } from './ask-window-model'

export interface AskWindowEntry {
  askId: string
  item: CabinAttentionItem
  env: CabinAskEnvelope
  z: number
  /** 本地已答（乐观）或服务端 409 幂等命中。 */
  answered: boolean
  /** attention 里已没有这条、又不是本地答的：别处答过 / 已过期。 */
  external: boolean
  /** 重复点同一行时的闪烁信号（自增）。 */
  flash: number
}

export interface AskWindowsContextValue {
  /** 当前可答的提问行（attention 过滤 + 乐观已答剔除），顺序沿用 attention。 */
  asks: PendingAsk[]
  /** 打开中的窗：靠前的在下、靠后的在上（真实层级看 z）。 */
  windows: AskWindowEntry[]
  open(ask: PendingAsk | string): void
  focus(askId: string): void
  close(askId: string): void
  closeAll(): void
  /** 提交成功后调用：行立即消失、窗显示回执。 */
  markAnswered(askId: string): void
  /** 顶层的 askId（Esc / 关闭最上面一扇用）。 */
  topAskId: string | null
}

const NOOP_VALUE: AskWindowsContextValue = {
  asks: [],
  windows: [],
  open: () => {},
  focus: () => {},
  close: () => {},
  closeAll: () => {},
  markAnswered: () => {},
  topAskId: null,
}

const AskWindowsContext = createContext<AskWindowsContextValue>(NOOP_VALUE)

export function useAskWindows(): AskWindowsContextValue {
  return useContext(AskWindowsContext)
}

export function AskWindowsProvider({
  attention,
  children,
}: {
  attention: readonly CabinAttentionItem[] | null | undefined
  children: ReactNode
}) {
  const [snapshots, setSnapshots] = useState<Record<string, PendingAsk>>({})
  const [order, setOrder] = useState<string[]>([])
  const [zById, setZById] = useState<Record<string, number>>({})
  const [flashById, setFlashById] = useState<Record<string, number>>({})
  const [answeredIds, setAnsweredIds] = useState<ReadonlySet<string>>(() => new Set())
  /** 打开窗时记录焦点，关闭后还给触发它的编队行（§3.7）。 */
  const triggerRef = useRef<HTMLElement | null>(null)

  const asks = useMemo(() => pendingAsks(attention, answeredIds), [attention, answeredIds])
  const askById = useMemo(() => {
    const map = new Map<string, PendingAsk>()
    for (const ask of asks) map.set(ask.askId, ask)
    return map
  }, [asks])

  const markAnswered = useCallback((askId: string) => {
    setAnsweredIds((prev) => {
      if (prev.has(askId)) return prev
      const next = new Set(prev)
      next.add(askId)
      return next
    })
  }, [])

  // 点窗内任意处只抬 z；闪烁只属于「重复点编队行」，否则每次点选项/输入框
  // 都重播一次闪框动画（用户 2026-11-16：点窗口会闪，影响操作）。
  const focus = useCallback((askId: string) => {
    setZById((prev) => ({ ...prev, [askId]: nextZ() }))
  }, [])

  const open = useCallback((ask: PendingAsk | string) => {
    const askId = typeof ask === 'string' ? ask : ask.askId
    const resolved = typeof ask === 'string' ? askById.get(ask) : ask
    const exists = order.includes(askId)
    if (!resolved && !exists) return
    if (!order.includes(askId) && typeof document !== 'undefined'
      && document.activeElement instanceof HTMLElement) {
      triggerRef.current = document.activeElement
    }
    if (resolved && !exists) {
      setSnapshots((prev) => ({ ...prev, [askId]: resolved }))
      setOrder((prev) => (prev.includes(askId) ? prev : [...prev, askId]))
    }
    // 同一 askId 至多一扇窗：再点 = 置顶 + 闪一下边框。
    setZById((prev) => ({ ...prev, [askId]: nextZ() }))
    setFlashById((prev) => ({ ...prev, [askId]: (prev[askId] ?? 0) + 1 }))
  }, [askById, order])

  const close = useCallback((askId: string) => {
    setOrder((prev) => prev.filter((id) => id !== askId))
    setSnapshots((prev) => {
      if (!(askId in prev)) return prev
      const next = { ...prev }
      delete next[askId]
      return next
    })
    setZById((prev) => {
      if (!(askId in prev)) return prev
      const next = { ...prev }
      delete next[askId]
      return next
    })
    // 焦点还给触发它的编队行（行可能已被乐观消项，先确认还在 DOM 里）。
    const trigger = triggerRef.current
    if (trigger && typeof document !== 'undefined' && document.contains(trigger)) {
      requestAnimationFrame(() => trigger.focus())
    }
  }, [])

  const closeAll = useCallback(() => {
    setOrder([])
    setSnapshots({})
    setZById({})
    setFlashById({})
  }, [])

  // 主 chat 里的卡片答掉 → 编队行立即消项（两个入口共用同一 askId）。
  useEffect(() => {
    const onAnswered = (event: Event) => {
      const id = (event as CustomEvent<{ askMessageId?: string }>).detail?.askMessageId
      if (id) markAnswered(id)
    }
    window.addEventListener('octopus:author-ask-answered', onAnswered)
    return () => window.removeEventListener('octopus:author-ask-answered', onAnswered)
  }, [markAnswered])

  const windows = useMemo<AskWindowEntry[]>(() => {
    const out: AskWindowEntry[] = []
    for (const askId of order) {
      const snap = snapshots[askId]
      if (!snap) continue
      const live = askById.get(askId)
      const answered = answeredIds.has(askId)
      out.push({
        askId,
        item: live?.item ?? snap.item,
        env: live?.env ?? snap.env,
        z: zById[askId] ?? 100,
        answered,
        external: !answered && !live,
        flash: flashById[askId] ?? 0,
      })
    }
    return out
  }, [askById, answeredIds, flashById, order, snapshots, zById])

  const topAskId = useMemo(() => {
    let top: string | null = null
    let z = Number.NEGATIVE_INFINITY
    for (const win of windows) {
      if (win.z >= z) { z = win.z; top = win.askId }
    }
    return top
  }, [windows])

  const value = useMemo<AskWindowsContextValue>(() => ({
    asks, windows, open, focus, close, closeAll, markAnswered, topAskId,
  }), [asks, windows, open, focus, close, closeAll, markAnswered, topAskId])

  return <AskWindowsContext.Provider value={value}>{children}</AskWindowsContext.Provider>
}
