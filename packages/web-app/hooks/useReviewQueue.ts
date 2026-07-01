'use client'

import { useState, useEffect, useCallback } from 'react'
import type { PendingItem, ReviewFilter, ReviewListResponse } from '@/lib/knowledge/types'
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

  const fetchItems = useCallback(async (currentPage: number, currentFilter: ReviewFilter) => {
    try {
      setLoading(true)
      setError(null)
      const params: { type?: string; page: number; pageSize: number } = {
        page: currentPage,
        pageSize,
      }
      if (currentFilter !== 'all') {
        params.type = currentFilter
      }
      const res: ReviewListResponse = await api.getPendingReviews(params)
      setItems(res.data)
      setTotal(res.total)
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
    // Select all items across pages — use total count
    // Since we can't know all IDs without fetching every page,
    // we select all IDs from the current page and mark "select all" semantically.
    // The consumer can use selectedIds.size === total to detect full selection.
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
    return fetchItems(page, filter)
  }, [fetchItems, page, filter])

  // Re-fetch when page or filter changes
  useEffect(() => {
    fetchItems(page, filter)
  }, [fetchItems, page, filter])

  // Reset to page 1 when filter changes
  const changeFilter = useCallback((newFilter: ReviewFilter) => {
    setFilter(newFilter)
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
    pendingCount,
    refetch,
    page,
    setPage,
    total,
  }
}
