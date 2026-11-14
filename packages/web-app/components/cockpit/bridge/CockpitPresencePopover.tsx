'use client'

// S6 owns this file —— 在场 popover（v12 的在场按钮 + 设计稿要求的三档频率）。
//
// 真源是 CockpitProvider 的 prefs：presenceOn / presenceRate；频率显示
// cockpit.ts 的 PRESENCE_RATES 真实分钟区间（quiet 12–24 / std 6–16 / active 3–8），
// 不写「偶尔 / 经常」这种模糊词，也不自造档位。
// 「现在说一句」调已有的 testPresence()（与立绘控制条同一个动作）。

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { useCockpit } from '@/components/cabin/CockpitProvider'
import { PRESENCE_RATES, type PresenceRate } from '@/components/cabin/cockpit'
import { useCockpitState } from '../state/CockpitStateProvider'
import { BRIDGE_POP_LAYER_PRIORITY } from './CockpitModelPopover'

const RATE_ORDER: PresenceRate[] = ['quiet', 'std', 'active']

export function CockpitPresencePopover() {
  const { prefs, setPref, testPresence } = useCockpit()
  const { layer } = useCockpitState()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    return layer.register('bridge-pop', BRIDGE_POP_LAYER_PRIORITY, () => setOpen(false))
  }, [open, layer])

  const rate = PRESENCE_RATES[prefs.presenceRate] ?? PRESENCE_RATES.std
  const label = prefs.presenceOn ? `在场 · ${rate.label}` : '不在场'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`ck12-rig-btn ck12-rig-pres${prefs.presenceOn ? '' : ' is-off'}`}
          title="在场：汐音会时不时主动说一句"
          aria-label="在场设置"
          data-testid="ck12-rig-presence"
        >
          <i aria-hidden="true" />
          <span>{label}</span>
        </button>
      </PopoverTrigger>

      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        className="ck12-rig-pop is-end"
        data-testid="ck12-rig-presence-pop"
        onEscapeKeyDown={(event) => {
          // 同 CockpitContextPopover：Radix 打开时 LayerStack 会让行，
          // 所以这里 preventDefault 之外还要显式关闭。
          event.preventDefault()
          setOpen(false)
        }}
      >
        <div className="ck12-rig-pop-h">
          <button
            type="button"
            className="ck12-rig-pop-x"
            onClick={() => setOpen(false)}
            aria-label="关闭在场设置"
            data-testid="ck12-rig-presence-close"
          ><X className="size-3" aria-hidden="true" /></button>
          <b>在场</b>
          <span>汐音会时不时主动说一句</span>
        </div>

        <div className="ck12-rig-pop-b">
          <div className="ck12-rig-switchrow">
            <Switch
              checked={prefs.presenceOn}
              onCheckedChange={(next) => setPref('presenceOn', next)}
              aria-label="主动搭话"
              data-testid="ck12-rig-presence-switch"
            />
            <span>主动搭话</span>
            <span className="ck12-rig-spacer" />
            <small>{prefs.presenceOn ? '开' : '关'}</small>
          </div>

          <div className="ck12-rig-sect">频率</div>
          <div className="ck12-rig-seg" role="group" aria-label="在场频率">
            {RATE_ORDER.map((key) => {
              const item = PRESENCE_RATES[key]
              const active = prefs.presenceRate === key
              return (
                <button
                  key={key}
                  type="button"
                  className={active ? 'on' : undefined}
                  aria-pressed={active}
                  onClick={() => setPref('presenceRate', key)}
                  data-testid={`ck12-rig-rate-${key}`}
                >
                  {item.label}
                  <small>{item.min}–{item.max} 分钟</small>
                </button>
              )
            })}
          </div>

          <div className="ck12-rig-note" data-testid="ck12-rig-presence-note">
            {prefs.presenceOn
              ? `约每 ${rate.min}–${rate.max} 分钟一句`
              : '已关闭 · 开启后按该频率开口'}
          </div>
        </div>

        <div className="ck12-rig-pop-f">
          <button
            type="button"
            className="ck12-rig-action"
            onClick={() => {
              testPresence()
              setOpen(false)
            }}
            data-testid="ck12-rig-presence-say"
          >现在说一句</button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
