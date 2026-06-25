"use client"

import { useEffect } from "react"
import { cn } from "@/lib/utils"
import { useSchedulerCron } from "@/hooks/use-scheduler-cron"
import { CheckCircle, XCircle, AlertTriangle, Loader2 } from "lucide-react"
import { format, parseISO } from "date-fns"

interface CronPreviewProps {
  expression: string
  timezone: string
}

export function CronPreview({ expression, timezone }: CronPreviewProps) {
  const { result, loading, error, parse } = useSchedulerCron()

  useEffect(() => {
    parse(expression, timezone)
  }, [expression, timezone, parse])

  if (!expression.trim()) {
    return (
      <p className="text-sm text-muted-foreground">
        输入 Cron 表达式预览触发时间
      </p>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        解析中...
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-start gap-2 rounded-md bg-destructive/5 p-3 text-sm">
        <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div>
          <p className="text-destructive">{error}</p>
          <a
            href="https://crontab.guru/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-muted-foreground underline hover:text-foreground"
          >
            Cron 语法参考
          </a>
        </div>
      </div>
    )
  }

  if (!result) return null

  return (
    <div
      className={cn(
        "rounded-md border p-3 text-sm",
        result.valid
          ? "border-scheduler-success/30 bg-scheduler-success/5"
          : "border-destructive/30 bg-destructive/5"
      )}
    >
      {result.valid ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <CheckCircle className="size-4 text-scheduler-success" />
            <span className="font-medium">{result.description}</span>
            {result.is_high_frequency && (
              <span className="inline-flex items-center gap-1 rounded-md bg-scheduler-warn/10 px-1.5 py-0.5 text-xs font-medium text-scheduler-warn">
                <AlertTriangle className="size-3" />
                高频调度
              </span>
            )}
          </div>
          {result.next_executions.length > 0 && (
            <div className="space-y-1 pl-6">
              <p className="text-xs text-muted-foreground">
                接下来 5 次执行时间:
              </p>
              <ul className="space-y-0.5">
                {result.next_executions.slice(0, 5).map((exec) => (
                  <li
                    key={exec}
                    className="font-mono text-xs text-muted-foreground"
                  >
                    {format(parseISO(exec), "yyyy-MM-dd HH:mm")}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.dst_notes.length > 0 && (
            <div className="pl-6">
              {result.dst_notes.map((note) => (
                <p
                  key={note}
                  className="flex items-center gap-1 text-xs text-scheduler-warn"
                >
                  <AlertTriangle className="size-3" />
                  {note}
                </p>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="flex items-start gap-2">
          <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div>
            <p className="text-destructive">{result.description || "无效的 Cron 表达式"}</p>
            <a
              href="https://crontab.guru/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-muted-foreground underline hover:text-foreground"
            >
              Cron 语法参考
            </a>
          </div>
        </div>
      )}
    </div>
  )
}
