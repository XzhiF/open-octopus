"use client"

import { useState, useEffect, useCallback } from "react"
import { Search, X } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"

interface Filters {
  search?: string
  status?: "enabled" | "disabled" | "failed"
  job_type?: "workflow" | "agent"
  workspace_id?: string
}

interface FilterBarProps {
  filters: Filters
  onFilterChange: (filters: Partial<Filters>) => void
  onClear: () => void
  workspaces: { id: string; name: string }[]
  dashboardRange?: "all" | "24h" | "7d" | "30d"
  onDashboardRangeChange?: (range: "all" | "24h" | "7d" | "30d") => void
}

const DEBOUNCE_MS = 300

export function FilterBar({
  filters,
  onFilterChange,
  onClear,
  workspaces,
  dashboardRange,
  onDashboardRangeChange,
}: FilterBarProps) {
  const [searchInput, setSearchInput] = useState(filters.search ?? "")

  useEffect(() => {
    setSearchInput(filters.search ?? "")
  }, [filters.search])

  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchInput !== (filters.search ?? "")) {
        onFilterChange({ search: searchInput || undefined })
      }
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchInput, filters.search, onFilterChange])

  const hasActiveFilters =
    !!filters.search ||
    !!filters.status ||
    !!filters.job_type ||
    !!filters.workspace_id

  const handleStatusChange = useCallback(
    (value: string) => {
      onFilterChange({
        status: value === "all" ? undefined : (value as Filters["status"]),
      })
    },
    [onFilterChange]
  )

  const handleTypeChange = useCallback(
    (value: string) => {
      onFilterChange({
        job_type:
          value === "all" ? undefined : (value as Filters["job_type"]),
      })
    },
    [onFilterChange]
  )

  const handleWorkspaceChange = useCallback(
    (value: string) => {
      onFilterChange({ workspace_id: value === "all" ? undefined : value })
    },
    [onFilterChange]
  )

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-3 py-4"
      )}
      role="search"
      aria-label="筛选调度任务"
    >
      <div className="relative flex-1 min-w-[200px] max-w-xs">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
        <Input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="搜索任务名称..."
          className="pl-8"
          aria-label="搜索任务"
        />
      </div>

      <Select
        value={filters.status ?? "all"}
        onValueChange={handleStatusChange}
      >
        <SelectTrigger size="sm" aria-label="按状态筛选">
          <SelectValue placeholder="全部状态" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">全部状态</SelectItem>
          <SelectItem value="enabled">已启用</SelectItem>
          <SelectItem value="disabled">已暂停</SelectItem>
          <SelectItem value="failed">失败</SelectItem>
        </SelectContent>
      </Select>

      <Select
        value={filters.job_type ?? "all"}
        onValueChange={handleTypeChange}
      >
        <SelectTrigger size="sm" aria-label="按类型筛选">
          <SelectValue placeholder="全部类型" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">全部类型</SelectItem>
          <SelectItem value="workflow">Workflow</SelectItem>
          <SelectItem value="agent">Agent</SelectItem>
        </SelectContent>
      </Select>

      {workspaces.length > 0 && (
        <Select
          value={filters.workspace_id ?? "all"}
          onValueChange={handleWorkspaceChange}
        >
          <SelectTrigger size="sm" aria-label="按 Workspace 筛选">
            <SelectValue placeholder="全部 Workspace" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部 Workspace</SelectItem>
            {workspaces.map((ws) => (
              <SelectItem key={ws.id} value={ws.id}>
                {ws.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {onDashboardRangeChange && (
        <Select
          value={dashboardRange ?? "all"}
          onValueChange={(v) => onDashboardRangeChange?.(v as "all" | "24h" | "7d" | "30d")}
        >
          <SelectTrigger size="sm" aria-label="仪表盘时间范围">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部时间</SelectItem>
            <SelectItem value="24h">24 小时</SelectItem>
            <SelectItem value="7d">7 天</SelectItem>
            <SelectItem value="30d">30 天</SelectItem>
          </SelectContent>
        </Select>
      )}

      {hasActiveFilters && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onClear}
          aria-label="清除所有筛选"
          className="text-muted-foreground"
        >
          <X className="size-4" />
          清除
        </Button>
      )}
    </div>
  )
}
