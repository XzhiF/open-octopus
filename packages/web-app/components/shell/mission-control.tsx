'use client'

import type { MissionSlot } from '@/lib/window-geometry'
import { cn } from '@/lib/utils'
import { CloseLightGlyph } from '@/components/ui/close-light'

export interface MissionItem {
  id: string
  label: string
  sublabel?: string
  minimized?: boolean
  focused?: boolean
  isDesktop?: boolean
  slot: MissionSlot
}

interface MissionControlProps {
  items: MissionItem[]
  narrow: boolean
  onPick: (id: string) => void
  onClose: () => void
}

export function MissionControl({ items, narrow, onPick, onClose }: MissionControlProps) {
  if (narrow) {
    return (
      <div className="absolute inset-0 z-[100] flex flex-col justify-end" data-testid="mission-control">
        <button
          type="button"
          aria-label="关闭窗口总览"
          className="absolute inset-0 bg-pop-bg/60"
          onClick={onClose}
        />
        <div className="relative max-h-[70vh] overflow-y-auto rounded-t-xl border-t-[1.5px] border-pop-bd bg-pop-paper p-3 shadow-pop-lg">
          <div className="mb-2 flex items-center gap-2 px-1">
            <button
              type="button"
              aria-label="关闭窗口总览"
              onClick={onClose}
              className="group/light grid size-6 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-pop-yellow"
            >
              <CloseLightGlyph />
            </button>
            <span className="text-[10px] font-black tracking-[0.2em] text-pop-dim">窗口总览</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                data-mc-tile={item.id}
                onClick={() => onPick(item.id)}
                className={cn(
                  'flex min-h-14 flex-col items-start justify-between gap-1 rounded-lg border-[1.5px] p-2 text-left transition-colors',
                  item.focused
                    ? 'border-pop-bd bg-pop-yellow text-pop-bg'
                    : 'border-pop-bd bg-pop-idle text-pop-ink hover:bg-accent',
                  item.minimized && 'opacity-50',
                )}
              >
                <span className="w-full truncate text-xs font-black">{item.label}</span>
                <span className="w-full truncate font-mono text-[9px] opacity-70">
                  {item.minimized ? '已最小化' : item.isDesktop ? '桌面' : item.sublabel ?? '应用窗口'}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-[100]" data-testid="mission-control">
      <button
        type="button"
        aria-label="关闭窗口总览"
        className="pointer-events-auto absolute inset-0 cursor-default"
        onClick={onClose}
      />

      <div className="pointer-events-none absolute inset-x-0 top-2 flex justify-center">
        <span className="rounded-full border-[1.5px] border-pop-bd bg-pop-paper/90 px-3 py-1 font-mono text-[10px] font-bold text-pop-dim">
          窗口总览 · 点击切换 · Esc 退出
        </span>
      </div>

      {items.map((item) => {
        const { slot } = item
        return (
          <div key={item.id}>
            <button
              type="button"
              data-mc-tile={item.id}
              aria-label={
                item.isDesktop
                  ? '切换到桌面'
                  : `切换到 ${item.label}${item.minimized ? '（已最小化）' : ''}`
              }
              onClick={() => onPick(item.id)}
              className={cn(
                'pointer-events-auto absolute rounded-lg transition-shadow',
                item.focused
                  ? 'ring-2 ring-pop-yellow ring-offset-2 ring-offset-pop-bg/70'
                  : 'hover:ring-2 hover:ring-pop-cyan/70',
              )}
              style={{
                left: slot.content.x,
                top: slot.content.y,
                width: slot.content.w,
                height: slot.content.h,
              }}
            />
            <div
              className={cn(
                'pointer-events-none absolute flex items-center justify-center gap-1.5 overflow-hidden px-1',
                item.minimized ? 'opacity-50' : '',
              )}
              style={{
                left: slot.caption.x,
                top: slot.caption.y,
                width: slot.caption.w,
                height: slot.caption.h,
              }}
            >
              <span className="truncate text-[11px] font-black text-pop-ink">{item.label}</span>
              {item.sublabel && (
                <span className="truncate font-mono text-[9px] text-pop-dim">{item.sublabel}</span>
              )}
              {item.minimized && (
                <span className="shrink-0 rounded bg-pop-idle px-1 py-0.5 font-mono text-[8px] text-pop-dim">
                  已最小化
                </span>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
