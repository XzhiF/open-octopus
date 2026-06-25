"use client"

import { useState, useEffect, useCallback } from "react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Loader2, ChevronDown } from "lucide-react"
import { getExecutionLog } from "@/lib/scheduler-api"

interface LogViewerProps {
  jobId: string
  executionId: string
}

export function LogViewer({ jobId, executionId }: LogViewerProps) {
  const [lines, setLines] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [hasMore, setHasMore] = useState(false)
  const [offset, setOffset] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)

  const fetchLog = useCallback(
    async (currentOffset: number, append: boolean) => {
      if (append) {
        setLoadingMore(true)
      } else {
        setLoading(true)
      }

      try {
        const data = await getExecutionLog(jobId, executionId, currentOffset, 5000)
        const newLines = data.content.split("\n")

        if (append) {
          setLines((prev) => [...prev, ...newLines])
        } else {
          setLines(newLines)
        }

        setOffset(data.offset + data.length)
        setHasMore(data.has_more)
      } catch {
        if (!append) {
          setLines(["无法加载日志"])
        }
      } finally {
        setLoading(false)
        setLoadingMore(false)
      }
    },
    [jobId, executionId]
  )

  useEffect(() => {
    fetchLog(0, false)
  }, [fetchLog])

  if (loading) {
    return (
      <div className="space-y-1 p-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-4 w-3/4 bg-neutral-800" />
        ))}
      </div>
    )
  }

  return (
    <div className="p-2">
      <pre className="overflow-x-auto rounded-md bg-neutral-900 p-3 font-mono text-xs leading-relaxed text-neutral-100">
        {lines.map((line, idx) => (
          <div key={idx} className="flex">
            <span className="mr-3 inline-block w-8 shrink-0 text-right text-neutral-600 select-none">
              {idx + 1}
            </span>
            <span className="whitespace-pre-wrap break-all">{line}</span>
          </div>
        ))}
      </pre>
      {hasMore && (
        <div className="mt-2 flex justify-center">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => fetchLog(offset, true)}
            disabled={loadingMore}
            className="text-xs text-muted-foreground"
          >
            {loadingMore ? (
              <Loader2 className="mr-1 size-3 animate-spin" />
            ) : (
              <ChevronDown className="mr-1 size-3" />
            )}
            加载更多
          </Button>
        </div>
      )}
    </div>
  )
}
