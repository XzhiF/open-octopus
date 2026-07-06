"use client"

import { cn } from "@/lib/utils"

interface FilterTabsProps {
  value: string | undefined
  onChange: (value: string | undefined) => void
}

const tabs = [
  { label: "全部", value: undefined },
  { label: "Skills", value: "skill" },
  { label: "Agents", value: "agent" },
  { label: "Workflows", value: "workflow" },
] as const

export function FilterTabs({ value, onChange }: FilterTabsProps) {
  return (
    <div
      role="tablist"
      aria-label="资源类型过滤"
      className="flex items-center gap-1 overflow-x-auto rounded-lg bg-muted p-1"
    >
      {tabs.map((tab) => {
        const isActive = value === tab.value
        return (
          <button
            key={tab.label}
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(tab.value)}
            className={cn(
              "shrink-0 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              isActive
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}
