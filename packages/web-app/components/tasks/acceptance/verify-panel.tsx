// packages/web-app/components/tasks/acceptance/verify-panel.tsx
//
// 验货台「当场复检」(acceptance v2) — run the task's acceptance_verify command
// IN THE LIVE WORKSPACE at decision time. The panel is presentational; the
// modal owns state (SSE-fed `lines`, the summary, run/abort calls) so verify
// events share one wiring point. Visual language: pop 终端 chrome (bg-pop-ink)
// + marching-ants while armed + 盖章 on verdict (rotate stamp, .pop-stamp).
//
// Honesty rules baked in:
//   - never auto-runs (button only, threat model in the server service header);
//   - ws gone / no config / already running → explicit disabled reasons;
//   - verdict .md written by server lands in 叙述 tab (this panel just points).

"use client"

import { useEffect, useRef, useState } from "react"
import { Ban, Play, Square, Terminal } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { AcceptanceVerify } from "@octopus/shared"
import { formatDuration } from "@/lib/format"
import type { VerifySummary } from "@/lib/tasks-api"

interface VerifyPanelProps {
  cfg: AcceptanceVerify | null
  summary: VerifySummary | null
  lines: string[]
  running: boolean
  busy: boolean
  /** run 不可用的诚实原因（ws 没了等）；undefined = 可跑（或可配命令）。 */
  disabledReason?: string
  /** 保存/清除复检命令；true=成功（面板随即收起编辑抽屉），false=失败保持编辑。 */
  onSaveCommand: (v: AcceptanceVerify | null) => Promise<boolean>
  onRun: () => void
  onAbort: () => void
}

const STATE_LABEL: Record<string, string> = {
  running: "复检执行中", passed: "PASSED", failed: "FAILED",
  aborted: "ABORTED", timeout: "TIMEOUT",
}

export function VerifyPanel({ cfg, summary, lines, running, busy, disabledReason, onSaveCommand, onRun, onAbort }: VerifyPanelProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(cfg?.command ?? "")
  const [timeoutDraft, setTimeoutDraft] = useState(String(cfg?.timeoutS ?? 600))
  const [saveBusy, setSaveBusy] = useState(false)
  const consoleRef = useRef<HTMLDivElement>(null)
  const [elapsedS, setElapsedS] = useState(0)

  // 运行中的秒表（marching-ants 是装饰，数字才是耐心药）。
  useEffect(() => {
    if (!running) { setElapsedS(0); return }
    const t0 = Date.now()
    const iv = setInterval(() => setElapsedS(Math.floor((Date.now() - t0) / 1000)), 1000)
    return () => clearInterval(iv)
  }, [running, summary?.started_at])

  // 新行到达即贴底（人在看日志，别让他滚动）。
  useEffect(() => {
    const el = consoleRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines.length])

  const save = async (v: AcceptanceVerify | null) => {
    setSaveBusy(true)
    try {
      if (await onSaveCommand(v)) setEditing(false)
    } finally {
      setSaveBusy(false)
    }
  }

  const stampTone =
    summary?.state === "passed" ? "border-pop-green outline-pop-green text-pop-green"
      : summary?.state === "running" ? "border-pop-amber outline-pop-amber text-pop-amber"
        : summary ? "border-pop-red outline-pop-red text-pop-red"
          : "border-pop-dim outline-pop-dim text-pop-dim"

  return (
    <div
      className={`rounded-[13px] border-2 border-pop-bd bg-pop-paper shadow-pop-sm overflow-hidden ${running ? "marching-ants-border" : ""}`}
      data-verify-panel data-testid="verify-panel"
    >
      {/* 头：命令 + 编辑/超时/跑钮 */}
      <div className="flex flex-wrap items-center gap-2 border-b-2 border-pop-bd/10 px-3 py-2">
        <Terminal className="size-3.5 shrink-0 text-pop-dim" />
        <span className="font-mono text-[9.5px] font-black tracking-[.09em] text-pop-dim">当场复检</span>
        {cfg ? (
          <code className="min-w-0 flex-1 truncate rounded bg-pop-bd/5 px-1.5 py-0.5 font-mono text-[11px]" title={cfg.command}>
            {cfg.command}
          </code>
        ) : (
          <span className="flex-1 text-[11px] text-muted-foreground">未预设复检命令</span>
        )}
        {cfg && !editing && (
          <>
            <span className="font-mono text-[9px] tabular-nums text-pop-dim">≤{cfg.timeoutS ?? 600}s</span>
            <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={() => { setDraft(cfg.command); setTimeoutDraft(String(cfg.timeoutS ?? 600)); setEditing(true) }} data-testid="verify-edit">
              编辑
            </Button>
          </>
        )}
        {!cfg && !editing && (
          <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={() => { setDraft(""); setTimeoutDraft("600"); setEditing(true) }} data-testid="verify-edit">
            配置命令
          </Button>
        )}
        {!running && summary && summary.state !== "running" && (
          <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" disabled={busy || !!disabledReason} onClick={onRun} data-testid="verify-rerun">
            <Play className="size-3 mr-1" /> 重跑
          </Button>
        )}
        {running ? (
          <Button size="sm" variant="destructive" className="h-6 px-2 text-[10px]" onClick={onAbort} disabled={busy} data-testid="verify-abort">
            <Square className="size-3 mr-1" /> 中止{elapsedS > 0 ? ` ${elapsedS}s` : ""}
          </Button>
        ) : cfg && !editing ? (
          <Button size="sm" className="h-6 border-[2.5px] border-pop-bd bg-pop-green px-2.5 font-mono text-[10px] font-black text-white shadow-pop-sm pop-press" disabled={busy || !!disabledReason} onClick={onRun} data-testid="verify-run" title={disabledReason ?? "在工作区现场执行，产出带新鲜时间戳的机器裁决"}>
            <Play className="size-3 mr-1" /> ▶ 复检
          </Button>
        ) : null}
      </div>

      {disabledReason && !editing && (
        <div className="border-b border-pop-bd/10 bg-pop-amber-soft px-3 py-1.5 text-[10px] text-pop-ink/80" data-testid="verify-disabled-reason">
          {disabledReason}
        </div>
      )}

      {/* 命令编辑抽屉（spec-field 持久化，随任务全 phase 复用） */}
      {editing && (
        <div className="border-b-2 border-pop-bd/10 bg-pop-bd/5 px-3 py-2 space-y-2" data-testid="verify-editor">
          <textarea
            className="h-16 w-full resize-y rounded-md border-2 border-pop-bd bg-pop-paper p-2 font-mono text-[11px]"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="如：pnpm --filter @octopus/server exec vitest run —— 注意命令里别写字面 $vars.（引擎替换语法）"
            data-testid="verify-command-input"
          />
          <div className="flex items-center gap-2">
            <label className="font-mono text-[10px] text-pop-dim">超时秒</label>
            <input
              type="number" min={5} max={1800}
              className="w-20 rounded-md border-2 border-pop-bd bg-pop-paper px-1.5 py-0.5 font-mono text-[11px] tabular-nums"
              value={timeoutDraft}
              onChange={(e) => setTimeoutDraft(e.target.value)}
              data-testid="verify-timeout-input"
            />
            <div className="ml-auto flex gap-1.5">
              <Button size="sm" variant="ghost" className="h-6 text-[10px]" disabled={saveBusy} onClick={() => void save(null)} data-testid="verify-clear">
                清除配置
              </Button>
              <Button size="sm" className="h-6 text-[10px]" disabled={saveBusy || !draft.trim()} onClick={() => void save({ command: draft.trim(), timeoutS: Math.max(5, Math.min(1800, Number(timeoutDraft) || 600)) })} data-testid="verify-save">
                保存（随任务持久化）
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 输出控制台：pop 终端 chrome */}
      {(running || lines.length > 0) && (
        <div className="border-y-2 border-pop-bd bg-pop-ink px-3 py-2 font-mono text-[10.5px] leading-relaxed text-pop-paper" ref={consoleRef} data-testid="verify-console">
          {lines.length > 120 && <div className="text-pop-dim">[…前 {lines.length - 120} 行已折叠，完整看 verdict 文件]</div>}
          {lines.slice(-120).map((l, i) => (
            <div key={i} className={`whitespace-pre-wrap break-all ${/^\[stderr\]|error|Error|FAIL/.test(l) ? "text-pop-amber" : ""}`}>{l || " "}</div>
          ))}
          {running && <div className="pop-blink text-pop-green">▊</div>}
        </div>
      )}

      {/* 脚：盖章 + verdict 指针 */}
      <div className="flex items-center gap-2 px-3 py-2">
        {summary && (
          <span
            className={`pop-stamp inline-block rounded-[10px] border-[2.5px] bg-transparent px-2 py-0.5 font-mono text-[12px] font-black tracking-[.12em] outline outline-[3px] -rotate-2 ${stampTone}`}
            data-testid="verify-stamp"
            data-state={summary.state}
          >
            {STATE_LABEL[summary.state] ?? summary.state}
            {summary.exit_code != null && summary.state !== "running" ? ` · exit ${summary.exit_code}` : ""}
          </span>
        )}
        {summary?.state === "running" && (
          <span className="font-mono text-[10px] text-pop-amber tabular-nums">已运行 {elapsedS}s — 全量套件是分钟级的，等它</span>
        )}
        {summary && summary.state !== "running" && (
          <span className="font-mono text-[9.5px] text-pop-dim tabular-nums">
            {new Date(summary.ended_at ?? summary.started_at).toLocaleString("zh-CN", { hour12: false })}
            {summary.duration_ms != null ? ` · ${formatDuration(summary.duration_ms)}` : ""}
          </span>
        )}
        <span className="ml-auto text-[10px] text-muted-foreground">
          {summary?.verdict_path ? `机器裁决已落盘：${summary.verdict_path}` : "verdict 落批次目录（叙述 tab 可见）"}
        </span>
      </div>
    </div>
  )
}
