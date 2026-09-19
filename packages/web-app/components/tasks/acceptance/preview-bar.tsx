// packages/web-app/components/tasks/acceptance/preview-bar.tsx
//
// 验收台「跑起来看」(acceptance v2.1, ADR-0022) — start the task's preview
// service in the live workspace, open it in a REAL browser, stop it. NO iframe
// (the reviewer's window is already dense; a sandboxed embed fakes the
// walkthrough the preview exists to enable). Presentational — the parent
// (acceptance-surface) owns the session state (SSE-fed) and start/stop calls.
//
// 两代配置并存（与 server resolveRunbook 同优先级，web 不另起裁判）：
//   ① acceptance_runbook —— 多服务/远端部署的正道形态：up 起、ready **跑命令看
//      退出码** 判就绪、views[] 多入口、down 收尾。存在时本条以 runbook 模式渲染。
//   ② acceptance_preview —— 单服务简写（长驻命令 + url 探活）。零改动继续跑。
// 都没配 → 「配置预览」抽屉（简写）或 「runbook 方式」直配多服务。
//
// Visual: one-line status strip (dot + state + 入口链接们) ↔ inline-expand
// config/log. pop 贴纸语言同 verify-panel。external (a `pnpm dev` the user
// started outside Octopus) shows as openable-but-no-stop.

"use client"

import { useState } from "react"
import { Play, Square, ExternalLink, Rocket, Terminal, Layers } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { AcceptancePreview, AcceptanceRunbook, RunbookView } from "@octopus/shared"
import type { PreviewSummary } from "@/lib/tasks-api"

interface PreviewBarProps {
  /** legacy 单服务简写（server 会把它合成一份 runbook）。 */
  cfg: AcceptancePreview | null
  /** 通用运行手册（多服务/远端部署）。存在时优先于 cfg（同 server 裁判）。 */
  runbook: AcceptanceRunbook | null
  preview: PreviewSummary | null
  busy: boolean
  disabledReason?: string
  /** 保存/清除简写配置；true=成功收起抽屉。 */
  onSaveCfg: (v: AcceptancePreview | null) => Promise<boolean>
  /** 保存/清除 runbook 配置；true=成功收起抽屉。 */
  onSaveRunbook: (v: AcceptanceRunbook | null) => Promise<boolean>
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

/** views[] → 编辑器 textarea 行（`label|url`，label 空则纯 url）。 */
function viewsToText(views: RunbookView[]): string {
  return views.map((v) => (v.label ? `${v.label}|${v.url}` : v.url)).join("\n")
}
/** textarea 行 → views[]；非法行静默丢（保存前用户看得见什么进什么出）。 */
function textToViews(text: string): RunbookView[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 20)
    .map((l) => {
      const i = l.indexOf("|")
      const url = (i >= 0 ? l.slice(i + 1) : l).trim()
      const label = i >= 0 ? l.slice(0, i).trim() : ""
      return { ...(label ? { label } : {}), url }
    })
    .filter((v) => /^https?:\/\//i.test(v.url))
}

const inputCls = "w-full rounded-md border-2 border-pop-bd bg-pop-paper px-2 py-1 font-mono text-[11px]"

export function PreviewBar({ cfg, runbook, preview, busy, disabledReason, onSaveCfg, onSaveRunbook, onStart, onStop }: PreviewBarProps) {
  const [editing, setEditing] = useState(false)
  // ② 简写编辑态
  const [cmd, setCmd] = useState(cfg?.command ?? "")
  const [url, setUrl] = useState(cfg?.url ?? "http://localhost:")
  const [cwd, setCwd] = useState(cfg?.cwd ?? "")
  const [pattern, setPattern] = useState(cfg?.readyPattern ?? "")
  // ① runbook 编辑态
  const [rbMode, setRbMode] = useState(false)
  const [upCmd, setUpCmd] = useState(runbook?.up.command ?? "")
  const [upCwd, setUpCwd] = useState(runbook?.up.cwd ?? "")
  const [readyCmd, setReadyCmd] = useState(runbook?.ready.command ?? "")
  const [readyCwd, setReadyCwd] = useState(runbook?.ready.cwd ?? "")
  const [viewsText, setViewsText] = useState(viewsToText(runbook?.views ?? []))
  const [downCmd, setDownCmd] = useState(runbook?.down?.command ?? "")
  const [downCwd, setDownCwd] = useState(runbook?.down?.cwd ?? "")
  const [timeoutDraft, setTimeoutDraft] = useState(String(runbook?.timeoutS ?? 120))
  const [saving, setSaving] = useState(false)

  const state = preview?.state ?? "stopped"
  const meta = STATE_TXT[state] ?? STATE_TXT.stopped
  const external = !!preview?.external
  const mode: "runbook" | "preview" | null = runbook ? "runbook" : cfg ? "preview" : null
  // 就绪入口：后端 views[] 为准（runbook 原样 / 简写合成 [{url}]），回退配置值。
  const views: RunbookView[] =
    preview?.views?.length ? preview.views
      : preview?.url ? [{ url: preview.url }]
        : runbook?.views?.length ? runbook.views
          : cfg?.url ? [{ url: cfg.url }] : []

  const seedRbFromPreview = () => {
    setUpCmd(cmd || cfg?.command || "")
    setUpCwd(cwd || cfg?.cwd || "")
    const u = (url || cfg?.url || "").trim()
    setReadyCmd(u ? `curl -sf ${JSON.stringify(u)} -o /dev/null` : "")
    setViewsText(u ? viewsToText([{ url: u }]) : "")
    setRbMode(true)
  }

  const startEdit = () => {
    if (runbook) setRbMode(true)
    setEditing(true)
  }

  const save = async (fn: () => Promise<boolean>) => {
    setSaving(true)
    try { if (await fn()) setEditing(false) } finally { setSaving(false) }
  }

  const rbValid = upCmd.trim().length > 0 && readyCmd.trim().length > 0

  return (
    <div className="rounded-[13px] border-2 border-pop-bd bg-pop-paper shadow-pop-sm overflow-hidden" data-preview-bar data-testid="preview-bar">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <Rocket className="size-3.5 shrink-0 text-pop-dim" />
        <span className="font-mono text-[9.5px] font-black tracking-[.09em] text-pop-dim">跑起来看</span>
        {mode === "runbook" && (
          <span className="inline-flex items-center gap-1 rounded-full border border-pop-bd/40 bg-pop-bd/10 px-1.5 py-px font-mono text-[9px] font-bold text-pop-dim" data-testid="preview-mode-runbook" title="通用运行手册：up → ready(命令退出码=就绪) → views → down">
            <Layers className="size-2" />runbook{runbook?.views && runbook.views.length > 1 ? ` ×${runbook.views.length}` : ""}
          </span>
        )}
        <span className={`inline-block size-2 rounded-full ${meta.dot}`} data-testid="preview-dot" />
        <span className="font-mono text-[11px] text-pop-ink/80">{meta.t}</span>
        {state === "ready" && views.map((v, i) => (
          <a key={`${v.url}-${i}`} href={v.url} target="_blank" rel="noreferrer" className="truncate font-mono text-[10.5px] text-pop-purple underline decoration-dotted hover:text-pop-ink" title={`在浏览器打开 ${v.label ?? v.url}`} data-testid="preview-url" data-view-label={v.label}>
            {v.label ? `${v.label} ${v.url}` : v.url}{external && i === 0 ? " (外部)" : ""}
          </a>
        ))}
        {mode && !editing && (
          <Button size="sm" variant="ghost" className="ml-auto h-6 px-2 text-[10px]" onClick={startEdit} data-testid="preview-edit">
            编辑
          </Button>
        )}
        {!mode && !editing && (
          <div className="ml-auto flex gap-1">
            <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={() => { setRbMode(true); setEditing(true) }} data-testid="preview-configure-rb">
              runbook 方式
            </Button>
            <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={() => { setRbMode(false); setEditing(true) }} data-testid="preview-configure">
              配置预览
            </Button>
          </div>
        )}
      </div>

      {/* 动作行 */}
      {!editing && (
        <div className="flex items-center gap-2 border-t border-pop-bd/10 px-3 py-1.5">
          {state === "starting" ? (
            <>
              <span className="text-[10.5px] text-pop-amber">{mode === "runbook" ? "探活中…（ready 命令退出码 0 = 就绪）" : "探活中…（任意 HTTP 响应即就绪）"}</span>
              <Button size="sm" variant="destructive" className="ml-auto h-6 px-2.5 text-[10px]" disabled={busy} onClick={onStop} data-testid="preview-stop"><Square className="size-3 mr-1" />停止</Button>
            </>
          ) : state === "ready" ? (
            <>
              <span className="text-[10px] text-pop-dim">{external ? "外部进程占用该端口 — 可直接打开（无需在此停止）" : "在工作区现场起着，检验完记得停"}</span>
              {views.length > 0 && <a href={views[0].url} target="_blank" rel="noreferrer"><Button size="sm" variant="outline" className="h-6 px-2.5 text-[10px]"><ExternalLink className="size-3 mr-1" />浏览器打开</Button></a>}
              {!external && <Button size="sm" variant="destructive" className="ml-auto h-6 px-2.5 text-[10px]" disabled={busy} onClick={onStop} data-testid="preview-stop"><Square className="size-3 mr-1" />停止</Button>}
            </>
          ) : (
            <>
              <span className="text-[10.5px] text-muted-foreground">
                {disabledReason ?? (mode
                  ? "未启动 — 决策(通过/打回/中止)时会自动停止并记入台账"
                  : "配一条起服务命令：compose up / mvn spring-boot:run / uvicorn…，或 runbook 方式（多服务·命令判就绪）")}
              </span>
              {mode && (
                <Button size="sm" className="ml-auto h-6 border-[2.5px] border-pop-bd bg-pop-green px-2.5 font-mono text-[10px] font-black text-white shadow-pop-sm pop-press" disabled={busy || !!disabledReason} onClick={onStart} title={disabledReason ?? "在工作区现场起服务，产出可在真浏览器检验"} data-testid="preview-start">
                  <Play className="size-3 mr-1" />▶ 启动
                </Button>
              )}
            </>
          )}
        </div>
      )}

      {/* 配置抽屉（spec-field 持久化，随任务全 phase 复用） */}
      {editing && rbMode && (
        <div className="space-y-1.5 border-t-2 border-pop-bd/10 bg-pop-bd/5 px-3 py-2" data-testid="preview-editor" data-rb="true">
          <div className="flex gap-2">
            <input className={inputCls + " flex-1"} placeholder="up：起服务命令（长驻或快速退出的 launcher 都行）" value={upCmd} onChange={(e) => setUpCmd(e.target.value)} data-testid="rb-up-command" />
            <input className="w-40 shrink-0 rounded-md border-2 border-pop-bd bg-pop-paper px-2 py-1 font-mono text-[11px]" placeholder="cwd(可选)" value={upCwd} onChange={(e) => setUpCwd(e.target.value)} data-testid="rb-up-cwd" />
          </div>
          <div className="flex gap-2">
            <input className={inputCls + " flex-1"} placeholder="ready：探活命令 — 退出码 0 = 就绪（curl 探 / compose ps / wait-for 全压成这条）" value={readyCmd} onChange={(e) => setReadyCmd(e.target.value)} data-testid="rb-ready-command" />
            <input className="w-40 shrink-0 rounded-md border-2 border-pop-bd bg-pop-paper px-2 py-1 font-mono text-[11px]" placeholder="cwd(可选)" value={readyCwd} onChange={(e) => setReadyCwd(e.target.value)} data-testid="rb-ready-cwd" />
          </div>
          <textarea rows={3} className={inputCls + " resize-y"} placeholder={"views：每行一个入口，url 或 label|url\n如 admin|http://localhost:8080/\nhttp://localhost:3000/"} value={viewsText} onChange={(e) => setViewsText(e.target.value)} data-testid="rb-views" />
          <div className="flex gap-2">
            <input className={inputCls + " flex-1"} placeholder="down（可选）：停止时收尾杀进程；留空 = 只结束会话（远端部署别写）" value={downCmd} onChange={(e) => setDownCmd(e.target.value)} data-testid="rb-down-command" />
            <input className="w-40 shrink-0 rounded-md border-2 border-pop-bd bg-pop-paper px-2 py-1 font-mono text-[11px]" placeholder="cwd(可选)" value={downCwd} onChange={(e) => setDownCwd(e.target.value)} data-testid="rb-down-cwd" />
          </div>
          <div className="flex items-center gap-2 pt-0.5">
            <label className="flex items-center gap-1 text-[10px] text-muted-foreground">就绪预算(s)
              <input type="number" min={5} max={1800} className="w-16 rounded-md border-2 border-pop-bd bg-pop-paper px-1.5 py-0.5 font-mono text-[10.5px]" value={timeoutDraft} onChange={(e) => setTimeoutDraft(e.target.value)} data-testid="rb-timeout" />
            </label>
            <span className="text-[10px] text-muted-foreground">别写字面 <code>$vars.</code> / <code>{"${x|filter}"}</code></span>
            <div className="ml-auto flex gap-1.5">
              {cfg && (
                <Button size="sm" variant="ghost" className="h-6 text-[10px]" disabled={saving} onClick={() => { setRbMode(false); setEditing(false) }} title="任务另有单服务简写配置，切回去看">
                  简写方式
                </Button>
              )}
              {runbook && (
                <Button size="sm" variant="ghost" className="h-6 text-[10px]" disabled={saving} onClick={() => void save(() => onSaveRunbook(null))} data-testid="rb-clear">清除</Button>
              )}
              <Button size="sm" className="h-6 text-[10px]" disabled={saving || !rbValid} onClick={() => void save(() => onSaveRunbook({
                up: { command: upCmd.trim(), ...(upCwd.trim() ? { cwd: upCwd.trim() } : {}) },
                ready: { command: readyCmd.trim(), ...(readyCwd.trim() ? { cwd: readyCwd.trim() } : {}) },
                ...(textToViews(viewsText).length ? { views: textToViews(viewsText) } : {}),
                ...(downCmd.trim() ? { down: { command: downCmd.trim(), ...(downCwd.trim() ? { cwd: downCwd.trim() } : {}) } } : {}),
                timeoutS: Math.max(5, Math.min(1800, Number(timeoutDraft) || 120)),
              }))} data-testid="rb-save">
                保存 runbook（随任务持久化）
              </Button>
            </div>
          </div>
        </div>
      )}
      {editing && !rbMode && (
        <div className="space-y-1.5 border-t-2 border-pop-bd/10 bg-pop-bd/5 px-3 py-2" data-testid="preview-editor">
          <input className={inputCls} placeholder="长驻命令，如 mvn -q spring-boot:run" value={cmd} onChange={(e) => setCmd(e.target.value)} data-testid="preview-command" />
          <div className="flex gap-2">
            <input className="min-w-0 flex-1 rounded-md border-2 border-pop-bd bg-pop-paper px-2 py-1 font-mono text-[11px]" placeholder="探活/打开 URL：http://localhost:8080/" value={url} onChange={(e) => setUrl(e.target.value)} data-testid="preview-url-input" />
            <input className="w-28 rounded-md border-2 border-pop-bd bg-pop-paper px-2 py-1 font-mono text-[11px]" placeholder="cwd(可选)" value={cwd} onChange={(e) => setCwd(e.target.value)} data-testid="preview-cwd" />
          </div>
          <input className="w-full rounded-md border-2 border-pop-bd bg-pop-paper px-2 py-1 font-mono text-[10.5px]" placeholder="readyPattern（可选，stdout 正则，如 'Started .*Application'）" value={pattern} onChange={(e) => setPattern(e.target.value)} data-testid="preview-pattern" />
          <div className="flex items-center gap-2 pt-0.5">
            <span className="text-[10px] text-muted-foreground">命令里别写字面 <code>$vars.</code> / <code>{"${x|filter}"}</code>（引擎替换语法，会被误替换）</span>
            <div className="ml-auto flex gap-1.5">
              <Button size="sm" variant="ghost" className="h-6 text-[10px]" disabled={saving} onClick={() => void seedRbFromPreview()} data-testid="preview-to-rb">runbook 方式 →</Button>
              <Button size="sm" variant="ghost" className="h-6 text-[10px]" disabled={saving} onClick={() => void save(() => onSaveCfg(null))} data-testid="preview-clear">清除</Button>
              <Button size="sm" className="h-6 text-[10px]" disabled={saving || !cmd.trim() || !/^https?:\/\//i.test(url)} onClick={() => void save(() => onSaveCfg({ command: cmd.trim(), url: url.trim(), ...(cwd.trim() ? { cwd: cwd.trim() } : {}), ...(pattern.trim() ? { readyPattern: pattern.trim() } : {}) }))} data-testid="preview-save">
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
