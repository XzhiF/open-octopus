"use client"

import { useState, useEffect } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CheckCircle2, AlertTriangle, Info, Lightbulb } from "lucide-react"
import { cn } from "@/lib/utils"
import { getServerUrl } from "@/lib/server-config"

interface SuggestionPanelProps {
  workspaceId: string
  workflowRef?: string
}

const SEVERITY_CONFIG = {
  critical: { icon: AlertTriangle, color: "text-red-600", bg: "bg-red-500/10" },
  warning: { icon: AlertTriangle, color: "text-amber-600", bg: "bg-amber-500/10" },
  info: { icon: Info, color: "text-blue-600", bg: "bg-blue-500/10" },
}

export function SuggestionPanel({ workspaceId, workflowRef }: SuggestionPanelProps) {
  const [suggestions, setSuggestions] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`${getServerUrl()}/api/workspaces/${workspaceId}/suggestions`)
      .then(r => r.json())
      .then(d => { if (!cancelled) setSuggestions(d.data ?? []) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [workspaceId])

  if (loading) return <div className="text-sm text-muted-foreground">分析中...</div>
  if (suggestions.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center">
        <Lightbulb className="h-8 w-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">暂无优化建议 — 当前工作流运行良好</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Lightbulb className="h-4 w-4 text-amber-500" />
        <span className="text-sm font-medium">优化建议 ({suggestions.length})</span>
      </div>
      {suggestions.map((s) => {
        const config = SEVERITY_CONFIG[s.severity as keyof typeof SEVERITY_CONFIG] ?? SEVERITY_CONFIG.info
        return (
          <div key={s.id} className="rounded-lg border p-3 space-y-2">
            <div className="flex items-center gap-2">
              <config.icon className={cn("h-4 w-4", config.color)} />
              <span className="text-sm font-medium">{s.title}</span>
              <Badge variant="outline" className={cn("ml-auto", config.color)}>{s.severity}</Badge>
            </div>
            <p className="text-xs text-muted-foreground">{s.diagnosis}</p>
            <p className="text-xs font-medium">{s.prescription}</p>
            {s.impact_estimate && (
              <p className="text-xs text-emerald-600">{s.impact_estimate}</p>
            )}
            <Button size="sm" variant="outline" className="h-7 text-xs"
              onClick={() => {
                fetch(`${getServerUrl()}/api/workspaces/${workspaceId}/suggestions/${s.id}/apply`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ applied: true }),
                }).then(() => {
                  setSuggestions(prev => prev.filter(x => x.id !== s.id))
                }).catch(() => {})
              }}>
              <CheckCircle2 className="mr-1 h-3 w-3" />应用建议
            </Button>
          </div>
        )
      })}
    </div>
  )
}
