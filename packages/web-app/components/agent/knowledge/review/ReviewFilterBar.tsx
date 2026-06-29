'use client'

import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { ReviewFilter } from '@/lib/knowledge/types'

interface ReviewFilterBarProps {
  filter: ReviewFilter
  onFilterChange: (filter: ReviewFilter) => void
  total: number
}

export function ReviewFilterBar({ filter, onFilterChange, total }: ReviewFilterBarProps) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-agent-divider">
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
  )
}
