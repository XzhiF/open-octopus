'use client'

import { useState, useEffect, useCallback } from 'react'
import type { PendingItem, ReviewFilter, ReviewStatusFilter, ReviewListResponse, ReviewStatusCounts } from '@/lib/knowledge/types'
import * as api from '@/lib/knowledge/api'

const DEFAULT_PAGE_SIZE = 20

export function useReviewQueue(pageSize: number = DEFAULT_PAGE_SIZE) {
  const [items, setItems] = useState<PendingItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState<ReviewFilter>('all')
  const [statusFilter, setStatusFilter] = useState<ReviewStatusFilter>('all')
  const [statusCounts, setStatusCounts] = useState<ReviewStatusCounts>({
    all: 0, pending: 0, deferred: 0, approved: 0, rejected: 0, edited: 0,
  })

  const fetchItems = useCallback(async (currentPage: number, currentFilter: ReviewFilter, currentStatus: ReviewStatusFilter) => {
    try {
      setLoading(true)
      setError(null)
      const params: { type?: string; status?: string; page: number; pageSize: number } = {
        page: currentPage,
        pageSize,
      }
      if (currentFilter !== 'all') {
        params.type = currentFilter
      }
      if (currentStatus !== 'all') {
        params.status = currentStatus
      }
      const res: ReviewListResponse = await api.getPendingReviews(params)
      setItems(res.data)
      setTotal(res.total)
      // Fetch status counts in parallel (lightweight summary endpoint)
      api.getReviewSummary().then((summary) => {
        if (summary.statusCounts) setStatusCounts(summary.statusCounts)
      }).catch(() => { /* counts are supplementary, ignore errors */ })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load pending reviews')
    } finally {
      setLoading(false)
    }
  }, [pageSize])

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }, [])

  const selectAll = useCallback(() => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      for (const item of items) {
        next.add(item.id)
      }
      return next
    })
  }, [items])

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set())
  }, [])

  const refetch = useCallback(() => {
    return fetchItems(page, filter, statusFilter)
  }, [fetchItems, page, filter, statusFilter])

  // Re-fetch when page, filter, or statusFilter changes
  useEffect(() => {
    fetchItems(page, filter, statusFilter)
  }, [fetchItems, page, filter, statusFilter])

  // Reset to page 1 when filter changes
  const changeFilter = useCallback((newFilter: ReviewFilter) => {
    setFilter(newFilter)
    setPage(1)
    setSelectedIds(new Set())
  }, [])

  const changeStatusFilter = useCallback((newStatus: ReviewStatusFilter) => {
    setStatusFilter(newStatus)
    setPage(1)
    setSelectedIds(new Set())
  }, [])

  const pendingCount = total

  return {
    items,
    loading,
    error,
    selectedIds,
    toggleSelect,
    selectAll,
    clearSelection,
    filter,
    setFilter: changeFilter,
    statusFilter,
    setStatusFilter: changeStatusFilter,
    pendingCount,
    refetch,
    page,
    setPage,
    total,
    statusCounts,
  }
}
