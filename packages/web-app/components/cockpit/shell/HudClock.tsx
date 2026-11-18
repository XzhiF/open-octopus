'use client'

// HUD 中间 pill 右段：当前时间（每秒更新）。
//
// 单独成件，是为了让「按秒重渲染」只发生在这一小块 —— HUD 其余读数（token /
// ctx / 消耗 / 舱籍）不跟着每秒重算。时间用系统时钟，不做任何推算或假数据；
// SSR/首帧拿不到 window 也没关系：setInterval 在 effect 里，服务端只会渲染首帧。

import { useEffect, useState } from 'react'

const pad = (value: number) => String(value).padStart(2, '0')

export function HudClock() {
  const [now, setNow] = useState<Date>(() => new Date())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  return (
    <span className="ck12-sr-clock" title="当前时间" data-testid="cockpit-clock">
      <b>{pad(now.getHours())}:{pad(now.getMinutes())}</b>
      <span className="ck12-sr-ss">:{pad(now.getSeconds())}</span>
    </span>
  )
}
