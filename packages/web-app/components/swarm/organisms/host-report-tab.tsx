"use client"

import { useMemo, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import rehypeSanitize from "rehype-sanitize"
import { AlertBanner } from "../atoms/alert-banner"
import type { HostRoundReport } from "@/hooks/use-swarm-events"

export interface HostReportTabProps {
  report: string | null
  hostDegraded: boolean
  hostReports?: HostRoundReport[]
}

function isJson(str: string): boolean {
  try {
    JSON.parse(str)
    return true
  } catch {
    return false
  }
}

function JsonTreeView({ data, depth = 0 }: { data: unknown; depth?: number }) {
  if (data === null || data === undefined) {
    return <span className="text-muted-foreground">null</span>
  }

  if (typeof data !== "object") {
    const strVal = String(data)
    const colorClass = typeof data === "string"
      ? "text-swarm-primary"
      : typeof data === "number"
        ? "text-swarm-mode-dispatch"
        : typeof data === "boolean"
          ? "text-swarm-mode-debate"
          : "text-foreground"
    return <span className={colorClass}>{typeof data === "string" ? `"${strVal}"` : strVal}</span>
  }

  if (Array.isArray(data)) {
    if (data.length === 0) return <span className="text-muted-foreground">[]</span>
    return (
      <div className={depth > 0 ? "ml-4" : ""}>
        <span className="text-muted-foreground">[</span>
        {data.map((item, i) => (
          <div key={i} className="ml-2">
            <JsonTreeView data={item} depth={depth + 1} />
            {i < data.length - 1 && <span className="text-muted-foreground">,</span>}
          </div>
        ))}
        <span className="text-muted-foreground">]</span>
      </div>
    )
  }

  const entries = Object.entries(data as Record<string, unknown>)
  if (entries.length === 0) return <span className="text-muted-foreground">{"{}"}</span>

  return (
    <div className={depth > 0 ? "ml-4" : ""}>
      <span className="text-muted-foreground">{"{"}</span>
      {entries.map(([key, value], i) => (
        <div key={key} className="ml-2">
          <span className="text-foreground/70 font-medium">"{key}"</span>
          <span className="text-muted-foreground">: </span>
          <JsonTreeView data={value} depth={depth + 1} />
          {i < entries.length - 1 && <span className="text-muted-foreground">,</span>}
        </div>
      ))}
      <span className="text-muted-foreground">{"}"}</span>
    </div>
  )
}

function ReportContent({ content, degraded }: { content: string; degraded: boolean }) {
  const parsedJson = useMemo(() => {
    if (!content) return null
    if (isJson(content)) {
      try {
        return JSON.parse(content)
      } catch {
        return null
      }
    }
    return null
  }, [content])

  return (
    <div className="space-y-3">
      {degraded && (
        <AlertBanner
          type="warning"
          message="Host 降级模式"
          detail="Host 综合时处于降级状态，部分专家结果可能不完整。"
          dismissible
        />
      )}

      {parsedJson ? (
        <div className="rounded-lg border border-border bg-card p-4">
          <pre className="text-xs font-mono leading-relaxed">
            <JsonTreeView data={parsedJson} />
          </pre>
        </div>
      ) : (
        <div className="prose prose-sm dark:prose-invert max-w-none rounded-lg border border-border bg-card p-4">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
            {content}
          </ReactMarkdown>
        </div>
      )}
    </div>
  )
}

export function HostReportTab({ report, hostDegraded, hostReports }: HostReportTabProps) {
  const hasMultiRound = hostReports && hostReports.length > 1
  const [selectedRound, setSelectedRound] = useState<number | null>(null)

  // Default to latest report
  const activeRound = selectedRound ?? (hostReports?.length ? hostReports[hostReports.length - 1].round : null)
  const activeReport = hostReports?.find(r => r.round === activeRound)

  if (!report && (!hostReports || hostReports.length === 0)) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
        等待 Host 综合报告...
      </div>
    )
  }

  if (!hasMultiRound) {
    // Single report — no round selector needed
    const content = activeReport?.content ?? report ?? ""
    const degraded = activeReport?.degraded ?? hostDegraded
    return <ReportContent content={content} degraded={degraded} />
  }

  return (
    <div className="space-y-3">
      {/* Round selector */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-muted-foreground">轮次:</span>
        {hostReports!.map((r) => (
          <button
            key={r.round}
            onClick={() => setSelectedRound(r.round)}
            className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
              activeRound === r.round
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background hover:bg-muted border-border"
            }`}
          >
            第 {r.round} 轮
          </button>
        ))}
      </div>

      {/* Active round report */}
      {activeReport ? (
        <ReportContent content={activeReport.content} degraded={activeReport.degraded} />
      ) : (
        <ReportContent content={report ?? ""} degraded={hostDegraded} />
      )}
    </div>
  )
}
