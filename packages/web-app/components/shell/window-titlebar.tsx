'use client'

import { useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { Maximize2, Minus, X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface WindowTitlebarProps {
  title: string
  focused: boolean
  canDrag: boolean
  onClose: () => void
  onMinimize: () => void
  onToggleMaximize: () => void
  onDragStart: () => void
  onDragMove: (dx: number, dy: number) => void
  onDragEnd: (dx: number, dy: number) => void
}

export function WindowTitlebar({
  title,
  focused,
  canDrag,
  onClose,
  onMinimize,
  onToggleMaximize,
  onDragStart,
  onDragMove,
  onDragEnd,
}: WindowTitlebarProps) {
  const startRef = useRef<{ x: number; y: number; pointerId: number } | null>(null)
  const offsetRef = useRef({ dx: 0, dy: 0 })

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!canDrag || event.button !== 0) return
    if ((event.target as HTMLElement).closest('[data-no-drag]')) return
    event.preventDefault()
    startRef.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId }
    offsetRef.current = { dx: 0, dy: 0 }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* pointer capture unavailable */
    }
    onDragStart()
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = startRef.current
    if (!start || start.pointerId !== event.pointerId) return
    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    offsetRef.current = { dx, dy }
    onDragMove(dx, dy)
  }

  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!startRef.current) return
    startRef.current = null
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      /* pointer capture unavailable */
    }
    onDragEnd(offsetRef.current.dx, offsetRef.current.dy)
  }

  const handleDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('[data-no-drag]')) return
    onToggleMaximize()
  }

  return (
    <div
      data-window-titlebar
      className={cn(
        'relative flex h-9 shrink-0 select-none items-center border-b-[1.5px] border-pop-bd',
        focused ? 'bg-pop-paper' : 'bg-pop-idle/70',
        canDrag ? 'cursor-grab active:cursor-grabbing' : 'cursor-default',
      )}
      style={{ touchAction: 'none' }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onDoubleClick={handleDoubleClick}
    >
      <div
        className="group/lights flex h-full cursor-default items-center gap-2 pl-3 pr-2"
        data-no-drag
      >
        <button
          type="button"
          aria-label="关闭窗口"
          title="关闭"
          onClick={onClose}
          className={cn(
            'relative grid size-3 cursor-default place-items-center rounded-full border transition-colors before:absolute before:-inset-1 before:rounded-full before:content-[""]',
            focused ? 'border-pop-bd/40 bg-pop-red' : 'border-pop-bd bg-pop-idle',
          )}
        >
          <X className="size-2 text-pop-bg opacity-0 transition-opacity group-hover/lights:opacity-80" />
        </button>
        <button
          type="button"
          aria-label="最小化窗口"
          title="最小化"
          onClick={onMinimize}
          className={cn(
            'relative grid size-3 cursor-default place-items-center rounded-full border transition-colors before:absolute before:-inset-1 before:rounded-full before:content-[""]',
            focused ? 'border-pop-bd/40 bg-pop-amber' : 'border-pop-bd bg-pop-idle',
          )}
        >
          <Minus className="size-2 text-pop-bg opacity-0 transition-opacity group-hover/lights:opacity-80" />
        </button>
        <button
          type="button"
          aria-label="最大化窗口"
          title="最大化 / 还原"
          onClick={onToggleMaximize}
          className={cn(
            'relative grid size-3 cursor-default place-items-center rounded-full border transition-colors before:absolute before:-inset-1 before:rounded-full before:content-[""]',
            focused ? 'border-pop-bd/40 bg-pop-green' : 'border-pop-bd bg-pop-idle',
          )}
        >
          <Maximize2 className="size-1.5 text-pop-bg opacity-0 transition-opacity group-hover/lights:opacity-80" />
        </button>
      </div>

      <div className="pointer-events-none absolute inset-x-0 flex items-center justify-center px-16">
        <span
          className={cn(
            'max-w-full truncate text-[11px] font-bold',
            focused ? 'text-pop-ink' : 'text-pop-dim',
          )}
        >
          {title}
        </span>
      </div>
    </div>
  )
}
