"use client"

import { RefreshCw, AlertTriangle, Search, Inbox, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"

/**
 * PageState — 5-state wrapper for page content (C0).
 * States: loading | error | empty | ready | stale
 */

type PageStateProps =
  | { status: "loading" }
  | { status: "error"; message: string; onRetry?: () => void }
  | { status: "empty"; title?: string; description?: string; icon?: React.ComponentType<{ className?: string }> }
  | { status: "ready"; children: React.ReactNode }
  | { status: "stale"; lastUpdated: Date; onRefresh: () => void; children: React.ReactNode }

export function PageState(props: PageStateProps) {
  switch (props.status) {
    case "loading":
      return (
        <div className="flex items-center justify-center py-12 text-muted-foreground" role="status" aria-label="加载中">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          加载中...
        </div>
      )
    case "error":
      return (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive" role="alert">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="flex-1">
              <p>{props.message}</p>
              {props.onRetry && (
                <Button variant="outline" size="sm" className="mt-3" onClick={props.onRetry}>
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                  重试
                </Button>
              )}
            </div>
          </div>
        </div>
      )
    case "empty": {
      const Icon = props.icon || Inbox
      return (
        <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
          <Icon className="mb-3 h-8 w-8 opacity-50" />
          <p className="font-medium">{props.title || "暂无数据"}</p>
          {props.description && <p className="mt-1 text-sm">{props.description}</p>}
        </div>
      )
    }
    case "stale":
      return (
        <div>
          <div className="mb-3 flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            <AlertTriangle className="h-3.5 w-3.5" />
            数据可能已过期 (更新于 {props.lastUpdated.toLocaleTimeString("zh-CN")})
            <Button variant="outline" size="sm" className="ml-auto h-7 text-xs" onClick={props.onRefresh}>
              <RefreshCw className="mr-1 h-3 w-3" />
              刷新
            </Button>
          </div>
          {props.children}
        </div>
      )
    case "ready":
      return <>{props.children}</>
  }
}
