"use client"

import { useState, useEffect, useCallback } from "react"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Search, RefreshCw } from "lucide-react"
import { ResourceCard } from "./resource-card"
import { PageState } from "./PageState"
import { UninstallConfirm } from "./UninstallConfirm"
import { listResources, uninstallResource } from "@/lib/resource/api"
import type { ResourceEntry, ResourceType } from "@/lib/resource/types"
import { useResourceOrg } from "./resource-context"

const TYPE_FILTERS: Array<{ label: string; value: ResourceType | "all" }> = [
  { label: "全部", value: "all" },
  { label: "Skills", value: "skill" },
  { label: "Agents", value: "agent" },
  { label: "Workflows", value: "workflow" },
]

export function ResourceList() {
  const org = useResourceOrg()
  const [entries, setEntries] = useState<ResourceEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [typeFilter, setTypeFilter] = useState<ResourceType | "all">("all")
  const [query, setQuery] = useState("")
  const [total, setTotal] = useState(0)
  const [uninstallTarget, setUninstallTarget] = useState<{ name: string; type: ResourceType } | null>(null)
  const [uninstalling, setUninstalling] = useState(false)

  const fetchResources = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await listResources(org, {
        type: typeFilter === "all" ? undefined : typeFilter,
        query: query || undefined,
      })
      setEntries(res.resources)
      setTotal(res.total)
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败")
      setEntries([])
    } finally {
      setLoading(false)
    }
  }, [typeFilter, query])

  useEffect(() => {
    fetchResources()
  }, [fetchResources])

  const handleUninstallConfirm = async () => {
    if (!uninstallTarget) return
    setUninstalling(true)
    try {
      await uninstallResource(org, uninstallTarget.name, uninstallTarget.type)
      setUninstallTarget(null)
      fetchResources()
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

  return (
    <div aria-label="资源列表">
      {/* Filters */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
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
          <Button variant="outline" size="icon" onClick={fetchResources} disabled={loading} aria-label="刷新">
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </Button>
        </div>
      </div>

      {/* Content */}
      {loading && entries.length === 0 ? (
        <PageState status="loading" />
      ) : error ? (
        <PageState status="error" message={error} onRetry={fetchResources} />
      ) : entries.length === 0 ? (
        <PageState
          status="empty"
          title="暂无资源"
          description="安装第一个 Skill、Agent 或 Workflow 开始使用"
          icon={Search}
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {entries.map((entry) => (
              <ResourceCard
                key={`${entry.type}:${entry.name}`}
                entry={entry}
                onUninstall={(name, type) => setUninstallTarget({ name, type })}
              />
            ))}
          </div>
          <div className="mt-4 text-center text-sm text-muted-foreground">
            共 {total} 个资源
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
