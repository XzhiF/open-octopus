"use client"

import { BarChart3, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

export interface SettingsMenuItem {
  id: string
  label: string
  icon: LucideIcon
  description: string
}

export const settingsMenuItems: SettingsMenuItem[] = [
  {
    id: "log-analysis",
    label: "日志分析",
    icon: BarChart3,
    description: "失败模式分析与异常检测",
  },
]

export function SettingsSidebar({
  activeItem,
  onItemClick,
}: {
  activeItem: string
  onItemClick: (id: string) => void
}) {
  return (
    <div className="flex h-full w-56 flex-col bg-sidebar border-r border-sidebar-border shrink-0">
      <div className="px-4 py-3">
        <div className="text-xs font-medium text-sidebar-foreground/70 uppercase tracking-wider">设置</div>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 pb-2">
        {settingsMenuItems.map((item) => (
          <button
            key={item.id}
            onClick={() => onItemClick(item.id)}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors mb-0.5",
              activeItem === item.id
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            )}
            title={item.label}
          >
            <item.icon className="h-4 w-4 shrink-0" />
            <span className="truncate">{item.label}</span>
          </button>
        ))}
      </nav>
    </div>
  )
}
