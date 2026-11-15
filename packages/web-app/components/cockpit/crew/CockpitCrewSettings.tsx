'use client'

// v13 · 汐音设置（HUD 右侧「◐ 汐音」/ ⌥X）：在场节奏、反馈特效强度、说一句、
// 互动一下、表情画廊。
//
// 设置搬到这里之后，点立绘只做一件事：跟她说话（见 CockpitCrew）。
// 真源仍是 CockpitProvider 的 prefs（presenceOn / presenceRate / fxLevel），
// 写进 cabin 的 cockpit_prefs 持久化，不是本次会话的临时值。

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cabinAudio } from '@/lib/cabin-audio'
import { useCockpit } from '@/components/cabin/CockpitProvider'
import {
  PRESENCE_RATES,
  XY_FORMS,
  moodPortrait,
  presenceRateLabel,
  type MoodKey,
  type PresenceFxLevel,
  type PresenceRate,
} from '@/components/cabin/cockpit'
import { useCockpitState } from '../state/CockpitStateProvider'
import { requestCrewPoke } from './crew-events'

/** Esc 顺序：设置面只比桥浮层低一档（它在 HUD 上，下面才是面/对话）。 */
const SETTINGS_LAYER_PRIORITY = 88
const PANEL_WIDTH = 352

const FX_LEVELS: { key: PresenceFxLevel; label: string; note: string }[] = [
  { key: 'full', label: '炫', note: '光晕 + 环 + 扫描 + 网格' },
  { key: 'std', label: '标准', note: '只有到达才全开' },
  { key: 'lite', label: '克制', note: '只留四边流光' },
]

const RATE_ORDER: PresenceRate[] = ['active', 'std', 'quiet']

export interface CockpitCrewSettingsProps {
  open: boolean
  /** HUD 上的触发按钮：面板贴住它向左下展开。 */
  anchor: HTMLElement | null
  onClose: () => void
}

export function CockpitCrewSettings({ open, anchor, onClose }: CockpitCrewSettingsProps) {
  const {
    prefs,
    setPref,
    mood,
    setMoodOverride,
    testPresence,
  } = useCockpit()
  const { layer } = useCockpitState()
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  const place = useCallback(() => {
    if (!anchor) return
    const rect = anchor.getBoundingClientRect()
    const width = panelRef.current?.offsetWidth || PANEL_WIDTH
    setPos({
      left: Math.max(10, Math.min(rect.right - width, window.innerWidth - width - 10)),
      top: Math.max(56, rect.bottom + 8),
    })
  }, [anchor])

  useLayoutEffect(() => {
    if (open) place()
  }, [open, place])

  useEffect(() => {
    if (!open) return
    const onResize = () => place()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [open, place])

  useEffect(() => {
    if (!open) return
    return layer.register('cockpit-crew-settings', SETTINGS_LAYER_PRIORITY, onClose)
  }, [open, layer, onClose])

  // 点外部关闭（按钮自己 stopPropagation，不会误触）。
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (panelRef.current?.contains(target) || anchor?.contains(target)) return
      onClose()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open, anchor, onClose])

  // 关闭时把焦点还给触发按钮（键盘用户不丢位置）。
  // 只在「这次是真的从开→关」时还，避免 HUD 常年挂着一个 open=false 的实例在
  // 页面加载时抢焦点。
  const wasOpenRef = useRef(false)
  useEffect(() => {
    if (open) { wasOpenRef.current = true; return }
    if (!wasOpenRef.current) return
    wasOpenRef.current = false
    anchor?.focus?.()
  }, [open, anchor])

  if (!open || typeof document === 'undefined') return null

  const rate = PRESENCE_RATES[prefs.presenceRate] ?? PRESENCE_RATES.active

  return createPortal(
    <div
      ref={panelRef}
      className="ck12-xset"
      role="dialog"
      aria-label="汐音设置"
      data-testid="cockpit-crew-settings"
      style={{ left: pos ? `${pos.left}px` : 10, top: `${pos?.top ?? 64}px` }}
    >
      <div className="ck12-xset-h">
        <span className="ck12-xset-av"><img src={moodPortrait(mood)} alt="" /></span>
        <b>汐音</b>
        <span className="ck12-xset-sub">XIYIN-07 · 设置</span>
        <button
          type="button"
          className="ck12-xset-x"
          onClick={onClose}
          aria-label="关闭汐音设置"
          data-testid="cockpit-crew-settings-close"
        ><X className="size-3" aria-hidden="true" /></button>
      </div>

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

      <div className="ck12-xset-gal" data-testid="cockpit-crew-gallery">
        {XY_FORMS.map((form) => (
          <button
            key={form.k}
            type="button"
            className={mood === form.k ? 'on' : undefined}
            aria-label={`表情 · ${form.name}`}
            aria-pressed={mood === form.k}
            title={`${form.name} · ${form.tag} · ${form.desc}`}
            onClick={() => {
              setMoodOverride(form.k as MoodKey)
              cabinAudio.blip(660, 0.05)
            }}
            data-mood={form.k}
          >
            <img src={moodPortrait(form.k)} alt="" />
          </button>
        ))}
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