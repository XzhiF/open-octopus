"use client"

import { useState, useMemo } from "react"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Search, RefreshCw, ChevronDown, ChevronUp } from "lucide-react"
import { ResourceCard } from "./resource-card"
import { PageState } from "./PageState"
import { UninstallConfirm } from "./UninstallConfirm"
import { uninstallResource } from "@/lib/resource/api"
import type { ResourceType } from "@/lib/resource/types"
import { useResourceOrg } from "./resource-context"
import { useResourceList } from "@/hooks/use-resource-list"

const TYPE_FILTERS: Array<{ label: string; value: ResourceType | "all" }> = [
  { label: "全部", value: "all" },
  { label: "Skills", value: "skill" },
  { label: "Agents", value: "agent" },
  { label: "Workflows", value: "workflow" },
]

export function ResourceList() {
  const org = useResourceOrg()
  const [typeFilter, setTypeFilter] = useState<ResourceType | "all">("all")
  const [query, setQuery] = useState("")
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set())
  const [groupsExpanded, setGroupsExpanded] = useState(false)
  const [uninstallTarget, setUninstallTarget] = useState<{ name: string; type: ResourceType } | null>(null)
  const [uninstalling, setUninstalling] = useState(false)

  const { resources: entries, total, loading, error, refresh } = useResourceList(org, {
    type: typeFilter === "all" ? undefined : typeFilter,
    query: query || undefined,
  })

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

  // Initialize selected groups to all on first load
  const activeGroups = useMemo(() => {
    if (selectedGroups.size === 0 && groups.length > 0) {
      return new Set(groups.map((g) => g.name))
    }
    return selectedGroups
  }, [selectedGroups, groups])

  // Filter entries by selected groups
  const filteredEntries = useMemo(() => {
    if (activeGroups.size === 0 || activeGroups.size === groups.length) return entries
    return entries.filter((e) => activeGroups.has((e as any).group ?? "unknown"))
  }, [entries, activeGroups, groups])

  const handleGroupToggle = (group: string) => {
    const next = new Set(activeGroups)
    if (next.has(group)) {
      next.delete(group)
    } else {
      next.add(group)
    }
    setSelectedGroups(next)
  }

  const handleSelectAll = () => {
    setSelectedGroups(new Set(groups.map((g) => g.name)))
  }

  const handleSelectNone = () => {
    setSelectedGroups(new Set())
  }

  const handleUninstallConfirm = async () => {
    if (!uninstallTarget) return
    setUninstalling(true)
    try {
      await uninstallResource(org, uninstallTarget.name, uninstallTarget.type)
      setUninstallTarget(null)
      refresh()
    } catch {
      // Error handled by PageState on next fetch
    } finally {
      setUninstalling(false)
    }
  }

  const counts = {
    all: entries.length,
    skill: entries.filter((e) => e.type === "skill").length,
    agent: entries.filter((e) => e.type === "agent").length,
    workflow: entries.filter((e) => e.type === "workflow").length,
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
              onClick={() => setTypeFilter(f.value)}
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
              onChange={(e) => setQuery(e.target.value)}
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
      {groups.length > 1 && (
        <div className="mb-4 rounded-lg border border-border bg-muted/30 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">组过滤</span>
            <div className="flex gap-2">
              <button onClick={handleSelectAll} className="text-xs text-primary hover:underline">全选</button>
              <span className="text-xs text-muted-foreground">|</span>
              <button onClick={handleSelectNone} className="text-xs text-primary hover:underline">全不选</button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {visibleGroups.map((g) => (
              <label
                key={g.name}
                className={cn(
                  "inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors",
                  activeGroups.has(g.name)
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border bg-background text-muted-foreground hover:border-primary/50"
                )}
              >
                <input
                  type="checkbox"
                  checked={activeGroups.has(g.name)}
                  onChange={() => handleGroupToggle(g.name)}
                  className="sr-only"
                />
                {g.name}
                <Badge variant="secondary" className="ml-0.5 h-4 px-1 text-[10px]">
                  {g.count}
                </Badge>
              </label>
            ))}
            {groups.length > GROUP_COLLAPSE_THRESHOLD && (
              <button
                onClick={() => setGroupsExpanded(!groupsExpanded)}
                className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-3 py-1 text-xs text-muted-foreground hover:text-foreground"
              >
                {groupsExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
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
            {filteredEntries.map((entry) => (
              <ResourceCard
                key={`${entry.type}:${(entry as any).group ?? ""}:${entry.name}`}
                entry={entry}
                onUninstall={(name, type) => setUninstallTarget({ name, type })}
              />
            ))}
          </div>
          <div className="mt-4 text-center text-sm text-muted-foreground">
            共 {filteredEntries.length} 个资源{activeGroups.size < groups.length && ` (已选 ${activeGroups.size}/${groups.length} 组)`}
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
