'use client'

// S7 · 汐音立绘 / 台词 / 在场（cockpit-v12 .crew / .pod / .speech / .pmenu / .heart）。
//
// 数据只读 CockpitProvider（mood / presenceLine / testPresence / setPref）与
// CockpitStateProvider（chat.streaming / fx.say / layer）：
//   · presenceLine → 本地气泡逐字 + fx.say（ticker 一份）；**不写 chat DOM，不调 chat API**；
//   · 「互动一下」随机取 cockpit.ts 的 XY_LINES，表情画廊取 XY_FORMS 的真实列表；
//   · 关闭按钮是控制条 DOM 里第一个可聚焦元素（plans §1.6），Esc 交给 LayerStack；
//   · prefers-reduced-motion：心形 / 浮动关掉，打字机直接出全文。
//
// 在场定时器由 useXiyinState 统一排程，这里只呈现 + 调已有动作。

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cabinAudio } from '@/lib/cabin-audio'
import { useCockpit } from '@/components/cabin/CockpitProvider'
import {
  CREW,
  PRESENCE_RATES,
  XY_FORMS,
  XY_LINES,
  moodPortrait,
  type MoodKey,
  type PresenceRate,
} from '@/components/cabin/cockpit'
import { useCockpitState } from '../state/CockpitStateProvider'

/** Esc 顺序：popover（更高）→ 立绘控制条 → 任务模块窗 → 编队抽屉 → 聊天浮窗（60）。 */
const CREW_MENU_LAYER_PRIORITY = 75
const TYPE_MS = 22
const PMENU_WIDTH = 344
const PMENU_FALLBACK_HEIGHT = 148

interface Speech {
  id: number
  text: string
  mood: MoodKey
  hold: number
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
    mood,
    prefs,
    setPref,
    setMoodOverride,
    presenceLine,
    dismissPresence,
    testPresence,
    setCrewBusy,
  } = useCockpit()
  const { chat, fx, layer } = useCockpitState()
  const reduce = usePrefersReducedMotion()

  const [menuOpen, setMenuOpen] = useState(false)
  const [speech, setSpeech] = useState<Speech | null>(null)
  const [typed, setTyped] = useState('')
  const [heart, setHeart] = useState(0)
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null)

  const speechIdRef = useRef(0)
  const consumedPresenceRef = useRef<number | null>(null)
  const heartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const podRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  const meta = CREW[mood] ?? CREW.idle
  const portrait = moodPortrait(mood)
  const streaming = chat?.streaming ?? false

  // ── 台词：本地气泡（逐字）+ ticker（fx.say 一份）────────────────────
  const present = useCallback((text: string, nextMood: MoodKey, hold: number) => {
    setSpeech({ id: ++speechIdRef.current, text, mood: nextMood, hold })
  }, [])

  useEffect(() => {
    if (!presenceLine) return
    if (consumedPresenceRef.current === presenceLine.id) return
    consumedPresenceRef.current = presenceLine.id

    const hold = presenceLine.hold ?? 9000
    present(presenceLine.text, presenceLine.mood, hold)
    setMoodOverride(presenceLine.mood, hold + 400)
    fx.say(presenceLine.text, presenceLine.mood)
    dismissPresence()
  }, [presenceLine, present, setMoodOverride, fx, dismissPresence])

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

  // 气泡停留：hold + 打字耗时（与旧舱一致）；只让当前这条收起。
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
  }, [])

  // ── 控制条：位置（贴在立绘上方）、焦点、Esc、外点关闭 ────────────────
  const place = useCallback(() => {
    if (typeof window === 'undefined') return
    const rect = podRef.current?.getBoundingClientRect()
    if (!rect) return
    const width = menuRef.current?.offsetWidth || PMENU_WIDTH
    const height = menuRef.current?.offsetHeight || PMENU_FALLBACK_HEIGHT
    setMenuPos({
      // left 是控制条中心：CSS 用 translateX(-50%)。
      left: Math.max(10 + width / 2, Math.min(rect.left + rect.width / 2, window.innerWidth - 10 - width / 2)),
      top: Math.max(56, rect.top - height - 12),
    })
  }, [])

  useLayoutEffect(() => {
    if (!menuOpen) return
    place()
  }, [menuOpen, place])

  useEffect(() => {
    if (!menuOpen) return
    const onResize = () => place()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [menuOpen, place])

  useEffect(() => {
    if (!menuOpen) return
    closeRef.current?.focus()
  }, [menuOpen])

  // Esc 逐层：控制条是独立一层（S1 的 CockpitLayerStack 是唯一监听者）。
  useEffect(() => {
    if (!menuOpen) return
    return layer.register('cockpit-crew-menu', CREW_MENU_LAYER_PRIORITY, () => setMenuOpen(false))
  }, [menuOpen, layer])

  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (menuRef.current?.contains(target) || podRef.current?.contains(target)) return
      setMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [menuOpen])

  const closeMenu = useCallback(() => {
    setMenuOpen(false)
    cabinAudio.blip(560, 0.04)
  }, [])

  const toggleMenu = useCallback(() => {
    cabinAudio.blip(720, 0.05)
    setMenuOpen((open) => !open)
  }, [])

  // ── 动作 ───────────────────────────────────────────────────────────
  const saySomething = useCallback(() => {
    setMenuOpen(false)
    testPresence()
  }, [testPresence])

  const interact = useCallback(() => {
    setMenuOpen(false)
    const [line, lineMood] = XY_LINES[Math.floor(Math.random() * XY_LINES.length)]
    present(line, lineMood, 5000)
    setMoodOverride(lineMood, 3000)
    fx.say(line, lineMood)
    cabinAudio.chime()
    if (reduce) return
    setHeart((n) => n + 1)
    if (heartTimerRef.current) clearTimeout(heartTimerRef.current)
    heartTimerRef.current = setTimeout(() => setHeart(0), 1100)
  }, [present, setMoodOverride, fx, reduce])

  const pickMood = useCallback((next: MoodKey) => {
    setMoodOverride(next)
    cabinAudio.blip(660, 0.05)
  }, [setMoodOverride])

  const pickRate = useCallback((rate: PresenceRate) => {
    setPref('presenceRate', rate)
  }, [setPref])

  const rate = PRESENCE_RATES[prefs.presenceRate] ?? PRESENCE_RATES.std

  // ── 控制条（portal 到 body：不被 arena overflow 裁剪，层级独立）────────
  const pmenu = menuOpen && typeof document !== 'undefined'
    ? createPortal(
        <div
          ref={menuRef}
          className="ck12-pmenu"
          role="dialog"
          aria-label="汐音控制条"
          data-testid="cockpit-crew-menu"
          style={{
            left: menuPos ? `${menuPos.left}px` : '50%',
            top: `${menuPos?.top ?? 64}px`,
          }}
        >
          <div className="ck12-pm-h">
            {/* 硬要求：关闭是第一个可聚焦元素，视觉在左（plans §1.6）。 */}
            <button
              ref={closeRef}
              type="button"
              className="ck12-pm-x"
              onClick={closeMenu}
              aria-label="关闭控制条"
              data-testid="cockpit-crew-menu-close"
            ><X className="size-3" aria-hidden="true" /></button>
            <span className="ck12-pm-av"><img src={portrait} alt="" /></span>
            <b>汐音</b>
            <span className="ck12-pm-sub">XIYIN-07 · 全域助理</span>
          </div>

          <div className="ck12-pm-line">
            <button type="button" className="ck12-pm-btn" onClick={saySomething} data-testid="cockpit-crew-say">
              <span>✦</span>说一句
            </button>
            <button type="button" className="ck12-pm-btn" onClick={interact} data-testid="cockpit-crew-poke">
              <span>♡</span>互动一下
            </button>
            <span className="ck12-pm-seg" role="group" aria-label="在场频率">
              {(Object.keys(PRESENCE_RATES) as PresenceRate[]).map((key) => {
                const item = PRESENCE_RATES[key]
                return (
                  <button
                    key={key}
                    type="button"
                    className={prefs.presenceRate === key ? 'on' : undefined}
                    aria-pressed={prefs.presenceRate === key}
                    title={`${item.label} · 每 ${item.min}–${item.max} 分钟一句`}
                    onClick={() => pickRate(key)}
                    data-testid={`cockpit-crew-rate-${key}`}
                  >{item.label}</button>
                )
              })}
            </span>
          </div>

          <div className="ck12-pm-note" data-testid="cockpit-crew-rate-note">
            {prefs.presenceOn
              ? `在场 · 约每 ${rate.min}–${rate.max} 分钟一句`
              : '在场已关 · 在舰桥开启后按该频率开口'}
          </div>

          <div className="ck12-pm-gal" data-testid="cockpit-crew-gallery">
            {XY_FORMS.map((form) => (
              <button
                key={form.k}
                type="button"
                className={mood === form.k ? 'on' : undefined}
                aria-label={`表情 · ${form.name}`}
                aria-pressed={mood === form.k}
                title={`${form.name} · ${form.tag} · ${form.desc}`}
                onClick={() => pickMood(form.k)}
                data-mood={form.k}
              >
                <img src={moodPortrait(form.k)} alt="" />
              </button>
            ))}
          </div>
        </div>,
        document.body,
      )
    : null

  return (
    <div className="ck12-crew" data-testid="cockpit-crew">
      <button
        ref={podRef}
        type="button"
        className="ck12-pod"
        data-state={mood}
        data-testid="cockpit-crew-pod"
        aria-haspopup="dialog"
        aria-expanded={menuOpen}
        aria-label={`汐音 · ${meta.label} · 打开控制条`}
        title="汐音 · 点击打开控制条"
        onClick={toggleMenu}
      >
        <img src={portrait} alt="汐音" />
        <span className="ck12-pod-scan" aria-hidden="true" />
        <span className="ck12-pod-vg" aria-hidden="true" />
        <span className="ck12-pod-tag"><i aria-hidden="true" />XIYIN-07 · 在线</span>
        <span className="ck12-pod-name">
          汐音 <small>· 全域助理</small>
          <em data-testid="cockpit-crew-mood">{meta.label}</em>
        </span>
      </button>

      <div
        className={`ck12-speech${speech ? ' show' : ''}`}
        data-testid="cockpit-crew-speech"
        aria-live="polite"
        aria-hidden={!speech}
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

      {pmenu}
    </div>
  )
}
