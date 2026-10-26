'use client'

import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { useEscapeClose } from '@/lib/escape-stack'

export interface ChatTimelineItem {
  id: string
  text: string
}

/** Longest dash stack before the collapsed rail windows to the latest turns. */
const MAX_DASHES = 12

interface ChatTimelineProps {
  items: ChatTimelineItem[]
  activeId: string | null
  onJump: (id: string) => void
  /** Workspace dock occupies the right column (lg+) — shift the rail clear of it. */
  clearDock?: boolean
}

/** User-turn scrubber (DeepSeek style): one dash per prompt hugging the right
 *  edge; hovering (or tabbing in) expands a scrollable list of the truncated
 *  prompts; clicking one scrolls the transcript to that turn. Hidden until a
 *  second prompt exists (a single turn needs no navigation).
 *  z-[25]: below the floating column (dock z-30 / editor z-40) so open panes
 *  simply cover the rail instead of colliding with it.
 *  Open state is JS (hover / focus): Esc dismisses it while the pointer stays
 *  put; hovering out and back in re-opens. */
export function ChatTimeline({ items, activeId, onJump, clearDock }: ChatTimelineProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const dashes = items.length > MAX_DASHES ? items.slice(-MAX_DASHES) : items

  // 最低优先级：被面板/编辑器盖住时（此时也点不到）先让它们关。
  useEscapeClose(open, () => setOpen(false), 5)

  useEffect(() => {
    if (!activeId) return
    listRef.current
      ?.querySelector<HTMLElement>(`[data-timeline-id="${activeId}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeId])

  if (items.length <= 1) return null

  return (
    <div
      data-testid="chat-timeline"
      data-open={open ? 'true' : undefined}
      className={cn(
        'absolute top-1/2 z-[25] hidden -translate-y-1/2 md:block',
        clearDock ? 'right-2 lg:right-[68px]' : 'right-2',
      )}
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
      }}
    >
      {/* Collapsed: one dash per turn, windowed to the latest MAX_DASHES. */}
      <div
        className={cn(
          'flex flex-col items-end gap-[5px] px-1.5 py-2 transition-opacity',
          open && 'opacity-0',
        )}
      >
        {dashes.map((item) => (
          <span
            key={item.id}
            aria-hidden
            className={cn(
              'h-[3px] w-4 rounded-full transition-colors',
              item.id === activeId ? 'bg-pop-pink' : 'bg-pop-dim/45',
            )}
          />
        ))}
      </div>

      {/* Hover / focus: prompt list, scrollable, follows the transcript scroll. */}
      <div
        className={cn(
          'absolute right-0 top-1/2 -translate-y-1/2 transition-opacity duration-150',
          open ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0',
        )}
      >
        <div
          ref={listRef}
          data-testid="chat-timeline-list"
          className="max-h-[min(58vh,320px)] w-[264px] overflow-y-auto overscroll-contain rounded-xl border border-white/[0.08] bg-pop-paper/95 p-1.5 shadow-pop-lg backdrop-blur-xl"
        >
          {items.map((item) => {
            const active = item.id === activeId
            return (
              <button
                key={item.id}
                type="button"
                data-timeline-id={item.id}
                aria-current={active ? 'true' : undefined}
                title={item.text}
                onClick={() => onJump(item.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-[7px] px-2 py-[5px] text-left text-[11.5px] leading-tight transition-colors',
                  active
                    ? 'text-pop-pink'
                    : 'text-pop-dim hover:bg-white/[0.05] hover:text-pop-ink',
                )}
              >
                <span className="min-w-0 flex-1 truncate">{item.text}</span>
                <span
                  aria-hidden
                  className={cn(
                    'h-[3px] w-3.5 shrink-0 rounded-full transition-colors',
                    active ? 'bg-pop-pink shadow-[0_0_6px_var(--pop-pink)]' : 'bg-pop-dim/35',
                  )}
                />
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}