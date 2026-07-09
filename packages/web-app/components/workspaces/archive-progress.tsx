"use client"

import { useState, useEffect, useRef } from "react"
import { CheckCircle2, Circle, Loader2, XCircle, Pause, Terminal } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { archiveWorkspaceSSE, type StepEvent, type ArchiveResult } from "@/lib/archive-api"

// ── Types ──────────────────────────────────────────────────────

interface StepDef {
  key: string
  label: string
}

const STEP_DEFS: StepDef[] = [
  { key: "archive_executions", label: "归档执行记录" },
  { key: "create_record", label: "创建归档记录" },
  { key: "extract_experiences", label: "提取经验" },
  { key: "install_skills", label: "安装 Skill" },
  { key: "delete_files", label: "清理文件" },
  { key: "update_stats", label: "更新统计" },
  { key: "soft_archive", label: "软归档" },
  { key: "cleanup_draft", label: "清理草稿" },
]

type StepStatus = "pending" | "running" | "done" | "error" | "paused"

interface StepState {
  status: StepStatus
  detail?: string
}

// ── Props ──────────────────────────────────────────────────────

interface ArchiveProgressProps {
  workspaceId: string
  options: {
    extractExperiences?: string[]
    installSkills?: string[]
    analysisReport?: unknown
    stats?: Record<string, unknown>
  }
  onComplete: (result: ArchiveResult) => void
  onCancel: () => void
}

// ── Component ──────────────────────────────────────────────────

export function ArchiveProgress({ workspaceId, options, onComplete, onCancel }: ArchiveProgressProps) {
  const [steps, setSteps] = useState<Record<string, StepState>>(
    Object.fromEntries(STEP_DEFS.map(s => [s.key, { status: "pending" as StepStatus }]))
  )
  const [logs, setLogs] = useState<string[]>([])
  const [phase, setPhase] = useState<"running" | "complete" | "error">("running")
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const logEndRef = useRef<HTMLDivElement>(null)

  // Auto-scroll terminal
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [logs])

  // Start SSE on mount
  useEffect(() => {
    const abort = archiveWorkspaceSSE(
      workspaceId,
      options,
      // onStep
      (event: StepEvent) => {
        setSteps(prev => ({
          ...prev,
          [event.step]: {
            status: event.status === "progress"
              ? (prev[event.step]?.status ?? "running")
              : event.status as StepStatus,
            detail: event.detail,
          },
        }))
      },
      // onLog
      (message: string) => {
        const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false })
        setLogs(prev => [...prev, `${ts}  ${message}`])
      },
      // onComplete
      (archiveResult: ArchiveResult) => {
        setPhase("complete")
        onComplete(archiveResult)
      },
      // onError
      (error: Error) => {
        setErrorMsg(error.message)
        setPhase("error")
        setSteps(prev => {
          const updated = { ...prev }
          let foundError = false
          for (const def of STEP_DEFS) {
            if (updated[def.key]?.status === "error") foundError = true
            if (foundError && updated[def.key]?.status === "pending") {
              updated[def.key] = { status: "paused" }
            }
          }
          return updated
        })
      },
    )

    return () => abort.abort()
  }, [workspaceId])

  // ── Step icon renderer ──────────────────────────────────────

  const StepIcon = ({ status }: { status: StepStatus }) => {
    switch (status) {
      case "done":    return <CheckCircle2 className="h-5 w-5 text-green-500" />
      case "running": return <Loader2 className="h-5 w-5 text-blue-500 animate-spin" />
      case "error":   return <XCircle className="h-5 w-5 text-red-500" />
      case "paused":  return <Pause className="h-5 w-5 text-muted-foreground" />
      default:        return <Circle className="h-5 w-5 text-muted-foreground" />
    }
  }

  // ── Render ──────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full min-h-[400px]">
      {/* Dual panel layout */}
      <div className="flex flex-1 gap-4 min-h-0">
        {/* Steps panel — left 280px */}
        <div className="w-[280px] shrink-0 border rounded-lg p-4 overflow-y-auto">
          <h4 className="text-sm font-semibold mb-3 text-muted-foreground">归档步骤</h4>
          <div className="space-y-1">
            {STEP_DEFS.map((def) => {
              const state = steps[def.key]
              return (
                <div
                  key={def.key}
                  className={cn(
                    "flex items-start gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                    state?.status === "running" && "bg-blue-50 dark:bg-blue-950/30",
                    state?.status === "error" && "bg-red-50 dark:bg-red-950/30",
                  )}
                >
                  <StepIcon status={state?.status ?? "pending"} />
                  <div className="flex-1 min-w-0">
                    <div className={cn(
                      "font-medium",
                      state?.status === "done" && "text-green-700 dark:text-green-400",
                      state?.status === "error" && "text-red-700 dark:text-red-400",
                      state?.status === "paused" && "text-muted-foreground",
                    )}>
                      {def.label}
                    </div>
                    {state?.detail && (
                      <div className="text-xs text-muted-foreground truncate">
                        {state.detail}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Terminal panel — right flex-1 */}
        <div className="flex-1 min-w-0 border rounded-lg flex flex-col">
          <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/50 rounded-t-lg">
            <Terminal className="h-4 w-4 text-muted-foreground" />
            <span className="text-xs font-mono text-muted-foreground">归档日志</span>
          </div>
          <div className="flex-1 overflow-y-auto p-3 font-mono text-xs leading-relaxed bg-zinc-950 text-zinc-100 rounded-b-lg">
            {logs.length === 0 ? (
              <div className="text-zinc-500 italic">等待归档开始...</div>
            ) : (
              logs.map((line, i) => (
                <div key={i} className={cn(
                  "whitespace-pre-wrap",
                  line.includes("ERROR") && "text-red-400",
                  line.includes("✓") && "text-green-400",
                  line.includes("═══") && "text-zinc-500",
                )}>
                  {line}
                </div>
              ))
            )}
            <div ref={logEndRef} />
          </div>
        </div>
      </div>

      {/* Bottom action bar */}
      <div className="mt-4 flex items-center justify-between border-t pt-4">
        <div className="text-sm">
          {phase === "running" && (
            <span className="text-muted-foreground">归档进行中，请勿关闭此窗口</span>
          )}
          {phase === "complete" && (
            <span className="text-green-600 font-medium">{"✅"} 归档完成</span>
          )}
          {phase === "error" && (
            <span className="text-red-600 font-medium">{"⚠️"} {errorMsg ?? "归档失败"}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {phase === "running" && (
            <Button variant="outline" disabled>
              归档中...
            </Button>
          )}
          {phase === "error" && (
            <Button variant="outline" onClick={onCancel}>关闭</Button>
          )}
          {phase === "complete" && (
            <Button onClick={onCancel}>关闭</Button>
          )}
        </div>
      </div>
    </div>
  )
}
