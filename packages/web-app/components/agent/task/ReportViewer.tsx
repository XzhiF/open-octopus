'use client'

import { useState, useEffect } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { AlertTriangle } from 'lucide-react'
import * as api from '@/lib/agent/api'

interface ReportViewerProps {
  reportId: string
}

export function ReportViewer({ reportId }: ReportViewerProps) {
  const [content, setContent] = useState<string | null>(null)
  const [rebuilt, setRebuilt] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    api.getReport(reportId).then((res) => {
      setContent(res.content)
      setRebuilt(res.rebuilt)
      setLoading(false)
    }).catch(() => {
      setContent(null)
      setLoading(false)
    })
  }, [reportId])

  if (loading) {
    return (
      <div className="p-6 space-y-3">
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    )
  }

  return (
    <div className="p-6 max-w-3xl">
      {rebuilt && (
        <div className="flex items-center gap-2 mb-4 p-3 rounded-md bg-agent-warn-light border border-agent-warn/20 text-sm">
          <AlertTriangle className="h-4 w-4 text-agent-warn" />
          原报告丢失，已从记忆重建摘要
        </div>
      )}

      {content ? (
        <div className="prose prose-sm dark:prose-invert max-w-none">
          <pre className="whitespace-pre-wrap font-mono text-sm leading-relaxed">{content}</pre>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">报告内容为空</p>
      )}
    </div>
  )
}
