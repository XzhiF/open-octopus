'use client'

// S7 · 汐音立绘 / 台词 / 在场（cockpit-v13 .crew / .pod / .speech / .heart）。
//
// 2026-11-15 v13：**点立绘 = 跟她说话**（打开对话浮窗并把焦点送进 composer），
// 与 classic 同义。表情画廊 / 在场节奏 / 互动 / 说一句这些设置全部搬到 HUD 的
// 「◐ 汐音」（CockpitCrewSettings）；本组件不再承载控制条。
//
// 2026-11-15 v13.1 · 点击的**即时反馈**（对齐 classic 点立绘的手感）：
//   一次点击在同一拍里出三样东西 —— 表情换图（mood override）、立绘上浮星光、
//   点击音；随后气泡说一句（首点「我在。你说。」，之后按 XY_LINES
//   顺序轮播）。全仓再叠 `fx.edge` 四边流光，炫档加背景扫描/环（`fx.feedback`）。
//   900ms 内的连点只重复「星光 + 音效」，不重启打字机、不重复台词 ——
//   否则连点会看到字一闪一闪地从头打。
//   v21 四轮：去掉立绘周边那圈矩形描边涟漪（原型立绘无框）。
//   反馈全部是绝对定位，`.ck12-crew` 的尺寸一键不变（见 design/13 §1.5 铁律）。
//
// 2026-11-16 · 对话联动（chat-reactions.ts）：
//   · 发出消息（chat.streaming false → true）→「回复中」思考/工作表情 + 等待气泡，
//     每 15s 换一句（越等越久语气换档），立绘角标显示已等秒数；
//   · 回答结束（true → false）→ 收尾表情（庆祝/完成/俏皮）+「回完了」+ 星光/边缘；
//   · 用户正在输入（composer 草稿非空）→「倾听」表情 + 一句「我在听」，只提示一次。
//   表情覆盖只在 prefs.mood = auto 且没有点击/presence 的瞬时 override 时生效，
//   所以 v13.1 的「点她立刻换表情」不会被对话联动吃掉。
//
// 数据只读 CockpitProvider（mood / presenceLine / testPresence）与
// CockpitStateProvider（chat.streaming / fx.say / chatWindow）：
//   · presenceLine → 本地气泡逐字 + fx.say（ticker 一份）；**不写 chat DOM，不调 chat API**；
//   · 「互动一下」由设置面经 crew-events 发信号，这里执行（台词取 XY_LINES）；
//   · prefers-reduced-motion：心形 / 浮动 / 星光关掉，打字机直接出全文。
//
// 2026-11-19 · 等你在场（用户：有待办时一直摇头、既呆又没信息）：
//   · 派生 mood = alert（有 attention 挂在你这里）时，片段不再锁死一支 ——
//     WAITING_CLIPS 以 alert 为主拍穿插日常动作，姿态语义仍是「警觉」；
//   · 头顶气泡按 18–27s 轮播真实清单（buildWaitNudges：条数 / 待验收 / 待拍板 /
//     受阻 + 具体标题），正在回复 / 倾听 / 别的台词在播时让位；
//   · 尊敬既有开关：在场关闭或静默中不提醒。
//
// 布局纪律：气泡 / 心形都是绝对定位，不参与任何 flex 高度计算。

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { cabinAudio } from '@/lib/cabin-audio'
import { useCockpit } from '@/components/cabin/CockpitProvider'
import {
  CREW,
  XY_LINES,
  type MoodKey,
} from '@/components/cabin/cockpit'
import { useCockpitState } from '../state/CockpitStateProvider'
import { useCockpitFleet } from '../fleet/CockpitFleetProvider'
import { collectInbox } from '../rail/inbox-model'
import { subscribeCrewPoke } from './crew-events'
import { buildWaitNudges } from './wait-nudges'
import { getChatSlot } from '../chat/chat-slots'
import {
  doneLine, listenLine, waitingLine,
} from './chat-reactions'
import {
  CLIPS, MOOD_POSE, POSE_META, POSE_MOOD, clipPose, clipVariants, nextAmbientClip,
  poseClip, waitingClipAt,
  type PoseKey,
} from './pose-model'
import { CockpitPoseSprite, PoseFX } from './CockpitPoseSprite'

const TYPE_MS = 22
/** 首点（对话窗原本是关的）说这一句；之后连点按 XY_LINES 顺序轮播。 */
const GREET = '我在。你说。'
/** 连点节流：这段时间内只重复触感（星光/音效），不重开打字机。 */
const TALK_GAP_MS = 900
/** 等待回答的气泡保持到下一次轮换/收尾；长回答中途不会空掉。 */
const WAIT_HOLD_MS = 60_000
/** 生成中每 15s 换一句等待台词（只在气泡仍是等待台词、或已收起时）。 */
const WAIT_REFRESH_MS = 15_000
/** 回答结束后，收尾表情和「已回完」标签保持多久。 */
const DONE_MOOD_MS = 3_200
/** 报到（ready）停留时长：台词比普通动作长，给足打字 + 停留。 */
const READY_MS = 4_200
/** 等你在场：首条提醒在进入待办态多久后开口；之后 18–27s 一条。 */
const WAIT_NUDGE_FIRST_MS = 7_000
const WAIT_NUDGE_GAP_MS = 18_000
const WAIT_NUDGE_JITTER_MS = 9_000
/** 提醒被占用（正在回复 / 倾听 / 别的台词在播）时，多久再看一眼。 */
const WAIT_NUDGE_RETRY_MS = 6_000

type ChatPhase = 'idle' | 'waiting' | 'done'
/** 气泡来源：等待轮换只覆盖自己，不打断点击/在场/倾听的台词。 */
type SpeechSource =
  | 'chat-wait' | 'chat-done' | 'listen' | 'click' | 'presence' | 'poke' | 'attention'

interface Speech {
  id: number
  text: string
  mood: MoodKey
  hold: number
  source: SpeechSource
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
    moodOverride,
    presenceLine,
    presenceSnoozeUntil,
    dismissPresence,
    setMoodOverride,
    setCrewBusy,
    scene,
  } = useCockpit()
  const { chat, fx, chatWindow, reportPose } = useCockpitState()
  // 待办清单（与右栏「要我处理」同一份 collectInbox 结果）：等待穿插与头顶提醒
  // 都读它 —— 提醒里的条数 / 标题是真实的 attention，不另拉接口。
  const { rows } = useCockpitFleet()
  const inboxEntries = useMemo(() => collectInbox(rows), [rows])
  const inboxRef = useRef(inboxEntries)
  useEffect(() => { inboxRef.current = inboxEntries }, [inboxEntries])
  const reduce = usePrefersReducedMotion()

  const [speech, setSpeech] = useState<Speech | null>(null)
  const [typed, setTyped] = useState('')
  const [heart, setHeart] = useState(0)
  const [sparks, setSparks] = useState<Spark[]>([])
  /** 对话联动：空闲 / 正在回复 / 刚回完。 */
  const [phase, setPhase] = useState<ChatPhase>('idle')
  /** 对话联动带来的表情（思考 / 完成 / 倾听）；null = 用舱面的派生 mood。 */
  const [reactMood, setReactMood] = useState<MoodKey | null>(null)
  /** 用户草稿非空 = 倾听态（助理在等你把话说完）。 */
  const [listening, setListening] = useState(false)
  /** 「回复中 12s」的秒表。 */
  const [waitSeconds, setWaitSeconds] = useState(0)

  const speechIdRef = useRef(0)
  const speechRef = useRef<Speech | null>(null)
  const consumedPresenceRef = useRef<number | null>(null)
  const heartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sparkIdRef = useRef(0)
  const sparkTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([])
  const lineIdxRef = useRef(0)
  /** 待办提醒轮播下标（每条说一次再回环）。 */
  const nudgeIdxRef = useRef(0)
  /** 等待穿插的步进游标：从第二拍起步（第一拍就换一支日常动作）。
   *  WAITING_CLIPS 里 alert 重复出现，不能用「当前片段找下标」推下一拍。 */
  const waitingStepRef = useRef(1)
  const lastTalkRef = useRef(0)
  // 对话联动用 ref 读最新值，避免把 streaming 过渡做成「每次渲染重新触发」。
  const streamingRef = useRef(false)
  const prevStreamingRef = useRef(false)
  const streamStartedRef = useRef(0)
  const listeningRef = useRef(false)
  const phaseRef = useRef<ChatPhase>('idle')
  const doneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const streaming = chat?.streaming ?? false
  useEffect(() => { streamingRef.current = streaming }, [streaming])
  useEffect(() => { phaseRef.current = phase }, [phase])

  // 对话联动表情只在「自动心情」且没有点击/在场瞬时 override 时生效：
  // 点她一下仍然是 wink，不会被「思考」压住。
  const chatMood: MoodKey | null =
    phase === 'waiting' ? (reactMood ?? 'thinking')
      : phase === 'done' ? (reactMood ?? 'cheer')
        : listening ? (reactMood ?? 'happy')
          : null
  const shownMood: MoodKey = prefs.mood === 'auto' && !moodOverride && chatMood
    ? chatMood
    : mood
  const label = phase === 'waiting'
    ? '回复中'
    : phase === 'done'
      ? (CREW[shownMood]?.label ?? CREW.happy.label)
      : listening
        ? '倾听'
        : (CREW[shownMood]?.label ?? CREW.idle.label)
  /** v22：动作姿态 override（派单 command / 图鉴 playClip / 报到 ready），
   *  期间 mood 不覆盖 pose；结束回落 mood pose（design 29 §9.1）。
   *  actionClip 记录图鉴点名的精确片段（同 pose 有多支片段时不合并）。 */
  const [actionPose, setActionPose] = useState<PoseKey | null>(null)
  const [actionClip, setActionClip] = useState<number | null>(null)
  /** v22.1：待命自走片段 —— 只在「真空闲」时生效，7–12s 换一支日常小动作。 */
  const [ambientClip, setAmbientClip] = useState<number | null>(null)
  const actionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const shownPose: PoseKey = actionPose
    ?? (phase === 'waiting' ? 'typing' : MOOD_POSE[shownMood])
  /** 真空闲 = 没有动作 override / 不在回复或倾听 / 语义姿态就是待命。 */
  const idleFree = !actionPose && phase === 'idle' && !listening && shownPose === 'idle'
  /** 等你在场（2026-11-19）：有 attention 挂在你这里 → 语义姿态 alert。此时
   *  片段也不能一支死循环（用户：一直左右摇头很呆）—— 按 WAITING_CLIPS 穿插。 */
  const waitingFree = !actionPose && phase === 'idle' && !listening && shownPose === 'alert'
  const rotateMode: 'ambient' | 'waiting' | null = idleFree
    ? 'ambient'
    : waitingFree ? 'waiting' : null
  /** v22：立绘永远视频；pose 只决定语义，clip 决定具体片段。
   *  优先级：动作点名 > 待命/等待轮播 > pose 首选片段。 */
  const shownClip = actionClip !== null && Number.isInteger(actionClip)
    ? actionClip
    : rotateMode !== null && ambientClip !== null
      ? ambientClip
      : poseClip(shownPose)
  const shownClipRef = useRef(shownClip)
  useEffect(() => { shownClipRef.current = shownClip }, [shownClip])
  useEffect(() => { reportPose(shownPose, shownClip) }, [shownPose, shownClip, reportPose])
  // v22.1 待命自走：真空闲时随机换日常小动作。首支 3.5–6s 就换（进舱后马上
  // 能看出她在动），之后 7–11s 一换；任何动作 / 对话 / 倾听 / reduced-motion
  // 打断即停，回到 idle 后重新起算。
  // 2026-11-19：有待办时（waiting 模式）按固定序列 4.2–6s / 5.2–7.8s 穿插，
  // 节奏比待命自走略快 —— 你正等着处理，她的动作要能看出「在场」。
  useEffect(() => {
    if (reduce || rotateMode === null) {
      setAmbientClip(null)
      return
    }
    let first = true
    let timer: ReturnType<typeof setTimeout>
    const schedule = () => {
      const delay = rotateMode === 'waiting'
        ? first ? 4200 + Math.random() * 1800 : 5200 + Math.random() * 2600
        : first ? 3500 + Math.random() * 2500 : 7000 + Math.random() * 4000
      first = false
      timer = setTimeout(() => {
        if (rotateMode === 'waiting') {
          // 游标步进（不在 setState updater 里改 ref：StrictMode 会双调用）。
          setAmbientClip(waitingClipAt(waitingStepRef.current))
          waitingStepRef.current += 1
        } else {
          // prev 为 null（本轮第一次轮播）= 画面还停在 pose 首选片段 —— 用
          // shownClipRef 当基准，保证第一拍确实换了一支（否则随机可能抽回同一支）。
          setAmbientClip((prev) => nextAmbientClip(prev ?? shownClipRef.current))
        }
        schedule()
      }, delay)
    }
    schedule()
    return () => clearTimeout(timer)
  }, [reduce, rotateMode])
  useEffect(() => () => {
    if (actionTimerRef.current) clearTimeout(actionTimerRef.current)
  }, [])
  const tagText = phase === 'waiting'
    ? `XIYIN-07 · 回复中 ${waitSeconds}s`
    : phase === 'done'
      ? 'XIYIN-07 · 已回完'
      : listening
        ? 'XIYIN-07 · 倾听'
        : 'XIYIN-07 · 在线'

  // ── 台词：本地气泡（逐字）+ ticker（fx.say 一份）────────────────────
  const present = useCallback((
    text: string,
    nextMood: MoodKey,
    hold: number,
    source: SpeechSource = 'click',
  ) => {
    const next: Speech = { id: ++speechIdRef.current, text, mood: nextMood, hold, source }
    speechRef.current = next
    setSpeech(next)
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
    // 点她先结束待命自走，让台词表情（mood override）立刻接管立绘。
    setAmbientClip(null)
    const now = Date.now()
    const fresh = now - lastTalkRef.current > TALK_GAP_MS
    lastTalkRef.current = now

    // 1) 手感：星光 + 点击音 —— 每次都出，连点也出。
    //    v21 四轮：立绘周边不再画矩形描边涟漪（原型无此边，点完会闪一圈边）。
    sparkle()
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
      present(text, lineMood, hold, 'click')
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
    present(presenceLine.text, presenceLine.mood, hold, 'presence')
    setMoodOverride(presenceLine.mood, hold + 400)
    fx.say(presenceLine.text, presenceLine.mood)
    // 反馈特效：炫档给光晕+环（lite），标准/克制只留四边流光（off）。
    fx.feedback('var(--ck-b)', prefs.fxLevel === 'full' ? 'lite' : 'off')
    fx.edge('var(--ck-b)')
    dismissPresence()
  }, [presenceLine, present, setMoodOverride, fx, dismissPresence, prefs.fxLevel])

  // ── 等你在场：待办提醒（2026-11-19 用户）────────────────────────────────
  // 有 attention 挂着 → 隔一阵在头顶报一条真实清单（条数 / 分组 / 标题），
  // 让她不只是摇头，还能把「要你处理什么」说出来。
  // 让位规则：正在回复（waiting）/ 倾听 / 页面隐藏 / 别的来源台词正在播时
  // 不抢麦，6s 后再看；在场关闭或静默期内完全不打扰。
  const hasPending = inboxEntries.length > 0
  useEffect(() => {
    if (!hasPending || !prefs.presenceOn) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const schedule = (ms: number) => { timer = setTimeout(fire, ms) }
    const fire = () => {
      if (cancelled) return
      const busy = streamingRef.current || listeningRef.current
        || presenceSnoozeUntil > Date.now()
        || (typeof document !== 'undefined' && document.hidden)
        || (speechRef.current !== null && speechRef.current.source !== 'attention')
      if (busy) {
        schedule(WAIT_NUDGE_RETRY_MS)
        return
      }
      const lines = buildWaitNudges(inboxRef.current)
      if (lines.length === 0) {
        schedule(WAIT_NUDGE_RETRY_MS)
        return
      }
      const line = lines[nudgeIdxRef.current % lines.length]!
      nudgeIdxRef.current += 1
      present(line.text, 'alert', line.hold, 'attention')
      schedule(WAIT_NUDGE_GAP_MS + Math.random() * WAIT_NUDGE_JITTER_MS)
    }
    schedule(WAIT_NUDGE_FIRST_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [hasPending, prefs.presenceOn, presenceSnoozeUntil, present])

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
      setSpeech((current) => {
        if (!current || current.id !== speech.id) return current
        if (speechRef.current?.id === speech.id) speechRef.current = null
        return null
      })
    }, life)
    return () => clearTimeout(timer)
  }, [speech, reduce])

  // ── 对话联动 ①：送出消息 → 回复中；回答结束 → 收尾 ────────────────────
  useEffect(() => {
    const was = prevStreamingRef.current
    prevStreamingRef.current = streaming
    if (streaming === was) return

    if (streaming) {
      streamStartedRef.current = Date.now()
      setPhase('waiting')
      setWaitSeconds(0)
      // 已经发出去了：草稿不再算「正在输入」。
      if (listeningRef.current) {
        listeningRef.current = false
        setListening(false)
      }
      const line = waitingLine(0)
      setReactMood(line.mood)
      present(line.text, line.mood, WAIT_HOLD_MS, 'chat-wait')
      sparkle()
      fx.edge('var(--ck-b)')
      cabinAudio.blip(660, 0.04)
      return
    }

    // 停止 / 正常收流都算这一轮结束：给一句收尾，但不假装「成功」。
    setPhase('done')
    const line = doneLine()
    setReactMood(line.mood)
    present(line.text, line.mood, 4600, 'chat-done')
    sparkle()
    fx.edge('var(--ck-a)')
    // 用户 #13（2026-11-20）：收尾同步来一次跃迁 —— 星流拉线 + 跃迁环，
    // 与她的收尾表情同一拍。只放效果不切幕（换景仍是 travel 的事）；
    // 克制档（只留四边流光）与 reduced-motion 不跑。
    if (!reduce && prefs.fxLevel !== 'lite') fx.jump()
    if (prefs.fxLevel === 'full') fx.feedback('var(--ck-a)', 'lite')
    cabinAudio.chime()
    if (doneTimerRef.current) clearTimeout(doneTimerRef.current)
    doneTimerRef.current = setTimeout(() => {
      doneTimerRef.current = null
      setPhase('idle')
      setReactMood(null)
    }, DONE_MOOD_MS)
  }, [streaming, present, sparkle, fx, prefs.fxLevel, reduce])

  // 回复中的秒表 + 台词轮换（只在气泡仍属于等待、或已收起时换）。
  useEffect(() => {
    if (phase !== 'waiting') {
      setWaitSeconds(0)
      return
    }
    const started = streamStartedRef.current || Date.now()
    const tick = () => setWaitSeconds(Math.max(0, Math.floor((Date.now() - started) / 1000)))
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [phase])

  useEffect(() => {
    if (phase !== 'waiting') return
    const timer = window.setInterval(() => {
      if (!streamingRef.current) return
      const source = speechRef.current?.source
      // 点击 / 在场 / 倾听的台词优先，不打断。
      if (source && source !== 'chat-wait') return
      const line = waitingLine(Date.now() - streamStartedRef.current)
      setReactMood(line.mood)
      present(line.text, line.mood, WAIT_HOLD_MS, 'chat-wait')
    }, WAIT_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [phase, present])

  // ── 对话联动 ②：用户正在输入（composer 草稿非空）→ 倾听 ───────────────
  // composer 是跨 React 树 portal，所以挂原生 DOM 监听；只看底栏槽里的编辑器。
  // 只在「有字 ↔ 没字」切换时更新，不在每个键上 setState（避免吞字）。
  useEffect(() => {
    if (typeof document === 'undefined') return
    const readDraft = () => {
      const slot = document.querySelector<HTMLElement>('[data-testid="cockpit-composer-slot"]')
      const editor = slot?.querySelector<HTMLTextAreaElement | HTMLInputElement>('textarea, input')
      return !!editor && editor.value.trim().length > 0
    }
    const sync = () => {
      // 正在回复 = 她不是在等你，倾听态让位给「回复中」。
      if (streamingRef.current) {
        if (listeningRef.current) {
          listeningRef.current = false
          setListening(false)
        }
        return
      }
      const active = readDraft()
      if (active === listeningRef.current) return
      listeningRef.current = active
      setListening(active)
      if (active) {
        // 收尾表情还没退场时开始输入：让「倾听」接上。
        if (doneTimerRef.current) {
          clearTimeout(doneTimerRef.current)
          doneTimerRef.current = null
        }
        if (phaseRef.current === 'done') setPhase('idle')
        const line = listenLine()
        setReactMood(line.mood)
        present(line.text, line.mood, 5200, 'listen')
        sparkle()
        cabinAudio.blip(700, 0.03)
      } else if (phaseRef.current === 'idle') {
        setReactMood(null)
      }
    }
    sync()
    document.addEventListener('input', sync, true)
    document.addEventListener('focusin', sync, true)
    document.addEventListener('focusout', sync, true)
    document.addEventListener('keydown', sync, true)
    // 发送后 value 由 composer 清空，不会再触发 input —— 兜底轮询（很低频）。
    const timer = window.setInterval(sync, 2000)
    return () => {
      document.removeEventListener('input', sync, true)
      document.removeEventListener('focusin', sync, true)
      document.removeEventListener('focusout', sync, true)
      document.removeEventListener('keydown', sync, true)
      window.clearInterval(timer)
    }
  }, [present, sparkle])

  // 流式时占用在场闸门：汐音不在这时候主动开口（chat 未接上 → false）。
  useEffect(() => {
    setCrewBusy(streaming)
  }, [streaming, setCrewBusy])
  useEffect(() => () => setCrewBusy(false), [setCrewBusy])

  useEffect(() => () => {
    if (heartTimerRef.current) clearTimeout(heartTimerRef.current)
    if (doneTimerRef.current) clearTimeout(doneTimerRef.current)
    sparkTimersRef.current.forEach((timer) => clearTimeout(timer))
    sparkTimersRef.current = []
  }, [])

  // ── 「互动一下」：设置面发信号，这里执行（气泡 + 表情 + 心形）──────────
  const interact = useCallback(() => {
    const [line, lineMood] = XY_LINES[Math.floor(Math.random() * XY_LINES.length)]
    present(line, lineMood, 5000, 'poke')
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

  // ── v22：动作片段（图鉴 playClip / 委派 relay command / 报到 ready）──────
  // clip 指定图鉴点名的精确片段；不传则在该姿态的变体间交替（同 pose 两支时
  // 这次播 A、下次播 B），待命自走立即让位。
  const playAction = useCallback((pose: PoseKey, ms = 2600, clip?: number) => {
    if (!(pose in POSE_META)) return
    const variants = clipVariants(pose)
    const nextVariant = variants[(variants.indexOf(shownClipRef.current) + 1) % variants.length] ?? variants[0]
    setActionPose(pose)
    setActionClip(Number.isInteger(clip) ? (clip as number) : nextVariant)
    setAmbientClip(null)
    if (actionTimerRef.current) clearTimeout(actionTimerRef.current)
    actionTimerRef.current = setTimeout(() => {
      setActionPose(null)
      setActionClip(null)
    }, ms)
    const meta = POSE_META[pose]
    const lineMood = POSE_MOOD[pose]
    present(meta.line, lineMood, ms, 'poke')
    fx.say(meta.line, lineMood)
    cabinAudio.chime()
  }, [present, fx])

  useEffect(() => {
    const onPose = (event: Event) => {
      const detail = (event as CustomEvent<{ pose?: PoseKey; ms?: number; clip?: number }>).detail
      const clip = Number.isInteger(detail?.clip) ? (detail?.clip as number) : undefined
      const pose = detail?.pose ?? (clip !== undefined ? clipPose(clip) : undefined)
      if (!pose || !(pose in POSE_META)) return
      playAction(pose, detail?.ms ?? 2600, clip)
    }
    window.addEventListener('octopus:crew-pose', onPose)
    return () => window.removeEventListener('octopus:crew-pose', onPose)
  }, [playAction])

  // ── v21 ready：报到由真实事件驱动（不再靠点击轮播）─────────────────────
  // ① 从休眠唤醒（mood sleep → 醒）：汐音报到；首进舱不播（design 31 §3.5
  //    开机=待命），以免一打开舱就被台词糊脸。
  const prevMoodRef = useRef<MoodKey>(mood)
  useEffect(() => {
    const prev = prevMoodRef.current
    prevMoodRef.current = mood
    if (prev !== 'sleep' || mood === 'sleep') return
    if (streamingRef.current) return
    playAction('ready', READY_MS)
  }, [mood, playAction])

  // ② 接管另一间舱（scene.key 变化）：一趟报到。同一间舱内切作业面不算。
  const sceneKey = scene.key
  const prevSceneRef = useRef(sceneKey)
  useEffect(() => {
    if (prevSceneRef.current === sceneKey) return
    prevSceneRef.current = sceneKey
    if (streamingRef.current) return
    playAction('ready', READY_MS)
  }, [sceneKey, playAction])

  return (
    <div className="ck12-crew" data-testid="cockpit-crew">
      <button
        type="button"
        className="ck12-pod"
        data-state={shownMood}
        data-phase={phase}
        data-listening={listening ? 'true' : 'false'}
        data-clip={shownClip}
        data-clip-no={CLIPS[shownClip]?.no}
        data-testid="cockpit-crew-pod"
        aria-label={`汐音 · ${label} · 点击跟她说话`}
        onClick={talkToXiyin}
      >
        <CockpitPoseSprite pose={shownPose} clip={shownClip} reduce={reduce} />
        <PoseFX pose={shownPose} reduce={reduce} />
        <span className="ck12-pod-scan" aria-hidden="true" />
        <span className="ck12-pod-vg" aria-hidden="true" />
        {listening && phase === 'idle' && (
          <span className="ck12-pod-listen" data-testid="cockpit-crew-listening" aria-hidden="true">
            <i /><i /><i />
          </span>
        )}
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
        <span className="ck12-pod-tag"><i aria-hidden="true" />{tagText}</span>
        <span className="ck12-pod-name">
          汐音 <small>· 全域助理</small>
          <em data-testid="cockpit-crew-mood">
            {label} · {String(shownClip + 1).padStart(2, '0')}/{CLIPS.length}
          </em>
        </span>
      </button>

      {/* 点击涟漪已移除（v21 四轮）：立绘无框，点击只留星光，不再闪一圈边。 */}

      <div
        className={`ck12-speech${speech ? ' show' : ''}`}
        data-testid="cockpit-crew-speech"
        data-phase={phase}
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
              <span className="ck12-speech-tag">
                {phase === 'waiting'
                  ? '回复中'
                  : phase === 'done'
                    ? '已回完'
                    : listening
                      ? '倾听'
                      : (CREW[speech.mood]?.label ?? '待命')}
              </span>
            </div>
            <div className="ck12-speech-tx">
              {typed}
              <span className="ck12-speech-cur" aria-hidden="true">▸</span>
              {phase === 'waiting' && speech.source === 'chat-wait' && (
                <span className="ck12-speech-dots" data-testid="cockpit-crew-wait-dots" aria-hidden="true">
                  <i /><i /><i />
                </span>
              )}
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