"use client"

import { useState, useEffect, useCallback } from "react"
import { BookOpen, Search, Tag } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { searchLessons } from "@/lib/archive-api"
import type { ExperienceItem, ExperienceType, ExperienceStatus } from "@octopus/shared"

const typeConfig: Record<ExperienceType, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  bug: { label: "Bug", variant: "destructive" },
  pattern: { label: "模式", variant: "default" },
  cost: { label: "成本", variant: "secondary" },
  failure: { label: "故障", variant: "outline" },
}

const statusConfig: Record<ExperienceStatus, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  active: { label: "活跃", variant: "default" },
  resolved: { label: "已解决", variant: "secondary" },
  obsolete: { label: "过时", variant: "outline" },
  superseded: { label: "已替代", variant: "outline" },
}

function LessonCard({ item }: { item: ExperienceItem }) {
  const type = typeConfig[item.type] ?? { label: item.type, variant: "outline" as const }
  const status = statusConfig[item.status] ?? { label: item.status, variant: "outline" as const }

  return (
    <div className="rounded-lg border p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium leading-snug">{item.title}</p>
        <div className="flex shrink-0 items-center gap-1">
          <Badge variant={type.variant} className="text-[10px]">{type.label}</Badge>
          <Badge variant={status.variant} className="text-[10px]">{status.label}</Badge>
        </div>
      </div>
      <p className="text-xs text-muted-foreground line-clamp-3">{item.content}</p>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {item.workflow_name && (
          <span className="truncate">{item.workflow_name}</span>
        )}
        {item.keywords && item.keywords.length > 0 && (
          <div className="flex items-center gap-1">
            <Tag className="h-3 w-3" />
            <span className="truncate">{item.keywords.slice(0, 3).join(", ")}</span>
          </div>
        )}
        <span className="ml-auto tabular-nums">
          引用 {item.use_count} 次
        </span>
      </div>
    </div>
  )
}

export function ExperienceSearch() {
  const [items, setItems] = useState<ExperienceItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [typeFilter, setTypeFilter] = useState<string>("all")
  const [initialLoaded, setInitialLoaded] = useState(false)

  const doSearch = useCallback(async (q: string, t: string) => {
    setLoading(true)
    setError(null)
    try {
      const result = await searchLessons({
        q: q || undefined,
        type: t === "all" ? undefined : t,
        limit: 20,
      })
      setItems(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : "搜索失败")
    } finally {
      setLoading(false)
      setInitialLoaded(true)
    }
  }, [])

  // Load initial data
  useEffect(() => {
    doSearch("", "all")
  }, [doSearch])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    doSearch(query, typeFilter)
  }

  return (
    <Card role="region" aria-label="经验搜索">
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <BookOpen className="h-4 w-4" />
            经验教训
          </CardTitle>
        </div>
        <form onSubmit={handleSubmit} className="flex items-center gap-2 mt-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="搜索经验..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-8 pl-8 text-xs"
            />
          </div>
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger size="sm" className="h-8 text-xs">
              <SelectValue placeholder="全部类型" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部类型</SelectItem>
              <SelectItem value="bug">Bug</SelectItem>
              <SelectItem value="pattern">模式</SelectItem>
              <SelectItem value="cost">成本</SelectItem>
              <SelectItem value="failure">故障</SelectItem>
            </SelectContent>
          </Select>
          <Button type="submit" size="sm" variant="outline" className="h-8 text-xs" disabled={loading}>
            搜索
          </Button>
        </form>
      </CardHeader>
      <CardContent className="space-y-3">
        {!initialLoaded || loading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
        ) : error ? (
          <div className="py-8 text-center">
            <p className="text-sm text-destructive">{error}</p>
            <Button variant="ghost" size="sm" className="mt-2" onClick={() => doSearch(query, typeFilter)}>
              重试
            </Button>
          </div>
        ) : items.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            暂无经验数据
          </div>
        ) : (
          items.map((item) => (
            <LessonCard key={item.id} item={item} />
          ))
        )}
      </CardContent>
    </Card>
  )
}
