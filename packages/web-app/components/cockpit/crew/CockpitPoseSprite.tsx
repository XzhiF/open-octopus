'use client'

// v22（design 33 §3）：汐音立绘 = **纯视频**。
//
//   · 片段由 `clip`（图鉴点击精确到段）或 `pose`（mood / 动作姿态）决定；
//     有 clip 用 clip，否则 poseClip(pose) 取该姿态的首选片段。
//   · 每个片段都是 768×1152 VP9 alpha WebM（_motion-v22.mjs 统一归一化：
//     人物高 1040 / 脚底 1105 / 躯干中轴 384），所以换段不跳位、比例一致。
//   · `playing` 才淡入（防切段时闪黑）；切段先压回 0。解码失败 → 单帧 pose PNG
//     兜底（仅错误路径，正常全程视频）。
//   · 片段字节先 fetch 成 blob URL 再交给 <video>（clip-blob.ts）：桌面端媒体
//     HTTP 管线在个别机器上 3MB ≈ 18s，blob 本地解码 <20ms；起播前垫同姿态静图，
//     加载慢也不会出现「背景还在、人没了」的透明空档（2026-11-20 用户 #15）。
//   · prefers-reduced-motion：不自动播，停在 0.5s 一帧（仍是视频真源，不是静态图）。
//   · document.hidden 暂停，回来续播，省电且不丢帧。
//
// 粒子层与视频解耦（PoseFX 按 POSE_META.fx 发射），点击/台词手感与 v21 一致。

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import {
  CLIPS,
  POSE_META,
  POSE_SRC,
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

export function CockpitPoseSprite({ pose, clip, reduce }: SpriteProps) {
  const index = Number.isInteger(clip) && (clip as number) >= 0 && (clip as number) < CLIPS.length
    ? (clip as number)
    : poseClip(pose)
  const item = CLIPS[index]
  const src = item.src
  const vidRef = useRef<HTMLVideoElement>(null)
  /** 实际交给 <video> 的地址：片段字节先 fetch 成 blob（见 clip-blob.ts）。
   *  桌面端媒体 HTTP 管线个别机器上极慢（3MB ≈ 18s），换段永远起不来。 */
  const [mediaSrc, setMediaSrc] = useState<string | null>(null)
  /** 只记住「已起播」的地址：换段瞬间 opacity 立即回 0，不用等 effect，避免闪帧。 */
  const [liveSrc, setLiveSrc] = useState<string | null>(null)
  const live = mediaSrc !== null && liveSrc === mediaSrc
  /** 只记住失败的 src：换段后自动重试，不会一次失败就永久退回静图。 */
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const failed = failedSrc === src

  // 片段字节先走 fetch（同源，实测 <0.5s），再挂 blob URL 给 <video>；
  // fetch 失败 / 环境不支持时退回原始 URL，仍是原来的加载路径。
  useEffect(() => {
    let alive = true
    setMediaSrc(null)
    void clipMediaUrl(src).then((url) => {
      if (alive) setMediaSrc(url)
    })
    return () => { alive = false }
  }, [src])

  useEffect(() => {
    const v = vidRef.current
    if (!v || !mediaSrc) return
    if (reduce) {
      try {
        v.pause()
        v.currentTime = 0.5
      } catch {
        /* jsdom / 未解码时忽略 */
      }
      setLiveSrc(mediaSrc)
      return
    }
    try {
      v.load()
      const p = v.play()
      if (p && typeof p.catch === 'function') p.catch(() => {})
    } catch {
      /* 自动播放被策略拦下时等用户手势；opacity 保持 0，不闪黑 */
    }
  }, [mediaSrc, reduce])

  useEffect(() => {
    const onVisibility = () => {
      const v = vidRef.current
      if (!v || reduce) return
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
    return (
      <span
        className="ck12-spr"
        data-testid="cockpit-pose-sprite"
        data-pose={pose}
        data-clip={index}
        data-clip-no={item.no}
        data-source="still-fallback"
      >
        <img src={POSE_SRC[pose]} alt="汐音" draggable={false} />
      </span>
    )
  }

  return (
    <span
      className="ck12-spr"
      data-testid="cockpit-pose-sprite"
      data-pose={pose}
      data-clip={index}
      data-clip-no={item.no}
      data-batch={item.batch}
      data-live={live ? 'true' : 'false'}
    >
      {/* 起播前垫一张同姿态静图：媒体加载慢时也不会出现「背景还在、人没了」的透明空档
          （2026-11-20 用户 #15：桌面端个别动作一直透明）。视频起播后静图立即撤掉。 */}
      {!live && <img src={POSE_SRC[pose]} alt="汐音" draggable={false} />}
      <video
        ref={vidRef}
        className="ck12-mv"
        src={mediaSrc ?? undefined}
        muted
        playsInline
        loop
        preload="auto"
        autoPlay={!reduce}
        aria-hidden="true"
        style={{ opacity: live ? 1 : 0 }}
        onPlaying={() => setLiveSrc(mediaSrc)}
        onError={() => setFailedSrc(src)}
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
