'use client'

// 汐音浮舱（原型 renderCrew / xySay / xyInteract / xySparkle / xyReceive / renderHub，
// docs/cabin-design/index.html 1702-1787）。立绘随 mood 切换（K3 派生自 view），
// 点击互动循环台词 + 星光 + chime；新待人 attention 触发涟漪 + 提醒；助理 hub 快捷
// 开窗。mood/prefs 来自 CockpitProvider，与调校台/画廊共享真源。

import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronRight, ClipboardList, Dices, LayoutGrid, Send, User, X } from 'lucide-react'
import { toast } from 'sonner'
import { cabinAudio } from '@/lib/cabin-audio'
import { useCabinContext } from './cabin-provider'
import { useCockpit } from './CockpitProvider'
import { CREW, THEMES, XY_ICON, XY_LINES, moodPortrait, type CockpitTheme, type MoodKey } from './cockpit'

interface Spark { id: number; left: number; top: number; dx: number; dy: number }

/** 对话可能来自点立绘 / 回流提醒 / 在场（主动搭话）。主动态多一个动作行。 */
interface CrewDialog {
  text: string
  tag: string
  hold: number
  proactive?: boolean
  /** 主动态主按钮要打开的浮窗 id。 */
  open?: string
  label?: string
}

export function CabinCrew() {
  const { cabin, view, openModule } = useCabinContext()
  const {
    mood, setMoodOverride, prefs, setPref,
    presenceLine, dismissPresence, snoozePresence, setCrewBusy,
  } = useCockpit()

  const [hubOpen, setHubOpen] = useState(false)
  const [crewInfo, setCrewInfo] = useState(false)
  const [dialog, setDialog] = useState<CrewDialog | null>(null)
  const [typed, setTyped] = useState('')
  const [sparks, setSparks] = useState<Spark[]>([])
  const [recvFlash, setRecvFlash] = useState(false)
  const [ripples, setRipples] = useState<{ id: number; delay: number }[]>([])
  const [iconPop, setIconPop] = useState(false)

  const lineIdx = useRef(0)
  const sparkId = useRef(0)
  const prevMood = useRef(mood)
  const prevPerson = useRef(0)

  const personCount = view?.attention.filter((a) => a.awaiting === 'person').length ?? 0
  const attentionCount = view?.attention.length ?? 0
  const running = view?.health.running ?? 0

  const say = useCallback((text: string, m?: MoodKey, hold = 5200) => {
    if (m) setMoodOverride(m, hold + 400)
    const tag = CREW[m ?? mood]?.label ?? CREW.idle.label
    setDialog({ text, tag, hold })
    cabinAudio.blip(920, 0.05, 'sine', 0.09)
  }, [mood, setMoodOverride])

  // 在场（主动搭话）：provider 派发一条 → 渲染成汐音对白，随即消费掉。
  useEffect(() => {
    if (!presenceLine) return
    const hold = presenceLine.hold ?? 9000
    setMoodOverride(presenceLine.mood, hold + 400)
    setDialog({
      text: presenceLine.text, tag: '主动', hold,
      proactive: true, open: presenceLine.open, label: presenceLine.label,
    })
    cabinAudio.blip(920, 0.05, 'sine', 0.09)
    dismissPresence()
  }, [presenceLine, setMoodOverride, dismissPresence])

  // 对白 / 助理菜单开着时上报 busy：在场闸门会等这一轮结束再开口。
  useEffect(() => { setCrewBusy(!!dialog || hubOpen) }, [dialog, hubOpen, setCrewBusy])
  useEffect(() => () => setCrewBusy(false), [setCrewBusy])

  // 打字机由 dialog 驱动（effect 清理随 dialog 变化/卸载），dev 双挂载下可重跑不空泡。
  useEffect(() => {
    if (!dialog) { setTyped(''); return }
    setTyped('')
    let i = 0
    const type = setInterval(() => {
      i += 1
      setTyped(dialog.text.slice(0, i))
      if (i >= dialog.text.length) clearInterval(type)
    }, 20)
    const hide = setTimeout(() => setDialog(null), dialog.hold + dialog.text.length * 20)
    return () => { clearInterval(type); clearTimeout(hide) }
  }, [dialog])

  const dismiss = useCallback(() => {
    setDialog(null)
    cabinAudio.blip(560, 0.04)
  }, [])

  const sparkle = useCallback(() => {
    const batch: Spark[] = Array.from({ length: 6 }, () => ({
      id: sparkId.current++,
      left: 30 + Math.random() * 100,
      top: 40 + Math.random() * 120,
      dx: Math.random() * 80 - 40,
      dy: -30 - Math.random() * 50,
    }))
    setSparks((s) => [...s, ...batch])
    setTimeout(() => setSparks((s) => s.filter((x) => !batch.some((b) => b.id === x.id))), 850)
  }, [])

  const interact = useCallback(() => {
    const [line, m] = XY_LINES[lineIdx.current++ % XY_LINES.length]
    setHubOpen(false)
    say(line, m, 5000)
    sparkle()
    cabinAudio.chime()
  }, [say, sparkle])

  const receive = useCallback(() => {
    setRecvFlash(true)
    const base = Date.now()
    setRipples((r) => [...r, { id: base, delay: 0 }, { id: base + 1, delay: 0.18 }])
    setTimeout(() => setRecvFlash(false), 600)
    setTimeout(() => setRipples((r) => r.filter((x) => x.id !== base && x.id !== base + 1)), 1200)
  }, [])

  // 状态徽章 pop（mood 变化时）。
  useEffect(() => {
    if (mood !== prevMood.current) {
      prevMood.current = mood
      setIconPop(true)
      const t = setTimeout(() => setIconPop(false), 560)
      return () => clearTimeout(t)
    }
  }, [mood])

  // 新待人 attention → 涟漪 + 提醒（原型 xyPrepare）。
  useEffect(() => {
    if (personCount > prevPerson.current) {
      receive()
      say(`指挥官，有 ${personCount} 件事等你裁决。点队列即可优先路由，我已在主 chat 整理好。`, 'alert', 6500)
    }
    prevPerson.current = personCount
  }, [personCount, receive, say])

  const toggleHub = useCallback(() => {
    setHubOpen((o) => !o)
    setCrewInfo(false)
    setDialog(null)
    cabinAudio.blip(720, 0.05)
  }, [])

  const openFromHub = useCallback((mod: string) => {
    setHubOpen(false)
    openModule(mod)
    cabinAudio.blip(660, 0.05)
  }, [openModule])

  // 随机只换色调（一定换成另一套）；整套风格仍在舱面调校里随机。
  const randomTheme = useCallback(() => {
    const keys = Object.keys(THEMES) as CockpitTheme[]
    let k = keys[Math.floor(Math.random() * keys.length)]
    if (keys.length > 1 && k === prefs.theme) k = keys[(keys.indexOf(k) + 1) % keys.length]
    setPref('theme', k)
    cabinAudio.chime()
    toast(`已随机色调 · ${THEMES[k].name}`)
  }, [prefs.theme, setPref])

  const meta = CREW[mood] ?? CREW.idle
  const portrait = moodPortrait(mood)

  const hubItem = (mod: string | null, Icon: typeof LayoutGrid, title: string, sub: string, badge?: number | string, action?: () => void) => (
    <button
      type="button"
      className="ch-item"
      onClick={() => { if (action) action(); else if (mod) openFromHub(mod) }}
    >
      <span className="ci"><Icon className="size-[15px]" /></span>
      <span className="cm"><b>{title}</b><span>{sub}</span></span>
      {badge ? <span className="cb">{badge}</span> : null}
      <span className="chev"><ChevronRight className="size-3" /></span>
    </button>
  )

  return (
    <>
      <div className="crew-pod" data-state={mood} data-testid="cabin-crew-pod">
        <span className="xy-aura" />
        <div
          className={`xy-frame${recvFlash ? ' recv' : ''}`}
          data-action="xy-click"
          title="汐音 · 点击互动"
          onClick={interact}
          data-testid="cabin-crew-frame"
        >
          <img src={portrait} alt="汐音" />
          <span className="xy-scan" /><span className="xy-sweep" /><span className="xy-glow" />
          {sparks.map((s) => (
            <span
              key={s.id}
              className="xy-spark"
              style={{ left: `${s.left}px`, top: `${s.top}px`, ['--dx' as string]: `${s.dx}px`, ['--dy' as string]: `${s.dy}px` }}
            >✦</span>
          ))}
        </div>
        {ripples.map((r) => (
          <span key={r.id} className="xy-ripple" style={{ animationDelay: `${r.delay}s` }} />
        ))}
        <span className={`xy-state-icon${iconPop ? ' pop' : ''}`} title={meta.label}>
          <span className="xyi-glyph">{XY_ICON[mood] ?? '✦'}</span>
          {attentionCount > 0 && <span className="xyi-count">{attentionCount}</span>}
        </span>
        <div className="xy-name"><span className="xn">汐音 <small>· 助理</small></span></div>
        <button type="button" className="xy-menu" onClick={(e) => { e.stopPropagation(); toggleHub() }} data-testid="cabin-crew-menu">
          <LayoutGrid className="size-3" />助理菜单
        </button>
      </div>

      <div
        className={`xy-dialog${dialog ? ' show' : ''}`}
        data-testid="cabin-crew-dialog"
        onClick={dismiss}
      >
        {dialog && (
          <>
            <div className="xyd-h">
              <span className="xyd-name">汐音</span>
              <span className="xyd-tag">{dialog.tag}</span>
              {dialog.proactive && <span className="xyd-hint">定时 + 随机 · 不进 chat</span>}
            </div>
            <div className="xyd-text"><span>{typed}</span><span className="xyd-cur">▸</span></div>
            {dialog.proactive && (
              <div className="xyd-acts">
                {dialog.open && (
                  <button
                    type="button" className="xyd-act" data-testid="cabin-presence-open"
                    onClick={(e) => {
                      e.stopPropagation()
                      const mod = dialog.open
                      setDialog(null)
                      if (mod) openModule(mod)
                      cabinAudio.blip(720, 0.04)
                    }}
                  >{dialog.label ?? '打开 →'}</button>
                )}
                <button
                  type="button" className="xyd-quiet" data-testid="cabin-presence-snooze"
                  title="30 分钟内不再主动搭话"
                  onClick={(e) => { e.stopPropagation(); setDialog(null); snoozePresence(30) }}
                >静 30 分</button>
              </div>
            )}
          </>
        )}
      </div>

      <div className={`crew-hub${hubOpen ? ' open' : ''}`} data-testid="cabin-crew-hub">
        <div className="ch-h">
          <span className="ch-av"><img src={portrait} alt="汐音" /></span>
          <span className="ch-id"><b>汐音</b><span>助理 · 舱灵 · {meta.label}</span></span>
          <button type="button" className="ch-close" title="关闭" onClick={toggleHub}><X className="size-3" /></button>
        </div>
        <div className="ch-stats">
          <button type="button" className="ch-stat" title="打开作战清单（进行中的作业）" onClick={() => openFromHub('missions')} data-testid="crew-stat-run">
            <b className="violet">{running}</b><span>运行</span>
          </button>
          <button type="button" className="ch-stat" title="打开需要你（按等谁分级）" onClick={() => openFromHub('overview')} data-testid="crew-stat-person">
            <b className="amber">{personCount}</b><span>需要你</span>
          </button>
          <button type="button" className="ch-stat" title="打开通讯队列" onClick={() => openFromHub('queue')} data-testid="crew-stat-queue">
            <b className="cyan">{attentionCount}</b><span>队列</span>
          </button>
        </div>
        <div className="ch-look" title={`色调 · ${THEMES[prefs.theme]?.name ?? ''}（随机只换色调；整套风格在舱面调校）`}>
          <span className="lab">色调</span>
          <div className="ch-themes">
            {(Object.keys(THEMES) as CockpitTheme[]).map((k) => (
              <button
                key={k} type="button" title={THEMES[k].name}
                className={`ch-theme${prefs.theme === k ? ' on' : ''}`}
                style={{ background: `linear-gradient(135deg, ${THEMES[k].a}, ${THEMES[k].b})` }}
                onClick={() => { setPref('theme', k); cabinAudio.blip(760, 0.06); toast(`色调 · ${THEMES[k].name}`) }}
                data-testid={`crew-theme-${k}`}
              />
            ))}
          </div>
          <button type="button" className="ch-random" title="随机一套色调" onClick={randomTheme} data-testid="crew-theme-random">
            <Dices className="size-3" />
          </button>
        </div>
        <div className="ch-menu">
          {hubItem('queue', Send, '通讯队列', '分身 / 工作树回流的消息', attentionCount || undefined)}
          {hubItem('missions', ClipboardList, '作战清单', '进行中的任务总览', running || undefined)}
          {hubItem('overview', LayoutGrid, '需要你', '按「等谁」分级的待办', personCount || undefined)}
          {hubItem('tuning', LayoutGrid, '舱面调校', `色调 / 光效 · 在场 ${prefs.presenceOn ? '开' : '关'}`)}
          {hubItem('gallery', User, '立绘画廊', '汐音的九种表情 · 可导出')}
          {hubItem(null, User, '个人状态', '汐音的舱内档案', undefined, () => { setCrewInfo((v) => !v); cabinAudio.blip(640, 0.04) })}
        </div>
        <div className={`ch-info${crewInfo ? ' open' : ''}`}>
          <div><span>型号</span><b>汐音 XIYIN-07</b></div>
          <div><span>归属</span><b>{cabin?.name ?? '主 Agent'}</b></div>
          <div><span>当前状态</span><b>{meta.label}</b></div>
          <div><span>职责</span><b>消息整理 · 待办提醒 · 交互</b></div>
          <div><span>rev</span><b>3</b></div>
        </div>
      </div>
    </>
  )
}