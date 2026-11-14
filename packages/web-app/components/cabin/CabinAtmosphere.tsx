'use client'

// 驾驶舱氛围层（原型 cockpit-bg / ck-particles / cockpit-frame / telemetry，
// docs/cabin-design/index.html 969-992 + 436-471 + 583-635）。pointer-events-none
// 覆于 chat 区之上、浮窗之下；--ck-* 由 CockpitProvider 实时驱动。telemetry 顶部
// 细条只读舱况（K3：一律读服务端 view，不本地派生）。

import { useMemo } from 'react'
import { useCabinContext } from './cabin-provider'
import { useCockpit } from './CockpitProvider'
import { CABIN_STATUS_META } from './cabin-meta'
import { THEMES } from './cockpit'

export function CabinAtmosphere() {
  const { cabin, view } = useCabinContext()
  const { prefs } = useCockpit()

  const particles = useMemo(() => {
    const th = THEMES[prefs.theme] ?? THEMES.terminal
    const cols = [th.a, th.b, th.c]
    return Array.from({ length: Math.round(prefs.particles) }, (_, i) => ({
      id: i,
      left: `${(Math.random() * 100).toFixed(1)}%`, // fmt-ok: 粒子 CSS 坐标，不是文案
      size: `${(2 + Math.random() * 3).toFixed(1)}px`,
      duration: `${(8 + Math.random() * 14).toFixed(1)}s`, // fmt-ok: 粒子动画时长
      delay: `${(-Math.random() * 22).toFixed(1)}s`, // fmt-ok: 粒子动画延迟
      color: cols[i % 3],
    }))
  }, [prefs.particles, prefs.theme])

  const statusLabel = cabin ? CABIN_STATUS_META[cabin.status].label : '—'
  const running = view?.health.running ?? 0
  const queued = view?.health.queued ?? 0
  const workers = view?.health.workers ?? 0
  const max = view?.health.max ?? 0
  const attention = view?.attention.length ?? 0

  return (
    <div className="pointer-events-none absolute inset-0 z-[5]" data-testid="cabin-atmosphere" aria-hidden="true">
      <div className="cockpit-bg" />
      <div className="ck-particles">
        {particles.map((p) => (
          <span
            key={p.id}
            className="ck-p"
            style={{
              left: p.left, width: p.size, height: p.size, background: p.color,
              animationDuration: p.duration, animationDelay: p.delay,
            }}
          />
        ))}
      </div>
      <div className="cockpit-frame">
        <span className="cf-corner tl" /><span className="cf-corner tr" />
        <span className="cf-corner bl" /><span className="cf-corner br" />
        <span className="cf-notch" /><span className="cf-rail top" /><span className="cf-rail bot" />
      </div>
      <div className="telemetry" data-testid="cabin-telemetry">
        <span className="sys"><i />SYS ONLINE</span>
        <span className="tsep" />
        <span className="titem"><span className="tk">状态</span><span className="tval violet">{statusLabel}</span></span>
        <span className="titem"><span className="tk">运行</span><span className="tval green">{running}</span></span>
        <span className="titem"><span className="tk">排队</span><span className="tval">{queued}</span></span>
        <span className="titem"><span className="tk">执行器</span><span className="tval">{workers}/{max}</span></span>
        <span className="titem"><span className="tk">需要你</span><span className="tval">{attention}</span></span>
      </div>
    </div>
  )
}