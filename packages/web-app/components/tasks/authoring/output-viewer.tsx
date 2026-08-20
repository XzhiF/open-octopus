// packages/web-app/components/tasks/authoring/output-viewer.tsx
//
// The v3 output-viewer (ticket 10, US7/US10/US11/D11/D19). The right-panel
// section BELOW the GoalAcCard: artifact index (click → ArtifactViewerDialog),
// assist-workflow run records (click → WorkflowLogDialog; active run shows the
// MoA adoption panel / parse-error degraded card), and the decisions memo.
// Interaction reference: prototype VariantL right-column artifacts + runs +
// memo (app/tasks/prototype/page.tsx:3354-3408) — code rewritten, not copied.
//
// D19 refresh: subscribes to `assist_run_update` (server emits {task_id,
// run_id, phase}) → re-fetches the run; and to `task_artifacts_update` (the
// designated D19 channel — server-side emission is a known gap; see ticket
// Exploration) → re-fetches the artifact index. As a verifiable bridge while
// the artifacts event isn't emitted, also re-fetches the index on
// `spec_field_update` for this task — the agent's spec update is the closest
// existing server-visible signal that artifacts were produced.

"use client"

import { useEffect, useState, useCallback } from "react"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog"
import { FileText, Eye, Brain, ShieldAlert, Lightbulb, FolderOpen, Copy, Settings2 } from "lucide-react"
import type { Task, ArtifactIndexEntry, AssistWorkflowRun } from "@octopus/shared"
import { SPEC_FIELD_UPDATE_EVENT, TASK_ARTIFACTS_UPDATE_EVENT, ASSIST_RUN_UPDATE_EVENT } from "@octopus/shared"
import { subscribeSSE } from "@/lib/sse-manager"
import { getServerUrl } from "@/lib/server-config"
import {
  listArtifacts,
  getAssistWorkflowRun,
  getTaskContext,
} from "@/lib/tasks-api"
import { ArtifactViewerDialog } from "./artifact-viewer-dialog"
import { WorkflowLogDialog } from "./workflow-log-dialog"
import { MoaAdoptionPanel } from "./moa-adoption-panel"

export interface OutputViewerProps {
  task: Task
  /** Run ids tracked by the parent (added on trigger). The viewer fetches
   *  each once + follows SSE assist_run_update transitions (D19: no polling).
   *  The parent owns this so the command-bar trigger + the viewer share
   *  one source of truth. */
  runIds: string[]
  /** Fired after an MoA adoption merges ac/decisions via spec-field (parent
   *  re-fetches the task so the decisions memo + GoalAcCard reflect new state). */
  onAdopted: () => void
}

/** Pick a file-type icon glyph for an artifact by extension (best-effort). */
function artifactIcon(path: string): string {
  const p = path.toLowerCase()
  if (p.endsWith(".md")) return "📝"
  if (p.endsWith(".json")) return "🧾"
  if (p.endsWith(".yaml") || p.endsWith(".yml")) return "⚙️"
  if (p.endsWith(".ts") || p.endsWith(".tsx") || p.endsWith(".js")) return "📜"
  return "📄"
}

/** Status badge for a run row — mirrors WorkflowLogDialog's mapping. */
function runBadge(status: string): { label: string; className: string } {
  const cls = "text-[9px] "
  switch (status) {
    case "running":
      return { label: "运行中", className: cls + "bg-purple-500/15 text-purple-600 animate-pulse" }
    case "done":
    case "completed":
      return { label: "完成", className: cls + "bg-emerald-500/15 text-emerald-600" }
    case "failed":
    case "error":
      return { label: "失败", className: cls + "bg-red-500/15 text-red-600" }
    case "aborted":
      return { label: "中止", className: cls + "bg-zinc-500/15 text-zinc-600" }
    default:
      return { label: status || "未知", className: cls + "bg-muted text-muted-foreground" }
  }
}

/** Fallback clipboard write for contexts where navigator.clipboard is
 *  unavailable (non-HTTPS, older browsers). Uses a hidden textarea +
 *  document.execCommand('copy'). */
function copyToClipboard(text: string): void {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text)
    return
  }
  const textarea = document.createElement("textarea")
  textarea.value = text
  textarea.style.position = "fixed"
  textarea.style.left = "-9999px"
  textarea.style.opacity = "0"
  document.body.appendChild(textarea)
  textarea.select()
  try {
    document.execCommand("copy")
  } catch {
    // ignore — nothing more we can do
  }
  document.body.removeChild(textarea)
}

export function OutputViewer({ task, runIds, onAdopted }: OutputViewerProps) {
  const taskId = task.id
  // Absolute paths from the server (fetched via getTaskContext on mount).
  // Falls back to ~/ prefix until the fetch resolves.
  const [artifactsDir, setArtifactsDir] = useState(`~/.octopus/tasks/${taskId}/artifacts`)
  const [contextFilePath, setContextFilePath] = useState("")

  // Fetch absolute paths + context content on mount / taskId change.
  useEffect(() => {
    let cancelled = false
    getTaskContext(taskId)
      .then((res) => {
        if (cancelled) return
        setArtifactsDir(res.artifactsDir)
        setContextFilePath(res.path)
        if (res.content !== null) setContextContent(res.content)
      })
      .catch(() => { /* non-fatal — keep ~/ fallback */ })
    return () => { cancelled = true }
  }, [taskId])

  // ── Context viewer (context.md) ──────────────────────────────────────
  const [showContext, setShowContext] = useState(false)
  const [contextContent, setContextContent] = useState<string | null>(null)
  const [contextLoading, setContextLoading] = useState(false)

  const openContextViewer = useCallback(async () => {
    setShowContext(true)
    // If content wasn't loaded yet by the initial fetch, fetch it now.
    if (contextContent === null && !contextLoading) {
      setContextLoading(true)
      try {
        const result = await getTaskContext(taskId)
        setContextContent(result.content)
        setContextFilePath(result.path)
        setArtifactsDir(result.artifactsDir)
      } catch {
        setContextContent(null)
      } finally {
        setContextLoading(false)
      }
    }
  }, [taskId, contextContent, contextLoading])

  // ── Artifacts index ────────────────────────────────────────────────
  const [artifacts, setArtifacts] = useState<ArtifactIndexEntry[]>([])
  const [artifactsLoading, setArtifactsLoading] = useState(true)
  const [artifactsError, setArtifactsError] = useState<string | null>(null)
  const [viewing, setViewing] = useState<ArtifactIndexEntry | null>(null)

  const refreshArtifacts = useCallback(async () => {
    try {
      const list = await listArtifacts(taskId)
      setArtifacts(list)
      setArtifactsError(null)
    } catch (err: unknown) {
      setArtifactsError(err instanceof Error ? err.message : "产物索引加载失败")
    } finally {
      setArtifactsLoading(false)
    }
  }, [taskId])

  useEffect(() => {
    setArtifactsLoading(true)
    void refreshArtifacts()
  }, [taskId, refreshArtifacts])

  // D19: SSE refresh. task_artifacts_update is the designated channel (emitted
  // by the server alongside spec_field_update — same taskpool mechanism);
  // spec_field_update stays subscribed as a direct trigger too. Both → re-fetch.
  useEffect(() => {
    if (!taskId) return
    const onArtifacts = () => void refreshArtifacts()
    const onSpecField = (e: MessageEvent) => {
      try {
        const payload = JSON.parse(e.data) as { task_id: string }
        if (payload.task_id !== taskId) return
        void refreshArtifacts()
      } catch {
        // malformed payload — ignore
      }
    }
    const url = `${getServerUrl()}/api/tasks/events`
    const unArt = subscribeSSE(url, TASK_ARTIFACTS_UPDATE_EVENT, onArtifacts)
    const unSpec = subscribeSSE(url, SPEC_FIELD_UPDATE_EVENT, onSpecField)
    return () => { unArt(); unSpec() }
  }, [taskId, refreshArtifacts])

  // ── Assist runs (runIds owned by parent; viewer fetches each) ───────
  const [runs, setRuns] = useState<Record<string, AssistWorkflowRun>>({})
  const [logRun, setLogRun] = useState<AssistWorkflowRun | null>(null)

  const refreshRun = useCallback(async (runId: string) => {
    try {
      const run = await getAssistWorkflowRun(taskId, runId)
      setRuns((prev) => ({ ...prev, [runId]: run }))
    } catch (err: unknown) {
      // A 404 (run pruned) or mismatch — drop it silently so the card disappears.
      // eslint-disable-next-line no-console
      console.warn(`[output-viewer] refreshRun ${runId} failed:`, err instanceof Error ? err.message : String(err))
    }
  }, [taskId])

  // Fetch each tracked run once on mount/runIds-change. D19: NO polling —
  // subsequent transitions are driven by the SSE assist_run_update handler
  // below (server emits start/complete/error). The one-shot initial fetch
  // covers the subscribe-before-trigger race.
  useEffect(() => {
    void Promise.all(runIds.map((id) => refreshRun(id)))
  }, [runIds, refreshRun])

  // D19: SSE assist_run_update → re-fetch the named run (filtered by task_id).
  useEffect(() => {
    if (!taskId) return
    const onAssist = (e: MessageEvent) => {
      try {
        const payload = JSON.parse(e.data) as { task_id: string; run_id: string; phase: string }
        if (payload.task_id !== taskId) return
        if (!runIds.includes(payload.run_id)) return
        void refreshRun(payload.run_id)
      } catch {
        // malformed — ignore
      }
    }
    const unsub = subscribeSSE(
      `${getServerUrl()}/api/tasks/events`,
      ASSIST_RUN_UPDATE_EVENT,
      onAssist,
    )
    return () => unsub()
  }, [taskId, runIds, refreshRun])

  // ── Decision memo (server-side truth: task_spec.decisions) ─────────
  const decisions = (task.task_spec.decisions as string[] | undefined) ?? []
  const acItems = (task.task_spec.ac as string[] | undefined) ?? []
  const existingDecisions = decisions

  return (
    <div className="space-y-3" data-output-viewer-sections>
      {/* ── Artifacts (AC1/AC2) ── */}
      <div className="rounded-lg border bg-background" data-artifacts-section>
        <div className="px-3 py-2 border-b flex items-center justify-between">
          <span className="text-xs font-medium flex items-center gap-1">
            <FileText className="size-3" /> 产物 ({artifacts.length})
          </span>
          <span className="text-[10px] text-muted-foreground">点击查看完整内容</span>
        </div>
        {/* Artifacts dir path display — helps users locate where skill outputs land */}
        <div className="px-3 py-1 border-b flex items-center gap-1.5 text-[10px] text-muted-foreground font-mono bg-muted/30">
          <FolderOpen className="size-2.5 shrink-0" />
          <span className="truncate" title={artifactsDir}>{artifactsDir}</span>
          <button
            onClick={() => { copyToClipboard(artifactsDir) }}
            className="shrink-0 ml-auto p-0.5 rounded hover:bg-muted transition-colors"
            title="复制路径"
          >
            <Copy className="size-2.5" />
          </button>
        </div>
        {/* Context.md viewer row — shows agent's workspace context on click */}
        <button
          className="w-full px-3 py-2 flex items-center gap-2 hover:bg-muted/50 text-left border-b transition-colors"
          onClick={openContextViewer}
          data-context-viewer-row
        >
          <Settings2 className="size-3.5 shrink-0 text-purple-500" />
          <div className="flex-1 min-w-0">
            <div className="text-xs truncate">工作上下文 (context.md)</div>
            <div className="text-[9px] text-muted-foreground">org · 项目路径 · 技能组 — agent 感知的工作语境</div>
          </div>
          <Eye className="size-3.5 text-muted-foreground shrink-0" />
        </button>
        {artifactsLoading ? (
          <div className="px-3 py-3 text-[11px] text-muted-foreground flex items-center gap-2">
            <Spinner className="size-3" /> 加载产物索引…
          </div>
        ) : artifactsError ? (
          <div className="px-3 py-2 text-[11px] text-red-600">{artifactsError}</div>
        ) : artifacts.length === 0 ? (
          <div className="px-3 py-3 text-[11px] text-muted-foreground/60">
            ⏳ 尚无产物——agent 编写后产物会在此登记（artifacts.json）
          </div>
        ) : (
          <div className="divide-y">
            {artifacts.map((a, i) => (
              <button
                key={i}
                className="w-full px-3 py-2.5 flex items-center gap-2.5 hover:bg-muted/50 text-left"
                onClick={() => setViewing(a)}
                data-artifact-row={i}
              >
                <span className="text-base shrink-0">{artifactIcon(a.path)}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-xs truncate">{a.title || a.path}</div>
                  <div className="text-[9px] text-muted-foreground font-mono truncate">{a.path}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-[9px] text-muted-foreground">{a.updated_at.slice(0, 16).replace("T", " ")}</div>
                  <div className="text-[9px] text-muted-foreground">by {a.by}</div>
                </div>
                <Eye className="size-3.5 text-muted-foreground shrink-0" />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Assist-workflow run records (AC3/AC4/AC5/AC6) ── */}
      {runIds.length > 0 && (
        <div className="rounded-lg border bg-background" data-workflow-runs-section>
          <div className="px-3 py-2 border-b flex items-center justify-between">
            <span className="text-xs font-medium flex items-center gap-1">
              <Brain className="size-3" /> 工作流运行记录
            </span>
            <span className="text-[10px] text-muted-foreground">点击查看过程日志</span>
          </div>
          <div className="divide-y">
            {runIds.map((rid) => {
              const r = runs[rid]
              const badge = r ? runBadge(r.status) : { label: "拉取中", className: "text-[9px] bg-muted text-muted-foreground" }
              const isRunning = r?.status === "running" || r?.status === "pending" || r?.status === "queued"
              const hasOutput = !!r?.output
              const parseError = r?.output_parse_error === true
              return (
                <div key={rid} className="space-y-0">
                  <button
                    className="w-full px-3 py-2.5 flex items-center gap-2.5 hover:bg-muted/50 text-left"
                    onClick={() => r && setLogRun(r)}
                    data-run-row={rid}
                  >
                    <span className="text-base shrink-0">🧠</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs truncate">{r?.template ?? "…"}</div>
                      <div className="text-[9px] text-muted-foreground">
                        {r ? `${r.logs.length} 条日志 · ${rid.slice(0, 8)}` : rid.slice(0, 8)}
                      </div>
                    </div>
                    <Badge className={badge.className}>{badge.label}</Badge>
                    <Eye className="size-3.5 text-muted-foreground shrink-0" />
                  </button>

                  {/* Running card: expert indicator (AC4) */}
                  {isRunning && (
                    <div className="px-3 pb-2 text-[11px] text-purple-600 flex items-center gap-1.5" data-run-running>
                      专家运行中 <span className="animate-pulse">●●●</span>
                    </div>
                  )}

                  {/* Parse-error degraded card (AC6/SW-BP10) */}
                  {parseError && r?.output_raw && (
                    <div className="mx-3 mb-2 rounded-md border border-amber-400/40 bg-amber-500/5 p-2 text-[11px]" data-run-parse-error>
                      <div className="flex items-center gap-1 text-amber-600 mb-1">
                        <ShieldAlert className="size-3" /> 聚合器输出解析失败（展示原文）
                      </div>
                      <pre className="whitespace-pre-wrap break-words text-muted-foreground font-mono text-[10px] max-h-40 overflow-auto">
                        {r.output_raw}
                      </pre>
                    </div>
                  )}

                  {/* Adoption panel (AC5) — only when the run produced structured output */}
                  {hasOutput && r!.output && (
                    <div className="px-3 pb-2">
                      <MoaAdoptionPanel
                        taskId={taskId}
                        output={r!.output}
                        existingAc={acItems}
                        existingDecisions={existingDecisions}
                        onAdopted={() => onAdopted()}
                      />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Decision memo (D10 — adopted suggestions) ── */}
      {decisions.length > 0 && (
        <div className="rounded-lg border border-purple-400/30 bg-background p-3" data-decision-memo>
          <div className="text-xs font-medium mb-1.5 flex items-center gap-1">
            <Lightbulb className="size-3 text-purple-500" /> 决策备忘
            <span className="text-[9px] text-muted-foreground font-normal">来自 MoA · 供方案决策</span>
          </div>
          <ul className="text-[11px] space-y-1 text-muted-foreground">
            {decisions.map((d, i) => <li key={i}>• {d}</li>)}
          </ul>
        </div>
      )}

      {/* ── Dialogs ── */}
      <ArtifactViewerDialog
        taskId={taskId}
        entry={viewing}
        onOpenChange={(o) => { if (!o) setViewing(null) }}
      />
      <WorkflowLogDialog
        run={logRun}
        onOpenChange={(o) => { if (!o) setLogRun(null) }}
      />

      {/* ── Context viewer dialog ── */}
      <Dialog open={showContext} onOpenChange={(o) => { if (!o) setShowContext(false) }}>
        <DialogContent
          className="sm:max-w-[640px] max-h-[75vh] p-0 gap-0 flex flex-col"
          showCloseButton
          data-context-viewer-dialog
        >
          <DialogHeader className="px-4 py-3 border-b shrink-0 space-y-0">
            <DialogTitle className="text-sm flex items-center gap-2">
              <Settings2 className="size-3.5 text-purple-500" />
              工作上下文 (context.md)
            </DialogTitle>
            <DialogDescription className="font-mono text-[10px] truncate">
              {contextFilePath || "加载中…"}
            </DialogDescription>
          </DialogHeader>

          <ScrollArea className="flex-1 min-h-0" data-context-content-scroll>
            {contextLoading ? (
              <div className="flex items-center justify-center p-8 text-xs text-muted-foreground gap-2">
                <Spinner className="size-4" /> 读取上下文…
              </div>
            ) : contextContent ? (
              <pre className="p-4 text-[11px] leading-relaxed whitespace-pre-wrap font-mono break-words" data-context-content>
                {contextContent}
              </pre>
            ) : (
              <div className="p-6 text-xs text-muted-foreground text-center">
                context.md 尚未生成——首次对话后自动创建
              </div>
            )}
          </ScrollArea>

          <div className="px-4 py-2 border-t text-[10px] text-muted-foreground shrink-0">
            此文件是 agent 的工作语境。修改"编写语境"后 agent 会自动重新读取
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
