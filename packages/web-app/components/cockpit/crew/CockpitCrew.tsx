'use client'

// S7 · 汐音立绘 / 台词 / 在场（cockpit-v13 .crew / .pod / .speech / .heart）。
//
// 2026-11-15 v13：**点立绘 = 跟她说话**（打开对话浮窗并把焦点送进 composer），
// 与 classic 同义。表情画廊 / 在场节奏 / 互动 / 说一句这些设置全部搬到 HUD 的
// 「◐ 汐音」（CockpitCrewSettings）；本组件不再承载控制条。
//
// 2026-11-15 v13.1 · 点击的**即时反馈**（对齐 classic 点立绘的手感）：
//   一次点击在同一拍里出四样东西 —— 表情换图（mood override）、立绘上浮星光、
//   一圈边框涟漪、点击音；随后气泡说一句（首点「我在。你说。」，之后按 XY_LINES
//   顺序轮播）。全仓再叠 `fx.edge` 四边流光，炫档加背景扫描/环（`fx.feedback`）。
//   900ms 内的连点只重复「星光 + 涟漪 + 音效」，不重启打字机、不重复台词 ——
//   否则连点会看到字一闪一闪地从头打。
//   反馈全部是绝对定位，`.ck12-crew` 的尺寸一键不变（见 design/13 §1.5 铁律）。
//
// 数据只读 CockpitProvider（mood / presenceLine / testPresence）与
// CockpitStateProvider（chat.streaming / fx.say / chatWindow）：
//   · presenceLine → 本地气泡逐字 + fx.say（ticker 一份）；**不写 chat DOM，不调 chat API**；
//   · 「互动一下」由设置面经 crew-events 发信号，这里执行（台词取 XY_LINES）；
//   · prefers-reduced-motion：心形 / 浮动关掉，打字机直接出全文。
//
// 布局纪律：气泡 / 心形都是绝对定位，不参与任何 flex 高度计算。

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { cabinAudio } from '@/lib/cabin-audio'
import { useCockpit } from '@/components/cabin/CockpitProvider'
import {
  CREW,
  XY_LINES,
  moodPortrait,
  type MoodKey,
} from '@/components/cabin/cockpit'
import { useCockpitState } from '../state/CockpitStateProvider'
import { subscribeCrewPoke } from './crew-events'
import { getChatSlot } from '../chat/chat-slots'

const TYPE_MS = 22
/** 首点（对话窗原本是关的）说这一句；之后连点按 XY_LINES 顺序轮播。 */
const GREET = '我在。你说。'
/** 连点节流：这段时间内只重复触感（星光/涟漪/音效），不重开打字机。 */
const TALK_GAP_MS = 900

interface Speech {
  id: number
  text: string
  mood: MoodKey
  hold: number
}

interface Spark {
  id: number
  left: number
  top: number
  dx: number
  dy: number
}

function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = (event: MediaQueryListEvent) => setReduce(event.matches)
    setReduce(query.matches)
    query.addEventListener?.('change', onChange)
    return () => query.removeEventListener?.('change', onChange)
  }, [])

  return reduce
}

export function CockpitCrew() {
  const {
    prefs,
    mood,
    presenceLine,
    dismissPresence,
    setMoodOverride,
    setCrewBusy,
  } = useCockpit()
  const { chat, fx, chatWindow } = useCockpitState()
  const reduce = usePrefersReducedMotion()

  const [speech, setSpeech] = useState<Speech | null>(null)
  const [typed, setTyped] = useState('')
  const [heart, setHeart] = useState(0)
  const [sparks, setSparks] = useState<Spark[]>([])
  const [tap, setTap] = useState(0)

  const speechIdRef = useRef(0)
  const consumedPresenceRef = useRef<number | null>(null)
  const heartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sparkIdRef = useRef(0)
  const sparkTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([])
  const lineIdxRef = useRef(0)
  const lastTalkRef = useRef(0)

  const meta = CREW[mood] ?? CREW.idle
  const portrait = moodPortrait(mood)
  const streaming = chat?.streaming ?? false

  // ── 台词：本地气泡（逐字）+ ticker（fx.say 一份）────────────────────
  const present = useCallback((text: string, nextMood: MoodKey, hold: number) => {
    setSpeech({ id: ++speechIdRef.current, text, mood: nextMood, hold })
  }, [])

  // ── 触感：立绘上浮星光（对齐 classic .xy-spark）──────────────────────
  const sparkle = useCallback(() => {
    if (reduce) return
    const batch: Spark[] = Array.from({ length: 6 }, () => ({
      id: sparkIdRef.current++,
      left: 36 + Math.random() * 260,
      top: 70 + Math.random() * 230,
      dx: Math.random() * 90 - 45,
      dy: -42 - Math.random() * 66,
    }))
    // 连点不无限堆积：只留最近 18 颗。
    setSparks((all) => [...all, ...batch].slice(-18))
    const ids = new Set(batch.map((item) => item.id))
    const timer = setTimeout(() => {
      setSparks((all) => all.filter((item) => !ids.has(item.id)))
      sparkTimersRef.current = sparkTimersRef.current.filter((item) => item !== timer)
    }, 900)
    sparkTimersRef.current.push(timer)
  }, [reduce])

  // ── 点她 = 说话（v13.1：点击同一拍就给反馈，然后才开窗）──────────────
  const talkToXiyin = useCallback(() => {
    const wasOpen = chatWindow.open
    const now = Date.now()
    const fresh = now - lastTalkRef.current > TALK_GAP_MS
    lastTalkRef.current = now

    // 1) 手感：星光 + 边框涟漪 + 点击音 —— 每次都出，连点也出。
    sparkle()
    setTap((n) => n + 1)
    cabinAudio.blip(920, 0.05)

    // 2) 台词（节流）：首点招呼，之后按 XY_LINES 顺序轮播；表情跟着台词换。
    if (fresh) {
      let text: string
      let lineMood: MoodKey
      let hold: number
      if (!wasOpen) {
        text = GREET
        lineMood = 'wink'
        hold = 3600
      } else {
        const [line, mood] = XY_LINES[lineIdxRef.current++ % XY_LINES.length]
        text = line
        lineMood = mood
        hold = 4600
      }
      present(text, lineMood, hold)
      setMoodOverride(lineMood, hold + 400)
      // 3) 全仓一拍：四边流光；炫档再加背景扫描/环（都在内容之下，不挡点击）。
      fx.edge('var(--ck-b)')
      if (prefs.fxLevel === 'full') fx.feedback('var(--ck-b)', 'lite')
    }

    // 4) 正事：开对话窗 + 焦点送进 composer（槽是跨树 portal 的）。
    chatWindow.openWithFocus()
    requestAnimationFrame(() => {
      getChatSlot('composer')?.querySelector<HTMLTextAreaElement>('textarea')?.focus()
    })
  }, [chatWindow, fx, prefs.fxLevel, present, setMoodOverride, sparkle])

  useEffect(() => {
    if (!presenceLine) return
    if (consumedPresenceRef.current === presenceLine.id) return
    consumedPresenceRef.current = presenceLine.id

    const hold = presenceLine.hold ?? 9000
    present(presenceLine.text, presenceLine.mood, hold)
    setMoodOverride(presenceLine.mood, hold + 400)
    fx.say(presenceLine.text, presenceLine.mood)
    // 反馈特效：炫档给光晕+环（lite），标准/克制只留四边流光（off）。
    fx.feedback('var(--ck-b)', prefs.fxLevel === 'full' ? 'lite' : 'off')
    fx.edge('var(--ck-b)')
    dismissPresence()
  }, [presenceLine, present, setMoodOverride, fx, dismissPresence, prefs.fxLevel])

  // 打字机：新台词重开；reduced-motion 直接出全文。
  useEffect(() => {
    if (!speech) {
      setTyped('')
      return
    }
    if (reduce) {
      setTyped(speech.text)
      return
    }
    setTyped('')
    let index = 0
    const timer = setInterval(() => {
      index += 1
      setTyped(speech.text.slice(0, index))
      if (index >= speech.text.length) clearInterval(timer)
    }, TYPE_MS)
    return () => clearInterval(timer)
  }, [speech, reduce])

  // 气泡停留：hold + 打字耗时；只让当前这条收起。
  useEffect(() => {
    if (!speech) return
    const life = speech.hold + (reduce ? 0 : speech.text.length * TYPE_MS)
    const timer = setTimeout(() => {
      setSpeech((current) => (current && current.id === speech.id ? null : current))
    }, life)
    return () => clearTimeout(timer)
  }, [speech, reduce])

  // 流式时占用在场闸门：汐音不在这时候主动开口（chat 未接上 → false）。
  useEffect(() => {
    setCrewBusy(streaming)
  }, [streaming, setCrewBusy])
  useEffect(() => () => setCrewBusy(false), [setCrewBusy])

  useEffect(() => () => {
    if (heartTimerRef.current) clearTimeout(heartTimerRef.current)
    sparkTimersRef.current.forEach((timer) => clearTimeout(timer))
    sparkTimersRef.current = []
  }, [])

  // ── 「互动一下」：设置面发信号，这里执行（气泡 + 表情 + 心形）──────────
  const interact = useCallback(() => {
    const [line, lineMood] = XY_LINES[Math.floor(Math.random() * XY_LINES.length)]
    present(line, lineMood, 5000)
    setMoodOverride(lineMood, 3000)
    fx.say(line, lineMood)
    fx.edge('var(--ck-b)')
    cabinAudio.chime()
    if (reduce) return
    setHeart((n) => n + 1)
    if (heartTimerRef.current) clearTimeout(heartTimerRef.current)
    heartTimerRef.current = setTimeout(() => setHeart(0), 1100)
  }, [present, setMoodOverride, fx, reduce])

  useEffect(() => subscribeCrewPoke(interact), [interact])

  return (
    <div className="ck12-crew" data-testid="cockpit-crew">
      <button
        type="button"
        className="ck12-pod"
        data-state={mood}
        data-testid="cockpit-crew-pod"
        aria-label={`汐音 · ${meta.label} · 点击跟她说话`}
        onClick={talkToXiyin}
      >
        <img src={portrait} alt="汐音" />
        <span className="ck12-pod-scan" aria-hidden="true" />
        <span className="ck12-pod-vg" aria-hidden="true" />
        {sparks.map((spark) => (
          <span
            key={spark.id}
            className="ck12-spark"
            aria-hidden="true"
            data-testid="cockpit-crew-spark"
            style={{
              left: `${spark.left}px`,
              top: `${spark.top}px`,
              ['--dx' as string]: `${spark.dx}px`,
              ['--dy' as string]: `${spark.dy}px`,
            }}
          >✦</span>
        ))}
        <span className="ck12-pod-tag"><i aria-hidden="true" />XIYIN-07 · 在线</span>
        <span className="ck12-pod-name">
          汐音 <small>· 全域助理</small>
          <em data-testid="cockpit-crew-mood">{meta.label}</em>
        </span>
      </button>

      {/* 点击涟漪：一圈边框向外淡出（纯装饰，不吃事件、不占布局） */}
      {tap > 0 && (
        <span key={tap} className="ck12-tapring" aria-hidden="true" data-testid="cockpit-crew-tapring" />
      )}

      <div
        className={`ck12-speech${speech ? ' show' : ''}`}
        data-testid="cockpit-crew-speech"
        aria-live="polite"
        aria-hidden={!speech}
        onClick={talkToXiyin}
        role={speech ? 'button' : undefined}
        tabIndex={speech ? 0 : undefined}
        title="点气泡也能说话"
      >
        {speech && (
          <>
            <div className="ck12-speech-who">
              <i aria-hidden="true" />汐音 · 助理
              <span className="ck12-speech-tag">{CREW[speech.mood]?.label ?? '待命'}</span>
            </div>
            <div className="ck12-speech-tx">
              {typed}
              <span className="ck12-speech-cur" aria-hidden="true">▸</span>
            </div>
          </>
        )}
      </div>

      {!reduce && heart > 0 && (
        <span key={heart} className="ck12-heart pop" aria-hidden="true" data-testid="cockpit-crew-heart">♡</span>
      )}
    </div>
  )
}