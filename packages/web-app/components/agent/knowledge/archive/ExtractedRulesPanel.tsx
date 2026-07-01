'use client'

import { useState, useCallback } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { ConflictBadge, ScopeBadge } from '../shared/badges'
import { ChevronDown, ChevronUp } from 'lucide-react'

interface RuleItem {
  text: string
  scope: string
  target: string
  conflicts: Array<{ existingRule: string; conflictType: string }> | null
}

interface ExtractedRulesPanelProps {
  rules: RuleItem[]
  selectedIds: Set<number>
  onToggleSelect: (index: number) => void
  onSelectAll: () => void
  onDeselectAll: () => void
}

export function ExtractedRulesPanel({
  rules,
  selectedIds,
  onToggleSelect,
  onSelectAll,
  onDeselectAll,
}: ExtractedRulesPanelProps) {
  const [expandedRules, setExpandedRules] = useState<Set<number>>(new Set())

  const allSelected = selectedIds.size === rules.length && rules.length > 0
  const someSelected = selectedIds.size > 0 && selectedIds.size < rules.length

  const handleToggleExpand = useCallback((index: number) => {
    setExpandedRules((prev) => {
      const next = new Set(prev)
      if (next.has(index)) {
        next.delete(index)
      } else {
        next.add(index)
      }
      return next
    })
  }, [])

  const handleSelectAllChange = useCallback(() => {
    if (allSelected) {
      onDeselectAll()
    } else {
      onSelectAll()
    }
  }, [allSelected, onSelectAll, onDeselectAll])

  const needsTruncation = useCallback((text: string) => {
    return text.length > 160 || text.split('\n').length > 3
  }, [])

  const selectedCount = selectedIds.size
  const totalCount = rules.length

  return (
    <div className="flex flex-col h-full">
      {/* Select all header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-agent-divider bg-agent-surface/50">
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <Checkbox
            checked={allSelected ? true : someSelected ? 'indeterminate' : false}
            onCheckedChange={handleSelectAllChange}
            className="shrink-0"
          />
          <span className="text-sm font-medium text-foreground">全选</span>
        </label>
        <span className="text-xs text-muted-foreground">
          已选 {selectedCount} / 共 {totalCount} 条
        </span>
      </div>

      {/* Rules list */}
      <ScrollArea className="flex-1">
        <div className="space-y-2 p-4">
          {rules.map((rule, index) => {
            const isSelected = selectedIds.has(index)
            const isExpanded = expandedRules.has(index)
            const isTruncated = needsTruncation(rule.text)

            return (
              <div
                key={index}
                className={cn(
                  'rounded-lg border transition-colors',
                  isSelected
                    ? 'border-l-2 border-l-knowledge-primary border-knowledge-primary/30 bg-knowledge-primary-light/30'
                    : 'border-agent-divider bg-agent-surface',
                )}
              >
                <div className="flex items-start gap-3 px-4 py-3">
                  <Checkbox
                    checked={isSelected}
                    onCheckedChange={() => onToggleSelect(index)}
                    className="mt-0.5 shrink-0"
                  />

                  <div className="flex-1 min-w-0 space-y-2">
                    {/* Rule text */}
                    <div className="flex items-start gap-2">
                      <p
                        className={cn(
                          'text-sm leading-relaxed text-foreground flex-1',
                          !isExpanded && isTruncated && 'line-clamp-3',
                        )}
                      >
                        {rule.text}
                      </p>
                      {isTruncated && (
                        <button
                          onClick={() => handleToggleExpand(index)}
                          className="shrink-0 p-0.5 text-muted-foreground hover:text-foreground transition-colors"
                          aria-label={isExpanded ? '收起' : '展开'}
                        >
                          {isExpanded ? (
                            <ChevronUp className="size-3.5" />
                          ) : (
                            <ChevronDown className="size-3.5" />
                          )}
                        </button>
                      )}
                    </div>

                    {/* Badges row */}
                    <div className="flex items-center flex-wrap gap-1.5">
                      <ScopeBadge scope={rule.scope} />
                      {rule.target && (
                        <span className="text-xs text-muted-foreground">
                          {rule.target}
                        </span>
                      )}
                      {rule.conflicts?.map((conflict, idx) => (
                        <ConflictBadge
                          key={idx}
                          conflictType={conflict.conflictType}
                          details={conflict.existingRule}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </ScrollArea>
    </div>
  )
}

/** Skeleton placeholder for ExtractedRulesPanel */
export function ExtractedRulesPanelSkeleton() {
  return (
    <div className="flex flex-col h-full">
      {/* Header skeleton */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-agent-divider">
        <div className="flex items-center gap-2">
          <div className="h-4 w-4 rounded bg-accent animate-pulse" />
          <div className="h-4 w-10 rounded bg-accent animate-pulse" />
        </div>
        <div className="h-3 w-24 rounded bg-accent animate-pulse" />
      </div>

      {/* Cards skeleton */}
      <div className="space-y-2 p-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="rounded-lg border border-agent-divider bg-agent-surface px-4 py-3"
          >
            <div className="flex items-start gap-3">
              <div className="mt-0.5 h-4 w-4 rounded shrink-0 bg-accent animate-pulse" />
              <div className="flex-1 space-y-2.5">
                <div className="space-y-1.5">
                  <div className="h-4 w-full rounded bg-accent animate-pulse" />
                  <div className="h-4 w-4/5 rounded bg-accent animate-pulse" />
                  <div className="h-4 w-2/3 rounded bg-accent animate-pulse" />
                </div>
                <div className="flex gap-2">
                  <div className="h-5 w-14 rounded-full bg-accent animate-pulse" />
                  <div className="h-5 w-20 rounded-full bg-accent animate-pulse" />
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
