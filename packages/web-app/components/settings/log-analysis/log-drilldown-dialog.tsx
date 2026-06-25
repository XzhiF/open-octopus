"use client"

import { useState, useEffect, useCallback } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import { getExecutionLogs } from "@/lib/analytics-client"
import { XCircle, AlertCircle, RefreshCw } from "lucide-react"
import type { Alert, LogContext } from "@/lib/analytics-types"

interface LogDrilldownDialogProps {
  alert: Alert
  workspaceId: string
  onClose: () => void
}

type ErrorType = "network" | "not_found" | "server" | null

export function LogDrilldownDialog({ alert, workspaceId, onClose }: LogDrilldownDialogProps) {
  const [logContext, setLogContext] = useState<LogContext | null>(null)
  const [loading, setLoading] = useState(true)
  const [errorType, setErrorType] = useState<ErrorType>(null)
  const [errorMessage, setErrorMessage] = useState<string>("")

  const loadLogs = useCallback(() => {
    const executionId = (alert.metadata.executionId as string) ?? ""
    const nodeId = alert.node_id

    if (!executionId) {
      setLoading(false)
      setErrorType("not_found")
      setErrorMessage("未找到执行 ID")
      return
    }

    setLoading(true)
    setErrorType(null)
    setErrorMessage("")

    getExecutionLogs(workspaceId, executionId, nodeId)
      .then(ctx => {
        setLogContext(ctx)
        setErrorType(null)
      })
      .catch(err => {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes("HTTP 404") || msg.includes("not found")) {
          setErrorType("not_found")
          setErrorMessage("日志文件不存在")
        } else if (msg.includes("fetch") || msg.includes("network") || msg.includes("Failed to fetch")) {
          setErrorType("network")
          setErrorMessage("网络连接失败，请检查网络后重试")
        } else {
          setErrorType("server")
          setErrorMessage(msg || "服务器错误")
        }
        setLogContext(null)
      })
      .finally(() => setLoading(false))
  }, [alert, workspaceId])

  useEffect(() => {
    loadLogs()
  }, [loadLogs])

  return (
    <Dialog open onOpenChange={() => onClose()}>
      <DialogContent className="max-w-2xl max-h-[80vh]" aria-describedby="log-drilldown-desc">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            执行日志
            {alert.node_id && <Badge variant="outline">{alert.node_id}</Badge>}
          </DialogTitle>
          <DialogDescription id="log-drilldown-desc" className="sr-only">
            显示工作流执行的详细日志上下文
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-start gap-3 p-3 rounded-md bg-destructive/5 border border-destructive/20">
            <XCircle className="h-5 w-5 text-destructive mt-0.5 shrink-0" aria-hidden="true" />
            <div>
              <p className="font-medium text-sm">{alert.title}</p>
              <p className="text-sm text-muted-foreground">{alert.description}</p>
            </div>
          </div>

          {loading && (
            <div className="space-y-2">
              {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-4" />)}
            </div>
          )}

          {!loading && errorType && (
            <div className="flex flex-col items-center gap-3 py-8">
              <AlertCircle className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
              <p className="text-sm text-muted-foreground text-center">{errorMessage}</p>
              {errorType === "network" && (
                <Button variant="outline" size="sm" onClick={loadLogs}>
                  <RefreshCw className="h-4 w-4 mr-2" />
                  重试
                </Button>
              )}
            </div>
          )}

          {!loading && !errorType && logContext && logContext.contextLines.length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground mb-2">
                日志上下文 ({logContext.contextLines.length}/{logContext.totalLines} 行)
              </p>
              <ScrollArea className="h-64">
                <pre className="text-xs font-mono bg-muted p-3 rounded-md space-y-0.5">
                  {logContext.contextLines.map((line, i) => (
                    <div key={i} className="flex gap-2">
                      <span className="text-muted-foreground select-none">{String(i + 1).padStart(3)}</span>
                      <span>{line.timestamp ? `[${line.timestamp.slice(11, 19)}]` : ""} {line.event}: {typeof line.data === "string" ? line.data : JSON.stringify(line.data)}</span>
                    </div>
                  ))}
                </pre>
              </ScrollArea>
            </div>
          )}

          {!loading && !errorType && logContext && logContext.contextLines.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">
              未找到日志文件，或日志文件为空
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
