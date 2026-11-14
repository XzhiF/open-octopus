'use client'

// 安静层（v12 .quiet）：真实舱内时钟（每秒）+ 三个真实编队读数 + ⌥1 / ⌘K 提示。
// 没有选中作业面时铺满 arena；选中后由 .ck12-arena.is-open 淡出（S4 落面时接管）。
// 读数来自 useCockpitFleet().counts；还没接上时显示「—」，不写 0 冒充。
// 「消耗」等 S6 的舰桥提供真值后再接（当前没有来源就保持「—」）。

import { useEffect, useState } from 'react'
import { useCockpitFleet } from '../fleet/CockpitFleetProvider'

const pad = (value: number) => String(value).padStart(2, '0')

export function CockpitQuiet() {
  const [now, setNow] = useState<Date>(() => new Date())
  const { counts } = useCockpitFleet()

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])

  return (
    <div className="ck12-quiet" data-testid="cockpit-quiet">
      <div className="ck12-clock">
        {pad(now.getHours())}:{pad(now.getMinutes())}
        <span className="ck12-clock-sec">:{pad(now.getSeconds())}</span>
        <small>MISSION CLOCK · 舱内时间</small>
      </div>
      <div className="ck12-arcs">
        <div className="ck12-arc"><b>{counts ? counts.run : '—'}</b>执行中</div>
        <div className="ck12-arc"><b>{counts ? counts.need : '—'}</b>需要你</div>
        <div className="ck12-arc"><b>{counts ? counts.jobs : '—'}</b>编队</div>
        <div className="ck12-arc"><b>—</b>消耗</div>
      </div>
      <div className="ck12-hintline">
        没有打开的作业面 · 汐音在盯着
        <br />
        <kbd>⌥1</kbd> 看最紧要的一条 · <kbd>⌘K</kbd> 随时下指令
      </div>
    </div>
  )
}
