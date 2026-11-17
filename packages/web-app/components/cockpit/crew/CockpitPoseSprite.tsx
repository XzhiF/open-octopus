'use client'

// v20（design 29 §9.3）：sprite-sheet 帧播放器 —— 真·连续动作。
//
//   · 单 rAF：dt 累积 → 每 1000/fps 步 idx+=dir，端点折返（ping-pong 保证任意
//     视频片段首尾相接循环无跳变）→ transform translateY(-idx*100/frames%)；
//   · .ck12-spr 裁切窗 + img height=frames*100%（sheet 1:3 与窗 2:3×frames 同比）；
//   · document.hidden 暂停；prefers-reduced-motion 静帧 0；
//   · motion 源 onerror → 双帧回退（fps 降 1.6 防眨闪）；
//   · 粒子层与帧动画解耦（PoseFX 按 POSE_META.fx 发射）。

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import {
  FALLBACK_FPS,
  FALLBACK_FRAMES,
  FALLBACK_SHEETS,
  MOTION_FRAMES,
  MOTION_SHEETS,
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
  const [src, setSrc] = useState(MOTION_SHEETS[pose])
  const [frames, setFrames] = useState(MOTION_FRAMES)
  const [fps, setFps] = useState(POSE_META[pose].fps)
  const imgRef = useRef<HTMLImageElement>(null)
  const moRef = useRef<MoState>({ idx: 0, dir: 1, acc: 0, last: 0 })

  useEffect(() => {
    setSrc(MOTION_SHEETS[pose])
    setFrames(MOTION_FRAMES)
    setFps(POSE_META[pose].fps)
    moRef.current = { idx: 0, dir: 1, acc: 0, last: 0 }
  }, [pose])

  useEffect(() => {
    const apply = (idx: number) => {
      const el = imgRef.current
      if (el) el.style.transform = `translateY(-${(idx * 100) / frames}%)`
    }
    if (reduce) {
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
      const step = 1000 / (frames > FALLBACK_FRAMES ? fps : FALLBACK_FPS)
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
        style={{ height: `${frames * 100}%` }}
        onError={() => {
          if (src === MOTION_SHEETS[pose]) {
            setSrc(FALLBACK_SHEETS[pose])
            setFrames(FALLBACK_FRAMES)
            setFps(FALLBACK_FPS)
            moRef.current = { idx: 0, dir: 1, acc: 0, last: 0 }
          }
        }}
      />
    </span>
  )
}

/** 姿态粒子层：loop 类常驻至换 pose；reduced 全禁（design 29 §9.3）。 */
export function PoseFX({ pose, reduce }: { pose: PoseKey; reduce: boolean }) {
  if (reduce) return null
  const fx = POSE_META[pose].fx
  return (
    <span className={`ck12-pfx ck12-pfx-${fx}`} key={pose} aria-hidden="true" data-testid="cockpit-pose-fx">
      {Array.from({ length: 8 }, (_, i) => (
        <i key={i} style={{ '--i': i } as CSSProperties} />
      ))}
    </span>
  )
}
