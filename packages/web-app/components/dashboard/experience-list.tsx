"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { Search, Bug, Wrench, DollarSign, AlertTriangle, ChevronDown, ChevronUp, BookOpen } from "lucide-react"
import { cn } from "@/lib/utils"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyMedia } from "@/components/ui/empty"
import { fetchLessons, type ExperienceLesson } from "@/lib/archive-api"

const typeIcons: Record<ExperienceLesson["type"], typeof Bug> = {
  bug: Bug,
  pattern: Wrench,
  cost: DollarSign,
  failure: AlertTriangle,
}

const typeColors: Record<ExperienceLesson["type"], string> = {
  bug: "text-red-500",
  pattern: "text-blue-500",
  cost: "text-amber-500",
  failure: "text-orange-500",
}

const typeLabels: Record<ExperienceLesson["type"], string> = {
  bug: "缺陷",
  pattern: "模式",
  cost: "成本",
  failure: "故障",
}

export function ExperienceList() {
  const [items, setItems] = useState<ExperienceLesson[]>([])
  const [loading, setLoading] = useState(true)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isInitialLoad = useRef(true)

  const doFetch = useCallback(async (q: string) => {
    const isSearching = q.length > 0
    if (isSearching) {
      setSearching(true)
    } else {
      setLoading(true)
    }
    setError(null)

    try {
      const result = await fetchLessons(q, { limit: 10 })
      setItems(result.items)
    } catch (err) {
      setError(err instanceof Error ? err.message : "获取经验列表失败")
    } finally {
      setLoading(false)
      setSearching(false)
    }
  }, [])

  useEffect(() => {
    // Initial load
    doFetch("")
    isInitialLoad.current = false
  }, [doFetch])

  useEffect(() => {
    if (isInitialLoad.current) return

    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
    }

    debounceRef.current = setTimeout(() => {
      doFetch(query)
    }, 300)

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
    }
  }, [query, doFetch])

  function handleToggle(id: string) {
    setExpandedId((prev) => (prev === id ? null : id))
  }

  function formatTime(dateStr: string): string {
    const d = new Date(dateStr)
    const now = new Date()
    const diffMs = now.getTime() - d.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)

    if (diffMins < 1) return "刚刚"
    if (diffMins < 60) return `${diffMins} 分钟前`
    if (diffHours < 24) return `${diffHours} 小时前`
    if (diffDays < 30) return `${diffDays} 天前`
    return d.toLocaleDateString("zh-CN")
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="space-y-4 p-4">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-9 w-full" />
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-start gap-3">
              <Skeleton className="h-5 w-5 mt-0.5" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center gap-2 p-8 text-center">
          <p className="text-sm text-destructive">{error}</p>
          <button
            className="text-sm text-primary underline"
            onClick={() => doFetch(query)}
          >
            重试
          </button>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">经验教训</h3>
        </div>

        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="搜索经验..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-8 pr-8"
          />
          {searching && (
            <div className="absolute right-2.5 top-1/2 -translate-y-1/2">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
            </div>
          )}
        </div>

        {items.length === 0 ? (
          <Empty className="py-6">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BookOpen className="h-5 w-5" />
              </EmptyMedia>
              <EmptyTitle>
                {query ? "未找到匹配的经验" : "暂无经验记录"}
              </EmptyTitle>
              <EmptyDescription>
                {query ? "请尝试其他搜索词" : "工作流执行后将自动记录经验"}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="space-y-2">
            {items.map((item) => {
              const Icon = typeIcons[item.type]
              const isExpanded = expandedId === item.id

              return (
                <div
                  key={item.id}
                  className={cn(
                    "rounded-lg border p-3 cursor-pointer transition-colors hover:bg-muted/50",
                    isExpanded && "bg-muted/30"
                  )}
                  onClick={() => handleToggle(item.id)}
                >
                  <div className="flex items-start gap-2.5">
                    <Icon className={cn("h-4 w-4 mt-0.5 shrink-0", typeColors[item.type])} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">
                          {item.title}
                        </span>
                        <Badge variant="secondary" className="text-[10px] px-1.5 shrink-0">
                          {typeLabels[item.type]}
                        </Badge>
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                        {item.workflow_name && (
                          <span className="truncate">{item.workflow_name}</span>
                        )}
                        <span className="shrink-0">{formatTime(item.created_at)}</span>
                      </div>
                    </div>
                    <div className="shrink-0 mt-0.5">
                      {isExpanded ? (
                        <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="mt-3 ml-6 border-t pt-3">
                      <p className="text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed">
                        {item.content}
                      </p>
                      <div className="mt-2 flex items-center gap-3 text-[10px] text-muted-foreground">
                        {item.project && (
                          <span>项目: {item.project}</span>
                        )}
                        <span>引用: {item.use_count} 次</span>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
