'use client'

/**
 * Review queue with filtering, pagination, and batch operations.
 */

import { useState, useCallback } from 'react'
import { RefreshCw, CheckCircle, ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { useReviewQueue } from '@/hooks/useReviewQueue'
import { useOrgs } from '@/hooks/useOrgs'
import { reviewAction, batchReview } from '@/lib/knowledge/api'
import type { BatchReviewResponse } from '@/lib/knowledge/types'
import { AgentEmptyState } from '@/components/agent/shared/AgentEmptyState'
import { ReviewFilterBar } from './ReviewFilterBar'
import { ReviewItemCard, ReviewItemCardSkeleton } from './ReviewItemCard'
import { BatchActionBar } from './BatchActionBar'

const PAGE_SIZE = 20

export function ReviewQueueList() {
  const {
    items,
    loading,
    error,
    selectedIds,
    toggleSelect,
    clearSelection,
    statusFilter,
    setStatusFilter,
    refetch,
    page,
    setPage,
    total,
    statusCounts,
  } = useReviewQueue(PAGE_SIZE)

  const { orgs } = useOrgs()
  const currentOrg = orgs[0]?.name

  const [batchLoading, setBatchLoading] = useState(false)

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  // ── Single-item action ──────────────────────────────────────────────────────
  const handleAction = useCallback(
    async (id: string, action: string, content?: string) => {
      if (action === 'edit') {
        if (!content) return
        try {
          await reviewAction(id, 'edit', content, undefined, currentOrg)
          toast.success('规则内容已更新')
          refetch()
        } catch (err) {
          toast.error(err instanceof Error ? err.message : '更新失败')
        }
        return
      }

      try {
        await reviewAction(id, action, undefined, undefined, currentOrg)

        const messages: Record<string, string> = {
          approve: '规则已纳入',
          reject: '规则已拒绝',
          defer: '规则已暂缓',
        }

        if (action === 'defer') {
          toast.info(messages[action] ?? '操作成功')
        } else {
          toast.success(messages[action] ?? '操作成功')
        }

        refetch()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : '操作失败')
      }
    },
    [refetch, currentOrg],
  )

  // ── Batch approve ───────────────────────────────────────────────────────────
  const handleBatchApprove = useCallback(async () => {
    setBatchLoading(true)
    try {
      const result: BatchReviewResponse = await batchReview(
        Array.from(selectedIds),
        'approve',
        currentOrg,
      )
      toast.success(`${result.succeeded} 条规则已纳入`)
      if (result.failed > 0) {
        toast.warning(`${result.failed} 条纳入失败`)
      }
      clearSelection()
      refetch()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '批量操作失败')
    } finally {
      setBatchLoading(false)
    }
  }, [selectedIds, clearSelection, refetch, currentOrg])

  // ── Batch reject ────────────────────────────────────────────────────────────
  const handleBatchReject = useCallback(async () => {
    setBatchLoading(true)
    try {
      const result: BatchReviewResponse = await batchReview(
        Array.from(selectedIds),
        'reject',
        currentOrg,
      )
      toast.success(`${result.succeeded} 条规则已拒绝`)
      if (result.failed > 0) {
        toast.warning(`${result.failed} 条拒绝失败`)
      }
      clearSelection()
      refetch()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '批量操作失败')
    } finally {
      setBatchLoading(false)
    }
  }, [selectedIds, clearSelection, refetch, currentOrg])

  // ── Error state with retry ──────────────────────────────────────────────────
  if (error && !loading && items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 px-4 text-center gap-4">
        <AgentEmptyState
          icon={RefreshCw}
          title="加载失败"
          description={error}
          actionLabel="重试"
          onAction={refetch}
        />
      </div>
    )
  }

  return (
    <div className="flex h-full">
      <div className="flex flex-col flex-1 min-w-0">
      {/* Filter bar */}
      <ReviewFilterBar
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        total={total}
        statusCounts={statusCounts}
      />

      {/* List area */}
      <div className="flex-1 overflow-auto">
        {/* Loading state */}
        {loading && items.length === 0 && (
          <div className="p-4 space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <ReviewItemCardSkeleton key={i} />
            ))}
          </div>
        )}

        {/* Empty state */}
        {!loading && items.length === 0 && (
          <AgentEmptyState
            icon={CheckCircle}
            title="暂无待审核项"
            description="工作流执行后产生的新规则和新 Skill 会自动进入审核队列。"
          />
        )}

        {/* Items list */}
        {items.length > 0 && (
          <div className="p-4 space-y-3">
            {items.map((item) => (
              <ReviewItemCard
                key={item.id}
                item={item}
                isSelected={selectedIds.has(item.id)}
                onToggleSelect={toggleSelect}
                onAction={handleAction}
              />
            ))}
          </div>
        )}
      </div>

      {/* Pagination */}
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-agent-divider">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-xs"
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
          >
            <ChevronLeft className="size-3.5" />
            上一页
          </Button>
          <span className="text-xs text-muted-foreground">
            {page} / {totalPages}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-xs"
            disabled={page >= totalPages}
            onClick={() => setPage(page + 1)}
          >
            下一页
            <ChevronRight className="size-3.5" />
          </Button>
        </div>
      )}

      {/* Batch action bar */}
      <BatchActionBar
        selectedCount={selectedIds.size}
        onBatchApprove={handleBatchApprove}
        onBatchReject={handleBatchReject}
        onClearSelection={clearSelection}
        loading={batchLoading}
      />
      </div>
    </div>
  )
}
