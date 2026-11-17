'use client'

// 汐音的登场（plan §6.5 / design 17 §5）：
//   · 286×330 大立绘，mix-blend screen + 椭圆遮罩吃掉黑底方框；
//   · 进页：升起 18px + 淡入、光圈扩散一次、7 颗星屑、台词逐字；
//   · 表情按画面挑（不用 moodPortrait —— 文件名字与画面错位，见 design/14 §10）。
//
// 生成一页「她在那儿」的舞台，不是角落里的 84px 小徽章。

import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

export type XiyinMood = 'greet' | 'listen' | 'think' | 'done'

/** 按画面挑图（不是按文件名猜）：
 *  thinking = 双手交叠 + 星屑（最适合「开个新舱」）
 *  happy    = 安静的笑（听你说）
 *  alert    = 托腮 + 问号（想事情）
 *  working  = 眨眼握拳（开好了） */
export const XIYIN_FACE: Record<XiyinMood, string> = {
  greet: '/cabin/xiyin-thinking.png',
  listen: '/cabin/xiyin-happy.png',
  think: '/cabin/xiyin-alert.png',
  done: '/cabin/xiyin-working.png',
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

interface Spark {
  id: number
  left: number
  top: number
  dx: number
  dy: number
  delay: number
}

export interface XiyinStageProps {
  mood: XiyinMood
  /** 台词（逐字打出）。 */
  line: string
  /** 第二行说明。 */
  subline?: string
  /** 每次 +1 撒一把星屑。 */
  sparkTick?: number
  sparkCount?: number
  /** 每次 +1 轻跳一下。 */
  nudgeTick?: number
  /** 完成态的小尺寸立绘（原型舱内 200×230）；新建页保持默认。 */
  compact?: boolean
  className?: string
  children?: React.ReactNode
}

let sparkSeq = 0

export function XiyinStage({
  mood,
  line,
  subline,
  sparkTick = 0,
  sparkCount = 7,
  nudgeTick = 0,
  compact = false,
  className,
  children,
}: XiyinStageProps) {
  const [typed, setTyped] = useState('')
  const [typing, setTyping] = useState(false)
  const [intro, setIntro] = useState(true)
  const [sparks, setSparks] = useState<Spark[]>([])
  const firstSparkRef = useRef(true)
  const firstNudgeRef = useRef(true)

  // 登场动画只跑一次（原型 1.6s 后摘掉 intro）。
  useEffect(() => {
    const timer = window.setTimeout(() => setIntro(false), 1600)
    return () => window.clearTimeout(timer)
  }, [])

  // 台词逐字（reduced-motion 直接给全文）。
  useEffect(() => {
    if (!line) {
      setTyped('')
      setTyping(false)
      return
    }
    if (prefersReducedMotion()) {
      setTyped(line)
      setTyping(false)
      return
    }
    setTyped('')
    setTyping(true)
    let i = 0
    const timer = window.setInterval(() => {
      i += 1
      setTyped(line.slice(0, i))
      if (i >= line.length) {
        window.clearInterval(timer)
        setTyping(false)
      }
    }, 26)
    return () => window.clearInterval(timer)
  }, [line])

  // 星屑
  useEffect(() => {
    if (firstSparkRef.current) {
      firstSparkRef.current = false
      return
    }
    if (prefersReducedMotion()) return
    const batch: Spark[] = Array.from({ length: sparkCount }, () => ({
      id: ++sparkSeq,
      left: 20 + Math.random() * 240,
      top: 130 + Math.random() * 150,
      dx: Math.random() * 80 - 40,
      dy: -50 - Math.random() * 70,
      delay: 0,
    })).map((s, i) => ({ ...s, delay: i * 45 }))
    setSparks((prev) => [...prev, ...batch])
    const timer = window.setTimeout(() => {
      const ids = new Set(batch.map((s) => s.id))
      setSparks((prev) => prev.filter((s) => !ids.has(s.id)))
    }, 2400)
    return () => window.clearTimeout(timer)
  }, [sparkTick, sparkCount])

  const [nudge, setNudge] = useState(false)
  useEffect(() => {
    if (firstNudgeRef.current) {
      firstNudgeRef.current = false
      return
    }
    setNudge(true)
    const timer = window.setTimeout(() => setNudge(false), 520)
    return () => window.clearTimeout(timer)
  }, [nudgeTick])

  return (
    <div className={cn('cc-stage', className)} data-intro={intro ? 'true' : 'false'} data-testid="xiyin-stage">
      <div
        className="cc-crew"
        data-nudge={nudge ? 'true' : 'false'}
        style={compact ? { width: 200, height: 230 } : undefined}
      >
        <div className="cc-aura" aria-hidden />
        <span className="cc-ring" aria-hidden />
        <img
          className="cc-crew-img"
          src={XIYIN_FACE[mood]}
          alt="汐音"
          draggable={false}
          data-face={mood}
        />
        <div className="cc-sparks" aria-hidden>
          {sparks.map((s) => (
            <span
              key={s.id}
              className="cc-spark"
              style={{
                left: s.left,
                top: s.top,
                animationDelay: `${s.delay}ms`,
                ['--dx' as string]: `${s.dx}px`,
                ['--dy' as string]: `${s.dy}px`,
              }}
            >
              ✦
            </span>
          ))}
        </div>
      </div>

      <div className="cc-bubble" data-typing={typing ? 'true' : 'false'} data-testid="xiyin-line">
        {typed}
      </div>
      {subline ? <div className="cc-subline" data-testid="xiyin-subline">{subline}</div> : null}

      {children}
    </div>
  )
}