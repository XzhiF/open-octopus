'use client'

import { useRef } from 'react'
import { WindowResizeHandles } from '@/components/shell/window-resize-handles'
import type { ResizeDirection } from '@/lib/window-geometry'

interface DialogResizeHandlesProps {
  minWidth?: number
  minHeight?: number
  className?: string
}

const VIEWPORT_PADDING = 16

/**
 * Eight-way resize for any floating box. It mutates the parent element's
 * width/height in place (works for Radix Dialog/AlertDialog and raw panels).
 */
export function DialogResizeHandles({
  minWidth = 280,
  minHeight = 140,
  className,
}: DialogResizeHandlesProps) {
  const anchorRef = useRef<HTMLDivElement>(null)
  const startRef = useRef<{
    target: HTMLElement
    width: number
    height: number
    direction: ResizeDirection
    left: number
    top: number
  } | null>(null)

  const onStart = (direction: ResizeDirection) => {
    const target = anchorRef.current?.parentElement
    if (!target) return
    const rect = target.getBoundingClientRect()
    // Radix 的弹窗是 fixed + left/top 50% + translate(-50%,-50%) 居中的：
    // 只改 width/height 会让框子绕中心双向长 —— 拖西/北边时指针在边上却
    // 拉着对边一起动，手感等同于「不能调整大小」（2026-10-30 用户反馈）。
    // 起手把「居中」换成实数 left/top 并撤掉位移，之后按方向钉住对边。
    // 注意位移要用 translate 撤：Tailwind v4 的 translate-x-[-50%] 编译成
    // `translate: var(--tw-translate-x) var(--tw-translate-y)`（独立 CSS 属性，
    // 不是 transform）。只写 transform:none 的话 -50% 仍在，且它按元素自身尺寸
    // 解析 —— 一改宽高框子就整体跳位，手感等同「拖不动」（2026-10-30 实测）。
    target.style.left = `${rect.left}px`
    target.style.top = `${rect.top}px`
    target.style.translate = 'none'
    target.style.transform = 'none'
    target.style.maxWidth = 'none'
    target.style.maxHeight = 'none'
    startRef.current = { target, width: rect.width, height: rect.height, direction, left: rect.left, top: rect.top }
  }

  const onMove = (dx: number, dy: number) => {
    const start = startRef.current
    if (!start) return
    const { direction, target } = start
    const right = start.left + start.width
    const bottom = start.top + start.height
    const widthDelta = direction.includes('e') ? dx : direction.includes('w') ? -dx : 0
    const heightDelta = direction.includes('s') ? dy : direction.includes('n') ? -dy : 0
    // 拖西/北边时对边（东/南）是锚：先用锚点削掉越界量，再套上下限，
    // 这样框不会被推出视口外再也抓不回来。东/南边同理 —— 上限按「锚住的那条
    // 对边」算，而不是按整幅视口，否则靠左/靠上的大框一拖就溢出视口边缘。
    const anchorW = direction.includes('w')
      ? right - VIEWPORT_PADDING                        // 东边钉住 → 西边最多拉到视口左沿留白
      : window.innerWidth - VIEWPORT_PADDING - start.left
    const anchorH = direction.includes('n')
      ? bottom - VIEWPORT_PADDING
      : window.innerHeight - VIEWPORT_PADDING - start.top
    let width = Math.min(start.width + widthDelta, anchorW)
    let height = Math.min(start.height + heightDelta, anchorH)
    const maxWidth = Math.max(minWidth, window.innerWidth - VIEWPORT_PADDING * 2)
    const maxHeight = Math.max(minHeight, window.innerHeight - VIEWPORT_PADDING * 2)
    width = Math.min(maxWidth, Math.max(minWidth, width))
    height = Math.min(maxHeight, Math.max(minHeight, height))
    target.style.width = `${Math.round(width)}px`
    target.style.height = `${Math.round(height)}px`
    if (direction.includes('w')) target.style.left = `${Math.round(right - width)}px`
    if (direction.includes('n')) target.style.top = `${Math.round(bottom - height)}px`
  }

  const onEnd = () => {
    startRef.current = null
  }

  return (
    <div ref={anchorRef} className={className}>
      <WindowResizeHandles onStart={onStart} onMove={onMove} onEnd={onEnd} />
    </div>
  )
}
