'use client'

// 对话左栏宽度：桌面对话（ChatTab）与舱内对话（CabinChatHost）共用一套
// 几何与持久化键 —— 用户在任一视图拖出来的宽度，切到另一视图仍是同一条线。
//
// 2026-11-14 用户要求：中间分隔线可拖；左栏必须有最大宽度，越过就停在边界。

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'

export const SIDEBAR_WIDTH_KEY = 'octopus.chat.sidebarWidth.v1'
export const SIDEBAR_DEFAULT = 236
export const SIDEBAR_MIN = 200
export const SIDEBAR_MAX = 380

export function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(width)))
}

export interface SidebarResizeHandlers {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void
  onDoubleClick: () => void
}

export interface SidebarWidth {
  width: number
  resizing: boolean
  resizeHandlers: SidebarResizeHandlers
}

export function useSidebarWidth(): SidebarWidth {
  const [width, setWidth] = useState(() => {
    if (typeof window === 'undefined') return SIDEBAR_DEFAULT
    const saved = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY))
    return Number.isFinite(saved) && saved > 0 ? clampSidebarWidth(saved) : SIDEBAR_DEFAULT
  })
  const [resizing, setResizing] = useState(false)
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width))
    } catch {
      /* storage unavailable */
    }
  }, [width])

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    event.preventDefault()
    dragRef.current = { startX: event.clientX, startWidth: width }
    setResizing(true)
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* pointer capture unavailable */
    }
  }, [width])

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current
    if (!drag) return
    setWidth(clampSidebarWidth(drag.startWidth + event.clientX - drag.startX))
  }, [])

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!dragRef.current) return
    dragRef.current = null
    setResizing(false)
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      /* pointer capture unavailable */
    }
  }, [])

  const onDoubleClick = useCallback(() => setWidth(SIDEBAR_DEFAULT), [])

  return { width, resizing, resizeHandlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onDoubleClick } }
}
