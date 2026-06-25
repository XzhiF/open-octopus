'use client'

import { useState } from 'react'
import { Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { Experience } from '@/lib/agent/types'

interface ExperienceListProps {
  experiences: Experience[]
  loading: boolean
  onSearch: (q: string) => void
}

export function ExperienceList({ experiences, loading, onSearch }: ExperienceListProps) {
  const [query, setQuery] = useState('')

  const handleSearch = () => {
    onSearch(query)
  }

  return (
    <div className="flex flex-col h-full">
      {/* Search bar */}
      <div className="px-4 py-3 border-b border-agent-divider">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSearch() }}
            placeholder="搜索经验库..."
            className="pl-9 bg-agent-surface-inset border-agent-divider focus-visible:ring-agent-primary"
          />
        </div>
      </div>

      {loading ? (
        <div className="p-4 space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      ) : (
        <ScrollArea className="flex-1">
          <div className="p-4 space-y-3">
            {experiences.map((exp) => (
              <div
                key={exp.id}
                className="rounded-lg border border-agent-divider bg-agent-surface-raised p-4"
              >
                <div className="flex items-center gap-2 mb-2">
                  <Badge variant="outline" className="text-xs font-mono">{exp.skill_name}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {new Date(exp.created_at).toLocaleDateString('zh-CN')}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground line-clamp-3">{exp.content}</p>
              </div>
            ))}
            {experiences.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-8">
                {query ? '未找到相关经验' : '暂无经验记录'}
              </p>
            )}
          </div>
        </ScrollArea>
      )}
    </div>
  )
}
