'use client'

// 问答窗挂载层（design 26 §3.3 / §3.7）：
//   · portal 到 body，层级由共享 z 栈（nextZ）写进每扇窗；
//   · 落点固定：cockpit 贴编队右缘、classic 贴编队左缘 —— 不跟行、不按行缩高；
//   · 多开只沿 x 错开 32px（由 askRect 计算），y 固定；
//   · resize 只夹 x（不改 y、不改高）；
//   · Esc：cockpit 注册到 CockpitLayerStack（priority 75：压过编队抽屉 70、
//     低于浮层/模态 100）；classic 用捕获阶段 keydown，尊重 defaultPrevented。

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CockpitLayerApi } from '@/components/cockpit/state/cockpit-state'
import { AskWindow } from './ask-window'
import { useAskWindows } from './ask-windows-provider'
import { askRect, clampLeft, windowWidthFor, type AskPlacement } from './ask-window-model'
import './ask-window.css'

export type AskWindowMode = 'cockpit' | 'classic'

/** cockpit 编队栏右缘：≤1120 是抽屉，未展开时按「无编队」处理（x 取 10）。 */
function readRailRight(): number | null {
  if (typeof document === 'undefined') return null
  const rail = document.getElementById('ck12-fleet-rail')
  if (!rail) return null
  if (window.innerWidth <= 1120 && !rail.classList.contains('is-open')) return null
  const rect = rail.getBoundingClientRect()
  return rect.width > 0 ? rect.right : null
}

/** classic 编队面板左缘：面板只在有行时挂载，≤1320 由 CSS 隐藏。 */
function readFleetLeft(): number | null {
  if (typeof document === 'undefined') return null
  const fleet = document.querySelector<HTMLElement>('.ck-fleet')
  if (!fleet) return null
  const rect = fleet.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0 ? rect.left : null
}

export interface AskWindowLayerProps {
  mode: AskWindowMode
  /** cockpit 传入 CockpitLayerStack，让 Esc 与其他层统一排队。 */
  escLayer?: CockpitLayerApi
}

export function AskWindowLayer({ mode, escLayer }: AskWindowLayerProps) {
  const { windows, close, focus, topAskId } = useAskWindows()
  const [positions, setPositions] = useState<Record<string, AskPlacement>>({})
  const [mounted, setMounted] = useState(false)
  const positionsRef = useRef<Record<string, AskPlacement>>(positions)
  positionsRef.current = positions

  useEffect(() => setMounted(true), [])

  // 新开的窗算一次固定落点；关掉的窗清理位置。
  useEffect(() => {
    const missing = windows.filter((win) => !positionsRef.current[win.askId])
    const ids = new Set(windows.map((win) => win.askId))
    const stale = Object.keys(positionsRef.current).filter((id) => !ids.has(id))
    if (missing.length === 0 && stale.length === 0) return
    const viewport = { w: window.innerWidth, h: window.innerHeight }
    const railRight = mode === 'cockpit' ? readRailRight() : null
    const fleetLeft = mode === 'classic' ? readFleetLeft() : null
    const added: Record<string, AskPlacement> = {}
    // 槽位 = 已占用落点里的下一个空位：关掉中间一扇再开新的，也不会与现存窗
    // 完全重叠（多开只沿 x 错开 32px 的语义不变）。
    const used = new Set(
      Object.values(positionsRef.current).map((pos) => Math.round(pos.left)),
    )
    let slot = 0
    for (const win of windows) {
      if (positionsRef.current[win.askId]) continue
      let pos = askRect(mode, { railRight, fleetLeft, openCount: slot, viewport })
      while (used.has(Math.round(pos.left)) && slot < 24) {
        slot += 1
        pos = askRect(mode, { railRight, fleetLeft, openCount: slot, viewport })
      }
      used.add(Math.round(pos.left))
      slot += 1
      added[win.askId] = pos
    }
    setPositions((prev) => {
      const next: Record<string, AskPlacement> = { ...prev, ...added }
      for (const id of stale) delete next[id]
      return next
    })
  }, [mode, windows])

  // resize：只夹 x（宽随视口窄档重取；y / 高不动）。
  useEffect(() => {
    if (windows.length === 0) return
    const onResize = () => {
      const vw = window.innerWidth
      const width = windowWidthFor(mode, vw)
      setPositions((prev) => {
        const next: Record<string, AskPlacement> = {}
        let changed = false
        for (const [id, pos] of Object.entries(prev)) {
          const left = clampLeft(pos.left, width, vw)
          next[id] = { ...pos, left, width }
          if (left !== pos.left || width !== pos.width) changed = true
        }
        return changed ? next : prev
      })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [mode, windows.length])

  // Esc：只关最上面一扇；不碰主 chat / 抽屉 / 模块窗。
  const topRef = useRef<string | null>(topAskId)
  topRef.current = topAskId
  const closeRef = useRef(close)
  closeRef.current = close

  useEffect(() => {
    if (windows.length === 0) return
    if (escLayer) {
      return escLayer.register('cabin-ask-windows', 75, () => {
        const id = topRef.current
        if (id) closeRef.current(id)
      })
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const id = topRef.current
      if (!id) return
      event.preventDefault()
      closeRef.current(id)
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [escLayer, windows.length])

  const move = useCallback((askId: string, left: number, top: number) => {
    setPositions((prev) => {
      const cur = prev[askId]
      if (!cur) return prev
      const next = { ...cur, left: clampLeft(left, cur.width, window.innerWidth), top: Math.max(0, top) }
      if (next.left === cur.left && next.top === cur.top) return prev
      return { ...prev, [askId]: next }
    })
  }, [])

  if (!mounted) return null

  return createPortal(
    <>
      {windows.map((win) => {
        const pos = positions[win.askId]
        if (!pos) return null
        return (
          <AskWindow
            key={win.askId}
            entry={win}
            left={pos.left}
            top={pos.top}
            width={pos.width}
            className={mode === 'classic' ? 'ck-askwin--classic' : 'ck-askwin--cockpit'}
            onMove={(left, top) => move(win.askId, left, top)}
            onFocus={() => focus(win.askId)}
            onClose={() => close(win.askId)}
          />
        )
      })}
    </>,
    document.body,
  )
}
