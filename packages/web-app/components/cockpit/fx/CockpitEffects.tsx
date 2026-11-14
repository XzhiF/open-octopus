'use client'

// S8 owns this file —— 全局特效（v12 .fx / .edgefx）：
//   · .ck12-edgefx：四条 3px 舱壁流光，2.4s，只擦屏幕边缘，不压中间的字；
//   · .ck12-fx：中心脉冲（1.15s），铺在内容之下（z-index 4，同原型）。
// 订阅 fx.edgeNonce / fx.pulseNonce：用 key = nonce 重挂重放（CSS 动画只跑一次），
// 普通重渲染不会重放。prefers-reduced-motion → 整个不挂载。
//
// z-index：edgefx 21（HUD 20 之上、聊天浮窗 24 / popover 之下），
// 两层都是 pointer-events:none。

import { useEffect, useState, type CSSProperties } from 'react'
import { useCockpitState } from '../state/CockpitStateProvider'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

/** 初值同步读 matchMedia（避免先挂载再卸载的闪一下），并订阅后续变化。 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia(REDUCED_MOTION_QUERY).matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(REDUCED_MOTION_QUERY)
    setReduced(query.matches)
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches)
    query.addEventListener?.('change', onChange)
    return () => query.removeEventListener?.('change', onChange)
  }, [])

  return reduced
}

export function CockpitEffects() {
  const { fx } = useCockpitState()
  const reduced = usePrefersReducedMotion()

  if (reduced) return null

  return (
    <>
      {/* 中心脉冲：key = nonce，换一次重放一次；nonce 0 是初值，不用播 */}
      <div
        key={`pulse:${fx.pulseNonce}`}
        className={`ck12-fx${fx.pulseNonce > 0 ? ' on' : ''}`}
        style={{ '--ck12-fx': fx.pulseColor } as CSSProperties}
        data-testid="cockpit-fx"
        data-nonce={fx.pulseNonce}
        aria-hidden="true"
      />

      {/* 四边流光：只走边缘 */}
      <div
        key={`edge:${fx.edgeNonce}`}
        className={`ck12-edgefx${fx.edgeNonce > 0 ? ' on' : ''}`}
        style={{ '--ck12-fx': fx.edgeColor } as CSSProperties}
        data-testid="cockpit-edgefx"
        data-nonce={fx.edgeNonce}
        aria-hidden="true"
      >
        <i className="t" />
        <i className="b" />
        <i className="l" />
        <i className="r" />
      </div>
    </>
  )
}
