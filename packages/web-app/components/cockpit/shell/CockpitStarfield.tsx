'use client'

// 舱窗星野（原型 cockpit-v12.html 的 warp IIFE，逐字移植）：
//   · 300 星 z 投影拖尾 + 230 远景尘埃；prefers-reduced-motion → 130 / 90 近静止；
//   · DPR ≤ 1.5；canvas 尺寸由 ResizeObserver 跟随自身 CSS 盒（首帧布局定稿也补算），
//     document.hidden 暂停；卸载清理 RAF + ResizeObserver / resize / visibility 监听；
//   · 帧率两档（设置 → 性能）：默认 30fps，可选 60fps；
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
  /** 设置 → 性能：true = 60fps，false = 30fps（减动效下 15fps）。 */
  setFrameRate(high: boolean): void
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
    return { handle: { jump() {}, refreshPalette() {}, setFrameRate() {} }, destroy() {} }
  }
  const context: CanvasRenderingContext2D = ctx

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  // 2026-11-16 性能：星野是常驻全屏 canvas，旧 Intel 驱动上 300 星 × 60fps
  // 会和聊天流式渲染抢帧。降到 200 星 / 150 尘，默认以 ~30fps 渲染（巡航本身
  // 很慢，30fps 肉眼无差），DPR 上限压到 1.5，省一半以上像素填充。
  // 2026-11-23：独显功耗放开，设置 → 性能 可切到 60fps（不改星数）。
  const starCount = reduce ? 90 : 200
  const dustCount = reduce ? 60 : 150
  const cruise = reduce ? 0.005 : 0.028
  const baseFrameMs = reduce ? 1000 / 15 : 1000 / 30
  const highFrameMs = 1000 / 60
  let frameMs = baseFrameMs

  let width = 1
  let height = 1
  let centerX = 0
  let centerY = 0
  let focal = 800
  let dpr = 1
  let speed = cruise
  let target = cruise
  let last = performance.now()
  /** 下一帧的目标时刻：按帧间隔累加，而不是「距上一帧 ≥ 间隔」——144Hz 屏上
   *  后者凑不齐整数倍会掉到 ~48fps。0 = 首帧 / 刚切档，立即渲染并对齐。 */
  let nextAt = 0
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

  // 几何以 canvas 自己的 CSS 盒为准，并由 ResizeObserver 驱动：挂载那一刻骨架屏
  // 还没退场，clientWidth/Height 量到的是旧值（实测背存储 1903×473、CSS 盒
  // 1522×755，星野被纵向拉伸）；只靠 window.resize 的话布局定稿后再也不会重算。
  // ResizeObserver 在首次布局完成时会回调一次，正好补上这个缺口。
  function resize() {
    const nextWidth = Math.round(canvas.clientWidth || window.innerWidth)
    const nextHeight = Math.round(canvas.clientHeight || window.innerHeight)
    // 0×0（面板收起 / 窗口最小化）时保留上一帧的几何，别把画布清成 1px。
    if (nextWidth < 2 || nextHeight < 2) return
    // DPR 上限 1.5：全屏 canvas 在 2x 屏上像素量翻倍，旧 GPU 吃不消。
    const nextDpr = Math.min(1.5, window.devicePixelRatio || 1)
    const pixelWidth = Math.round(nextWidth * nextDpr)
    const pixelHeight = Math.round(nextHeight * nextDpr)
    // 改 canvas.width/height 会清空画布并重置变换，尺寸没变就别碰。
    if (width === nextWidth && height === nextHeight && canvas.width === pixelWidth && canvas.height === pixelHeight) {
      return
    }
    dpr = nextDpr
    width = nextWidth
    height = nextHeight
    canvas.width = pixelWidth
    canvas.height = pixelHeight
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
    // 帧率上限（默认 30fps：慢速星野够用，省下的合成时间留给流式文字）。
    if (now < nextAt) return
    nextAt += frameMs
    // 掉帧 / 切后台回来落后超过一帧：重新对齐，别连发补帧。
    if (nextAt < now) nextAt = now + frameMs
    // 拖到缩放不同的屏幕 / 改系统缩放时 CSS 盒不变、ResizeObserver 不回调，
    // 这里每帧比对一次 DPR 兜底（一次浮点比较）。
    if (Math.min(1.5, window.devicePixelRatio || 1) !== dpr) resize()
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
    nextAt = 0
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
  // 画布尺寸跟着自己的 CSS 盒走：首帧布局定稿、窗口 / 侧栏 / 缩放变化都能收到。
  const resizeObserver =
    typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => resize())
  resizeObserver?.observe(canvas)
  // window.resize 兜底（部分环境下 RO 对纯窗口尺寸变化回调有延迟）。
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
      setFrameRate(high: boolean) {
        frameMs = high ? highFrameMs : baseFrameMs
        // 立即按新档位出下一帧，再重新对齐节奏。
        nextAt = 0
      },
    },
    destroy() {
      stop()
      resizeObserver?.disconnect()
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

  // 帧率档位（设置 → 性能）：挂载和切档各跑一次，新建的引擎也会立刻对齐。
  useEffect(() => {
    handleRef.current?.setFrameRate(prefs.frameRate === 'high')
  }, [prefs.frameRate])

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
