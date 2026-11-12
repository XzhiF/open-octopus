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
  DEFAULT_COCKPIT, cockpitCssVars, deriveMood, normalizePrefs, randomPrefs,
  type CockpitPrefs, type MoodKey,
} from './cockpit'

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

  const prefsRef = useRef(prefs)
  const versionRef = useRef(cabin?.version ?? 0)
  const pendingRef = useRef<CockpitPrefs | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const moodTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const writingRef = useRef(false)
  const retryRef = useRef(0)

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
    applyPrefs(randomPrefs())
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

  const value = useMemo<CockpitContextValue>(() => ({
    prefs, mood, moodOverride, streaming, setStreaming,
    setPref, applyPrefs, reset, randomize, setMoodOverride,
  }), [prefs, mood, moodOverride, streaming, setPref, applyPrefs, reset, randomize, setMoodOverride])

  return <CockpitContext.Provider value={value}>{children}</CockpitContext.Provider>
}