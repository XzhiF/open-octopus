'use client'

import { X } from 'lucide-react'
import type { ToolCallRecord } from '@/lib/agent/types'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ToolCallCard } from './ToolCallCard'

interface ToolCallPanelProps {
  toolCalls: ToolCallRecord[]
  onClose: () => void
}

export function ToolCallPanel({ toolCalls, onClose }: ToolCallPanelProps) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-agent-divider">
        <h3 className="text-sm font-semibold">工具调用</h3>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      <ScrollArea className="flex-1">
        <div className="p-3 space-y-2">
          {toolCalls.map((tc) => (
            <ToolCallCard key={tc.id} toolCall={tc} />
          ))}
          {toolCalls.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">暂无工具调用</p>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
