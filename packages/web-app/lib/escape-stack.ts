'use client'

import { useEffect, useRef } from 'react'

interface EscapeEntry {
  id: symbol
  priority: number
  seq: number
  close: () => void
}

const stack: EscapeEntry[] = []
let sequence = 0

function radixLayerOpen(): boolean {
  if (typeof document === 'undefined') return false
  return !!document.querySelector(
    [
      '[data-slot="dialog-content"][data-state="open"]',
      '[data-slot="alert-dialog-content"][data-state="open"]',
      '[data-slot="sheet-content"][data-state="open"]',
      '[data-slot="popover-content"][data-state="open"]',
      '[role="menu"][data-state="open"]',
    ].join(','),
  )
}

/**
 * Esc closes the top-most custom floating layer (window/pane/editor).
 * Radix dialogs/menus/popovers handle Esc themselves; while one is open we
 * stay out of the way so its own close wins.
 */
export function useEscapeClose(active: boolean, close: () => void, priority = 0): void {
  const closeRef = useRef(close)
  closeRef.current = close

  useEffect(() => {
    if (!active) return
    const entry: EscapeEntry = {
      id: Symbol('escape-layer'),
      priority,
      seq: sequence++,
      close: () => closeRef.current(),
    }
    stack.push(entry)

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (radixLayerOpen()) return
      let top: EscapeEntry | null = null
      for (const item of stack) {
        if (!top || item.priority > top.priority || (item.priority === top.priority && item.seq > top.seq)) {
          top = item
        }
      }
      if (top !== entry) return
      event.preventDefault()
      event.stopPropagation()
      entry.close()
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      const index = stack.indexOf(entry)
      if (index >= 0) stack.splice(index, 1)
    }
  }, [active, priority])
}
