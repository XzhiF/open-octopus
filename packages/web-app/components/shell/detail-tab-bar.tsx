'use client'

import { X } from 'lucide-react'
import { useDetailTabs } from '@/lib/detail-tabs'
import { cn } from '@/lib/utils'

export function DetailTabBar() {
  const { tabs, activeKey, focusTab, closeTab } = useDetailTabs()
  if (tabs.length === 0) return null

  return (
    <div
      className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b-[1.5px] border-pop-bd bg-pop-paper px-2"
      role="tablist"
      aria-label="详情标签"
      data-testid="detail-tab-bar"
    >
      {tabs.map((tab) => {
        const active = tab.key === activeKey
        return (
          <div
            key={tab.key}
            className={cn(
              'group flex h-7 max-w-[220px] shrink-0 items-center rounded-md border-[1.5px] transition-colors',
              active
                ? 'border-pop-bd bg-pop-yellow text-pop-bg'
                : 'border-transparent text-pop-dim hover:border-pop-bd hover:bg-accent hover:text-pop-ink',
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              title={tab.title}
              onClick={() => focusTab(tab)}
              className="min-w-0 flex-1 truncate px-2 text-left text-[11px] font-bold"
            >
              {tab.title}
            </button>
            <button
              type="button"
              aria-label={`关闭 ${tab.title}`}
              title={`关闭 ${tab.title}`}
              onClick={(event) => {
                event.stopPropagation()
                closeTab(tab.key)
              }}
              className={cn(
                'mr-0.5 grid size-5 shrink-0 place-items-center rounded transition-colors',
                active ? 'hover:bg-pop-bg/20' : 'opacity-60 hover:bg-pop-idle hover:opacity-100',
              )}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
