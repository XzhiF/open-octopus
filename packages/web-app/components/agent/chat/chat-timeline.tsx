'use client'

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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
  /** 全域座舱：索引搬进浮窗标题栏（portal 到 index 槽），正文区零常驻控件。
   *  classic 的一竖排短杠与展开列表完全不变（2026-11-14 用户口径）。 */
  compact?: boolean
  /** compact 的挂载点（CockpitChatWindow 注册的标题栏槽）。没有槽就不渲染 ——
   *  绝不回退成正文右侧的悬浮把手。 */
  portalHost?: HTMLElement | null
}

/** User-turn scrubber (DeepSeek style): one dash per prompt hugging the right
 *  edge; hovering (or tabbing in) expands a scrollable list of the truncated
 *  prompts; clicking one scrolls the transcript to that turn. Hidden until a
 *  second prompt exists (a single turn needs no navigation).
 *
 *  compact（全域）：把同一个索引做成标题栏里的一枚 `≡ N轮` 按钮，点开在
 *  标题下弹编号列表（新的在上），↑↓ 选、⏎ 跳、Esc 收。转录区不再有常驻元素。
 *
 *  z-[25]: below the floating column (dock z-30 / editor z-40) so open panes
 *  simply cover the rail instead of colliding with it.
 *  Open state is JS (hover / focus / click): Esc dismisses it while the pointer
 *  stays put; hovering out and back in re-opens. */
export function ChatTimeline({
  items,
  activeId,
  onJump,
  clearDock,
  compact,
  portalHost,
}: ChatTimelineProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  // 面板挂在浮窗本体上（不在标题栏槽里），这样宽度能按窗宽夹住 —— 槽只有
  // 52px 宽，右对齐弹 300px 会从窗左缘漏出去被 overflow:hidden 裁掉。
  const [panelGeom, setPanelGeom] = useState<{ left: number; width: number } | null>(null)
  const listId = useId()
  const dashes = items.length > MAX_DASHES ? items.slice(-MAX_DASHES) : items
  // 最新的在前：打开索引先看到刚说过的那几句；编号仍是原始轮次。
  const entries = items.map((item, index) => ({ item, no: index + 1 })).reverse()

  // 最低优先级：被面板/编辑器盖住时（此时也点不到）先让它们关。
  useEscapeClose(open, () => setOpen(false), 5)

  useEffect(() => {
    if (!activeId) return
    listRef.current
      ?.querySelector<HTMLElement>(`[data-timeline-id="${activeId}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeId, open])

  // compact：点开时把焦点放到当前轮（没有就最新一条），↑↓ 才能立刻用。
  useEffect(() => {
    if (!compact || !open) return
    const node =
      listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]') ??
      listRef.current?.querySelector<HTMLElement>('[data-timeline-id]')
    node?.focus({ preventScroll: true })
  }, [compact, open])

  // compact：面板挂在浮窗本体上，按按钮位置算一个夹在窗内的 left/宽度。
  const windowHost = portalHost?.closest<HTMLElement>('.ck12-comms') ?? portalHost ?? null
  useLayoutEffect(() => {
    if (!compact || !open || !windowHost) return
    const place = () => {
      const trigger = triggerRef.current
      if (!trigger) return
      const host = windowHost.getBoundingClientRect()
      const btn = trigger.getBoundingClientRect()
      const width = Math.max(180, Math.min(300, host.width - 24))
      const left = Math.max(12, Math.min(btn.left - host.left, host.width - width - 12))
      setPanelGeom({ left, width })
    }
    place()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null
    observer?.observe(windowHost)
    window.addEventListener('resize', place)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', place)
    }
  }, [compact, open, windowHost])

  // compact：点外面收起（标题栏本身是拖拽区，这里只认按钮与面板之外）。
  useEffect(() => {
    if (!compact || !open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [compact, open])

  const moveFocus = useCallback((dir: 1 | -1) => {
    const nodes = [
      ...(listRef.current?.querySelectorAll<HTMLButtonElement>('[data-timeline-id]') ?? []),
    ]
    if (nodes.length === 0) return
    const current = nodes.findIndex((node) => node === document.activeElement)
    const next = current < 0
      ? (dir > 0 ? 0 : nodes.length - 1)
      : (current + dir + nodes.length) % nodes.length
    nodes[next].focus({ preventScroll: true })
    nodes[next].scrollIntoView({ block: 'nearest' })
  }, [])

  if (items.length <= 1) return null

  // ── 全域：标题栏索引（正文区不渲染任何东西）─────────────────────────
  if (compact) {
    if (!portalHost) return null
    const close = () => setOpen(false)
    return (
      <>
        {createPortal(
          <div
            ref={rootRef}
            className="ck12-idx"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button
              ref={triggerRef}
              type="button"
              className="ck12-idx-btn"
              data-testid="chat-timeline-handle"
              aria-haspopup="listbox"
              aria-expanded={open}
              aria-controls={open ? listId : undefined}
              title={`对话索引 · ${items.length} 轮（点开跳转）`}
              onClick={() => setOpen((value) => !value)}
            >
              <span className="ck12-idx-glyph" aria-hidden="true">≡</span>
              <span className="ck12-idx-count">{items.length}轮</span>
            </button>
          </div>,
          portalHost,
        )}

        {open && windowHost && createPortal(
          <div
            ref={panelRef}
            className="ck12-idx-panel"
            data-testid="chat-timeline-panel"
            style={{ left: panelGeom?.left ?? 12, width: panelGeom?.width ?? 300 }}
          >
            <div className="ck12-idx-head">
              <b>对话索引 · {items.length} 轮</b>
              <span>↑↓ 选 · ⏎ 跳转 · Esc 收起</span>
            </div>
            <div
              ref={listRef}
              id={listId}
              role="listbox"
              aria-label="用户输入历史"
              data-testid="chat-timeline-list"
              className="ck12-idx-list"
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  moveFocus(1)
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  moveFocus(-1)
                }
              }}
            >
              {entries.map(({ item, no }) => {
                const active = item.id === activeId
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    data-timeline-id={item.id}
                    title={item.text}
                    onClick={() => {
                      onJump(item.id)
                      close()
                      requestAnimationFrame(() => triggerRef.current?.focus())
                    }}
                    className={cn('ck12-idx-item', active && 'on')}
                  >
                    <span className="ck12-idx-no" aria-hidden="true">
                      {String(no).padStart(2, '0')}
                    </span>
                    <span className="ck12-idx-text">{item.text}</span>
                  </button>
                )
              })}
            </div>
          </div>,
          windowHost,
        )}
      </>
    )
  }

  // ── classic / 桌面：一竖排短杠 + 悬停展开（逐字不变）──────────────────
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