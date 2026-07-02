'use client'

import type { ReviewFilter, ReviewStatusFilter, ReviewTypeStatusCounts, ReviewStatusCounts } from '@/lib/knowledge/types'
import { cn } from '@/lib/utils'

interface ReviewFilterBarProps {
  filter: ReviewFilter
  onFilterChange: (filter: ReviewFilter) => void
  statusFilter: ReviewStatusFilter
  onStatusFilterChange: (status: ReviewStatusFilter) => void
  total: number
  typeStatusCounts: ReviewTypeStatusCounts
}

function Pill({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors',
        active
          ? 'bg-knowledge-primary text-knowledge-primary-foreground'
          : 'bg-agent-surface text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

function CountBadge({ count, active }: { count: number; active: boolean }) {
  if (count === 0) return null
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center min-w-[18px] h-[18px] rounded-full px-1 text-[10px] font-semibold tabular-nums',
        active
          ? 'bg-knowledge-primary-foreground/20 text-knowledge-primary-foreground'
          : 'bg-agent-divider text-muted-foreground',
      )}
    >
      {count}
    </span>
  )
}

const STATUS_KEYS: { key: keyof ReviewStatusCounts; label: string }[] = [
  { key: 'all', label: '全部状态' },
  { key: 'pending', label: '待审' },
  { key: 'deferred', label: '已暂缓' },
  { key: 'approved', label: '已纳入' },
  { key: 'rejected', label: '已拒绝' },
]

export function ReviewFilterBar({
  filter,
  onFilterChange,
  statusFilter,
  onStatusFilterChange,
  total,
  typeStatusCounts,
}: ReviewFilterBarProps) {
  // Type filter options with counts from the "all statuses" row
  const typeOptions: { value: ReviewFilter; label: string; count: number }[] = [
    { value: 'all', label: '全部', count: typeStatusCounts.all?.all ?? 0 },
    { value: 'rule', label: '经验', count: typeStatusCounts.rule?.all ?? 0 },
  ]

  // Status counts react to the selected type filter
  const activeCounts: ReviewStatusCounts = filter === 'rule'
    ? typeStatusCounts.rule
    : typeStatusCounts.all

  return (
    <div className="space-y-2.5 px-4 py-3 border-b border-agent-divider">
      {/* Type filter + total */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {typeOptions.map((opt) => (
            <Pill
              key={opt.value}
              active={filter === opt.value}
              onClick={() => onFilterChange(opt.value)}
            >
              {opt.label}
              <CountBadge count={opt.count} active={filter === opt.value} />
            </Pill>
          ))}
        </div>

        <span className="text-xs text-muted-foreground whitespace-nowrap tabular-nums">
          共 {total} 条
        </span>
      </div>

      {/* Status filter with counts (linked to type filter) */}
      <div className="flex items-center gap-2">
        {STATUS_KEYS.map((opt) => (
          <Pill
            key={opt.key}
            active={statusFilter === opt.key}
            onClick={() => onStatusFilterChange(opt.key as ReviewStatusFilter)}
          >
            {opt.label}
            <CountBadge
              count={activeCounts?.[opt.key] ?? 0}
              active={statusFilter === opt.key}
            />
          </Pill>
        ))}
      </div>
    </div>
  )
}
