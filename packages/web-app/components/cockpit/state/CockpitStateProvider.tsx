'use client'

// 全域座舱的唯一可变状态（plans/cabin-cockpit-v12.md §2.1）。
// S1 先把接口落死：selection / tab / chat / chatWindow / railOpen / fx / layer。
// 后续 Step 只读它，不在组件里另起真源。

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { MoodKey } from '@/components/cabin/cockpit'
import {
  sameCockpitRef,
  type CockpitChatApi,
  type CockpitChatWindow,
  type CockpitChatWindowPatch,
  type CockpitChatWindowState,
  type CockpitFx,
  type CockpitLayerApi,
  type CockpitRef,
  type CockpitSaid,
  type CockpitState,
  type CockpitTab,
} from './cockpit-state'

const CockpitStateContext = createContext<CockpitState | null>(null)

export function useCockpitState(): CockpitState {
  const ctx = useContext(CockpitStateContext)
  if (!ctx) throw new Error('useCockpitState must be used inside CockpitStateProvider')
  return ctx
}

interface LayerEntry {
  id: string
  priority: number
  seq: number
  close: () => void
}

interface FxState {
  pulseNonce: number
  pulseColor: string
  edgeNonce: number
  edgeColor: string
  jumpNonce: number
  lastSaid: CockpitSaid | null
}

const INITIAL_CHAT_WINDOW: CockpitChatWindowState = {
  open: false,
  mini: false,
  pinned: false,
  alpha: 0.94,
  rect: null,
}

const INITIAL_FX: FxState = {
  pulseNonce: 0,
  pulseColor: 'var(--ck-a)',
  edgeNonce: 0,
  edgeColor: 'var(--pop-amber)',
  jumpNonce: 0,
  lastSaid: null,
}

export interface CockpitStateProviderProps {
  entryCabinId: string
  children: ReactNode
}

export function CockpitStateProvider({ entryCabinId, children }: CockpitStateProviderProps) {
  const [selection, setSelection] = useState<CockpitRef | null>(null)
  const [tab, setTabState] = useState<CockpitTab>('overview')
  const [chat, setChat] = useState<CockpitChatApi | null>(null)
  const [chatWindowState, setChatWindowState] = useState<CockpitChatWindowState>(INITIAL_CHAT_WINDOW)
  const [railOpen, setRailOpenState] = useState(false)
  const [fxState, setFxState] = useState<FxState>(INITIAL_FX)

  // ── selection / tab ────────────────────────────────────────────────
  const select = useCallback((ref: CockpitRef | null, nextTab?: CockpitTab) => {
    setSelection((current) => (sameCockpitRef(current, ref) ? current : ref))
    if (nextTab) setTabState(nextTab)
  }, [])

  const setTab = useCallback((next: CockpitTab) => setTabState(next), [])

  // ── chat telemetry（S5 写，S6/S1 读；未接上恒 null）─────────────────
  const reportChat = useCallback((api: CockpitChatApi | null) => setChat(api), [])

  // ── 聊天浮窗 ───────────────────────────────────────────────────────
  const setChatWindow = useCallback((patch: CockpitChatWindowPatch) => {
    setChatWindowState((prev) => ({ ...prev, ...patch }))
  }, [])

  const openWithFocus = useCallback(() => {
    setChatWindowState((prev) => (prev.open && !prev.mini ? prev : { ...prev, open: true, mini: false }))
  }, [])

  const chatWindow = useMemo<CockpitChatWindow>(
    () => ({ ...chatWindowState, set: setChatWindow, openWithFocus }),
    [chatWindowState, setChatWindow, openWithFocus],
  )

  // ── 编队抽屉（≤1120 由 S3 消费）─────────────────────────────────────
  const setRailOpen = useCallback((open: boolean) => setRailOpenState(open), [])

  // ── 特效：只递增 nonce（useState，不用 ref 绕过渲染）─────────────────
  const pulse = useCallback((color?: string) => {
    setFxState((prev) => ({
      ...prev,
      pulseNonce: prev.pulseNonce + 1,
      pulseColor: color ?? prev.pulseColor,
    }))
  }, [])

  const edge = useCallback((color?: string) => {
    setFxState((prev) => ({
      ...prev,
      edgeNonce: prev.edgeNonce + 1,
      edgeColor: color ?? prev.edgeColor,
    }))
  }, [])

  const jump = useCallback(() => {
    setFxState((prev) => ({ ...prev, jumpNonce: prev.jumpNonce + 1 }))
  }, [])

  const say = useCallback((line: string, mood?: MoodKey) => {
    setFxState((prev) => ({
      ...prev,
      lastSaid: { nonce: (prev.lastSaid?.nonce ?? 0) + 1, line, mood },
    }))
  }, [])

  const fx = useMemo<CockpitFx>(
    () => ({
      pulseNonce: fxState.pulseNonce,
      pulseColor: fxState.pulseColor,
      edgeNonce: fxState.edgeNonce,
      edgeColor: fxState.edgeColor,
      jumpNonce: fxState.jumpNonce,
      pulse,
      edge,
      jump,
      say,
      lastSaid: fxState.lastSaid,
    }),
    [fxState, pulse, edge, jump, say],
  )

  // ── Esc 层栈 ───────────────────────────────────────────────────────
  // 注册表放 ref（不是渲染数据）；closeTop 每次读最新表，不触发渲染。
  const layersRef = useRef<Map<string, LayerEntry>>(new Map())
  const layerSeqRef = useRef(0)

  const register = useCallback((id: string, priority: number, close: () => void) => {
    const seq = ++layerSeqRef.current
    layersRef.current.set(id, { id, priority, seq, close })
    return () => {
      const current = layersRef.current.get(id)
      if (current && current.seq === seq) layersRef.current.delete(id)
    }
  }, [])

  const closeTop = useCallback(() => {
    let top: LayerEntry | null = null
    for (const entry of layersRef.current.values()) {
      if (
        !top ||
        entry.priority > top.priority ||
        (entry.priority === top.priority && entry.seq > top.seq)
      ) {
        top = entry
      }
    }
    if (!top) return false
    // 先摘再关：close() 即使同步卸载组件，其 cleanup 也只会碰到已删除的 id。
    layersRef.current.delete(top.id)
    top.close()
    return true
  }, [])

  const layer = useMemo<CockpitLayerApi>(() => ({ register, closeTop }), [register, closeTop])

  const value = useMemo<CockpitState>(
    () => ({
      entryCabinId,
      selection,
      tab,
      select,
      setTab,
      chat,
      reportChat,
      chatWindow,
      railOpen,
      setRailOpen,
      fx,
      layer,
    }),
    [
      entryCabinId, selection, tab, select, setTab,
      chat, reportChat, chatWindow,
      railOpen, setRailOpen,
      fx, layer,
    ],
  )

  return <CockpitStateContext.Provider value={value}>{children}</CockpitStateContext.Provider>
}
