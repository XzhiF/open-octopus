"use client"

import { useState, useEffect, useCallback } from "react"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Search, RefreshCw } from "lucide-react"
import { ResourceCard } from "./resource-card"
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

  const handleUninstall = async (name: string, type: ResourceType) => {
    if (!confirm(`确认卸载 ${type}:${name}？`)) return
    try {
      await uninstallResource(org, name, type)
      fetchResources()
    } catch (err) {
      alert(err instanceof Error ? err.message : "卸载失败")
    }
  }

  const counts = {
    all: entries.length,
    skill: entries.filter((e) => e.type === "skill").length,
    agent: entries.filter((e) => e.type === "agent").length,
    workflow: entries.filter((e) => e.type === "workflow").length,
  }

  return (
    <div>
      {/* Filters */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-1">
          {TYPE_FILTERS.map((f) => (
            <Button
              key={f.value}
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
            />
          </div>
          <Button variant="outline" size="icon" onClick={fetchResources} disabled={loading}>
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            <span className="sr-only">刷新</span>
          </Button>
        </div>
      </div>

      {/* Content */}
      {loading && entries.length === 0 ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
          加载中...
        </div>
      ) : error ? (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
        </div>
      ) : entries.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
          <Search className="mb-3 h-8 w-8 opacity-50" />
          <p className="font-medium">暂无资源</p>
          <p className="text-sm">安装第一个 Skill、Agent 或 Workflow 开始使用</p>
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {entries.map((entry) => (
              <ResourceCard
                key={`${entry.type}:${entry.name}`}
                entry={entry}
                onUninstall={handleUninstall}
              />
            ))}
          </div>
          <div className="mt-4 text-center text-sm text-muted-foreground">
            共 {total} 个资源
          </div>
        </>
      )}
    </div>
  )
}
