'use client'

// 舱数据门禁期的出场立绘（2026-11-20 用户：一打开全域就要见到汐音）。
//
// 骨架屏（CockpitSkeleton）之上先挂一支出场片（动作 01「眨眼」）—— 和真立绘同一个
// CockpitPoseSprite，位置 / 尺寸 / 显影动画全部同一套；舱数据到位、真舱面挂载后，
// 等真立绘首帧可画（notifyRealSpriteLive）再 0.28s 淡出卸载。
//
// 为什么不直接让骨架屏等真立绘：真舱面要等舱接口，video 也要等字节 + 解码，
// 两段是串行的；boot 把「等人」这段填上，交接期间画面一直有人。
// 真立绘不重播显影由 boot-handover 的 bootCoversEntrance 负责。

import { useEffect, useState } from 'react'
import { CockpitPoseSprite } from '../crew/CockpitPoseSprite'
import { ENTRY_CLIP } from '../crew/pose-model'
import { enterBootLayer, leaveBootLayer, onRealSpriteLive } from '../crew/boot-handover'

/** 舱面放行后仍没有真立绘可画，最多再盖这么久（防止异常时一直挡着舱面）。 */
const HANDOVER_TIMEOUT_MS = 6_000
/** 与 crew.css 的 .ck12-boot-layer 过渡对齐。 */
const FADE_MS = 280

type Phase = 'shown' | 'fading' | 'gone'

function prefersReduced(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function CockpitBootLayer({
  gateOpen,
  gateFailed,
}: {
  /** 舱数据已放行（真舱面开始挂载）。 */
  gateOpen: boolean
  /** 舱不存在 / 加载失败：boot 不该留着。 */
  gateFailed: boolean
}) {
  const [phase, setPhase] = useState<Phase>('shown')
  const [reduce] = useState(prefersReduced)

  useEffect(() => {
    enterBootLayer()
    return () => leaveBootLayer()
  }, [])

  // 真立绘首帧可画 → 退场。
  useEffect(() => {
    if (phase !== 'shown') return
    return onRealSpriteLive(() => setPhase((p) => (p === 'shown' ? 'fading' : p)))
  }, [phase])

  // 兜底：舱面放行后迟迟等不到真立绘，收 boot，别挡舱面。
  useEffect(() => {
    if (!gateOpen || phase !== 'shown') return
    const timer = setTimeout(() => setPhase((p) => (p === 'shown' ? 'fading' : p)), HANDOVER_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [gateOpen, phase])

  useEffect(() => {
    if (gateFailed) setPhase('gone')
  }, [gateFailed])

  useEffect(() => {
    if (phase !== 'fading') return
    const timer = setTimeout(() => setPhase('gone'), FADE_MS)
    return () => clearTimeout(timer)
  }, [phase])

  if (phase === 'gone') return null

  return (
    <div
      className={`ck12-app ck12-boot-layer${phase === 'fading' ? ' is-fading' : ''}`}
      data-testid="cockpit-boot-layer"
      data-phase={phase}
      aria-hidden="true"
    >
      <div className="ck12-crew ck12-crew-boot" data-testid="cockpit-boot-crew">
        <div className="ck12-pod" data-state="ready">
          <CockpitPoseSprite pose="wink" clip={ENTRY_CLIP} reduce={reduce} boot />
          <span className="ck12-pod-vg" />
          <span className="ck12-pod-name">
            汐音 <small>· 全域助理</small>
            <em>待命 · 01/13</em>
          </span>
        </div>
      </div>
    </div>
  )
}
