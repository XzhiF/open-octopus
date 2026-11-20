'use client'

// v22（design 33 §3）：汐音立绘 = **纯视频**。
//
//   · 片段由 `clip`（图鉴点击精确到段）或 `pose`（mood / 动作姿态）决定；
//     有 clip 用 clip，否则 poseClip(pose) 取该姿态的首选片段。
//   · 每个片段都是 768×1152 VP9 alpha WebM（_motion-v22.mjs 统一归一化：
//     人物高 1040 / 脚底 1105 / 躯干中轴 384），所以换段不跳位、比例一致。
//   · **画面只有视频**：不再垫 docs 里 v21 的整身静图。那批静图与 13 支视频不是
//     同一套画，cheer 这类没有专属片段的姿态一垫就露馅（2026-11-20 用户：连点她
//     会出现「双手举起的开心立绘」，看着像第 14 个动作）。解码真失败才退到该片段
//     的 v22 缩略图。
//   · 双层交叉淡入（2026-11-20 用户：换动作太僵硬）：A/B 两支 <video> 常驻，新片段
//     装进后层预载，起播瞬间旧层停最后一帧当残影，CSS opacity 0.22s 完成过渡。
//     前层始终是「完整出过画面的那一支」，任何时刻都不会露空。
//   · 片段字节先 fetch 成 blob URL 再交给 <video>（clip-blob.ts）：桌面端媒体
//     HTTP 管线在个别机器上 3MB ≈ 18s，blob 本地解码 <20ms（2026-11-20 用户 #15）。
//   · prefers-reduced-motion：不自动播，停在 0.5s 一帧（仍是视频真源，不是静态图）。
//   · document.hidden 暂停前层，回来续播，省电且不丢帧。
//
// 粒子层与视频解耦（PoseFX 按 POSE_META.fx 发射），点击/台词手感与 v21 一致。

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import {
  CLIPS,
  POSE_META,
  poseClip,
  type PoseKey,
} from './pose-model'
import { clipMediaUrl } from './clip-blob'

interface SpriteProps {
  pose: PoseKey
  /** 图鉴点名的精确片段下标；不传则按 pose 映射。 */
  clip?: number | null
  reduce: boolean
}

type Slot = 'a' | 'b'
const flip = (slot: Slot): Slot => (slot === 'a' ? 'b' : 'a')

export function CockpitPoseSprite({ pose, clip, reduce }: SpriteProps) {
  const index = Number.isInteger(clip) && (clip as number) >= 0 && (clip as number) < CLIPS.length
    ? (clip as number)
    : poseClip(pose)
  const item = CLIPS[index]
  const src = item.src

  const aRef = useRef<HTMLVideoElement>(null)
  const bRef = useRef<HTMLVideoElement>(null)

  /** 两层各自的 blob 地址：front 可见，另一层预载下一支。 */
  const [slots, setSlots] = useState<Record<Slot, string | null>>({ a: null, b: null })
  const [front, setFront] = useState<Slot>('a')
  const frontRef = useRef<Slot>('a')
  /** 每层装的是哪一支片段（判断这一层到底是不是当前要的 src）。 */
  const slotSrcRef = useRef<Record<Slot, string | null>>({ a: null, b: null })
  /** 已经上屏的 / 正在加载的 src，避免同一支重复抓包。 */
  const shownRef = useRef<string | null>(null)
  const wantRef = useRef<string | null>(null)
  /** 只记住失败的 src：换段后自动重试，不会一次失败就永久退到兜底图。 */
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const failed = failedSrc === src

  // 新片段装进后层：片段字节先 fetch 成 blob（同源，实测 <0.5s，桌面端媒体管线
  // 慢的机器也能秒起）。旧片段继续在前层播，等后层 playing 再交叉淡入。
  useEffect(() => {
    if (shownRef.current === src || wantRef.current === src) return
    wantRef.current = src
    let alive = true
    void clipMediaUrl(src).then((url) => {
      if (!alive) return
      const back = flip(frontRef.current)
      slotSrcRef.current[back] = src
      setSlots((prev) => ({ ...prev, [back]: url }))
    })
    return () => { alive = false }
  }, [src])

  // 后层就绪 → 起播；playing 事件里再把它翻到前层（见 handlePlaying）。
  useEffect(() => {
    const back = flip(frontRef.current)
    const media = slots[back]
    const v = (back === 'a' ? aRef : bRef).current
    if (!media || !v) return
    try {
      v.load()
      if (reduce) {
        v.pause()
        v.currentTime = 0.5
        frontRef.current = back
        shownRef.current = slotSrcRef.current[back]
        setFront(back)
        return
      }
      const p = v.play()
      if (p && typeof p.catch === 'function') p.catch(() => {})
    } catch {
      /* 自动播放被策略拦下时等用户手势；前层保持可见，不闪黑 */
    }
  }, [slots, reduce])

  const handlePlaying = (slot: Slot) => {
    if (frontRef.current === slot) return
    // 旧层停在最后一帧当残影，CSS opacity 0.22s 完成交叉淡入。
    try {
      (slot === 'a' ? bRef : aRef).current?.pause()
    } catch {
      /* jsdom / 未解码 */
    }
    frontRef.current = slot
    shownRef.current = slotSrcRef.current[slot]
    setFront(slot)
  }

  useEffect(() => {
    const onVisibility = () => {
      if (reduce) return
      const v = (frontRef.current === 'a' ? aRef : bRef).current
      if (!v) return
      if (document.hidden) v.pause()
      else {
        try {
          const p = v.play()
          if (p && typeof p.catch === 'function') p.catch(() => {})
        } catch {
          /* 同上 */
        }
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [reduce])

  if (failed) {
    // 解码真失败（损坏/不支持）才退到该片段的 v22 缩略图 —— 仍是 13 支之内那一支，
    // 不出现 v21 静图那种「第 14 个动作」。
    return (
      <span
        className="ck12-spr"
        data-testid="cockpit-pose-sprite"
        data-pose={pose}
        data-clip={index}
        data-clip-no={item.no}
        data-source="thumb-fallback"
      >
        <img src={item.thumb} alt="汐音" draggable={false} />
      </span>
    )
  }

  const layer = (slot: Slot) => (
    <video
      key={slot}
      ref={slot === 'a' ? aRef : bRef}
      className="ck12-mv"
      src={slots[slot] ?? undefined}
      muted
      playsInline
      loop
      preload="auto"
      autoPlay={!reduce}
      aria-hidden="true"
      style={{ opacity: front === slot ? 1 : 0 }}
      onPlaying={() => handlePlaying(slot)}
      onError={() => {
        if (slotSrcRef.current[slot] === src) setFailedSrc(src)
      }}
    />
  )

  return (
    <span
      className="ck12-spr"
      data-testid="cockpit-pose-sprite"
      data-pose={pose}
      data-clip={index}
      data-clip-no={item.no}
      data-batch={item.batch}
      data-live={slots[front] ? 'true' : 'false'}
    >
      {layer('a')}
      {layer('b')}
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
