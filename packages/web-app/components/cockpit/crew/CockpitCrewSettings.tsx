'use client'

// v13 · 汐音设置（HUD 右侧「◐ 汐音」/ ⌥X）：在场节奏、反馈特效强度、说一句、
// 互动一下、动作图鉴。
//
// 2026-11-19 用户 #7：「更多 → ♡ 汐音」打开本面板 —— 面板顶部新增 AGENT 档案
// （身份 / 模型 / 人格 / 技能 / 工具 / 记忆，全部只读真源）；打开期间汐音会
// 轮播几个动作（CockpitCrewSettingsLayer），点开就是在看她。
// 同日再改：技能多 → 上 tab 下内容；互动页图鉴必须是 **13 支视频片段**（与
// 动作图鉴同源 CLIPS），不是旧的 9 张 mood 静图。
//
// 真源仍是 CockpitProvider 的 prefs（presenceOn / presenceRate / fxLevel），
// 写进 cabin 的 cockpit_prefs 持久化，不是本次会话的临时值。

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cabinAudio } from '@/lib/cabin-audio'
import { useCockpit } from '@/components/cabin/CockpitProvider'
import {
  PRESENCE_RATES,
  moodPortrait,
  presenceRateLabel,
  type PresenceFxLevel,
  type PresenceRate,
} from '@/components/cabin/cockpit'
import { useCockpitState } from '../state/CockpitStateProvider'
import { cockpitConsoleRect } from '../chat/geometry'
import { requestCrewPoke } from './crew-events'
import {
  setCrewSettingsOpen, useCrewSettingsOpen,
} from './crew-settings'
import {
  CREW_BUILTIN_TOOLS, useCrewAgentInfo,
} from './use-crew-agent-info'
import { CLIPS, POSE_META, type PoseKey } from './pose-model'

/** Esc 顺序：档案面比设置弹窗略高（它在 HUD 层之上），下面才是面/对话。 */
const SETTINGS_LAYER_PRIORITY = 88

const FX_LEVELS: { key: PresenceFxLevel; label: string; note: string }[] = [
  { key: 'full', label: '炫', note: '光晕 + 环 + 扫描 + 网格' },
  { key: 'std', label: '标准', note: '只有到达才全开' },
  { key: 'lite', label: '克制', note: '只留四边流光' },
]

const RATE_ORDER: PresenceRate[] = ['active', 'std', 'quiet']

/** 档案分区（2026-11-19 用户：技能多，改成上 tab 下内容）。 */
type CrewTab = 'profile' | 'persona' | 'skills' | 'tools' | 'settings'
const CREW_TABS: Array<{ id: CrewTab; label: string }> = [
  { id: 'profile', label: '资料' },
  { id: 'persona', label: '人格' },
  { id: 'skills', label: '技能' },
  { id: 'tools', label: '工具' },
  { id: 'settings', label: '互动' },
]

export interface CockpitCrewSettingsProps {
  open: boolean
  /** 兼容旧调用：档案面现在是居中 dossier（像作业详情），不再贴触发按钮。 */
  anchor?: HTMLElement | null
  onClose: () => void
}

export function CockpitCrewSettings({ open, onClose }: CockpitCrewSettingsProps) {
  const {
    prefs,
    setPref,
    mood,
    testPresence,
  } = useCockpit()
  const { chat, layer, clip: activeClip } = useCockpitState()
  const panelRef = useRef<HTMLDivElement | null>(null)
  // 2026-11-19 用户 #7：档案面盖在**通讯台位置**上（不压立绘）；高度封顶 480。
  const [geo, setGeo] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  const place = useCallback(() => {
    if (typeof window === 'undefined') return
    const el = document.querySelector<HTMLElement>('[data-testid="cockpit-chat-window"]')
    const cr = el?.getBoundingClientRect()
    const host = cr && cr.width > 120 && cr.height > 120
      ? { x: cr.x, y: cr.y, w: cr.width, h: cr.height }
      : (() => {
          const r = cockpitConsoleRect({ viewport: { width: window.innerWidth, height: window.innerHeight } })
          return { x: r.x, y: r.y, w: r.w, h: r.h }
        })()
    const width = Math.round(Math.max(480, Math.min(host.w - 24, 720)))
    const height = Math.round(Math.max(360, Math.min(host.h - 12, 480)))
    const left = Math.round(
      Math.max(8, Math.min(host.x + (host.w - width) / 2, window.innerWidth - width - 8)),
    )
    const top = Math.round(
      Math.max(8, Math.min(host.y + 6, window.innerHeight - height - 8)),
    )
    setGeo({ left, top, width, height })
  }, [])

  useEffect(() => {
    if (open) place()
  }, [open, place])

  useEffect(() => {
    if (!open) return
    const onResize = () => place()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [open, place])

  // 2026-11-19 用户 #7：AGENT 档案（真源三接口，60s 缓存）。
  // 2026-11-19 二改（用户：技能多，用 tab）—— 上 tab 下内容，五个分区各管一屏。
  const info = useCrewAgentInfo()
  const [tab, setTab] = useState<CrewTab>('profile')
  const pickTab = useCallback((next: CrewTab) => {
    setTab(next)
    cabinAudio.blip(700, 0.04)
  }, [])

  useEffect(() => {
    if (!open) return
    return layer.register('cockpit-crew-settings', SETTINGS_LAYER_PRIORITY, onClose)
  }, [open, layer, onClose])

  // 点面板外部关闭（不再铺全屏背幕 —— 立绘/编队要一直看得见）。
  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (!target || panelRef.current?.contains(target)) return
      onClose()
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [open, onClose])

  if (!open || typeof document === 'undefined') return null

  const rate = PRESENCE_RATES[prefs.presenceRate] ?? PRESENCE_RATES.active

  return createPortal(
    <div
      ref={panelRef}
      className="ck12-xy"
      role="dialog"
      aria-label="汐音档案"
      data-testid="cockpit-crew-settings"
      style={geo ? { left: `${geo.left}px`, top: `${geo.top}px`, width: `${geo.width}px`, height: `${geo.height}px` } : undefined}
    >
      <div className="ck12-xy-h">
        <button
          type="button"
          className="ck12-xy-x"
          onClick={onClose}
          aria-label="关闭汐音档案"
          data-testid="cockpit-crew-settings-close"
        ><X className="size-3.5" aria-hidden="true" /></button>
        <span className="ck12-xy-av"><img src={moodPortrait(mood)} alt="" /></span>
        <b>汐音</b>
        <span className="ck12-xy-sub">XIYIN-07 · 舱调度者</span>
        <span className="ck12-xy-ln" aria-hidden="true" />
        <span className="ck12-xy-en">AGENT DOSSIER</span>
      </div>

      <div className="ck12-xy-tabs" role="tablist" aria-label="汐音档案分区">
        {CREW_TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={tab === item.id ? 'is-on' : undefined}
            data-testid={`cockpit-crew-tab-${item.id}`}
            onClick={() => pickTab(item.id)}
          >
            {item.label}
            {item.id === 'skills' && info.skills.length > 0 && <b>{info.skills.length}</b>}
            {item.id === 'tools' && info.mcp.length > 0 && <b>{info.mcp.length}</b>}
          </button>
        ))}
      </div>

      <div className="ck12-xy-b" data-tab={tab}>
        {tab === 'profile' && (
          <div className="ck12-xset-ag" data-testid="cockpit-crew-agent">
            <div className="ck12-xset-ag-id">
              <span className="ck12-xset-ag-av"><img src={moodPortrait(mood)} alt="" /></span>
              <span className="ck12-xset-ag-name">
                <b>舱调度者</b>
                <span>cabin-orchestrator · 舱主对话的默认身份</span>
              </span>
              <span className="ck12-xset-ag-tag">隔离记忆</span>
            </div>

            <div className="ck12-xset-ag-row">
              <span className="ck12-xset-ag-k">模型</span>
              <span className="ck12-xset-ag-v">
                <b>{chat?.model || '未就绪'}</b> <i>· 在通讯台 MODEL 芯片切换</i>
              </span>
            </div>

            <div className="ck12-xset-ag-row">
              <span className="ck12-xset-ag-k">人格</span>
              <span className="ck12-xset-ag-v">
                {info.loading
                  ? <i>载入…</i>
                  : info.persona
                    ? <>persona.md · {info.personaLines} 行 · <i>全能舱主：能调度，也能直接写业务代码</i></>
                    : <i>读不到 persona.md</i>}
              </span>
              {info.persona && (
                <button
                  type="button"
                  onClick={() => pickTab('persona')}
                  data-testid="cockpit-crew-agent-persona"
                >查看</button>
              )}
            </div>

            <div className="ck12-xset-ag-row">
              <span className="ck12-xset-ag-k">技能</span>
              <span className="ck12-xset-ag-v">
                <b>{info.loading ? '…' : `${info.skills.length} 项`}</b> <i>· 全部共享技能（内置 + 本地进化）</i>
              </span>
              {info.skills.length > 0 && (
                <button
                  type="button"
                  onClick={() => pickTab('skills')}
                  data-testid="cockpit-crew-agent-skills"
                >查看</button>
              )}
            </div>

            <div className="ck12-xset-ag-row">
              <span className="ck12-xset-ag-k">工具</span>
              <span className="ck12-xset-ag-v">
                <b>{info.loading ? '…' : `${info.mcp.length} 套 MCP`}</b> <i>+ 内建 {CREW_BUILTIN_TOOLS.length} 类</i>
              </span>
              <button
                type="button"
                onClick={() => pickTab('tools')}
                data-testid="cockpit-crew-agent-tools"
              >查看</button>
            </div>

            <div className="ck12-xset-ag-row">
              <span className="ck12-xset-ag-k">记忆</span>
              <span className="ck12-xset-ag-v">isolated <i>· ~/.octopus/agent/built-in/cabin-orchestrator/memory</i></span>
            </div>
          </div>
        )}

        {tab === 'persona' && (
          info.loading ? (
            <div className="ck12-xy-empty">载入人格…</div>
          ) : info.persona ? (
            <pre className="ck12-xset-ag-pre is-fill" data-testid="cockpit-crew-agent-persona-text">{info.persona}</pre>
          ) : (
            <div className="ck12-xy-empty">读不到 persona.md（分身目录不可达）</div>
          )
        )}

        {tab === 'skills' && (
          info.skills.length > 0 ? (
            <div className="ck12-xset-ag-chips is-page" data-testid="cockpit-crew-agent-skill-chips">
              {info.skills.map((name) => <span key={name}>{name}</span>)}
            </div>
          ) : (
            <div className="ck12-xy-empty">{info.loading ? '载入技能…' : '没有已安装的技能'}</div>
          )
        )}

        {tab === 'tools' && (
          <div className="ck12-xy-tools" data-testid="cockpit-crew-agent-tool-chips">
            {info.mcp.map((server) => (
              <div key={server.server} className="ck12-xy-tool">
                <div className="ck12-xy-tool-h">
                  <b>{server.label}</b>
                  <span>{server.server}</span>
                  <i>{server.tools.length} tools</i>
                </div>
                {server.description && <div className="ck12-xy-tool-d">{server.description}</div>}
                <div className="ck12-xset-ag-chips">
                  {server.tools.map((item) => <span key={item.name} className="is-tool">{item.name}</span>)}
                </div>
              </div>
            ))}
            <div className="ck12-xy-tool">
              <div className="ck12-xy-tool-h">
                <b>内建工具</b>
                <span>SDK 默认全量</span>
                <i>{CREW_BUILTIN_TOOLS.length} 类</i>
              </div>
              <div className="ck12-xset-ag-chips">
                {CREW_BUILTIN_TOOLS.map((name) => <span key={name} className="is-tool">{name}</span>)}
              </div>
            </div>
          </div>
        )}

        {tab === 'settings' && (
          <div className="ck12-xy-settings">
            <div className="ck12-xset-row">
              <span className="ck12-xset-l">在场</span>
              <button
                type="button"
                className={`ck12-xset-toggle${prefs.presenceOn ? ' is-on' : ''}`}
                aria-pressed={prefs.presenceOn}
                onClick={() => setPref('presenceOn', !prefs.presenceOn)}
                data-testid="cockpit-crew-presence-toggle"
              >{prefs.presenceOn ? '开' : '关'}</button>
              <span className="ck12-xset-seg" role="group" aria-label="在场节奏">
                {RATE_ORDER.map((key) => (
                  <button
                    key={key}
                    type="button"
                    className={prefs.presenceRate === key ? 'on' : undefined}
                    aria-pressed={prefs.presenceRate === key}
                    title={`静默 ${presenceRateLabel(key)} 说一句`}
                    onClick={() => setPref('presenceRate', key)}
                    data-testid={`cockpit-crew-rate-${key}`}
                  >{presenceRateLabel(key)}</button>
                ))}
              </span>
            </div>
            <div className="ck12-xset-note" data-testid="cockpit-crew-rate-note">
              {prefs.presenceOn
                ? `没在交互、静默 ${presenceRateLabel(prefs.presenceRate)} 她就说一句；动一下键鼠重新计时`
                : '已关闭 · 回流与阻塞照常举牌，只是不闲聊'}
            </div>

            <div className="ck12-xset-row">
              <span className="ck12-xset-l">特效</span>
              <span className="ck12-xset-seg" role="group" aria-label="反馈特效强度">
                {FX_LEVELS.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    className={prefs.fxLevel === item.key ? 'on' : undefined}
                    aria-pressed={prefs.fxLevel === item.key}
                    title={item.note}
                    onClick={() => setPref('fxLevel', item.key)}
                    data-testid={`cockpit-crew-fx-${item.key}`}
                  >{item.label}</button>
                ))}
              </span>
            </div>

            <div className="ck12-xset-row">
              <span className="ck12-xset-l">现在</span>
              <button
                type="button"
                className="ck12-xset-btn"
                onClick={() => { testPresence(); cabinAudio.blip(780, 0.05) }}
                data-testid="cockpit-crew-say"
              ><span>✦</span>让她说一句</button>
              <button
                type="button"
                className="ck12-xset-btn"
                onClick={() => { requestCrewPoke(); cabinAudio.chime() }}
                data-testid="cockpit-crew-poke"
              ><span>♡</span>互动一下</button>
            </div>

            <div className="ck12-xset-note">
              动作图鉴 · {CLIPS.length} 支片段（旧批次 3 + 新批次 10）· 点一支她就就地演
            </div>

            <div className="ck12-xset-gal is-clips" data-testid="cockpit-crew-gallery">
              {CLIPS.map((item, index) => {
                const meta = POSE_META[item.pose]
                const no = String(item.no).padStart(2, '0')
                return (
                  <button
                    key={item.no}
                    type="button"
                    className={activeClip === index ? 'on' : undefined}
                    aria-label={`动作 ${no} · ${meta.cn}`}
                    aria-pressed={activeClip === index}
                    title={`${no} · ${meta.cn} · ${meta.desc} · ${item.batch}批次`}
                    data-clip-no={item.no}
                    onClick={() => {
                      // 图鉴同一通道：精确到片段，所以 command/thinking/wink 两支不合并。
                      window.dispatchEvent(new CustomEvent('octopus:crew-pose', {
                        detail: { pose: item.pose, clip: index, ms: 2600 },
                      }))
                      cabinAudio.blip(660, 0.05)
                    }}
                  >
                    <img src={item.thumb} alt="" loading="lazy" />
                    <span className="ck12-galb">{no}</span>
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </div>

      <div className="ck12-xset-foot">
        点立绘 = <b>直接跟她说话</b> · ⌥X 打开这里
        <span className="ck12-xset-cd">
          在场 · {prefs.presenceOn ? presenceRateLabel(prefs.presenceRate) : '关'}
        </span>
      </div>
    </div>,
    document.body,
  )
}

/** 打开汐音档案时她做的动作轮播（只在她空闲时换，正在回复不抢戏）。 */
const CREW_SHOW_POSES: PoseKey[] = ['ready', 'smile', 'wink', 'command']

/**
 * 「更多 → ♡ 汐音」的挂载层：读 crew-settings store（点开合不依赖旁路状态），
 * 锚到右栏「更多」按钮，并把面板渲染到 body。
 *
 * 2026-11-19 用户 #7：打开期间让汐音跟着做几个动作 —— 点开档案本身就是在看她，
 * 立绘不能僵着。动作走既有的 `octopus:crew-pose` 通道（CockpitCrew 执行），
 * chat 正在回复时不打扰。
 */
export function CockpitCrewSettingsLayer() {
  const open = useCrewSettingsOpen()
  const { chat } = useCockpitState()
  const streamingRef = useRef(false)
  useEffect(() => {
    streamingRef.current = chat?.streaming ?? false
  }, [chat?.streaming])

  useEffect(() => {
    if (!open) return
    let index = 0
    const fire = () => {
      if (streamingRef.current) return
      const pose = CREW_SHOW_POSES[index % CREW_SHOW_POSES.length]
      index += 1
      window.dispatchEvent(new CustomEvent('octopus:crew-pose', { detail: { pose, ms: 2800 } }))
    }
    fire()
    const timer = window.setInterval(fire, 6400)
    return () => window.clearInterval(timer)
  }, [open])

  return (
    <CockpitCrewSettings
      open={open}
      onClose={() => setCrewSettingsOpen(false)}
    />
  )
}