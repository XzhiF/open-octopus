'use client'

// S8 舱面调校（原型 wbTuning docs/cabin-design/index.html 1570-1594）：色彩主题 /
// 悬浮样式 / 场景 HUD / 光效粒子 / 角色大小+mood / 自决开关 / 音效，实时作用驾驶舱。
// 随机/重置/导出配置/导出立绘。新增 C11 打盹阈值（dormantMinutes，0=关闭自动打盹）。
// prefs 经 CockpitProvider 乐观写 + 防抖持久化；autonomy 是行为键（改派发行为）。

import { useEffect, useState } from 'react'
import { Dices, Download, RotateCcw, SlidersHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import { cabinAudio } from '@/lib/cabin-audio'
import { useCockpit } from '../CockpitProvider'
import { WbH } from './ui'
import {
  HRANGES, MOOD_OPTIONS, PRESENCE_RATES, THEMES, moodPortrait,
  type CockpitFloat, type CockpitPrefs, type CockpitTheme, type CabinAutonomy, type CabinMood, type PresenceRate,
} from '../cockpit'

const FLOATS: [CockpitFloat, string][] = [['glass', '玻璃'], ['solid', '实色'], ['holo', '全息']]
const AUTONOMY: [CabinAutonomy, string][] = [['off', '关闭'], ['observe', '观察'], ['auto', '自主']]
const PRESENCE_ORDER: PresenceRate[] = ['quiet', 'std', 'active']

function rangeValue(k: keyof CockpitPrefs, v: number): string {
  if (k === 'scan') return v === 0 ? '关' : String(v)
  if (k === 'glow') return v.toFixed(1)
  if (k === 'charScale') return `${v.toFixed(2)}×`
  return String(v)
}

function download(name: string, href: string): void {
  const a = document.createElement('a')
  a.href = href
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
}

export function CabinTuning() {
  const {
    prefs, mood, setPref, reset, randomize,
    presenceDueAt, presenceSnoozeUntil, testPresence,
  } = useCockpit()

  // 在场「下次」倒计时：调校窗开着时每秒刷新。
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [])
  let presenceDueLabel = '—'
  if (!prefs.presenceOn) presenceDueLabel = '已关闭'
  else if (presenceSnoozeUntil > now) presenceDueLabel = `静默中 · ${Math.ceil((presenceSnoozeUntil - now) / 60_000)} 分后恢复`
  else if (presenceDueAt > 0) {
    const s = Math.max(0, Math.round((presenceDueAt - now) / 1000))
    presenceDueLabel = s >= 120 ? `${Math.round(s / 60)} 分后` : `${s} 秒后`
  }

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(prefs, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    download('cabin-cockpit.json', url)
    setTimeout(() => URL.revokeObjectURL(url), 1500)
    cabinAudio.blip(880, 0.08)
    toast('已导出驾驶舱配置 JSON')
  }
  const exportPortrait = () => {
    download(`xiyin-${mood}.png`, moodPortrait(mood))
    cabinAudio.blip(880, 0.08)
    toast(`已导出汐音当前立绘（${mood}）`)
  }

  const Range = ({ k }: { k: keyof CockpitPrefs }) => {
    const cfg = HRANGES.find((r) => r.k === k)
    if (!cfg) return null
    const v = prefs[k] as number
    return (
      <div className="hrow">
        <span className="tlabel">{cfg.label}</span>
        <input
          type="range" className="hrange" data-ck={k}
          min={cfg.min} max={cfg.max} step={cfg.step} value={v}
          onChange={(e) => setPref(k, Number(e.target.value) as CockpitPrefs[typeof k])}
        />
        <span className="hv">{rangeValue(k, v)}</span>
      </div>
    )
  }

  const Toggle = ({ k, label }: { k: keyof CockpitPrefs; label: string }) => (
    <div className="hrow">
      <span className="tlabel">{label}</span>
      <button
        type="button" className={`htoggle${prefs[k] ? ' on' : ''}`} data-ck={k}
        aria-pressed={!!prefs[k]}
        onClick={() => setPref(k, !prefs[k] as CockpitPrefs[typeof k])}
      ><i /></button>
    </div>
  )

  return (
    <div className="tuning" data-testid="cabin-tuning-body">
      <WbH icon={SlidersHorizontal} title="舱面调校" cap="实时作用于驾驶舱氛围 · 中心 chat 始终主导" />

      <div className="helm-actions">
        <button type="button" className="hbtn" title="随机一套舱面风格" onClick={randomize} data-testid="tuning-random">
          <Dices className="size-3" />随机
        </button>
        <button type="button" className="hbtn" title="恢复默认" onClick={reset} data-testid="tuning-reset">
          <RotateCcw className="size-3" />重置
        </button>
        <button type="button" className="hbtn" title="导出当前配置 JSON" onClick={exportJson} data-testid="tuning-export-json">
          <Download className="size-3" />配置
        </button>
        <button type="button" className="hbtn pri" title="导出汐音当前立绘" onClick={exportPortrait} data-testid="tuning-export-portrait">
          <Download className="size-3" />角色立绘
        </button>
      </div>

      <div className="helm-grid">
        <div className="hgroup">
          <span className="gl">色彩 THEME<span className="hv">{THEMES[prefs.theme].name}</span></span>
          <div className="swatches">
            {(Object.keys(THEMES) as CockpitTheme[]).map((k) => (
              <button
                key={k} type="button" title={THEMES[k].name}
                className={`swatch${prefs.theme === k ? ' on' : ''}`}
                style={{ background: `linear-gradient(135deg, ${THEMES[k].a}, ${THEMES[k].b})` }}
                onClick={() => { setPref('theme', k); cabinAudio.blip(760, 0.06) }}
                data-testid={`tuning-theme-${k}`}
              />
            ))}
          </div>
        </div>

        <div className="hgroup">
          <span className="gl">在场 PRESENCE<span className="hv">{prefs.presenceOn ? 'ON' : 'OFF'}</span></span>
          <Toggle k="presenceOn" label="主动搭话" />
          <div className="hrow">
            <span className="tlabel">频率</span>
            <select
              className="hsel" value={prefs.presenceRate}
              onChange={(e) => { setPref('presenceRate', e.target.value as PresenceRate); cabinAudio.blip(660, 0.04) }}
              data-testid="tuning-presence-rate"
            >
              {PRESENCE_ORDER.map((r) => (
                <option key={r} value={r}>{PRESENCE_RATES[r].label} {PRESENCE_RATES[r].min}–{PRESENCE_RATES[r].max} 分</option>
              ))}
            </select>
          </div>
          <div className="hrow">
            <span className="tlabel">下次</span>
            <span className="tlabel" style={{ fontSize: 9, opacity: .75 }} data-testid="tuning-presence-due">{presenceDueLabel}</span>
          </div>
          <div className="hrow">
            <button type="button" className="hbtn" onClick={testPresence} data-testid="tuning-presence-test">现在说一句</button>
            <span className="tlabel" style={{ fontSize: 8.5, opacity: .6 }}>免打扰 22:00–08:00</span>
          </div>
        </div>

        <div className="hgroup">
          <span className="gl">悬浮 FLOAT</span>
          <div className="seg">
            {FLOATS.map(([v, l]) => (
              <button key={v} type="button" className={prefs.float === v ? 'on' : ''} onClick={() => { setPref('float', v); cabinAudio.blip(680, 0.05) }}>{l}</button>
            ))}
          </div>
          <Range k="floatAmp" />
        </div>

        <div className="hgroup">
          <span className="gl">场景 SCENE</span>
          <Toggle k="hud" label="HUD 括角" />
          <Range k="scan" />
          <Range k="grid" />
        </div>

        <div className="hgroup">
          <span className="gl">光效 GLOW</span>
          <Range k="glow" />
          <Range k="particles" />
          <Range k="blur" />
        </div>

        <div className="hgroup">
          <span className="gl">角色 PILOT</span>
          <Range k="charScale" />
          <div className="hrow">
            <span className="tlabel">状态</span>
            <select className="hsel" data-ck="mood" value={prefs.mood} onChange={(e) => setPref('mood', e.target.value as CabinMood)} data-testid="tuning-mood">
              {MOOD_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
        </div>

        <div className="hgroup">
          <span className="gl">自决 AUTONOMY</span>
          <div className="seg">
            {AUTONOMY.map(([v, l]) => (
              <button key={v} type="button" className={prefs.autonomy === v ? 'on' : ''} onClick={() => { setPref('autonomy', v); cabinAudio.blip(680, 0.05) }} data-testid={`tuning-autonomy-${v}`}>{l}</button>
            ))}
          </div>
          <span className="tlabel" style={{ fontSize: 9, opacity: .7 }}>explicit 自决派发 · inferred 观察模式先确认</span>
        </div>

        <div className="hgroup">
          <span className="gl">声音 AUDIO</span>
          <Toggle k="sound" label="舱内音效" />
          <span className="tlabel" style={{ fontSize: 9, opacity: .7 }}>环境低鸣 + 操作提示音</span>
        </div>

        <div className="hgroup">
          <span className="gl">打盹 NAP<span className="hv">{prefs.dormantMinutes === 0 ? '关' : `${prefs.dormantMinutes}分`}</span></span>
          <div className="hrow">
            <span className="tlabel">空闲阈值</span>
            <input
              type="range" className="hrange" min={0} max={180} step={5} value={prefs.dormantMinutes}
              onChange={(e) => setPref('dormantMinutes', Number(e.target.value))}
              data-testid="tuning-dormant"
            />
          </div>
          <span className="tlabel" style={{ fontSize: 9, opacity: .7 }}>无运行 / 无待人 / 无排队且人在舱里的互动停了超阈值 → 自动打盹；进舱、键鼠、发消息都会立刻叫醒（0=关闭）</span>
        </div>
      </div>
    </div>
  )
}