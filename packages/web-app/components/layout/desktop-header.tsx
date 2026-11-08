'use client'

import { Code2, CircleHelp, Columns2, LayoutGrid, StickyNote } from 'lucide-react'
import { APP_CATALOG, isAppId } from '@/lib/app-catalog'
import { useDesktopWindows, windowTitle } from '@/lib/desktop-windows'
import { setChatSplitEnabled, useChatSplitEnabled } from '@/lib/chat-split'
import { cn } from '@/lib/utils'
import { OctopusMenu } from './octopus-menu'
import { QuickNotes } from './quick-notes'
import { RunningAgents } from './running-agents'

/** Single global header: logo menu | open windows | … | running agents | Mission Control. */
export function DesktopHeader() {
  const {
    state,
    breakpoint,
    focusWindow,
    restoreWindow,
    toggleMissionControl,
  } = useDesktopWindows()
  const narrow = breakpoint === 'narrow'
  const chatSplit = useChatSplitEnabled()
  const splitAllowed = breakpoint === 'wide'
  const splitTitle = chatSplit
    ? '关闭对话分屏 (⌘\\)'
    : splitAllowed
      ? '对话分屏 (⌘\\)'
      : '分屏需要更宽的窗口（≥1024px）'

  return (
    <header
      data-shell-chrome
      className="z-50 flex h-8 shrink-0 items-center gap-1 border-b-[1.5px] border-pop-bd bg-pop-paper px-1.5"
    >
      <OctopusMenu narrow={narrow} />

      <div className="mx-1 h-4 w-px shrink-0 bg-pop-bd" aria-hidden />

      <div
        className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        aria-label="打开的窗口"
        data-testid="window-strip"
      >
        {state.order.map((id) => {
          const record = state.windows[id]
          if (!record) return null
          const app = isAppId(id) ? APP_CATALOG[id] : null
          const Icon =
            app?.icon ??
            (id === 'dev' ? Code2 : id === 'notes' ? StickyNote : CircleHelp)
          const active = state.focused === id && !record.minimized
          const title = windowTitle(record)
          return (
            <button
              key={id}
              type="button"
              data-window-icon={id}
              data-active={active ? 'true' : undefined}
              aria-label={record.minimized ? `${title}（已最小化）` : title}
              title={title}
              aria-current={active ? 'page' : undefined}
              onClick={() => (record.minimized ? restoreWindow(id) : focusWindow(id))}
              className={cn(
                'relative grid size-6 shrink-0 place-items-center rounded-md border-[1.5px] transition-colors',
                active
                  ? 'border-pop-bd bg-pop-yellow text-pop-bg'
                  : 'border-transparent text-pop-dim hover:border-pop-bd hover:bg-accent hover:text-pop-ink',
                record.minimized && 'opacity-50',
              )}
            >
              <Icon className="size-3.5" />
              {record.minimized && (
                <span className="absolute -bottom-0.5 left-1/2 size-1 -translate-x-1/2 rounded-full bg-pop-amber" />
              )}
            </button>
          )
        })}
        {state.order.length === 0 && (
          <span className="px-2 font-mono text-[10px] text-pop-dim">桌面</span>
        )}
      </div>

      <RunningAgents />

      <QuickNotes />

      {/* 对话分屏：与窗口总览并排；窄屏置灰（<1024 自动退出分屏）。 */}
      <button
        type="button"
        data-testid="chat-split-toggle"
        aria-label="对话分屏"
        title={splitTitle}
        aria-pressed={chatSplit}
        disabled={!splitAllowed && !chatSplit}
        onClick={() => setChatSplitEnabled(!chatSplit)}
        className={cn(
          'grid size-6 shrink-0 place-items-center rounded-md border-[1.5px] transition-colors',
          chatSplit
            ? 'border-pop-bd bg-pop-yellow text-pop-bg'
            : 'border-transparent text-pop-dim hover:border-pop-bd hover:bg-accent hover:text-pop-ink',
          !splitAllowed && !chatSplit && 'cursor-not-allowed opacity-40 hover:border-transparent hover:bg-transparent hover:text-pop-dim',
        )}
      >
        <Columns2 className="size-3.5" />
      </button>

      <button
        type="button"
        aria-label="窗口总览"
        title="窗口总览 (F3)"
        aria-pressed={state.missionControl}
        onClick={toggleMissionControl}
        className={cn(
          'grid size-6 shrink-0 place-items-center rounded-md border-[1.5px] transition-colors',
          state.missionControl
            ? 'border-pop-bd bg-pop-yellow text-pop-bg'
            : 'border-transparent text-pop-dim hover:border-pop-bd hover:bg-accent hover:text-pop-ink',
        )}
      >
        <LayoutGrid className="size-3.5" />
      </button>
    </header>
  )
}
