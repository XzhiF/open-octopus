'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { Bug, Search, ChevronDown, ChevronRight } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import * as api from '@/lib/agent/api'
import type { AgentConfig, DebugLogEntry } from '@/lib/agent/types'

interface DebugLogViewerProps {
  config: (AgentConfig & { config_degraded: boolean }) | null
  onSave: (data: Partial<AgentConfig>) => Promise<boolean>
}

interface LogItem {
  id: string
  session_id: string
  timestamp: string
  summary: string
  chat_id: string
}

const PAGE_SIZE = 20

export function DebugLogViewer({ config, onSave }: DebugLogViewerProps) {
  const [debugEnabled, setDebugEnabled] = useState(config?.debug?.enabled ?? false)
  const [logs, setLogs] = useState<LogItem[]>([])
  const [selectedLog, setSelectedLog] = useState<DebugLogEntry | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const [hasMore, setHasMore] = useState(false)
  const [expandedSegments, setExpandedSegments] = useState<Set<number>>(new Set())
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()

  // Sync debugEnabled when config changes externally
  useEffect(() => {
    if (config?.debug?.enabled !== undefined) {
      setDebugEnabled(config.debug.enabled)
    }
  }, [config?.debug?.enabled])

  const fetchLogs = useCallback(async (opts: { cursor?: string; search?: string; append?: boolean } = {}) => {
    if (opts.append) {
      setLoadingMore(true)
    } else {
      setLoading(true)
      setLogs([])
      setSelectedLog(null)
    }

    try {
      const res = await api.getDebugLog({
        limit: PAGE_SIZE,
        cursor: opts.cursor,
        search: opts.search || undefined,
      })
      const newItems = res.items.map(item => ({
        id: item.id,
        session_id: item.session_id,
        timestamp: item.timestamp,
        chat_id: item.chat_id,
        summary: (item as unknown as { summary: string }).summary ?? '',
      }))

      if (opts.append) {
        setLogs(prev => [...prev, ...newItems])
      } else {
        setLogs(newItems)
      }
      setHasMore(res.has_more ?? false)
      setCursor(res.next_cursor ?? undefined)
    } catch {
      // Silently fail — debug log is non-critical
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [])

  // Initial load
  useEffect(() => {
    fetchLogs()
  }, [fetchLogs])

  // Debounced search
  const handleSearchChange = useCallback((value: string) => {
    setSearchTerm(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setCursor(undefined)
      fetchLogs({ search: value })
    }, 300)
  }, [fetchLogs])

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  const handleLoadMore = useCallback(() => {
    if (cursor && !loadingMore) {
      fetchLogs({ cursor, search: searchTerm, append: true })
    }
  }, [cursor, loadingMore, searchTerm, fetchLogs])

  const handleToggleDebug = useCallback(async (enabled: boolean) => {
    setDebugEnabled(enabled)
    const ok = await onSave({ debug: { enabled } })
    if (ok) {
      toast.success(enabled ? '调试模式已开启' : '调试模式已关闭')
    } else {
      setDebugEnabled(!enabled)
      toast.error('保存失败')
    }
  }, [onSave])

  const handleSelect = async (chatId: string) => {
    setLoading(true)
    setExpandedSegments(new Set())
    try {
      const detail = await api.getAssembleDetail(chatId)
      setSelectedLog(detail)
    } catch {
      setSelectedLog(null)
    } finally {
      setLoading(false)
    }
  }

  const toggleSegment = (index: number) => {
    setExpandedSegments(prev => {
      const next = new Set(prev)
      if (next.has(index)) {
        next.delete(index)
      } else {
        next.add(index)
      }
      return next
    })
  }

  return (
    <section className="rounded-xl border border-agent-divider bg-agent-surface-raised overflow-hidden">
      <div className="px-5 py-4 border-b border-agent-divider">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Bug className="h-4 w-4" />
              调试日志
            </h3>
            <p className="text-xs text-muted-foreground mt-1">开启后将记录 Agent 决策日志</p>
          </div>
          <Switch
            checked={debugEnabled}
            onCheckedChange={handleToggleDebug}
          />
        </div>
      </div>

      {logs.length === 0 && !searchTerm ? (
        <div className="px-5 py-8 text-sm text-muted-foreground text-center">
          {debugEnabled ? '暂无调试日志，进行一次 Agent 对话后将自动记录' : '开启调试模式后将记录 Agent 决策日志'}
        </div>
      ) : (
        <div>
          {/* Search bar */}
          <div className="px-4 py-2 border-b border-agent-divider">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={searchTerm}
                onChange={(e) => handleSearchChange(e.target.value)}
                placeholder="搜索日志关键词..."
                className="pl-8 h-8 text-sm bg-agent-surface-inset border-agent-divider"
              />
            </div>
          </div>

          <div className="flex">
            {/* Log list */}
            <div className="w-72 border-r border-agent-divider">
              <ScrollArea className="max-h-[600px]">
                <div className="divide-y divide-agent-divider">
                  {logs.length === 0 ? (
                    <div className="px-4 py-6 text-sm text-muted-foreground text-center">
                      未找到匹配的日志
                    </div>
                  ) : (
                    logs.map((log, i) => (
                      <button
                        key={log.id ? `${log.id}-${i}` : i}
                        onClick={() => handleSelect(log.chat_id ?? log.id)}
                        className={cn(
                          'w-full text-left px-4 py-3 hover:bg-accent transition-colors',
                          selectedLog?.chat_id === log.chat_id && 'bg-agent-primary-light'
                        )}
                      >
                        <p className="text-sm truncate">{log.summary}</p>
                        <span className="text-xs text-muted-foreground">
                          {new Date(log.timestamp).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </ScrollArea>

              {/* Load more button */}
              {hasMore && (
                <div className="px-4 py-2 border-t border-agent-divider">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleLoadMore}
                    disabled={loadingMore}
                    className="w-full text-xs"
                  >
                    {loadingMore ? (
                      <Skeleton className="h-3 w-20" />
                    ) : (
                      <>
                        <ChevronDown className="h-3 w-3 mr-1" />
                        加载更多
                      </>
                    )}
                  </Button>
                </div>
              )}
            </div>

            {/* Log detail */}
            <ScrollArea className="flex-1 max-h-[600px]">
              {loading ? (
                <div className="p-4 space-y-2">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-3/4" />
                </div>
              ) : selectedLog ? (
                <div className="p-4">
                  <h4 className="text-sm font-semibold mb-3">System Prompt 组装详情</h4>
                  <div className="space-y-3">
                    {selectedLog.segments.map((seg) => {
                      const isExpanded = expandedSegments.has(seg.index)
                      return (
                        <div key={seg.index} className="rounded-lg border border-agent-divider overflow-hidden">
                          <button
                            onClick={() => toggleSegment(seg.index)}
                            className="w-full flex items-center justify-between p-3 hover:bg-accent/50 transition-colors"
                          >
                            <div className="flex items-center gap-2">
                              {isExpanded ? (
                                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                              ) : (
                                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                              )}
                              <span className="text-sm font-medium">{seg.name}</span>
                            </div>
                            <span className={cn(
                              'text-xs shrink-0',
                              seg.degraded ? 'text-agent-warn' : 'text-muted-foreground'
                            )}>
                              {seg.token_count} / {seg.budget} tokens
                              {seg.degraded && ' (已降级)'}
                            </span>
                          </button>
                          {isExpanded ? (
                            <div className="px-3 pb-3 border-t border-agent-divider">
                              <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap mt-2 max-h-[400px] overflow-auto">
                                {seg.content || '(empty)'}
                              </pre>
                            </div>
                          ) : (
                            <div className="px-3 pb-3">
                              <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap line-clamp-3">
                                {seg.content_preview}
                              </pre>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                  {Object.keys(selectedLog.skill_sources ?? {}).length > 0 && (
                    <div className="mt-4">
                      <h5 className="text-xs font-semibold mb-2">SKILL 来源</h5>
                      <div className="space-y-1">
                        {Object.entries(selectedLog.skill_sources ?? {}).map(([name, source]) => (
                          <div key={name} className="flex items-center gap-2 text-xs">
                            <span className="font-mono">{name}</span>
                            <span className="text-muted-foreground">→</span>
                            <span>{source}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex items-center justify-center h-[200px] text-sm text-muted-foreground p-4">
                  选择一条日志查看组装详情
                </div>
              )}
            </ScrollArea>
          </div>
        </div>
      )}
    </section>
  )
}
