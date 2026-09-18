// packages/web-app/components/tasks/acceptance/preview-bar.tsx
//
// 验收台「跑起来看」(acceptance v2.1, ADR-0022) — start the task's
// acceptance_preview command as a long-lived process in the live workspace,
// open it in a REAL browser, stop it. NO iframe (the reviewer's window is
// already dense; a sandboxed embed fakes the walkthrough the preview exists to
// enable). Presentational — the parent (acceptance-surface) owns the preview
// session state (SSE-fed) and the start/stop calls, same wiring point as verify.
//
// Visual: one-line status strip (dot + state + url) ↔ inline-expand config/log,
// pop 贴纸语言同 verify-panel。external (a `pnpm dev` the user started outside
// Octopus) shows as openable-but-no-stop.

"use client"

import { useState } from "react"
import { Play, Square, ExternalLink, Rocket, Terminal } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { AcceptancePreview } from "@octopus/shared"
import type { PreviewSummary } from "@/lib/tasks-api"

interface PreviewBarProps {
  cfg: AcceptancePreview | null
  preview: PreviewSummary | null
  busy: boolean
  disabledReason?: string
  /** 保存/清除预览配置；true=成功收起抽屉。 */
  onSaveCfg: (v: AcceptancePreview | null) => Promise<boolean>
  onStart: () => void
  onStop: () => void
}

const STATE_TXT: Record<string, { t: string; dot: string }> = {
  starting: { t: "启动中…", dot: "bg-pop-amber animate-pulse" },
  ready: { t: "ready", dot: "bg-pop-green" },
  exited: { t: "已退出", dot: "bg-pop-red" },
  stopped: { t: "未运行", dot: "bg-pop-dim" },
  failed: { t: "启动失败", dot: "bg-pop-red" },
}

export function PreviewBar({ cfg, preview, busy, disabledReason, onSaveCfg, onStart, onStop }: PreviewBarProps) {
  const [editing, setEditing] = useState(false)
  const [cmd, setCmd] = useState(cfg?.command ?? "")
  const [url, setUrl] = useState(cfg?.url ?? "http://localhost:")
  const [cwd, setCwd] = useState(cfg?.cwd ?? "")
  const [pattern, setPattern] = useState(cfg?.readyPattern ?? "")
  const [saving, setSaving] = useState(false)

  const state = preview?.state ?? "stopped"
  const meta = STATE_TXT[state] ?? STATE_TXT.stopped
  const external = !!preview?.external
  const openUrl = preview?.url ?? cfg?.url

  const save = async (v: AcceptancePreview | null) => {
    setSaving(true)
    try { if (await onSaveCfg(v)) setEditing(false) } finally { setSaving(false) }
  }

  return (
    <div className="rounded-[13px] border-2 border-pop-bd bg-pop-paper shadow-pop-sm overflow-hidden" data-preview-bar data-testid="preview-bar">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <Rocket className="size-3.5 shrink-0 text-pop-dim" />
        <span className="font-mono text-[9.5px] font-black tracking-[.09em] text-pop-dim">跑起来看</span>
        <span className={`inline-block size-2 rounded-full ${meta.dot}`} data-testid="preview-dot" />
        <span className="font-mono text-[11px] text-pop-ink/80">{meta.t}</span>
        {state === "ready" && openUrl && (
          <a href={openUrl} target="_blank" rel="noreferrer" className="truncate font-mono text-[10.5px] text-pop-purple underline decoration-dotted hover:text-pop-ink" title={`在浏览器打开 ${openUrl}`} data-testid="preview-url">
            {openUrl}{external ? " (外部)" : ""}
          </a>
        )}
        {cfg && !editing && (
          <Button size="sm" variant="ghost" className="ml-auto h-6 px-2 text-[10px]" onClick={() => { setCmd(cfg.command); setUrl(cfg.url); setCwd(cfg.cwd ?? ""); setPattern(cfg.readyPattern ?? ""); setEditing(true) }} data-testid="preview-edit">
            编辑
          </Button>
        )}
        {!cfg && !editing && (
          <Button size="sm" variant="ghost" className="ml-auto h-6 px-2 text-[10px]" onClick={() => { setCmd(""); setUrl("http://localhost:"); setEditing(true) }} data-testid="preview-configure">
            配置预览
          </Button>
        )}
      </div>

      {/* 动作行 */}
      {!editing && (
        <div className="flex items-center gap-2 border-t border-pop-bd/10 px-3 py-1.5">
          {state === "starting" ? (
            <>
              <span className="text-[10.5px] text-pop-amber">探活中…（任意 HTTP 响应即就绪）</span>
              <Button size="sm" variant="destructive" className="ml-auto h-6 px-2.5 text-[10px]" disabled={busy} onClick={onStop} data-testid="preview-stop"><Square className="size-3 mr-1" />停止</Button>
            </>
          ) : state === "ready" ? (
            <>
              <span className="text-[10px] text-pop-dim">{external ? "外部进程占用该端口 — 可直接打开（无需在此停止）" : "在工作区现场起着，检验完记得停"}</span>
              {openUrl && <a href={openUrl} target="_blank" rel="noreferrer"><Button size="sm" variant="outline" className="h-6 px-2.5 text-[10px]"><ExternalLink className="size-3 mr-1" />浏览器打开</Button></a>}
              {!external && <Button size="sm" variant="destructive" className="ml-auto h-6 px-2.5 text-[10px]" disabled={busy} onClick={onStop} data-testid="preview-stop"><Square className="size-3 mr-1" />停止</Button>}
            </>
          ) : (
            <>
              <span className="text-[10.5px] text-muted-foreground">
                {disabledReason ?? (cfg ? "未启动 — 决策(通过/打回/中止)时会自动停止并记入台账" : "配一条长驻命令：pnpm dev / mvn spring-boot:run / uvicorn…")}
              </span>
              {cfg && (
                <Button size="sm" className="ml-auto h-6 border-[2.5px] border-pop-bd bg-pop-green px-2.5 font-mono text-[10px] font-black text-white shadow-pop-sm pop-press" disabled={busy || !!disabledReason} onClick={onStart} title={disabledReason ?? "在工作区现场起服务，产出可在真浏览器检验"} data-testid="preview-start">
                  <Play className="size-3 mr-1" />▶ 启动
                </Button>
              )}
            </>
          )}
        </div>
      )}

      {/* 配置抽屉（spec-field 持久化，随任务全 phase 复用） */}
      {editing && (
        <div className="space-y-1.5 border-t-2 border-pop-bd/10 bg-pop-bd/5 px-3 py-2" data-testid="preview-editor">
          <input className="w-full rounded-md border-2 border-pop-bd bg-pop-paper px-2 py-1 font-mono text-[11px]" placeholder="长驻命令，如 mvn -q spring-boot:run" value={cmd} onChange={(e) => setCmd(e.target.value)} data-testid="preview-command" />
          <div className="flex gap-2">
            <input className="min-w-0 flex-1 rounded-md border-2 border-pop-bd bg-pop-paper px-2 py-1 font-mono text-[11px]" placeholder="探活/打开 URL：http://localhost:8080/" value={url} onChange={(e) => setUrl(e.target.value)} data-testid="preview-url-input" />
            <input className="w-28 rounded-md border-2 border-pop-bd bg-pop-paper px-2 py-1 font-mono text-[11px]" placeholder="cwd(可选)" value={cwd} onChange={(e) => setCwd(e.target.value)} data-testid="preview-cwd" />
          </div>
          <input className="w-full rounded-md border-2 border-pop-bd bg-pop-paper px-2 py-1 font-mono text-[10.5px]" placeholder="readyPattern（可选，stdout 正则，如 'Started .*Application'）" value={pattern} onChange={(e) => setPattern(e.target.value)} data-testid="preview-pattern" />
          <div className="flex items-center gap-2 pt-0.5">
            <span className="text-[10px] text-muted-foreground">命令里别写字面 <code>$vars.</code> / <code>{"${x|filter}"}</code>（引擎替换语法，会被误替换）</span>
            <div className="ml-auto flex gap-1.5">
              <Button size="sm" variant="ghost" className="h-6 text-[10px]" disabled={saving} onClick={() => void save(null)} data-testid="preview-clear">清除</Button>
              <Button size="sm" className="h-6 text-[10px]" disabled={saving || !cmd.trim() || !/^https?:\/\//i.test(url)} onClick={() => void save({ command: cmd.trim(), url: url.trim(), ...(cwd.trim() ? { cwd: cwd.trim() } : {}), ...(pattern.trim() ? { readyPattern: pattern.trim() } : {}) })} data-testid="preview-save">
                保存（随任务持久化）
              </Button>
            </div>
          </div>
        </div>
      )}
      {preview?.tail && preview.tail.length > 0 && state === "starting" && (
        <div className="max-h-[120px] overflow-hidden border-t border-pop-bd/10 bg-pop-ink px-3 py-1.5 font-mono text-[9.5px] leading-relaxed text-pop-bg">
          <div className="flex items-center gap-1 text-pop-dim mb-0.5"><Terminal className="size-2.5" />stdout（末行）</div>
          {preview.tail.slice(-3).map((l, i) => <div key={i} className="truncate">{l}</div>)}
        </div>
      )}
    </div>
  )
}
