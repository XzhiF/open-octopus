'use client'

import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { VersionDetail } from './VersionDetail'
import type { AgentVersionInfo, VersionStage, AgentVersionStatus } from '@/lib/agent/types'

// ── Badge configs ──────────────────────────────────────────────────

const stageConfig: Record<VersionStage, { label: string; className: string }> = {
  alpha: { label: 'Alpha', className: 'bg-orange-50 text-orange-700 border-orange-200' },
  beta: { label: 'Beta', className: 'bg-blue-50 text-blue-700 border-blue-200' },
  rc: { label: 'RC', className: 'bg-purple-50 text-purple-700 border-purple-200' },
  stable: { label: 'Stable', className: 'bg-green-50 text-green-700 border-green-200' },
}

const statusConfig: Record<AgentVersionStatus, { label: string; className: string }> = {
  draft: { label: '草稿', className: 'bg-muted text-muted-foreground' },
  published: { label: '已发布', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  archived: { label: '已归档', className: 'bg-gray-50 text-gray-500 border-gray-200' },
}

// ── Helpers ────────────────────────────────────────────────────────

function formatDate(dateStr?: string): string {
  if (!dateStr) return '—'
  try {
    const date = new Date(dateStr)
    return date.toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return dateStr
  }
}

// ── Component ──────────────────────────────────────────────────────

interface VersionListProps {
  versions: AgentVersionInfo[]
  onRollback: (version: string) => void
  onArchive: (version: string) => void
  onCompare: (from: string, to: string) => void
}

export function VersionList({ versions, onRollback, onArchive, onCompare }: VersionListProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [selectedForCompare, setSelectedForCompare] = useState<string[]>([])

  function toggleExpand(id: string) {
    setExpandedId((prev) => (prev === id ? null : id))
  }

  function toggleCompareSelection(version: string) {
    setSelectedForCompare((prev) => {
      if (prev.includes(version)) {
        return prev.filter((v) => v !== version)
      }
      // Keep max 2 selections
      if (prev.length >= 2) {
        return [prev[1], version]
      }
      return [...prev, version]
    })
  }

  function handleCompare() {
    if (selectedForCompare.length === 2) {
      onCompare(selectedForCompare[0], selectedForCompare[1])
    }
  }

  if (versions.length === 0) {
    return (
      <div className="text-center py-12 text-sm text-muted-foreground">
        暂无版本记录。点击"发布新版本"创建第一个快照。
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Compare toolbar */}
      {selectedForCompare.length > 0 && (
        <div className="flex items-center justify-between bg-muted/50 rounded-md px-3 py-2">
          <span className="text-xs text-muted-foreground">
            已选 {selectedForCompare.length}/2 个版本进行对比
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={handleCompare}
            disabled={selectedForCompare.length !== 2}
            className="gap-1.5"
          >
            开始对比
          </Button>
        </div>
      )}

      {/* Version rows */}
      <div className="space-y-1">
        {versions.map((v) => {
          const isExpanded = expandedId === v.id
          const isArchived = v.status === 'archived'
          const isSelected = selectedForCompare.includes(v.version)

          return (
            <div
              key={v.id}
              className={cn(
                'rounded-md border border-agent-divider transition-colors',
                isExpanded && 'border-agent-primary/30 bg-agent-primary/5',
                isArchived && 'opacity-60',
              )}
            >
              {/* Row header */}
              <div
                className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-muted/50 transition-colors"
                onClick={() => toggleExpand(v.id)}
              >
                {/* Compare checkbox */}
                {!isArchived && (
                  <Checkbox
                    checked={isSelected}
                    onCheckedChange={() => toggleCompareSelection(v.version)}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={`选择 ${v.version} 进行对比`}
                  />
                )}

                {/* Expand icon */}
                {isExpanded ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                )}

                {/* Version string */}
                <span className="text-sm font-mono font-medium min-w-[100px]">
                  {v.version}
                </span>

                {/* Stage badge */}
                <Badge
                  variant="outline"
                  className={cn('text-xs', stageConfig[v.stage].className)}
                >
                  {stageConfig[v.stage].label}
                </Badge>

                {/* Status badge */}
                <Badge
                  variant="outline"
                  className={cn('text-xs', statusConfig[v.status].className)}
                >
                  {statusConfig[v.status].label}
                </Badge>

                {/* Changelog preview */}
                {v.changelog && (
                  <span className="text-xs text-muted-foreground truncate flex-1">
                    {v.changelog}
                  </span>
                )}

                {/* Published date */}
                <span className="text-xs text-muted-foreground shrink-0 ml-auto">
                  {formatDate(v.published_at || v.created_at)}
                </span>
              </div>

              {/* Expanded detail */}
              {isExpanded && (
                <VersionDetail
                  version={v}
                  onRollback={onRollback}
                  onArchive={onArchive}
                  onViewDiff={(ver) => {
                    // When clicking "diff with..." from detail, pre-fill this version as "to"
                    onCompare('', ver)
                  }}
                  isArchived={isArchived}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
