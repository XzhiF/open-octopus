'use client'

import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { ScrollArea } from '@/components/ui/scroll-area'
import { FileText, AlertTriangle } from 'lucide-react'
import type { ReportInfo } from '@/lib/agent/types'
import { cn } from '@/lib/utils'
import { ReportViewer } from './ReportViewer'

interface ReportListProps {
  reports: ReportInfo[]
  loading: boolean
}

const statusStyles: Record<string, string> = {
  ok: 'bg-agent-success-light text-agent-success-foreground',
  missing: 'bg-agent-error-light text-agent-error',
  rebuilt: 'bg-agent-warn-light text-agent-warn-foreground',
}

export function ReportList({ reports, loading }: ReportListProps) {
  const [selectedReport, setSelectedReport] = useState<ReportInfo | null>(null)

  if (loading) {
    return (
      <div className="p-4 space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    )
  }

  if (reports.length === 0) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground">
        暂无报告
      </div>
    )
  }

  return (
    <div className="flex h-full">
      <ScrollArea className="flex-1 border-r border-agent-divider">
        <div className="p-3 space-y-2">
          {reports.map((report) => (
            <button
              key={report.id}
              onClick={() => setSelectedReport(report)}
              className={cn(
                'w-full text-left rounded-lg border p-3 transition-colors',
                selectedReport?.id === report.id
                  ? 'border-agent-primary bg-agent-primary-light'
                  : 'border-agent-divider bg-agent-surface-raised hover:bg-accent'
              )}
            >
              <div className="flex items-center gap-2 mb-1">
                <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                <h4 className="text-sm font-medium truncate">{report.task_name}</h4>
                {report.status !== 'ok' && (
                  <AlertTriangle className="h-3.5 w-3.5 text-agent-warn shrink-0" />
                )}
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>{report.date}</span>
                <Badge variant="outline" className={cn('text-xs', statusStyles[report.status])}>
                  {report.status}
                </Badge>
              </div>
            </button>
          ))}
        </div>
      </ScrollArea>

      {/* Report viewer */}
      <div className="flex-1 overflow-auto">
        {selectedReport ? (
          <ReportViewer reportId={selectedReport.id} />
        ) : (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
            选择一个报告查看
          </div>
        )}
      </div>
    </div>
  )
}
