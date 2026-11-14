'use client'

// 汐音状态机（2026-11-14 从 CockpitProvider 抽出）：心情派生 + 瞬时覆盖 + 在场
// （定时随机主动搭话）。每个舱一份实例；scene.key 变化即把所有瞬时态归零，
// 所以换舱时上一间舱的对白、静默、瞬时心情不会跟过去。
//
// 纯派生仍在 cockpit.ts（K3：mood 由视图派生，绝不落库）；这里只负责调度与
// 「人在不在」的闸门。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { cabinAudio } from '@/lib/cabin-audio'
import {
  buildPresenceLine, deriveMood, presenceGap, presenceGate,
  type CabinMood, type MoodKey, type PresenceLineData, type PresenceRate,
} from './cockpit'
import type { XiyinScene } from './xiyin-scene'

/** 一条主动搭话（provider 派发，立绘浮舱渲染成汐音对白）。 */
export interface PresenceLine extends PresenceLineData { id: number }

export interface XiyinState {
  mood: MoodKey
  moodOverride: MoodKey | null
  setMoodOverride: (m: MoodKey | null, ms?: number) => void
  /** 在场：待渲染的主动搭话（一次性，渲染后 dismiss）。 */
  presenceLine: PresenceLine | null
  /** 在场：下一轮开口时间（epoch ms；0 = 未排程）。 */
  presenceDueAt: number
  presenceSnoozeUntil: number
  dismissPresence: () => void
  snoozePresence: (minutes: number) => void
  testPresence: () => void
  /** 立绘对白/助理菜单正开着 → 在场景里设 true，主动搭话等这一轮结束。 */
  setCrewBusy: (busy: boolean) => void
}

export function useXiyinState({
  scene,
  moodPref,
  presenceOn,
  presenceRate,
  active = true,
}: {
  scene: XiyinScene
  /** 调校台里的「心情」：非 auto 时压过状态机。 */
  moodPref: CabinMood
  presenceOn: boolean
  presenceRate: PresenceRate
  /** 立绘此刻是否真的挂着（舱内切到任务/别的会话时没有立绘 → 停止排程）。 */
  active?: boolean
}): XiyinState {
  const [moodOverride, setMoodOverrideState] = useState<MoodKey | null>(null)
  const [presenceLine, setPresenceLine] = useState<PresenceLine | null>(null)
  const [presenceDueAt, setPresenceDueAt] = useState(0)
  const [presenceSnoozeUntil, setPresenceSnoozeUntil] = useState(0)

  // 闸门要读最新值，用 ref 避免把随机排程做成「每次渲染重置」。
  const sceneRef = useRef(scene)
  const crewBusyRef = useRef(false)
  const lastUserAtRef = useRef(Date.now())
  const presenceNRef = useRef(0)
  const presenceLastTextRef = useRef<string | null>(null)
  const presenceIdRef = useRef(0)
  const presenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const moodTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => { sceneRef.current = scene }, [scene])

  // 换舱 = 换一份形象状态：瞬时态全部归零（舱 A 的静默不会带去舱 B）。
  const sceneKey = scene.key
  useEffect(() => {
    setMoodOverrideState(null)
    setPresenceLine(null)
    setPresenceSnoozeUntil(0)
    presenceNRef.current = 0
    presenceLastTextRef.current = null
    lastUserAtRef.current = Date.now()
    if (moodTimerRef.current) { clearTimeout(moodTimerRef.current); moodTimerRef.current = null }
  }, [sceneKey])

  const mood = useMemo(() => deriveMood({
    prefsMood: moodPref,
    override: moodOverride,
    status: scene.status,
    personAttention: scene.personAttention,
    running: scene.running,
    streaming: scene.streaming,
    hasBlocked: scene.hasBlocked,
  }), [
    moodPref, moodOverride, scene.status,
    scene.personAttention, scene.running, scene.streaming, scene.hasBlocked,
  ])

  const setMoodOverride = useCallback((m: MoodKey | null, ms?: number) => {
    setMoodOverrideState(m)
    if (moodTimerRef.current) clearTimeout(moodTimerRef.current)
    if (m) moodTimerRef.current = setTimeout(() => setMoodOverrideState(null), ms ?? 2600)
  }, [])

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
    if (presenceOn) return
    setPresenceLine(null)
    setPresenceSnoozeUntil(0)
  }, [presenceOn])

  const pickLine = useCallback((n: number): PresenceLineData => {
    const s = sceneRef.current
    return buildPresenceLine({
      personAttention: s.personAttention,
      attentionTotal: s.attentionTotal,
      queued: s.queued,
      running: s.running,
      dormant: s.dormant,
      firstAttentionTitle: s.firstAttentionTitle,
      hour: new Date().getHours(),
      n,
      lastText: presenceLastTextRef.current,
    })
  }, [])

  // 排程：到点 → 过闸门 → 开口 → 重排；开关 / 频率 / 静默 / 立绘是否在场都会重排。
  useEffect(() => {
    if (presenceTimerRef.current) { clearTimeout(presenceTimerRef.current); presenceTimerRef.current = null }
    if (!presenceOn || !active) { setPresenceDueAt(0); return }
    let cancelled = false

    function schedule(delayMs?: number) {
      if (cancelled) return
      const due = presenceSnoozeUntil > Date.now()
        ? presenceSnoozeUntil
        : Date.now() + (delayMs ?? presenceGap(presenceRate))
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
      const s = sceneRef.current
      const block = presenceGate({
        on: presenceOn,
        now,
        snoozedUntil: presenceSnoozeUntil,
        hidden: typeof document !== 'undefined' && document.hidden,
        streaming: s.streaming,
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
      schedule()
    }

    // 进场景先安静 15–30s，别一进来就开口。
    schedule(15_000 + Math.random() * 15_000)
    return () => {
      cancelled = true
      if (presenceTimerRef.current) { clearTimeout(presenceTimerRef.current); presenceTimerRef.current = null }
    }
  }, [presenceOn, presenceRate, presenceSnoozeUntil, pickLine, sceneKey, active])

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

  useEffect(() => () => {
    if (moodTimerRef.current) clearTimeout(moodTimerRef.current)
    if (presenceTimerRef.current) clearTimeout(presenceTimerRef.current)
  }, [])

  return useMemo<XiyinState>(() => ({
    mood, moodOverride, setMoodOverride,
    presenceLine, presenceDueAt, presenceSnoozeUntil,
    dismissPresence, snoozePresence, testPresence, setCrewBusy,
  }), [
    mood, moodOverride, setMoodOverride,
    presenceLine, presenceDueAt, presenceSnoozeUntil,
    dismissPresence, snoozePresence, testPresence, setCrewBusy,
  ])
}
