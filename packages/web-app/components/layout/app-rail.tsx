"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { PanelLeftClose, PanelLeftOpen } from "lucide-react"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { cn } from "@/lib/utils"
import { NAV_GROUPS, isNavItemActive } from "./nav-config"

const RAIL_COLLAPSED_KEY = "octopus.rail.collapsed"

interface RailLinksProps {
  collapsed: boolean
  onNavigate?: () => void
}

function RailLinks({ collapsed, onNavigate }: RailLinksProps) {
  const pathname = usePathname()

  return (
    <>
      {NAV_GROUPS.map((group, groupIndex) => (
        <div
          key={group.label}
          className={cn(
            groupIndex > 0 && "mt-3 border-t-[1.5px] border-pop-bd/60 pt-3",
          )}
        >
          {!collapsed && (
            <div className="px-2 pb-1 text-[10px] font-black tracking-[0.2em] text-pop-dim">
              {group.label}
            </div>
          )}
          <div className="space-y-1">
            {group.items.map((item) => {
              const active = isNavItemActive(pathname, item)
              const Icon = item.icon
              return (
                <Link
                  key={item.name}
                  href={item.href}
                  onClick={onNavigate}
                  aria-current={active ? "page" : undefined}
                  title={collapsed ? item.name : undefined}
                  className={cn(
                    "flex items-center rounded-lg border-[1.5px] transition-all",
                    collapsed
                      ? "mx-auto h-9 w-9 justify-center"
                      : "gap-2.5 px-3 py-1.5 text-sm",
                    active
                      ? "border-pop-bd bg-pop-yellow font-black text-pop-bg shadow-pop-sm"
                      : "border-transparent font-bold text-pop-dim hover:bg-accent hover:text-pop-ink",
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {!collapsed && <span className="truncate">{item.name}</span>}
                </Link>
              )
            })}
          </div>
        </div>
      ))}
    </>
  )
}

interface AppRailProps {
  mobileOpen: boolean
  onMobileOpenChange: (open: boolean) => void
}

export function AppRail({ mobileOpen, onMobileOpenChange }: AppRailProps) {
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(RAIL_COLLAPSED_KEY) === "1")
    } catch {
      /* storage unavailable — keep expanded */
    }
  }, [])

  const toggleCollapsed = () => {
    setCollapsed((previous) => {
      const next = !previous
      try {
        window.localStorage.setItem(RAIL_COLLAPSED_KEY, next ? "1" : "0")
      } catch {
        /* storage unavailable */
      }
      return next
    })
  }

  return (
    <>
      <aside
        className={cn(
          "hidden shrink-0 flex-col border-r-[1.5px] border-pop-bd bg-pop-paper transition-[width] duration-200 md:flex",
          collapsed ? "w-14" : "w-52",
        )}
      >
        <div
          className={cn(
            "flex h-12 shrink-0 items-center border-b-[1.5px] border-pop-bd px-2",
            collapsed ? "justify-center" : "justify-between",
          )}
        >
          {!collapsed && (
            <span className="px-2 text-[10px] font-black tracking-[0.2em] text-pop-dim">
              导航
            </span>
          )}
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? "展开导航栏" : "收起导航栏"}
            title={collapsed ? "展开导航栏" : "收起导航栏"}
            className="grid size-8 place-items-center rounded-lg text-pop-dim transition-colors hover:bg-accent hover:text-pop-ink"
          >
            {collapsed ? (
              <PanelLeftOpen className="h-4 w-4" />
            ) : (
              <PanelLeftClose className="h-4 w-4" />
            )}
          </button>
        </div>

        <nav
          aria-label="主导航"
          className={cn(
            "flex-1 overflow-y-auto",
            collapsed ? "px-1.5 py-3" : "p-2",
          )}
        >
          <RailLinks collapsed={collapsed} />
        </nav>

        {!collapsed && (
          <div className="shrink-0 border-t-[1.5px] border-pop-bd px-3 py-2 font-mono text-[10px] text-pop-dim">
            Octopus · AI Native
          </div>
        )}
      </aside>

      <Sheet open={mobileOpen} onOpenChange={onMobileOpenChange}>
        <SheetContent side="left" className="w-72 p-0">
          <SheetHeader className="border-b-[1.5px] border-pop-bd">
            <SheetTitle>导航</SheetTitle>
          </SheetHeader>
          <nav
            aria-label="移动端主导航"
            className="flex-1 overflow-y-auto p-3"
          >
            <RailLinks
              collapsed={false}
              onNavigate={() => onMobileOpenChange(false)}
            />
          </nav>
        </SheetContent>
      </Sheet>
    </>
  )
}
