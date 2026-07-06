"use client"

import { useCallback, useRef, type KeyboardEvent } from "react"
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
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])

  // H7 fix: keyboard navigation — arrow keys, Home, End
  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null

    switch (e.key) {
      case "ArrowRight":
        nextIndex = (index + 1) % tabs.length
        break
      case "ArrowLeft":
        nextIndex = (index - 1 + tabs.length) % tabs.length
        break
      case "Home":
        nextIndex = 0
        break
      case "End":
        nextIndex = tabs.length - 1
        break
      default:
        return
    }

    e.preventDefault()
    if (nextIndex !== null) {
      tabRefs.current[nextIndex]?.focus()
      onChange(tabs[nextIndex].value)
    }
  }, [onChange])

  return (
    <div
      role="tablist"
      aria-label="资源类型过滤"
      className="flex items-center gap-1 overflow-x-auto rounded-lg bg-muted p-1"
    >
      {tabs.map((tab, index) => {
        const isActive = value === tab.value
        return (
          <button
            key={tab.label}
            ref={(el) => { tabRefs.current[index] = el }}
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(tab.value)}
            onKeyDown={(e) => handleKeyDown(e, index)}
            className={cn(
              "shrink-0 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
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
