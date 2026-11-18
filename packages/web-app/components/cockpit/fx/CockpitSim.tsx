'use client'

// v20（design 29 §7.3）：模拟弹层 —— **仅 DEV + ?demo=1**（生产构建静态摇掉）。
//
// 真数据纪律（design 12 #8）：演示只走 fx + 标注「演示」的简报，不伪造编队 /
// 决断数据。所以这里的「回流」=  staggered 演示简报 + 特效；「全部按 REC 收口」
// 在真实舱里是人的决断（决策端点），演示不代答 —— 与原型 mock 的唯一差异。
// 自动回流 34s（30% 概率 2–3 连发）；随机跃迁开关接 state.autoWarp。

import { useCallback, useEffect, useRef, useState } from 'react'
import { useCockpitState } from '../state/CockpitStateProvider'
import { demoArrivalEnabled } from '../fx/CockpitBrief'
import { setSimAuto, useSimAuto } from './sim-auto'

const AUTO_MS = 34_000

export function CockpitSim() {
  const { fx, autoWarp, setAutoWarp } = useCockpitState()
  const [open, setOpen] = useState(false)
  const autoArrival = useSimAuto()
  const timersRef = useRef<number[]>([])
  const enabled = demoArrivalEnabled()

  const demo = useCallback((count: number, gap: number) => {
    for (let i = 0; i < count; i += 1) {
      const timer = window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent('octopus:demo-arrival'))
      }, i * gap)
      timersRef.current.push(timer)
    }
  }, [])

  useEffect(() => () => {
    for (const timer of timersRef.current) window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (!enabled || !autoArrival) return
    const timer = window.setInterval(() => {
      if (document.hidden) return
      if (Math.random() < 0.3) demo(2 + Math.floor(Math.random() * 2), 1100)
      else demo(1, 0)
    }, AUTO_MS)
    return () => window.clearInterval(timer)
  }, [enabled, autoArrival, demo])

  if (!enabled) return null

  const burst = () => {
    const count = 4 + Math.floor(Math.random() * 3)
    demo(count, 430)
    // 260ms 处插一条 progress 报信（与原型连发节奏一致）。
    const timer = window.setTimeout(() => fx.say('演示：编队推进中…', 'working'), 260)
    timersRef.current.push(timer)
  }

  return (
    <div className="ck12-sim" data-testid="cockpit-sim">
      <button
        type="button"
        className="ck12-sim-btn"
        aria-expanded={open}
        title="模拟弹层（仅 dev + ?demo=1）"
        data-testid="cockpit-sim-toggle"
        onClick={() => setOpen(!open)}
      >
        ✦ 模拟
      </button>
      {open && (
        <div className="ck12-sim-pop" role="dialog" aria-label="模拟弹层">
          <button type="button" data-testid="cockpit-sim-one" onClick={() => demo(1, 0)}>单条回流</button>
          <button type="button" data-testid="cockpit-sim-triple" onClick={() => demo(3, 1100)}>三连回流</button>
          <button type="button" data-testid="cockpit-sim-burst" onClick={burst}>连发回流 ×4–6</button>
          <button
            type="button"
            data-testid="cockpit-sim-auto"
            aria-pressed={autoArrival}
            onClick={() => setSimAuto(!autoArrival)}
          >
            自动回流 {autoArrival ? '开' : '关'}
          </button>
          <button
            type="button"
            data-testid="cockpit-sim-warp"
            aria-pressed={autoWarp}
            onClick={() => setAutoWarp(!autoWarp)}
          >
            随机跃迁 {autoWarp ? '开' : '关'}
          </button>
          <div className="ck12-sim-note">演示只报信不写数据 · 决断收口仍走真人</div>
        </div>
      )}
    </div>
  )
}
