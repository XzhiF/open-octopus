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
  COCKPIT_DEFAULT_TAB,
  COCKPIT_WIN_LIMIT,
  type CockpitChatApi,
  type CockpitChatWindow,
  type CockpitChatWindowPatch,
  type CockpitChatWindowState,
  type CockpitFlash,
  type CockpitFx,
  type CockpitLayerApi,
  type CockpitPanelKind,
  type CockpitPopWin,
  type CockpitReceipt,
  type CockpitRef,
  type CockpitSaid,
  type CockpitSelectSource,
  type CockpitState,
  type CockpitTab,
  type CockpitThreadsApi,
  type CockpitWindowsApi,
} from './cockpit-state'
import { SCENE_COUNT } from '../scene/scene-model'

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
  feedbackNonce: number
  feedbackColor: string
  feedbackLevel: 'full' | 'lite' | 'off'
  lastSaid: CockpitSaid | null
}

const INITIAL_CHAT_WINDOW: CockpitChatWindowState = {
  // v21 三轮：输入框住进通讯台，通讯台就是原型里常驻的 TUI 面板 —— 默认展开。
  open: true,
  mini: false,
  pinned: false,
  alpha: 0.94,
  rect: null,
  docked: false,
}

const INITIAL_FX: FxState = {
  pulseNonce: 0,
  pulseColor: 'var(--ck-a)',
  edgeNonce: 0,
  edgeColor: 'var(--pop-amber)',
  jumpNonce: 0,
  feedbackNonce: 0,
  feedbackColor: 'var(--ck-a)',
  feedbackLevel: 'full',
  lastSaid: null,
}

export interface CockpitStateProviderProps {
  entryCabinId: string
  children: ReactNode
}

export function CockpitStateProvider({ entryCabinId, children }: CockpitStateProviderProps) {
  const [selection, setSelection] = useState<CockpitRef | null>(null)
  const [projectFilter, setProjectFilterState] = useState<string | null>(null)
  // v22 #5：默认页签 = 运行（对话页签已删除；旧 ?tab=dialog 由 isCockpitTab 丢掉）。
  const [tab, setTabState] = useState<CockpitTab>(COCKPIT_DEFAULT_TAB)
  /** v22.3：面来源 —— 从「要我处理」打开的面让到浮层左侧，其余居中。 */
  const [detailSource, setDetailSource] = useState<CockpitSelectSource>('fleet')
  const [chat, setChat] = useState<CockpitChatApi | null>(null)
  const [chatWindowState, setChatWindowState] = useState<CockpitChatWindowState>(INITIAL_CHAT_WINDOW)
  const [railOpen, setRailOpenState] = useState(false)
  const [fxState, setFxState] = useState<FxState>(INITIAL_FX)

  // ── v20 线程未读 / 本地回执 ──────────────────────────────────────────
  // v22 #5：主通讯台固定主对话，线程切换整套撤掉 —— 这里只剩未读与回执。
  const [unread, setUnread] = useState<Record<string, number>>({})
  const [receipts, setReceipts] = useState<Record<string, CockpitReceipt[]>>({})
  const [windows, setWindows] = useState<CockpitPopWin[]>([])
  const [panel, setPanel] = useState<CockpitPanelKind | null>(null)
  const [panelArg, setPanelArg] = useState<string | null>(null)
  const [flash, setFlash] = useState<CockpitFlash>({ key: null, at: 0, nonce: 0 })
  const [inboxOpen, setInboxOpen] = useState(false)
  const [inboxSel, setInboxSel] = useState<string | null>(null)
  const [activityOpen, setActivityOpen] = useState(false)
  const [activitySel, setActivitySel] = useState<string | null>(null)
  const [pose, setPose] = useState('idle')
  const [clip, setClip] = useState(0)
  const [autoWarp, setAutoWarp] = useState(true)
  // v21：舱景三幕。跃迁与换色共用 fx.jump 的星流闪光，但只有 travel() 会切幕
  // —— 换色 / 回传入场不该把船开走。
  const [sceneIndex, setSceneIndex] = useState(0)
  const receiptSeqRef = useRef(0)
  const winSeqRef = useRef(0)

  // ── selection / tab ────────────────────────────────────────────────
  const select = useCallback((ref: CockpitRef | null, nextTab?: CockpitTab, source: CockpitSelectSource = 'fleet') => {
    setSelection((current) => (sameCockpitRef(current, ref) ? current : ref))
    if (nextTab) setTabState(nextTab)
    // 来源跟着这次选中走：同一条作业从编队点（居中）后再从 inbox 点「去处理」，
    // 也要切成左侧 aside。
    setDetailSource(ref ? source : 'fleet')
    // v21 三轮：详情是覆盖在舱面上的玻璃面板（原型 .panel），不再需要为了
    // 看见作业面而把通讯台收起来 —— 选面不再动 chatWindow（连输入框一起消失
    // 是原型的反直觉点）。
  }, [])

  const setTab = useCallback((next: CockpitTab) => setTabState(next), [])
  const setProjectFilter = useCallback((next: string | null) => setProjectFilterState(next), [])

  // ── chat telemetry（S5 写，S6/S1 读；未接上恒 null）─────────────────
  const reportChat = useCallback((api: CockpitChatApi | null) => setChat(api), [])

  // ── 聊天浮窗 ───────────────────────────────────────────────────────
  const setChatWindow = useCallback((patch: CockpitChatWindowPatch) => {
    setChatWindowState((prev) => ({ ...prev, ...patch }))
  }, [])

  const openWithFocus = useCallback(() => {
    setChatWindowState((prev) => (
      prev.open && !prev.mini && !prev.docked
        ? prev
        : { ...prev, open: true, mini: false, docked: false }
    ))
    // 共享 z 栈（design 26 §5.3）：主 chat 从任意入口打开 / 聚焦都要压住问答窗。
    // 用事件而不是改状态契约 —— 浮窗自己持有 DOM z，状态保持纯数据。
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('octopus:chat-focus'))
    }
  }, [])

  const chatWindow = useMemo<CockpitChatWindow>(
    () => ({ ...chatWindowState, set: setChatWindow, openWithFocus }),
    [chatWindowState, setChatWindow, openWithFocus],
  )

  // ── 编队抽屉（≤1120 由 S3 消费）─────────────────────────────────────
  const setRailOpen = useCallback((open: boolean) => setRailOpenState(open), [])

  // ── v20 线程未读 / 本地回执（v22 #5：无线程切换） ─────────────────────
  const clearUnread = useCallback((key: string) => {
    setUnread((prev) => (prev[key] ? { ...prev, [key]: 0 } : prev))
  }, [])

  const bumpUnread = useCallback((key: string, n = 1) => {
    setUnread((prev) => ({ ...prev, [key]: (prev[key] ?? 0) + n }))
  }, [])

  const pushReceipt = useCallback((key: string, text: string) => {
    const id = ++receiptSeqRef.current
    setReceipts((prev) => ({
      ...prev,
      [key]: [...(prev[key] ?? []), { id, text, at: Date.now() }].slice(-40),
    }))
  }, [])

  const threads = useMemo<CockpitThreadsApi>(
    () => ({ unread, receipts, clearUnread, bumpUnread, pushReceipt }),
    [unread, receipts, clearUnread, bumpUnread, pushReceipt],
  )

  // ── v20 弹出窗（design 29 §4）────────────────────────────────────────
  const openWindow = useCallback((threadKey: string, rect: CockpitPopWin['rect']): boolean => {
    const hit = windows.find((w) => w.threadKey === threadKey)
    if (hit) {
      // 已存在：恢复 + 聚焦事件（z 由窗自己 bump），不新建。
      if (hit.min) setWindows((prev) => prev.map((w) => (w.id === hit.id ? { ...w, min: false } : w)))
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('octopus:cockpit-win-focus', { detail: { id: hit.id } }))
      }
      return true
    }
    if (windows.length >= COCKPIT_WIN_LIMIT) return false
    const id = `w${++winSeqRef.current}`
    setWindows((prev) => (prev.length >= COCKPIT_WIN_LIMIT ? prev : [...prev, { id, threadKey, rect, min: false }]))
    return true
  }, [windows])

  const closeWindow = useCallback((id: string) => {
    setWindows((prev) => prev.filter((w) => w.id !== id))
  }, [])

  const setWindowMin = useCallback((id: string, min: boolean) => {
    setWindows((prev) => prev.map((w) => (w.id === id ? { ...w, min } : w)))
    if (!min && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('octopus:cockpit-win-focus', { detail: { id } }))
    }
  }, [])

  const patchWindowRect = useCallback((id: string, rect: CockpitPopWin['rect']) => {
    setWindows((prev) => prev.map((w) => (w.id === id ? { ...w, rect } : w)))
  }, [])

  const wins = useMemo<CockpitWindowsApi>(
    () => ({ windows, openWindow, closeWindow, setWindowMin, patchWindowRect }),
    [windows, openWindow, closeWindow, setWindowMin, patchWindowRect],
  )

  // ── v20 模态面板 / 回传 flash ────────────────────────────────────────
  const openPanel = useCallback((kind: CockpitPanelKind, arg: string | null = null) => {
    setPanelArg(arg)
    setPanel(kind)
    // v21（design 31 §3.2.2）：打开面板时自动收起 inbox。
    setInboxOpen(false)
    setInboxSel(null)
    // v22 十四轮：活动浮层同样让位。
    setActivityOpen(false)
    setActivitySel(null)
  }, [])
  const closePanel = useCallback(() => setPanel(null), [])
  const markArrival = useCallback((key: string) => {
    setFlash((prev) => ({ key, at: Date.now(), nonce: prev.nonce + 1 }))
  }, [])

  // ── v21 右栏 inbox 浮层 ──────────────────────────────────────────────
  const openInbox = useCallback((attentionId: string | null = null) => {
    setInboxOpen(true)
    setInboxSel(attentionId ?? null)
    // v22 十四轮：两个右栏浮层互斥，同一时间只开一个。
    setActivityOpen(false)
    setActivitySel(null)
  }, [])
  const closeInbox = useCallback(() => {
    setInboxOpen(false)
    setInboxSel(null)
  }, [])
  const selectInbox = useCallback((attentionId: string | null) => {
    setInboxSel(attentionId)
    setInboxOpen(true)
    setActivityOpen(false)
    setActivitySel(null)
  }, [])

  // ── v22 十四轮 右栏 activity 浮层 ─────────────────────────────────────
  const openActivity = useCallback(() => {
    setActivityOpen(true)
    setInboxOpen(false)
    setInboxSel(null)
  }, [])
  const closeActivity = useCallback(() => {
    setActivityOpen(false)
    setActivitySel(null)
  }, [])
  const selectActivity = useCallback((activityId: string | null) => {
    setActivitySel(activityId)
    setActivityOpen(true)
    // 详情窗开着时不能同时开 inbox。
    setInboxOpen(false)
    setInboxSel(null)
  }, [])
  const reportPose = useCallback((next: string, clipIndex?: number) => {
    setPose(next)
    if (typeof clipIndex === 'number' && Number.isFinite(clipIndex)) setClip(clipIndex)
  }, [])

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

  // ── v21 舱景：点某一幕 / 跃迁到下一幕 ────────────────────────────────
  const setScene = useCallback((index: number) => {
    setSceneIndex(((index % SCENE_COUNT) + SCENE_COUNT) % SCENE_COUNT)
  }, [])

  const travel = useCallback(() => {
    setSceneIndex((prev) => (prev + 1) % SCENE_COUNT)
    jump()
  }, [jump])

  // v21 八轮：自动轮换 = 随机计时 + 随机另一幕（保证不原地重切；手动跃迁仍顺序，
  // 方便人把 12 幕挨个看完）。
  const travelRandom = useCallback(() => {
    setSceneIndex((prev) => (prev + 1 + Math.floor(Math.random() * (SCENE_COUNT - 1))) % SCENE_COUNT)
    jump()
  }, [jump])

  const feedback = useCallback((color?: string, level: 'full' | 'lite' | 'off' = 'full') => {
    setFxState((prev) => ({
      ...prev,
      feedbackNonce: prev.feedbackNonce + 1,
      feedbackColor: color ?? prev.feedbackColor,
      feedbackLevel: level,
    }))
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
      feedbackNonce: fxState.feedbackNonce,
      feedbackColor: fxState.feedbackColor,
      feedbackLevel: fxState.feedbackLevel,
      pulse,
      edge,
      jump,
      feedback,
      say,
      lastSaid: fxState.lastSaid,
    }),
    [fxState, pulse, edge, jump, feedback, say],
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
      detailSource,
      select,
      setTab,
      projectFilter,
      setProjectFilter,
      chat,
      reportChat,
      chatWindow,
      railOpen,
      setRailOpen,
      threads,
      wins,
      panel,
      panelArg,
      openPanel,
      closePanel,
      flash,
      markArrival,
      inboxOpen,
      inboxSel,
      openInbox,
      closeInbox,
      selectInbox,
      activityOpen,
      activitySel,
      openActivity,
      closeActivity,
      selectActivity,
      pose,
      clip,
      reportPose,
      autoWarp,
      setAutoWarp,
      sceneIndex,
      setScene,
      travel,
      travelRandom,
      fx,
      layer,
    }),
    [
      entryCabinId, selection, tab, detailSource, select, setTab, projectFilter, setProjectFilter,
      chat, reportChat, chatWindow,
      railOpen, setRailOpen,
      threads, wins, panel, panelArg, openPanel, closePanel, flash, markArrival,
      inboxOpen, inboxSel, openInbox, closeInbox, selectInbox,
      activityOpen, activitySel, openActivity, closeActivity, selectActivity,
      pose, clip, reportPose, autoWarp,
      sceneIndex, setScene, travel, travelRandom,
      fx, layer,
    ],
  )

  return <CockpitStateContext.Provider value={value}>{children}</CockpitStateContext.Provider>
}
