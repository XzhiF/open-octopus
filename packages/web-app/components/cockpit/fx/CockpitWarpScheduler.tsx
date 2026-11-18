'use client'

// v20（design 29 §7.4）：随机跃迁 —— 15–45s 随机 setTimeout → 非隐藏页且
// 非 reduced-motion 才 travel；手动跃迁 / 换场景（jumpNonce 变化）也重排计时。
// v21 八轮：自动轮换改为「随机计时 + 随机另一幕」（travelRandom），手动跃迁仍顺序。
// PROD 常驻（氛围特效），开关在 state.autoWarp（DEV 模拟弹层可关）。

import { useEffect } from 'react'
import { useCockpitState } from '../state/CockpitStateProvider'

const WARP_MIN_MS = 15_000
const WARP_SPAN_MS = 30_000

export function CockpitWarpScheduler() {
  const { fx, autoWarp, travelRandom } = useCockpitState()
  const nonce = fx.jumpNonce

  useEffect(() => {
    if (!autoWarp) return
    let timer = 0
    const schedule = () => {
      timer = window.setTimeout(() => {
        const reduce = typeof window.matchMedia === 'function'
          && window.matchMedia('(prefers-reduced-motion: reduce)').matches
        if (!document.hidden && !reduce) travelRandom()
        schedule()
      }, WARP_MIN_MS + Math.random() * WARP_SPAN_MS)
    }
    schedule()
    return () => window.clearTimeout(timer)
  }, [autoWarp, travelRandom, nonce])

  return null
}
