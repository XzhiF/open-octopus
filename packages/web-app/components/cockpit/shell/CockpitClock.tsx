'use client'

// v21（design 31 §3.4.6）· 右下角舰桥时钟（原型 .clockwidget）：
//   16px 绿色 HH:MM + 副行「舰桥时间 · 全舱正常」。
// v13 的在场读数并入副行（原型没有，但这是生产能力，§7 登记）。
// 时间走真时钟；不刷新秒（原型只到分钟），每分钟更新一次。

import { useEffect, useState } from 'react'
import { useCockpit } from '@/components/cabin/CockpitProvider'
import { presenceRateLabel } from '@/components/cabin/cockpit'

function hhmm(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function CockpitClock() {
  const { prefs } = useCockpit()
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    // 对齐到分钟边界再定时，避免每分钟漂移。
    let timer = 0
    const tick = () => {
      setNow(new Date())
      timer = window.setTimeout(tick, 60_000 - (Date.now() % 60_000) + 20)
    }
    timer = window.setTimeout(tick, 60_000 - (Date.now() % 60_000) + 20)
    return () => window.clearTimeout(timer)
  }, [])

  const presence = prefs.presenceOn
    ? presenceRateLabel(prefs.presenceRate)
    : '关'

  return (
    <div
      className="ck12-clockwidget"
      data-testid="cockpit-clock"
      title={`在场：${presence}（汐音设置里可调）`}
    >
      <span className="ck12-cw">{hhmm(now)}</span>
      <span className="ck12-cs">舰桥时间 · 全舱正常</span>
    </div>
  )
}
