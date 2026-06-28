"use client"

import { useState } from "react"
import { Input } from "@/components/ui/input"
import { ExperienceCard } from "@/components/archive/experience-card"
import type { ExperienceItem } from "@/lib/archive-api"
import { Search, X, Loader2 } from "lucide-react"

interface ExperienceListProps {
  lessons: ExperienceItem[]
  total: number
  loading: boolean
  query: string
  onSearch: (q: string) => void
}

export function ExperienceList({ lessons, total, loading, query, onSearch }: ExperienceListProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null)

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium">最近经验</h3>
        <div className="relative">
          <Input
            value={query}
            onChange={e => onSearch(e.target.value)}
            placeholder="搜索经验..."
            aria-label="搜索经验"
            className="h-8 w-48 pr-8 text-xs"
            onKeyDown={e => { if (e.key === "Escape") { onSearch(""); (e.target as HTMLInputElement).blur() } }}
          />
          {query ? (
            <button
              onClick={() => onSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          ) : loading ? (
            <Loader2 className="absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 animate-spin text-muted-foreground" />
          ) : (
            <Search className="absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
          )}
        </div>
      </div>

      {lessons.length === 0 && !loading && (
        <p className="text-sm text-muted-foreground text-center py-8">
          {query ? "未找到匹配的经验。尝试使用不同的关键词。" : "暂无经验数据"}
        </p>
      )}

      <div className="space-y-2 max-h-[400px] overflow-y-auto">
        {lessons.map(item => (
          <ExperienceCard
            key={item.id}
            item={item}
            expanded={expandedId === item.id}
            onToggle={() => setExpandedId(expandedId === item.id ? null : item.id)}
          />
        ))}
      </div>
    </div>
  )
}
