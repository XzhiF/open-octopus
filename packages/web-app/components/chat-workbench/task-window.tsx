'use client'

import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import {
  bleedMaximizeRect,
  clampRect,
  resizeRect,
  type Rect,
  type ResizeDirection,
  type Size,
} from '@/lib/window-geometry'
import { WindowTitlebar } from '@/components/shell/window-titlebar'
import { WindowResizeHandles } from '@/components/shell/window-resize-handles'
import { useEscapeClose } from '@/lib/escape-stack'
import type { TaskWindowRecord } from './task-window-types'

interface TaskWindowProps {
  record: TaskWindowRecord
  title: string
  container: Size
  /** 窗口层容器左边缘在视口里的 x —— 最大化时向左出血盖住任务栏（见 bleedMaximizeRect）。 */
  bleedLeft?: number
  focused: boolean
  zIndex: number
  /** 验收窗用 paper：亮纸外壳，与窗内的三步验收台同一张纸。 */
  tone?: 'pop' | 'paper'
  onChange: (patch: Partial<TaskWindowRecord>) => void
  onClose: () => void
  onFocus: () => void
  children: ReactNode
}

/** Task-scoped floating window inside the chat workbench (not a shell app window). */
export function TaskWindow({
  record,
  title,
  container,
  bleedLeft = 0,
  focused,
  zIndex,
  tone = 'pop',
  onChange,
  onClose,
  onFocus,
  children,
}: TaskWindowProps) {
  const rect = record.maximized ? bleedMaximizeRect(container, bleedLeft) : clampRect(record.rect, container)
  const positionerRef = useRef<HTMLDivElement>(null)
  const dragLayerRef = useRef<HTMLDivElement>(null)
  const resizeStartRef = useRef<{ rect: Rect; direction: ResizeDirection } | null>(null)
  const resizeLastRef = useRef<Rect | null>(null)

  // Esc closes only the focused task window (top-most custom layer).
  useEscapeClose(focused, onClose, 20)

  const handleDragStart = () => {
    const layer = dragLayerRef.current
    if (!layer) return
    layer.style.transition = 'none'
    layer.style.willChange = 'transform'
  }

  const handleDragMove = (dx: number, dy: number) => {
    if (dragLayerRef.current) {
      dragLayerRef.current.style.transform = `translate3d(${dx}px, ${dy}px, 0)`
    }
  }

  const handleDragEnd = (dx: number, dy: number) => {
    const layer = dragLayerRef.current
    if (layer) {
      layer.style.transform = ''
      layer.style.willChange = ''
      layer.style.transition = ''
    }
    const next = clampRect({ ...rect, x: rect.x + dx, y: rect.y + dy }, container)
    if (positionerRef.current) {
      positionerRef.current.style.left = `${next.x}px`
      positionerRef.current.style.top = `${next.y}px`
    }
    onChange({ rect: next })
  }

  const handleResizeStart = (direction: ResizeDirection) => {
    resizeStartRef.current = { rect, direction }
    resizeLastRef.current = rect
  }

  const handleResizeMove = (dx: number, dy: number) => {
    const start = resizeStartRef.current
    if (!start) return
    const next = resizeRect(start.rect, start.direction, dx, dy, container)
    resizeLastRef.current = next
    const element = positionerRef.current
    if (element) {
      element.style.left = `${next.x}px`
      element.style.top = `${next.y}px`
      element.style.width = `${next.w}px`
      element.style.height = `${next.h}px`
    }
  }

  const handleResizeEnd = () => {
    const next = resizeLastRef.current
    resizeStartRef.current = null
    if (next) onChange({ rect: next })
  }

  const toggleMaximize = () => {
    if (record.maximized) {
      onChange({
        maximized: false,
        rect: clampRect(record.restoreRect ?? record.rect, container),
        restoreRect: null,
      })
      return
    }
    onChange({ maximized: true, restoreRect: rect })
  }

  return (
    <div
      ref={positionerRef}
      data-task-window={record.module}
      className="pointer-events-auto absolute"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex }}
      onPointerDownCapture={onFocus}
    >
      <div ref={dragLayerRef} className="h-full w-full">
        <div
          className={cn(
            'flex h-full w-full flex-col overflow-hidden rounded-xl border-[1.5px]',
            tone === 'paper'
              ? 'border-[#dfe6dd] bg-[#fdfefb]'
              : 'border-pop-bd bg-pop-paper',
            focused
              ? tone === 'paper'
                ? 'shadow-[0_42px_100px_-46px_rgba(22,38,31,0.6)]'
                : 'shadow-pop-lg'
              : tone === 'paper'
                ? 'shadow-[0_20px_50px_-40px_rgba(22,38,31,0.45)]'
                : 'shadow-pop',
          )}
        >
          <WindowTitlebar
            title={title}
            focused={focused}
            tone={tone}
            canDrag={!record.maximized}
            onClose={onClose}
            onMinimize={() => onChange({ minimized: true })}
            onToggleMaximize={toggleMaximize}
            onDragStart={handleDragStart}
            onDragMove={handleDragMove}
            onDragEnd={handleDragEnd}
          />
          <div className="relative min-h-0 flex-1 overflow-hidden">{children}</div>
        </div>
      </div>

      {focused && !record.maximized && (
        <WindowResizeHandles
          onStart={handleResizeStart}
          onMove={handleResizeMove}
          onEnd={handleResizeEnd}
        />
      )}
    </div>
  )
}
