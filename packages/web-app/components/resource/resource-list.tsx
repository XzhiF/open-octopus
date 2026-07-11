"use client"

import { useState, useMemo, useEffect } from "react"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Search, RefreshCw, ChevronDown, ChevronUp } from "lucide-react"
import { ResourceCard } from "./resource-card"
import { PageState } from "./PageState"
import { UninstallConfirm } from "./UninstallConfirm"
import { uninstallResource } from "@/lib/resource/api"
import type { ResourceType } from "@/lib/resource/types"
import { useResourceList } from "@/hooks/use-resource-list"

const TYPE_FILTERS: Array<{ label: string; value: ResourceType | "all" }> = [
  { label: "全部", value: "all" },
  { label: "Skills", value: "skill" },
  { label: "Agents", value: "agent" },
  { label: "Workflows", value: "workflow" },
]

const STORAGE_KEY = "resource-list-state"

interface ListState {
  typeFilter: ResourceType | "all"
  query: string
  selectedGroups: string[] | null
  page: number
}

function loadState(): ListState {
  if (typeof window === "undefined") {
    return { typeFilter: "all", query: "", selectedGroups: null, page: 1 }
  }
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored)
      return {
        typeFilter: parsed.typeFilter || "all",
        query: parsed.query || "",
        selectedGroups: parsed.selectedGroups || null,
        page: parsed.page || 1,
      }
    }
  } catch {}
  return { typeFilter: "all", query: "", selectedGroups: null, page: 1 }
}

function saveState(state: ListState) {
  if (typeof window === "undefined") return
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {}
}

export function ResourceList() {
  const [typeFilter, setTypeFilter] = useState<ResourceType | "all">(() => loadState().typeFilter)
  const [query, setQuery] = useState(() => loadState().query)
  const [selectedGroups, setSelectedGroups] = useState<Set<string> | null>(() => {
    const stored = loadState().selectedGroups
    return stored ? new Set(stored) : null
  })
  const [groupsExpanded, setGroupsExpanded] = useState(false)
  const [uninstallTarget, setUninstallTarget] = useState<{ name: string; type: ResourceType } | null>(null)
  const [uninstalling, setUninstalling] = useState(false)
  const [page, setPage] = useState(() => loadState().page)

  // Save state to sessionStorage whenever it changes
  useEffect(() => {
    saveState({
      typeFilter,
      query,
      selectedGroups: selectedGroups ? Array.from(selectedGroups) : null,
      page,
    })
  }, [typeFilter, query, selectedGroups, page])

  // Always fetch all types — filter client-side so counts stay accurate
  const { resources: allEntries, loading, error, refresh } = useResourceList({
    query: query || undefined,
  })

  // Type counts from full dataset
  const counts = useMemo(() => ({
    all: allEntries.length,
    skill: allEntries.filter((e) => e.type === "skill").length,
    agent: allEntries.filter((e) => e.type === "agent").length,
    workflow: allEntries.filter((e) => e.type === "workflow").length,
  }), [allEntries])

  // Apply type filter
  const entries = useMemo(() => {
    if (typeFilter === "all") return allEntries
    return allEntries.filter((e) => e.type === typeFilter)
  }, [allEntries, typeFilter])

  // Extract unique groups with counts
  const groups = useMemo(() => {
    const map = new Map<string, number>()
    for (const e of entries) {
      const g = (e as any).group ?? "unknown"
      map.set(g, (map.get(g) ?? 0) + 1)
    }
    return Array.from(map.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
  }, [entries])

  // null = uninitialized (show all). Empty Set = user explicitly deselected all.
  const activeGroups = useMemo(() => {
    if (selectedGroups === null && groups.length > 0) {
      return new Set(groups.map((g) => g.name))
    }
    return selectedGroups ?? new Set<string>()
  }, [selectedGroups, groups])

  // Filter entries by selected groups
  const filteredEntries = useMemo(() => {
    if (activeGroups.size === 0 || activeGroups.size === groups.length) return entries
    return entries.filter((e) => activeGroups.has((e as any).group ?? "unknown"))
  }, [entries, activeGroups, groups])

  // Pagination
  const PAGE_SIZE = 24
  const totalPages = Math.max(1, Math.ceil(filteredEntries.length / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const paginatedEntries = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE
    return filteredEntries.slice(start, start + PAGE_SIZE)
  }, [filteredEntries, currentPage])

  // Reset page when filters change
  const handleTypeFilter = (v: ResourceType | "all") => { setTypeFilter(v); setPage(1) }
  const handleQueryChange = (v: string) => { setQuery(v); setPage(1) }

  const handleGroupToggle = (group: string) => {
    const base = selectedGroups ?? new Set(groups.map((g) => g.name))
    const next = new Set(base)
    if (next.has(group)) {
      next.delete(group)
    } else {
      next.add(group)
    }
    setSelectedGroups(next)
    setPage(1)
  }

  const handleSelectAll = () => {
    setSelectedGroups(new Set(groups.map((g) => g.name)))
    setPage(1)
  }

  const handleSelectNone = () => {
    setSelectedGroups(new Set())
    setPage(1)
  }

  const handleUninstallConfirm = async () => {
    if (!uninstallTarget) return
    setUninstalling(true)
    try {
      await uninstallResource(uninstallTarget.name, uninstallTarget.type)
      setUninstallTarget(null)
      refresh()
    } catch {
      // Error handled by PageState on next fetch
    } finally {
      setUninstalling(false)
    }
  }

  const GROUP_COLLAPSE_THRESHOLD = 5
  const visibleGroups = groupsExpanded ? groups : groups.slice(0, GROUP_COLLAPSE_THRESHOLD)

  return (
    <div aria-label="资源列表">
      {/* Type filters */}
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-1" role="tablist" aria-label="资源类型过滤">
          {TYPE_FILTERS.map((f) => (
            <Button
              key={f.value}
              role="tab"
              aria-selected={typeFilter === f.value}
              variant={typeFilter === f.value ? "default" : "outline"}
              size="sm"
              onClick={() => handleTypeFilter(f.value)}
            >
              {f.label}
              {f.value !== "all" && (
                <span className="ml-1.5 rounded-full bg-background/20 px-1.5 text-xs">
                  {counts[f.value]}
                </span>
              )}
            </Button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="搜索资源..."
              value={query}
              onChange={(e) => handleQueryChange(e.target.value)}
              className="w-64 pl-9"
              aria-label="搜索资源"
            />
          </div>
          <Button variant="outline" size="icon" onClick={refresh} disabled={loading} aria-label="刷新">
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </Button>
        </div>
      </div>

      {/* Group filter */}
      {groups.length > 0 && (
        <div className="mb-4 rounded-lg border border-border bg-card p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium text-foreground">分组</span>
            <div className="flex items-center gap-3">
              <button
                onClick={handleSelectAll}
                className="text-xs text-muted-foreground hover:text-primary transition-colors"
              >
                全选
              </button>
              <button
                onClick={handleSelectNone}
                className="text-xs text-muted-foreground hover:text-primary transition-colors"
              >
                清除
              </button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {visibleGroups.map((g) => (
              <label
                key={g.name}
                className={cn(
                  "inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition-colors",
                  activeGroups.has(g.name)
                    ? "border-primary bg-primary/5 text-foreground"
                    : "border-border bg-background text-muted-foreground hover:border-primary/40"
                )}
              >
                <Checkbox
                  checked={activeGroups.has(g.name)}
                  onCheckedChange={() => handleGroupToggle(g.name)}
                />
                <span>{g.name}</span>
                <Badge variant="secondary" className="h-5 px-1.5 text-[11px]">
                  {g.count}
                </Badge>
              </label>
            ))}
            {groups.length > GROUP_COLLAPSE_THRESHOLD && (
              <button
                onClick={() => setGroupsExpanded(!groupsExpanded)}
                className="inline-flex items-center gap-1 rounded-md border border-dashed border-border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                {groupsExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                {groupsExpanded ? "收起" : `+${groups.length - GROUP_COLLAPSE_THRESHOLD} 更多`}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Content */}
      {loading && entries.length === 0 ? (
        <PageState status="loading" />
      ) : error ? (
        <PageState status="error" message={error} onRetry={refresh} />
      ) : filteredEntries.length === 0 ? (
        <PageState
          status="empty"
          title={entries.length === 0 ? "暂无资源" : "无匹配资源"}
          description={entries.length === 0 ? "安装第一个 Skill、Agent 或 Workflow 开始使用" : "尝试切换组或修改搜索条件"}
          icon={Search}
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {paginatedEntries.map((entry) => (
              <ResourceCard
                key={`${entry.type}:${(entry as any).group ?? ""}:${entry.name}`}
                entry={entry}
                onUninstall={(name, type) => setUninstallTarget({ name, type })}
              />
            ))}
          </div>

          {/* Pagination */}
          <div className="mt-4 flex items-center justify-between">
            <span className="text-sm text-muted-foreground">
              共 {filteredEntries.length} 个{activeGroups.size < groups.length && ` (已选 ${activeGroups.size}/${groups.length} 组)`}
              {totalPages > 1 && `，第 ${currentPage}/${totalPages} 页`}
            </span>
            {totalPages > 1 && (
              <div className="flex items-center gap-1">
                <Button
                  variant="outline" size="sm"
                  disabled={currentPage <= 1}
                  onClick={() => setPage(1)}
                >
                  首页
                </Button>
                <Button
                  variant="outline" size="sm"
                  disabled={currentPage <= 1}
                  onClick={() => setPage(currentPage - 1)}
                >
                  上一页
                </Button>
                {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                  // Show pages around current page
                  let p: number
                  if (totalPages <= 5) {
                    p = i + 1
                  } else if (currentPage <= 3) {
                    p = i + 1
                  } else if (currentPage >= totalPages - 2) {
                    p = totalPages - 4 + i
                  } else {
                    p = currentPage - 2 + i
                  }
                  return (
                    <Button
                      key={p}
                      variant={p === currentPage ? "default" : "outline"}
                      size="sm"
                      onClick={() => setPage(p)}
                    >
                      {p}
                    </Button>
                  )
                })}
                <Button
                  variant="outline" size="sm"
                  disabled={currentPage >= totalPages}
                  onClick={() => setPage(currentPage + 1)}
                >
                  下一页
                </Button>
                <Button
                  variant="outline" size="sm"
                  disabled={currentPage >= totalPages}
                  onClick={() => setPage(totalPages)}
                >
                  末页
                </Button>
              </div>
            )}
          </div>
        </>
      )}

      <UninstallConfirm
        open={!!uninstallTarget}
        onOpenChange={(open) => !open && setUninstallTarget(null)}
        name={uninstallTarget?.name || ""}
        type={uninstallTarget?.type || "skill"}
        onConfirm={handleUninstallConfirm}
        loading={uninstalling}
      />
    </div>
  )
}
