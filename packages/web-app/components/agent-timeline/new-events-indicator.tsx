"use client"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { ArrowDown } from "lucide-react"

interface NewEventsIndicatorProps {
  count: number
  onScrollToBottom: () => void
}

export function NewEventsIndicator({ count, onScrollToBottom }: NewEventsIndicatorProps) {
  if (count === 0) return null

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 animate-in fade-in slide-in-from-bottom-2">
      <Button
        size="sm"
        variant="outline"
        className="shadow-lg gap-1.5"
        onClick={onScrollToBottom}
      >
        <ArrowDown className="h-3.5 w-3.5" />
        {count} 个新事件
      </Button>
    </div>
  )
}
