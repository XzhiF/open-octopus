'use client'

// 驾驶舱氛围引擎 provider（原型 COCKPIT 引擎 1531-1657 的 React 化）：
// 持有 cockpit_prefs（乐观本地 + 防抖持久化 PATCH /:id，整列替换需 spread），
// 实时把 --ck-* 变量写到 document root + body float/scan/hud 类，派生汐音 mood，
// 驱动 WebAudio。tuning / gallery / atmosphere / crew 共享同一 prefs 真源。
// autonomy 是行为键（cabin-tools 读取），写它即改 orchestrator 派发行为。

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react'
import { toast } from 'sonner'
import { CabinApiError, patchCabin } from '@/lib/cabin-api'
import { cabinAudio } from '@/lib/cabin-audio'
import { useCabinContext } from './cabin-provider'
import {
  DEFAULT_COCKPIT, buildPresenceLine, cockpitCssVars, deriveMood, normalizePrefs, presenceGap, presenceGate, randomPrefs,
  type CockpitPrefs, type MoodKey, type PresenceLineData,
} from './cockpit'

/** 一条主动搭话（provider 派发，CabinCrew 渲染成汐音对白）。 */
export interface PresenceLine extends PresenceLineData { id: number }

interface CockpitContextValue {
  prefs: CockpitPrefs
  mood: MoodKey
  moodOverride: MoodKey | null
  streaming: boolean
  setStreaming: (v: boolean) => void
  setPref: <K extends keyof CockpitPrefs>(key: K, value: CockpitPrefs[K]) => void
  applyPrefs: (next: CockpitPrefs) => void
  reset: () => void
  randomize: () => void
  setMoodOverride: (m: MoodKey | null, ms?: number) => void
  /** 在场：待渲染的主动搭话（一次性，渲染后 dismiss）。 */
  presenceLine: PresenceLine | null
  /** 在场：下一轮开口时间（epoch ms；0 = 未排程）。 */
  presenceDueAt: number
  presenceSnoozeUntil: number
  dismissPresence: () => void
  snoozePresence: (minutes: number) => void
  testPresence: () => void
  /** CabinCrew 上报：立绘对白/助理菜单正开着，别叠加。 */
  setCrewBusy: (busy: boolean) => void
}

const CockpitContext = createContext<CockpitContextValue | null>(null)

export function useCockpit(): CockpitContextValue {
  const ctx = useContext(CockpitContext)
  if (!ctx) throw new Error('useCockpit must be used inside CockpitProvider')
  return ctx
}

export function CockpitProvider({ children }: { children: ReactNode }) {
  const { cabinId, cabin, view, refresh } = useCabinContext()
  const [prefs, setPrefsState] = useState<CockpitPrefs>(() => normalizePrefs(cabin?.cockpit_prefs))
  const [moodOverride, setMoodOverrideState] = useState<MoodKey | null>(null)
  const [streaming, setStreaming] = useState(false)
  const [presenceLine, setPresenceLine] = useState<PresenceLine | null>(null)
  const [presenceDueAt, setPresenceDueAt] = useState(0)
  const [presenceSnoozeUntil, setPresenceSnoozeUntil] = useState(0)

  const prefsRef = useRef(prefs)
  const versionRef = useRef(cabin?.version ?? 0)
  const pendingRef = useRef<CockpitPrefs | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const moodTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const writingRef = useRef(false)
  const retryRef = useRef(0)
  // 在场：闸门要读最新值，用 ref 避免把随机排程做成「每次渲染重置」。
  const streamingRef = useRef(streaming)
  const viewRef = useRef(view)
  const cabinStatusRef = useRef(cabin?.status)
  const crewBusyRef = useRef(false)
  const lastUserAtRef = useRef(Date.now())
  const presenceNRef = useRef(0)
  const presenceLastTextRef = useRef<string | null>(null)
  const presenceIdRef = useRef(0)
  const presenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => { prefsRef.current = prefs }, [prefs])
  useEffect(() => { versionRef.current = cabin?.version ?? 0 }, [cabin?.version])

  // 服务端 prefs 回流（SSE/轮询 refresh）：仅在没有待写乐观值时对齐，避免覆盖正在拖的滑杆。
  useEffect(() => {
    if (pendingRef.current) return
    const server = normalizePrefs(cabin?.cockpit_prefs)
    setPrefsState((cur) => (JSON.stringify(cur) === JSON.stringify(server) ? cur : server))
  }, [cabin?.cockpit_prefs])

  // 实时作用 --ck-* + body 类 + 音效开关（卸载时清理，不泄漏到其它路由）。
  useEffect(() => {
    if (typeof document === 'undefined') return
    const root = document.documentElement
    const vars = cockpitCssVars(prefs)
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v)
    document.body.classList.toggle('scan-off', prefs.scan === 0)
    document.body.classList.toggle('hud-off', !prefs.hud)
    document.body.classList.remove('float-glass', 'float-solid', 'float-holo')
    document.body.classList.add(`float-${prefs.float}`)
    cabinAudio.setOn(prefs.sound)
    return () => {
      for (const k of Object.keys(vars)) root.style.removeProperty(k)
      document.body.classList.remove('scan-off', 'hud-off', 'float-glass', 'float-solid', 'float-holo')
    }
  }, [prefs])

  // 首次手势解锁 WebAudio（原型 1656-1657）。
  useEffect(() => {
    if (typeof window === 'undefined') return
    const unlock = () => cabinAudio.resume()
    window.addEventListener('pointerdown', unlock, { once: true })
    window.addEventListener('keydown', unlock, { once: true })
    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
  }, [])

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (moodTimerRef.current) clearTimeout(moodTimerRef.current)
  }, [])

  const flushPersist = useCallback(async () => {
    const next = pendingRef.current
    if (!next || writingRef.current) return
    writingRef.current = true
    pendingRef.current = null
    let to: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, rej) => { to = setTimeout(() => rej(new Error("cockpit-prefs-timeout")), 8000) })
    try {
      const res = await Promise.race([
        patchCabin(cabinId, versionRef.current, { cockpit_prefs: next as unknown as Record<string, unknown> }),
        timeout,
      ])
      versionRef.current = res.version
      retryRef.current = 0
    } catch (err) {
      if (err instanceof CabinApiError && err.status === 409) {
        // 版本竞争（focus/迭代等并发写）：刷新拿新 version 后重试一次。
        await refresh().catch(() => {})
        pendingRef.current = next
        setTimeout(() => void flushPersist(), 60)
      } else {
        // 网络拥塞（如 dev 下 SSE 占满浏览器连接池）：prefs 幂等 → 退避重试，超限显形不静默挂死。
        retryRef.current += 1
        if (retryRef.current < 3) {
          pendingRef.current = next
          setTimeout(() => void flushPersist(), 2000 * retryRef.current)
        } else {
          retryRef.current = 0
          toast.error('舱面配置保存失败（网络拥塞），稍后重试')
        }
      }
    } finally {
      clearTimeout(to)
      writingRef.current = false
    }
  }, [cabinId, refresh])

  const schedulePersist = useCallback((next: CockpitPrefs) => {
    pendingRef.current = next
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => void flushPersist(), 700)
  }, [flushPersist])

  const applyPrefs = useCallback((next: CockpitPrefs) => {
    prefsRef.current = next
    setPrefsState(next)
    schedulePersist(next)
  }, [schedulePersist])

  const setPref = useCallback(<K extends keyof CockpitPrefs>(key: K, value: CockpitPrefs[K]) => {
    const next = { ...prefsRef.current, [key]: value }
    applyPrefs(next)
    cabinAudio.blip(600, 0.03, 'sine', 0.05)
  }, [applyPrefs])

  const reset = useCallback(() => {
    applyPrefs({ ...DEFAULT_COCKPIT })
    cabinAudio.blip(520, 0.08)
    toast('驾驶舱已恢复默认')
  }, [applyPrefs])

  const randomize = useCallback(() => {
    // 随机的是舱面风格，不改行为：在场开关/频率保持原样。
    applyPrefs({
      ...randomPrefs(),
      presenceOn: prefsRef.current.presenceOn,
      presenceRate: prefsRef.current.presenceRate,
    })
    cabinAudio.chime()
    toast('已随机一套驾驶舱风格')
  }, [applyPrefs])

  const setMoodOverride = useCallback((m: MoodKey | null, ms?: number) => {
    setMoodOverrideState(m)
    if (moodTimerRef.current) clearTimeout(moodTimerRef.current)
    if (m) moodTimerRef.current = setTimeout(() => setMoodOverrideState(null), ms ?? 2600)
  }, [])

  const personAttention = view?.attention.filter((a) => a.awaiting === 'person').length ?? 0
  const hasBlocked = view?.attention.some((a) => a.stage === 'blocked') ?? false
  const running = view?.health.running ?? 0
  const mood = useMemo(() => deriveMood({
    prefsMood: prefs.mood, override: moodOverride, status: cabin?.status,
    personAttention, running, streaming, hasBlocked,
  }), [prefs.mood, moodOverride, cabin?.status, personAttention, running, streaming, hasBlocked])

  // ── 在场：定时 + 随机间隔（classic-v4）────────────────────────────
  useEffect(() => { streamingRef.current = streaming }, [streaming])
  useEffect(() => { viewRef.current = view }, [view])
  useEffect(() => { cabinStatusRef.current = cabin?.status }, [cabin?.status])

  // 键鼠/滚轮都算「人在」；60s 内动过就不开口（输入框聚焦另有闸门）。
  useEffect(() => {
    if (typeof window === 'undefined') return
    const mark = () => { lastUserAtRef.current = Date.now() }
    const events = ['pointerdown', 'keydown', 'input', 'wheel'] as const
    for (const e of events) window.addEventListener(e, mark, true)
    return () => { for (const e of events) window.removeEventListener(e, mark, true) }
  }, [])

  // 关掉在场 → 清掉静默和残留对白。
  useEffect(() => {
    if (prefs.presenceOn) return
    setPresenceLine(null)
    setPresenceSnoozeUntil(0)
  }, [prefs.presenceOn])

  const pickLine = useCallback((n: number): PresenceLineData => {
    const v = viewRef.current
    return buildPresenceLine({
      personAttention: v?.attention.filter((a) => a.awaiting === 'person').length ?? 0,
      attentionTotal: v?.attention.length ?? 0,
      queued: v?.health.queued ?? 0,
      running: v?.health.running ?? 0,
      dormant: cabinStatusRef.current === 'dormant',
      firstAttentionTitle: v?.attention.find((a) => a.awaiting === 'person')?.title,
      hour: new Date().getHours(),
      n,
      lastText: presenceLastTextRef.current,
    })
  }, [])

  // 排程：到点 → 过闸门 → 开口 → 重排；开关 / 频率 / 静默变化都会重排。
  useEffect(() => {
    if (presenceTimerRef.current) { clearTimeout(presenceTimerRef.current); presenceTimerRef.current = null }
    if (!prefs.presenceOn) { setPresenceDueAt(0); return }
    let cancelled = false

    function schedule(delayMs?: number) {
      if (cancelled) return
      const due = presenceSnoozeUntil > Date.now()
        ? presenceSnoozeUntil
        : Date.now() + (delayMs ?? presenceGap(prefs.presenceRate))
      setPresenceDueAt(due)
      presenceTimerRef.current = setTimeout(fire, Math.max(3000, due - Date.now()))
    }
    function fire() {
      if (cancelled) return
      const now = Date.now()
      const ae = typeof document !== 'undefined' ? document.activeElement as HTMLInputElement | HTMLTextAreaElement | HTMLElement | null : null
      // 只在「焦点在输入框且已经有草稿」时拦：chat 底座可能残留焦点，
      // 光看 focus 会让在场永远不开口；真正在打字由 60s 空闲闸门兜住。
      const hasDraft = !!ae && (
        'value' in ae ? String(ae.value ?? '').length > 0 : (ae.textContent ?? '').length > 0
      )
      const editing = !!ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT' || ae.isContentEditable) && hasDraft
      const block = presenceGate({
        on: prefsRef.current.presenceOn,
        now,
        snoozedUntil: presenceSnoozeUntil,
        hidden: typeof document !== 'undefined' && document.hidden,
        streaming: streamingRef.current,
        busy: crewBusyRef.current,
        editing,
        lastUserAt: lastUserAtRef.current,
        idleMs: 60_000,
        hour: new Date(now).getHours(),
      })
      if (block !== 'ok') {
        schedule(block === 'hidden' ? 20_000 : block === 'quiet' ? 10 * 60_000 : 15_000)
        return
      }
      const line = pickLine(presenceNRef.current)
      presenceNRef.current += 1
      presenceLastTextRef.current = line.text
      setPresenceLine({ ...line, id: ++presenceIdRef.current })
      cabinAudio.blip(760, 0.05, 'sine', 0.07)
      schedule()
    }

    // 进舱先安静 15–30s，别一进来就开口。
    schedule(15_000 + Math.random() * 15_000)
    return () => {
      cancelled = true
      if (presenceTimerRef.current) { clearTimeout(presenceTimerRef.current); presenceTimerRef.current = null }
    }
  }, [prefs.presenceOn, prefs.presenceRate, presenceSnoozeUntil, pickLine])

  const dismissPresence = useCallback(() => setPresenceLine(null), [])
  const snoozePresence = useCallback((minutes: number) => {
    setPresenceLine(null)
    setPresenceSnoozeUntil(Date.now() + Math.max(1, minutes) * 60_000)
    toast(`已静 ${minutes} 分钟 · 汐音暂不主动搭话`)
    cabinAudio.blip(520, 0.06)
  }, [])
  const testPresence = useCallback(() => {
    const line = pickLine(0)
    presenceNRef.current += 1
    presenceLastTextRef.current = line.text
    setPresenceLine({ ...line, id: ++presenceIdRef.current })
    cabinAudio.blip(780, 0.05, 'sine', 0.06)
  }, [pickLine])
  const setCrewBusy = useCallback((busy: boolean) => { crewBusyRef.current = busy }, [])

  const value = useMemo<CockpitContextValue>(() => ({
    prefs, mood, moodOverride, streaming, setStreaming,
    setPref, applyPrefs, reset, randomize, setMoodOverride,
    presenceLine, presenceDueAt, presenceSnoozeUntil,
    dismissPresence, snoozePresence, testPresence, setCrewBusy,
  }), [
    prefs, mood, moodOverride, streaming, setPref, applyPrefs, reset, randomize, setMoodOverride,
    presenceLine, presenceDueAt, presenceSnoozeUntil, dismissPresence, snoozePresence, testPresence, setCrewBusy,
  ])

  return <CockpitContext.Provider value={value}>{children}</CockpitContext.Provider>
}