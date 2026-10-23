'use client'

import { useState, type ComponentPropsWithRef } from 'react'
import { Activity } from 'lucide-react'
import { APP_GROUPS, type AppId } from '@/lib/app-catalog'
import { useDesktopWindows } from '@/lib/desktop-windows'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'

function LogoButton({ ref, className, ...rest }: ComponentPropsWithRef<'button'>) {
  return (
    <button
      ref={ref}
      {...rest}
      type="button"
      aria-label="Octopus 菜单"
      aria-haspopup="menu"
      title="Octopus 菜单"
      className={cn(
        'flex shrink-0 items-center gap-2 rounded-lg px-1 py-0.5 transition-colors hover:bg-accent',
        className,
      )}
    >
      <span className="grid size-7 place-items-center rounded-lg border-[1.5px] border-pop-bd bg-pop-pink text-pop-bg shadow-pop-sm">
        <Activity className="size-4" />
      </span>
      <span className="hidden text-base font-black tracking-tight text-pop-ink sm:inline">
        Octopus
      </span>
    </button>
  )
}

export function OctopusMenu({ narrow }: { narrow: boolean }) {
  const { state, openApp, closeAll } = useDesktopWindows()
  const [sheetOpen, setSheetOpen] = useState(false)

  const open = (id: AppId) => {
    openApp(id)
    setSheetOpen(false)
  }

  const closeEverything = () => {
    closeAll()
    setSheetOpen(false)
  }

  if (narrow) {
    return (
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetTrigger asChild>
          <LogoButton />
        </SheetTrigger>
        <SheetContent side="left" className="w-72 p-0">
          <SheetHeader className="border-b-[1.5px] border-pop-bd">
            <SheetTitle>Octopus</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto p-2">
            {APP_GROUPS.map((group, groupIndex) => (
              <div
                key={group.label}
                className={cn(
                  'pb-1',
                  groupIndex > 0 && 'mt-2 border-t-[1.5px] border-pop-bd/60 pt-2',
                )}
              >
                <div className="px-2 pb-1 text-[10px] font-black tracking-[0.2em] text-pop-dim">
                  {group.label}
                </div>
                {group.apps.map((app) => {
                  const Icon = app.icon
                  return (
                    <button
                      key={app.id}
                      type="button"
                      data-app-id={app.id}
                      onClick={() => open(app.id)}
                      className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm font-bold text-pop-ink transition-colors hover:bg-accent"
                    >
                      <Icon className="size-4 shrink-0 text-pop-dim" />
                      <span className="min-w-0 flex-1 truncate">{app.label}</span>
                      {state.windows[app.id] && (
                        <span className="size-1.5 rounded-full bg-pop-yellow" aria-label="已打开" />
                      )}
                    </button>
                  )
                })}
              </div>
            ))}
            <div className="mt-2 border-t-[1.5px] border-pop-bd/60 pt-2">
              <button
                type="button"
                onClick={closeEverything}
                className="flex w-full items-center rounded-lg px-2 py-1.5 text-left text-sm font-bold text-pop-dim transition-colors hover:bg-accent hover:text-pop-ink"
              >
                关闭所有窗口
              </button>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <LogoButton />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} className="w-64" data-shell-chrome>
        {APP_GROUPS.map((group, groupIndex) => (
          <div key={group.label}>
            {groupIndex > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-[10px] font-black tracking-[0.2em] text-pop-dim">
              {group.label}
            </DropdownMenuLabel>
            {group.apps.map((app) => {
              const Icon = app.icon
              const isOpen = !!state.windows[app.id]
              return (
                <DropdownMenuItem
                  key={app.id}
                  data-app-id={app.id}
                  onSelect={() => openApp(app.id)}
                  className="gap-2.5 text-sm font-bold"
                >
                  <Icon className="size-4 text-pop-dim" />
                  <span className="flex-1">{app.label}</span>
                  {isOpen && (
                    <span className="size-1.5 rounded-full bg-pop-yellow" aria-label="已打开" />
                  )}
                </DropdownMenuItem>
              )
            })}
          </div>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={closeEverything}
          className="text-sm font-bold text-pop-dim"
        >
          关闭所有窗口
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
