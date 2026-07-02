'use client'

import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { X, Check } from 'lucide-react'

interface BatchActionBarProps {
  selectedCount: number
  onBatchApprove: () => void
  onBatchReject: () => void
  onClearSelection: () => void
  loading?: boolean
}

export function BatchActionBar({
  selectedCount,
  onBatchApprove,
  onBatchReject,
  onClearSelection,
  loading = false,
}: BatchActionBarProps) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 px-4 py-3',
        'border-t border-agent-divider shadow-md bg-agent-surface-raised',
        'transition-all duration-200 ease-in-out',
        selectedCount > 0
          ? 'translate-y-0 opacity-100'
          : 'translate-y-full opacity-0 pointer-events-none',
      )}
    >
      {/* Left side */}
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium">
          已选 {selectedCount} 条
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClearSelection}
          disabled={loading}
          className="text-xs"
        >
          取消选择
        </Button>
      </div>

      {/* Right side */}
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onBatchReject}
          disabled={loading}
          className="gap-1.5 text-agent-error border-agent-error/30 hover:bg-agent-error/10"
        >
          {loading ? <Spinner className="size-3.5" /> : <X className="size-3.5" />}
          {loading ? '处理中...' : '全部拒绝'}
        </Button>
        <Button
          size="sm"
          onClick={onBatchApprove}
          disabled={loading}
          className="gap-1.5 bg-knowledge-primary hover:bg-knowledge-primary/90 text-white"
        >
          {loading ? <Spinner className="size-3.5" /> : <Check className="size-3.5" />}
          {loading ? '处理中...' : `纳入选中 (${selectedCount} 条)`}
        </Button>
      </div>
    </div>
  )
}
