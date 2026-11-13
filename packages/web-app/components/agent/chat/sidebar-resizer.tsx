'use client'

// 左栏右缘的拖拽分隔线。absolute 贴在 aside 内，跨在两个区域中间；
// 视觉上只在悬停/拖拽时亮起一条 1px 线，避免平时多出一条装饰线。

import { cn } from '@/lib/utils'
import type { SidebarResizeHandlers } from './sidebar-width'

export function SidebarResizer({
  resizing,
  handlers,
}: {
  resizing: boolean
  handlers: SidebarResizeHandlers
}) {
  return (
    <div
      {...handlers}
      role="separator"
      aria-orientation="vertical"
      aria-label="调整侧栏宽度"
      title="拖动调整宽度 · 双击复位"
      data-testid="chat-sidebar-resizer"
      data-resizing={resizing ? 'true' : undefined}
      className="group/resizer absolute -right-1 top-0 z-20 hidden h-full w-2 cursor-col-resize touch-none md:block"
    >
      <span
        className={cn(
          'pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors',
          resizing ? 'bg-pop-yellow/70' : 'bg-transparent group-hover/resizer:bg-white/25',
        )}
      />
    </div>
  )
}
