'use client'

// v21（design 31 §3.4.7）· 舱景层：三幕桥景 + crossfade + 视差。
//
//   · 首屏固定第一幕（舰桥·日落）；跃迁（travel）切下一幕，0.9s 淡入淡出。
//   · 只加载当前幕；空闲时预取下一幕（单张 ~3MB，移动端不预取）。
//   · 指针视差 ±12/8px，prefers-reduced-motion 关闭。
//   · 星流/跃迁环由 CockpitStarfield 订阅 fx.jumpNonce 负责，本层不重复画。
//   · 场景色罩（grade）与颗粒（grain）逐字照原型，压住照片亮度、统一暗色调。
//
// 卸载/换幕的旧图保留一个过渡槽，1s 后移除，避免淡出被截断。

import { useEffect, useRef, useState } from 'react'
import { SCENES } from './scene-model'
import { useCockpitState } from '../state/CockpitStateProvider'

const FADE_MS = 900

export function CockpitScene() {
  const { sceneIndex } = useCockpitState()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [idx, setIdx] = useState(0)
  const [prev, setPrev] = useState<number | null>(null)

  // 切幕：等目标图解码完成再翻面，避免淡入到一半闪白。
  useEffect(() => {
    if (sceneIndex === idx) return
    const url = SCENES[sceneIndex]?.file
    if (!url) return
    let alive = true
    const commit = () => {
      if (!alive) return
      setPrev(idx)
      setIdx(sceneIndex)
    }
    const img = new Image()
    img.src = url
    if (typeof img.decode === 'function') img.decode().then(commit).catch(commit)
    else { img.onload = commit; img.onerror = commit }
    return () => { alive = false }
  }, [sceneIndex, idx])

  // 淡出槽在过渡结束后移除。
  useEffect(() => {
    if (prev === null) return
    const timer = window.setTimeout(() => setPrev(null), FADE_MS + 120)
    return () => window.clearTimeout(timer)
  }, [prev])

  // 空闲预取下一幕（跳过后台标签页）。
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (window.matchMedia('(max-width: 900px)').matches) return
    const next = SCENES[(sceneIndex + 1) % SCENES.length]
    const run = () => {
      const img = new Image()
      img.src = next.file
    }
    const ric = (window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback
    if (ric) {
      const id = ric(run, { timeout: 4000 })
      const cancel = (window as Window & { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback
      return () => { if (cancel) cancel(id) }
    }
    const timer = window.setTimeout(run, 2500)
    return () => window.clearTimeout(timer)
  }, [sceneIndex])

  // 指针视差（原型 pointermove ±12/8）。
  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof window === 'undefined') return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const onMove = (event: PointerEvent) => {
      const dx = (event.clientX / window.innerWidth - 0.5) * -12
      const dy = (event.clientY / window.innerHeight - 0.5) * -8
      el.style.transform = `translate3d(${dx.toFixed(2)}px, ${dy.toFixed(2)}px, 0)`
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    return () => window.removeEventListener('pointermove', onMove)
  }, [])

  return (
    <div className="ck12-scene" ref={rootRef} aria-hidden="true" data-testid="cockpit-scene">
      {prev !== null && (
        <img
          className="ck12-scene-img"
          data-scene="out"
          src={SCENES[prev].file}
          alt=""
          draggable={false}
          decoding="async"
        />
      )}
      <img
        key={idx}
        className="ck12-scene-img"
        data-scene="in"
        src={SCENES[idx].file}
        alt=""
        draggable={false}
        decoding="async"
      />
      <div className="ck12-grade" />
      <div className="ck12-grain" />
    </div>
  )
}
