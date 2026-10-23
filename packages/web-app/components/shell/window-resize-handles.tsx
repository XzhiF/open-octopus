'use client'

import { useRef, type PointerEvent as ReactPointerEvent } from 'react'
import type { ResizeDirection } from '@/lib/window-geometry'

const HANDLES: Array<{ dir: ResizeDirection; className: string }> = [
  { dir: 'n', className: 'left-3 right-3 top-0 h-1.5 cursor-ns-resize' },
  { dir: 's', className: 'left-3 right-3 bottom-0 h-1.5 cursor-ns-resize' },
  { dir: 'w', className: 'top-3 bottom-3 left-0 w-1.5 cursor-ew-resize' },
  { dir: 'e', className: 'top-3 bottom-3 right-0 w-1.5 cursor-ew-resize' },
  { dir: 'nw', className: 'left-0 top-0 size-3 cursor-nwse-resize' },
  { dir: 'ne', className: 'right-0 top-0 size-3 cursor-nesw-resize' },
  { dir: 'sw', className: 'left-0 bottom-0 size-3 cursor-nesw-resize' },
  { dir: 'se', className: 'right-0 bottom-0 size-3 cursor-nwse-resize' },
]

interface WindowResizeHandlesProps {
  onStart: (direction: ResizeDirection) => void
  onMove: (dx: number, dy: number) => void
  onEnd: (dx: number, dy: number) => void
}

export function WindowResizeHandles({ onStart, onMove, onEnd }: WindowResizeHandlesProps) {
  const startRef = useRef<{ x: number; y: number; pointerId: number } | null>(null)
  const offsetRef = useRef({ dx: 0, dy: 0 })

  const begin = (direction: ResizeDirection) => (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    startRef.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId }
    offsetRef.current = { dx: 0, dy: 0 }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* pointer capture unavailable */
    }
    onStart(direction)
  }

  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = startRef.current
    if (!start || start.pointerId !== event.pointerId) return
    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    offsetRef.current = { dx, dy }
    onMove(dx, dy)
  }

  const finish = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!startRef.current) return
    startRef.current = null
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      /* pointer capture unavailable */
    }
    onEnd(offsetRef.current.dx, offsetRef.current.dy)
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-20">
      {HANDLES.map((handle) => (
        <div
          key={handle.dir}
          data-resize-dir={handle.dir}
          aria-hidden
          className={`pointer-events-auto absolute ${handle.className}`}
          onPointerDown={begin(handle.dir)}
          onPointerMove={move}
          onPointerUp={finish}
          onPointerCancel={finish}
        />
      ))}
    </div>
  )
}
