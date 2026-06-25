'use client'

import { useState, useCallback } from 'react'
import { Search, AlertTriangle } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { useAgentMemory } from '@/hooks/useAgentMemory'

export function SessionSearch() {
  const [query, setQuery] = useState('')
  const { searchResults, searchDegraded, loading, error, search } = useAgentMemory()

  const handleSearch = useCallback(() => {
    if (query.trim()) search(query, 5)
  }, [query, search])

  return (
    <div className="p-6 max-w-3xl">
      <h2 className="text-lg font-semibold mb-4">会话记忆</h2>

      {/* Search bar */}
      <div className="flex gap-2 mb-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSearch() }}
            placeholder="搜索会话记忆..."
            className="pl-9 bg-agent-surface-inset border-agent-divider focus-visible:ring-agent-primary"
            role="search"
            aria-label="搜索会话记忆"
          />
        </div>
      </div>

      {searchDegraded && (
        <div className="flex items-center gap-2 mb-4 p-2 rounded-md bg-agent-warn-light border border-agent-warn/20 text-sm text-agent-warn-foreground">
          <AlertTriangle className="h-4 w-4 text-agent-warn" />
          FTS 索引已降级为模糊搜索，结果可能不够精确
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-md bg-agent-error-light border border-agent-error/20 p-3 text-sm text-agent-error">
          {error}
        </div>
      )}

      {loading && (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      )}

      {/* Results */}
      {!loading && searchResults.length > 0 && (
        <div className="space-y-2">
          {searchResults.map((result) => (
            <div
              key={result.session_id}
              className="rounded-lg border border-agent-divider bg-agent-surface-raised p-4 hover:shadow-sm transition-shadow cursor-pointer"
            >
              <div className="flex items-center gap-2 mb-1">
                <h4 className="text-sm font-medium">{result.session_title}</h4>
                <Badge variant="outline" className="text-xs">
                  相关度: {(result.score * 100).toFixed(0)}%
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground line-clamp-2">{result.summary}</p>
              <span className="text-xs text-muted-foreground mt-1 block">
                {new Date(result.created_at).toLocaleDateString('zh-CN')}
              </span>
            </div>
          ))}
        </div>
      )}

      {!loading && query && searchResults.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          未找到相关会话记忆
        </p>
      )}

      {!query && !loading && (
        <p className="text-sm text-muted-foreground text-center py-8">
          输入关键词搜索历史会话记忆
        </p>
      )}
    </div>
  )
}
