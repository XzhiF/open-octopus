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
  const startRef = useRef<{ target: HTMLElement; width: number; height: number; direction: ResizeDirection } | null>(null)

  const onStart = (direction: ResizeDirection) => {
    const target = anchorRef.current?.parentElement
    if (!target) return
    const rect = target.getBoundingClientRect()
    target.style.maxWidth = 'none'
    target.style.maxHeight = 'none'
    startRef.current = { target, width: rect.width, height: rect.height, direction }
  }

  const onMove = (dx: number, dy: number) => {
    const start = startRef.current
    if (!start) return
    const { direction } = start
    const widthDelta = direction.includes('e') ? dx : direction.includes('w') ? -dx : 0
    const heightDelta = direction.includes('s') ? dy : direction.includes('n') ? -dy : 0
    const maxWidth = Math.max(minWidth, window.innerWidth - VIEWPORT_PADDING * 2)
    const maxHeight = Math.max(minHeight, window.innerHeight - VIEWPORT_PADDING * 2)
    const width = Math.min(maxWidth, Math.max(minWidth, start.width + widthDelta))
    const height = Math.min(maxHeight, Math.max(minHeight, start.height + heightDelta))
    start.target.style.width = `${Math.round(width)}px`
    start.target.style.height = `${Math.round(height)}px`
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
