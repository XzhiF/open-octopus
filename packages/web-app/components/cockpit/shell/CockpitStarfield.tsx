'use client'

// 舱窗星野（原型 cockpit-v12.html 的 warp IIFE，逐字移植）：
//   · 300 星 z 投影拖尾 + 230 远景尘埃；prefers-reduced-motion → 130 / 90 近静止；
//   · DPR ≤ 2；document.hidden 暂停；卸载清理 RAF + resize/visibility 监听；
//   · fx.jumpNonce 变化 → 拉线 + 跃迁环（warpflash 用 key 重挂重放动画）；
//   · 调色板从 getComputedStyle(document.body) 的 --ck-a / --ck-b 读，
//     换色后下一帧刷新（父级 CockpitProvider 的 effect 在子 effect 之后写变量）。

import { useEffect, useRef } from 'react'
import { useCockpit } from '@/components/cabin/CockpitProvider'
import { useCockpitState } from '../state/CockpitStateProvider'

type Rgb = [number, number, number]

interface Star {
  x: number
  y: number
  z: number
  tone: number
  a: number
}

interface Dust {
  x: number
  y: number
  a: number
  r: number
}

interface Comet {
  x: number
  y: number
  vx: number
  vy: number
  t: number
  life: number
}

interface Palette {
  a: Rgb
  b: Rgb
  w: Rgb
  d: Rgb
}

interface StarfieldHandle {
  jump(power?: number): void
  refreshPalette(): void
}

const WHITE: Rgb = [222, 234, 255]

function toRgb(value: string): Rgb | null {
  if (!value) return null
  const text = value.trim()
  if (!text) return null
  if (text.startsWith('#')) {
    let hex = text.slice(1)
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('')
    if (hex.length !== 6) return null
    const rgb: Rgb = [
      Number.parseInt(hex.slice(0, 2), 16),
      Number.parseInt(hex.slice(2, 4), 16),
      Number.parseInt(hex.slice(4, 6), 16),
    ]
    return rgb.every(Number.isFinite) ? rgb : null
  }
  const parts = text.match(/\d+/g)
  if (!parts || parts.length < 3) return null
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])]
}

function createStarfield(canvas: HTMLCanvasElement): {
  handle: StarfieldHandle
  destroy: () => void
} {
  const ctx = canvas.getContext('2d')
  if (!ctx || typeof window === 'undefined') {
    return { handle: { jump() {}, refreshPalette() {} }, destroy() {} }
  }
  const context: CanvasRenderingContext2D = ctx

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const starCount = reduce ? 130 : 300
  const dustCount = reduce ? 90 : 230
  const cruise = reduce ? 0.005 : 0.028

  let width = 1
  let height = 1
  let centerX = 0
  let centerY = 0
  let focal = 800
  let dpr = 1
  let speed = cruise
  let target = cruise
  let last = performance.now()
  let flash = 0
  let raf = 0

  const palette: Palette = {
    a: [79, 209, 217],
    b: [167, 139, 250],
    w: WHITE,
    d: [214, 228, 255],
  }

  function refreshPalette() {
    if (typeof document === 'undefined') return
    const styles = getComputedStyle(document.body)
    const a = toRgb(styles.getPropertyValue('--ck-a'))
    const b = toRgb(styles.getPropertyValue('--ck-b'))
    if (a) palette.a = a
    if (b) palette.b = b
    palette.d = palette.w.map((value, index) =>
      Math.round(value * 0.72 + palette.a[index] * 0.28),
    ) as Rgb
  }

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1)
    width = canvas.clientWidth || window.innerWidth
    height = canvas.clientHeight || window.innerHeight
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    centerX = width * 0.5
    centerY = height * 0.44
    focal = Math.min(width, height) * 0.9
  }

  function plant(star: Star, first: boolean) {
    const angle = Math.random() * Math.PI * 2
    const radius = Math.sqrt(Math.random()) * 1.45
    star.x = Math.cos(angle) * radius
    star.y = Math.sin(angle) * radius * 0.8
    if (!first) star.z = 1
    star.tone = Math.random()
    star.a = 0.28 + Math.random() * 0.72
  }

  const stars: Star[] = []
  for (let i = 0; i < starCount; i++) {
    const star: Star = { x: 0, y: 0, z: 0, tone: 0, a: 0 }
    plant(star, true)
    star.z = Math.random() * 0.95 + 0.05
    stars.push(star)
  }

  const dust: Dust[] = []
  for (let i = 0; i < dustCount; i++) {
    dust.push({
      x: Math.random(),
      y: Math.random(),
      a: 0.06 + Math.random() * 0.3,
      r: Math.random() < 0.1 ? 1.3 : 0.7,
    })
  }

  const project = (star: Star, z: number) => ({
    x: centerX + (star.x / z) * focal * 0.42,
    y: centerY + (star.y / z) * focal * 0.42,
  })

  let comet: Comet | null = null
  let cometIn = 7 + Math.random() * 10

  function frame(now: number) {
    raf = requestAnimationFrame(frame)
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000))
    last = now
    speed += (target - speed) * Math.min(1, dt * 3.2)
    target += (cruise - target) * Math.min(1, dt * (flash > 0 ? 0.7 : 1.8))
    if (flash > 0) flash = Math.max(0, flash - dt * 1.8)

    context.clearRect(0, 0, width, height)
    context.globalCompositeOperation = 'lighter'
    context.lineCap = 'round'

    for (const speck of dust) {
      context.fillStyle = `rgba(${palette.d.join(',')},${speck.a.toFixed(3)})`
      context.fillRect(speck.x * width, speck.y * height, speck.r, speck.r)
    }

    for (const star of stars) {
      const previousZ = star.z
      star.z -= speed * dt * 1.7
      if (star.z <= 0.035) {
        plant(star, false)
        continue
      }
      const from = project(star, previousZ)
      const to = project(star, star.z)
      const dx = to.x - from.x
      const dy = to.y - from.y
      const length = Math.hypot(dx, dy)
      if (length > 190) {
        const scale = 190 / length
        from.x = to.x - dx * scale
        from.y = to.y - dy * scale
      }
      const near = 1 - star.z
      const alpha = Math.min(1, star.a * (0.12 + near * 1.3))
      const lineWidth = 0.6 + near * 2.1
      const color = star.tone > 0.87 ? palette.b : star.tone > 0.62 ? palette.a : palette.w
      context.strokeStyle = `rgba(${color[0]},${color[1]},${color[2]},${alpha.toFixed(3)})`
      context.lineWidth = lineWidth
      context.beginPath()
      context.moveTo(from.x, from.y)
      context.lineTo(to.x, to.y)
      context.stroke()
    }

    // 偶尔划过一颗彗星：跟着色调走（7–17s 一颗）。
    cometIn -= dt
    if (!comet && cometIn <= 0) {
      const fromLeft = Math.random() < 0.55
      comet = {
        x: fromLeft ? -60 : width + 60,
        y: height * (0.08 + Math.random() * 0.42),
        vx: (fromLeft ? 1 : -1) * width * (0.55 + Math.random() * 0.3),
        vy: height * (0.16 + Math.random() * 0.16),
        t: 0,
        life: 1.3 + Math.random() * 0.7,
      }
    }
    if (comet) {
      comet.t += dt
      comet.x += comet.vx * dt
      comet.y += comet.vy * dt
      const progress = comet.t / comet.life
      if (progress >= 1 || comet.x < -160 || comet.x > width + 160) {
        comet = null
        cometIn = 7 + Math.random() * 10
      } else {
        const alpha = Math.sin(Math.PI * progress) * 0.9
        const velocity = Math.hypot(comet.vx, comet.vy) || 1
        const tail = 110 + 100 * Math.sin(Math.PI * progress)
        const tailX = comet.x - (comet.vx / velocity) * tail
        const tailY = comet.y - (comet.vy / velocity) * tail
        const gradient = context.createLinearGradient(tailX, tailY, comet.x, comet.y)
        gradient.addColorStop(0, `rgba(${palette.a.join(',')},0)`)
        gradient.addColorStop(0.72, `rgba(${palette.a.join(',')},${(alpha * 0.5).toFixed(3)})`)
        gradient.addColorStop(1, `rgba(255,255,255,${alpha.toFixed(3)})`)
        context.strokeStyle = gradient
        context.lineWidth = 1.6
        context.beginPath()
        context.moveTo(tailX, tailY)
        context.lineTo(comet.x, comet.y)
        context.stroke()
        context.fillStyle = `rgba(255,255,255,${(alpha * 0.9).toFixed(3)})`
        context.beginPath()
        context.arc(comet.x, comet.y, 1.2, 0, 6.283)
        context.fill()
      }
    }

    context.globalCompositeOperation = 'source-over'
    if (flash > 0.01) {
      const radius = Math.min(width, height) * (0.58 - flash * 0.1)
      const gradient = context.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius)
      gradient.addColorStop(0, `rgba(${palette.a.join(',')},${(0.15 * flash).toFixed(3)})`)
      gradient.addColorStop(0.55, `rgba(${palette.b.join(',')},${(0.05 * flash).toFixed(3)})`)
      gradient.addColorStop(1, 'rgba(0,0,0,0)')
      context.fillStyle = gradient
      context.fillRect(0, 0, width, height)
    }
  }

  function start() {
    if (raf) return
    last = performance.now()
    raf = requestAnimationFrame(frame)
  }

  function stop() {
    if (!raf) return
    cancelAnimationFrame(raf)
    raf = 0
  }

  const onVisibilityChange = () => {
    if (document.hidden) stop()
    else start()
  }

  refreshPalette()
  resize()
  window.addEventListener('resize', resize)
  document.addEventListener('visibilitychange', onVisibilityChange)
  if (!document.hidden) start()

  return {
    handle: {
      jump(power = 1) {
        flash = Math.min(1.6, flash + power)
        target = Math.max(target, cruise + 0.55 * power)
      },
      refreshPalette,
    },
    destroy() {
      stop()
      window.removeEventListener('resize', resize)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    },
  }
}

export function CockpitStarfield() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const handleRef = useRef<StarfieldHandle | null>(null)
  const { prefs } = useCockpit()
  const { fx } = useCockpitState()

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const engine = createStarfield(canvas)
    handleRef.current = engine.handle
    return () => {
      engine.destroy()
      handleRef.current = null
    }
  }, [])

  // 父级 CockpitProvider 在子 effect 之后才把新的 --ck-* 写到 root，
  // 所以延到下一帧再读色板。
  useEffect(() => {
    const id = requestAnimationFrame(() => handleRef.current?.refreshPalette())
    return () => cancelAnimationFrame(id)
  }, [prefs.theme])

  useEffect(() => {
    if (fx.jumpNonce <= 0) return
    handleRef.current?.jump(1)
  }, [fx.jumpNonce])

  return (
    <>
      <canvas ref={canvasRef} className="ck12-starfield" aria-hidden="true" />
      {/* key = nonce：重挂重放跃迁环 + 中心闪光（CSS 动画只跑一次） */}
      <div
        key={fx.jumpNonce}
        className={fx.jumpNonce > 0 ? 'ck12-warpflash on' : 'ck12-warpflash'}
        aria-hidden="true"
      />
    </>
  )
}
