'use client'

// v20（design 29 §7.4）：随机跃迁 —— 45–105s 随机 setTimeout → 非隐藏页且
// 非 reduced-motion 才 travel；手动跃迁 / 换场景（jumpNonce 变化）也重排计时。
// PROD 常驻（氛围特效），开关在 state.autoWarp（DEV 模拟弹层可关）。

import { useEffect } from 'react'
import { useCockpitState } from '../state/CockpitStateProvider'

const WARP_MIN_MS = 45_000
const WARP_SPAN_MS = 60_000

export function CockpitWarpScheduler() {
  const { fx, autoWarp } = useCockpitState()
  const jump = fx.jump
  const nonce = fx.jumpNonce

  useEffect(() => {
    if (!autoWarp) return
    let timer = 0
    const schedule = () => {
      timer = window.setTimeout(() => {
        const reduce = typeof window.matchMedia === 'function'
          && window.matchMedia('(prefers-reduced-motion: reduce)').matches
        if (!document.hidden && !reduce) jump()
        schedule()
      }, WARP_MIN_MS + Math.random() * WARP_SPAN_MS)
    }
    schedule()
    return () => window.clearTimeout(timer)
  }, [autoWarp, jump, nonce])

  return null
}
