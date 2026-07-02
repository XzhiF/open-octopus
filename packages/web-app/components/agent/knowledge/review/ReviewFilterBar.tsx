'use client'

import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { ReviewFilter, ReviewStatusFilter } from '@/lib/knowledge/types'

interface ReviewFilterBarProps {
  filter: ReviewFilter
  onFilterChange: (filter: ReviewFilter) => void
  statusFilter: ReviewStatusFilter
  onStatusFilterChange: (status: ReviewStatusFilter) => void
  total: number
}

export function ReviewFilterBar({
  filter,
  onFilterChange,
  statusFilter,
  onStatusFilterChange,
  total,
}: ReviewFilterBarProps) {
  return (
    <div className="space-y-2 px-4 py-3 border-b border-agent-divider">
      {/* Type filter */}
      <div className="flex items-center justify-between gap-3">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={filter}
          onValueChange={(value) => {
            if (value) onFilterChange(value as ReviewFilter)
          }}
        >
          <ToggleGroupItem value="all">全部</ToggleGroupItem>
          <ToggleGroupItem value="rule">规则</ToggleGroupItem>
          <ToggleGroupItem value="skill">Skill</ToggleGroupItem>
        </ToggleGroup>

        <span className="text-xs text-muted-foreground whitespace-nowrap">
          共 {total} 条
        </span>
      </div>

      {/* Status filter */}
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={statusFilter}
        onValueChange={(value) => {
          if (value) onStatusFilterChange(value as ReviewStatusFilter)
        }}
      >
        <ToggleGroupItem value="all">全部状态</ToggleGroupItem>
        <ToggleGroupItem value="pending">待审</ToggleGroupItem>
        <ToggleGroupItem value="deferred">已暂缓</ToggleGroupItem>
        <ToggleGroupItem value="approved">已纳入</ToggleGroupItem>
        <ToggleGroupItem value="rejected">已拒绝</ToggleGroupItem>
      </ToggleGroup>
    </div>
  )
}
