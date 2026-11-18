'use client'

// v20 帧播放器 / v21 静态阶段（design 29 §9.3 + design 31 §3.5）：
//
//   · 帧源由 pose-model.poseSource() 决定：motion sheet（12 帧）→ 双帧回退 → 单帧
//     pose PNG。v21 先静态确认人设，MOTION_SHEETS 留空 → frames=1，rAF 不启动；
//     sheet 补齐后同一组件自动回到 12 帧播放，无需改这里。
//   · 单 rAF：dt 累积 → 每 1000/fps 步 idx+=dir，端点折返（ping-pong 保证任意
//     视频片段首尾相接循环无跳变）→ transform translateY(-idx*100/frames%)；
//   · .ck12-spr 裁切窗 + img height=frames*100%（sheet 1:3 与窗 2:3×frames 同比）；
//   · document.hidden 暂停；prefers-reduced-motion 静帧 0；
//   · 解码失败逐级回退（fallbackSource），最终停在单帧立绘；
//   · 粒子层与帧动画解耦（PoseFX 按 POSE_META.fx 发射）。

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import {
  fallbackSource,
  poseSource,
  POSE_META,
  type PoseKey,
} from './pose-model'

interface MoState {
  idx: number
  dir: 1 | -1
  acc: number
  last: number
}

export function CockpitPoseSprite({ pose, reduce }: { pose: PoseKey; reduce: boolean }) {
  const initial = poseSource(pose)
  const [src, setSrc] = useState(initial.src)
  const [frames, setFrames] = useState(initial.frames)
  const [fps, setFps] = useState(initial.fps)
  const imgRef = useRef<HTMLImageElement>(null)
  const moRef = useRef<MoState>({ idx: 0, dir: 1, acc: 0, last: 0 })

  useEffect(() => {
    const next = poseSource(pose)
    setSrc(next.src)
    setFrames(next.frames)
    setFps(next.fps)
    moRef.current = { idx: 0, dir: 1, acc: 0, last: 0 }
  }, [pose])

  useEffect(() => {
    const apply = (idx: number) => {
      const el = imgRef.current
      if (el) el.style.transform = `translateY(-${(idx * 100) / frames}%)`
    }
    // 单帧 / reduced-motion：静帧，不占 rAF。
    if (reduce || frames < 2) {
      apply(0)
      return
    }
    let raf = 0
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop)
      const mo = moRef.current
      if (document.hidden) {
        mo.last = t
        return
      }
      if (!mo.last) mo.last = t
      mo.acc += t - mo.last
      mo.last = t
      const step = 1000 / fps
      while (mo.acc >= step) {
        mo.acc -= step
        mo.idx += mo.dir
        if (mo.idx >= frames - 1) {
          mo.idx = frames - 1
          mo.dir = -1
        } else if (mo.idx <= 0) {
          mo.idx = 0
          mo.dir = 1
        }
      }
      apply(mo.idx)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [frames, fps, reduce, src])

  return (
    <span className="ck12-spr" data-testid="cockpit-pose-sprite" data-pose={pose} data-frames={frames}>
      <img
        ref={imgRef}
        src={src}
        alt="汐音"
        draggable={false}
        data-static={frames < 2 ? 'true' : undefined}
        style={{ height: `${frames * 100}%` }}
        onError={() => {
          const next = fallbackSource(pose, src)
          if (!next) return
          setSrc(next.src)
          setFrames(next.frames)
          setFps(next.fps)
          moRef.current = { idx: 0, dir: 1, acc: 0, last: 0 }
        }}
      />
    </span>
  )
}

/** 姿态粒子层：loop 类常驻至换 pose；reduced 全禁（design 29 §9.3）。
 *  v21 四轮：fx='none'（alert）不再渲染任何粒子层。 */
export function PoseFX({ pose, reduce }: { pose: PoseKey; reduce: boolean }) {
  if (reduce) return null
  const fx = POSE_META[pose].fx
  if (fx === 'none') return null
  return (
    <span className={`ck12-pfx ck12-pfx-${fx}`} key={pose} aria-hidden="true" data-testid="cockpit-pose-fx">
      {Array.from({ length: 8 }, (_, i) => (
        <i key={i} style={{ '--i': i } as CSSProperties} />
      ))}
    </span>
  )
}
