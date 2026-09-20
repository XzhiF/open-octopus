// packages/web-app/components/tasks/acceptance/verify-panel.tsx
//
// 验货台「当场复检」(acceptance v2) — run the task's acceptance_verify command
// IN THE LIVE WORKSPACE at decision time. The panel is presentational; the
// modal owns state (SSE-fed `lines`, the summary, run/abort calls) so verify
// events share one wiring point.
//
// 头三层重排（2026-09-20 原型定稿 20260920-verify-header-mock，用户点名「一行八物太乱」）：
//   L1 身份行 = 把手 + 题名 + 状态胶囊（未跑/跑着·Ns/✓ passed·dur/✗ failed·dur）+ 右动作区；
//   L2 参数行 = `$ 命令` + 逐仓 chip + ≤Ns + 编辑（文字钮）—— 命令是参数不是动作；
//   L3 结果区 = 状态驱动的输出：跑着常开随流；**跑完（过/挂）尾窗保留可见，
//       结论行「收起/看输出」开关控制显隐**（2026-09-20 用户改判：结束即消失
//       的终端没处回看，保留能看到、可折叠即可）。verdict 路径直接可点开全文。
//       旧 Terminal(>_) 手动钮退役 —— 它既被误认成折叠钮，显示时机又无需用户决定。
//
// Honesty rules baked in:
//   - never auto-runs (button only, threat model in the server service header);
//   - ws gone / no config / already running → explicit disabled reasons;
//   - verdict .md written by server lands in the batch dir; this panel points at
//     it and opens it in place (onOpenVerdict → ArtifactViewerDialog).

"use client"

import { useEffect, useRef, useState } from "react"
import { Play, RotateCcw, Square } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { AcceptanceVerify } from "@octopus/shared"
import { formatDuration } from "@/lib/format"
import { FoldHandle, useFold } from "../fold-context"
import { verifyPillLabel } from "./acceptance-labels"
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
  /** 点开 verdict .md 全文（home-relative path → ArtifactViewerDialog）。 */
  onOpenVerdict?: (path: string) => void
  onRun: () => void
  onAbort: () => void
}

export function VerifyPanel({ cfg, summary, lines, running, busy, disabledReason, onSaveCommand, onOpenVerdict, onRun, onAbort }: VerifyPanelProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(cfg?.command ?? "")
  const [cwdDraft, setCwdDraft] = useState(cfg?.cwd ?? "")
  const [perRepo, setPerRepo] = useState(!!cfg?.per_repo)
  const [timeoutDraft, setTimeoutDraft] = useState(String(cfg?.timeoutS ?? 600))
  const [saveBusy, setSaveBusy] = useState(false)
  const consoleRef = useRef<HTMLDivElement>(null)
  const [elapsedS, setElapsedS] = useState(0)
  // 跑完后的输出窗折叠开关（缺省=开着：结束保留可见，嫌占眼再折上）。
  const [outOpen, setOutOpen] = useState(true)
  const [showAll, setShowAll] = useState(false)

  // 新一次跑批 = 输出窗复位（重新开脸就展开）。
  useEffect(() => {
    setShowAll(false)
    setOutOpen(true)
  }, [summary?.started_at])

  // 运行中的秒表：从会话真实起点起算（started_at），重挂/切 tab 回来不归零 ——
  // 旧实现 t0=Date.now() 在每次挂载重算，跑 10 分钟切走再回显「跑着 · 2s」是假数。
  useEffect(() => {
    if (!running) { setElapsedS(0); return }
    const t0 = summary?.started_at ? Date.parse(summary.started_at) : Date.now()
    const base = Number.isNaN(t0) ? Date.now() : t0
    const tick = () => setElapsedS(Math.max(0, Math.floor((Date.now() - base) / 1000)))
    tick()
    const iv = setInterval(tick, 1000)
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

  const fold = useFold()
  const closed = fold ? fold.closed("item-verify", "info") : false
  // live 双源：父级 busy 旗 + summary 态（SSE 乱序/重连时二者可短暂背离）。
  const live = running || summary?.state === "running"
  const done = summary && summary.state !== "running" ? summary : null
  const failish = done && done.state !== "passed"
  const dur = done?.duration_ms != null ? ` · ${formatDuration(done.duration_ms)}` : ""
  const pill = live
    ? { t: `● 跑着 · ${elapsedS}s`, cls: "bg-pop-amber-soft text-pop-amber", st: "running" }
    : done?.state === "passed"
      ? { t: `✓ ${verifyPillLabel("passed")}${dur}`, cls: "bg-pop-green-soft text-[#0c7a4d]", st: "passed" }
      : done
        ? { t: `✗ ${verifyPillLabel(done.state)}${dur}`, cls: "bg-[#ffe3e9] text-pop-red", st: done.state }
        : cfg
          ? { t: "未跑", cls: "bg-pop-idle text-pop-dim", st: "idle" }
          : { t: "未配置", cls: "bg-pop-idle text-pop-dim", st: "none" }
  // 控制台出现时机：跑着/有未裁决的流在（断线重连 lines 先到）→ 常开；
  // 跑完（过/挂）→ 尾窗保留，跟 outOpen 折叠开关走 —— 结束后不再自动消失。
  const consoleOn = !closed && !editing && lines.length > 0 && (live || !done || outOpen)
  // 尾窗行数：跑着/通过截末 120 行（「前 N 行」钮可放全量）；挂了展开看全量。
  const consoleCap = live || !failish ? 120 : 3000
  return (
    <div
      className={`rounded-[13px] border-2 border-pop-bd bg-pop-paper shadow-pop-sm overflow-hidden ${running ? "marching-ants-border" : ""}`}
      data-verify-panel data-testid="verify-panel" data-fold-box="item-verify" data-fold-closed={closed ? "true" : undefined}
    >
      {/* L1 身份 + 结论 + 动作 */}
      <div className="flex items-center gap-2 px-3 py-2">
        {fold && <FoldHandle id="item-verify" closed={closed} onToggle={() => fold.toggle("item-verify", "info")} />}
        <span className="shrink-0 font-mono text-[9.5px] font-black tracking-[.09em] text-pop-dim">当场复检</span>
        <span className={`shrink-0 rounded-full border-2 border-pop-bd px-2.5 py-px font-mono text-[10px] font-black tabular-nums ${pill.cls}`} data-testid="verify-pill" data-state={pill.st}>
          {pill.t}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {done && !running && cfg && !editing && !closed && (
            <button
              onClick={onRun} disabled={busy || !!disabledReason}
              title="重跑（与初跑同参数）"
              className="grid size-[24px] place-items-center rounded-[8px] border-2 border-pop-bd bg-pop-paper text-pop-ink shadow-pop-sm transition-transform hover:-translate-y-px disabled:opacity-40"
              data-testid="verify-rerun"
            >
              <RotateCcw className="size-3" />
            </button>
          )}
          {live ? (
            <Button size="sm" variant="destructive" className="h-6 border-[2.5px] border-pop-bd px-2.5 font-mono text-[10px] font-black shadow-pop-sm" onClick={onAbort} disabled={busy} data-testid="verify-abort">
              <Square className="size-3 mr-1" /> 中止
            </Button>
          ) : cfg && !editing && !closed ? (
            <Button size="sm" className="h-6 border-[2.5px] border-pop-bd bg-pop-green px-3 font-mono text-[10.5px] font-black text-white shadow-pop-sm pop-press" disabled={busy || !!disabledReason} onClick={onRun} data-testid="verify-run" title={disabledReason ?? "在工作区现场执行，产出带新鲜时间戳的机器裁决"}>
              <Play className="size-3 mr-1" /> ▶ 复检
            </Button>
          ) : !cfg && !editing && !closed ? (
            <Button size="sm" variant="outline" className="h-6 border-[2.5px] border-pop-bd px-2.5 font-mono text-[10px] font-black shadow-pop-sm" onClick={() => { setDraft(""); setCwdDraft(""); setPerRepo(false); setTimeoutDraft("600"); setEditing(true) }} data-testid="verify-edit">
              配置命令
            </Button>
          ) : null}
        </span>
      </div>

      {/* L2 参数行（命令是参数，动作不在此） */}
      {!closed && !editing && cfg && (
        <div className="flex items-center gap-2 border-t-[1.5px] border-dashed border-pop-bd/15 bg-[#fbf8ee] px-3 py-1.5 font-mono" data-testid="verify-params">
          <span aria-hidden className="shrink-0 text-pop-dim">$</span>
          <code className="min-w-0 flex-1 truncate text-[11px]" title={cfg.command}>{cfg.command}</code>
          {cfg.per_repo && (
            <span className="shrink-0 rounded-[6px] border-[1.5px] border-dashed border-pop-bd/35 bg-pop-paper px-1.5 py-px text-[9px] font-black text-pop-dim" data-testid="verify-per-repo" title="对 projects/*/ 每个 git 仓各跑一次（仓根为 cwd），任一仓失败即整体 FAILED">逐仓</span>
          )}
          <span className="shrink-0 text-[10px] tabular-nums text-pop-dim">≤{cfg.timeoutS ?? 600}s</span>
          {!running && (
            <button className="shrink-0 text-[9.5px] font-black text-pop-navy underline decoration-dotted underline-offset-2" onClick={() => { setDraft(cfg.command); setCwdDraft(cfg.cwd ?? ""); setPerRepo(!!cfg.per_repo); setTimeoutDraft(String(cfg.timeoutS ?? 600)); setEditing(true) }} data-testid="verify-edit">
              编辑
            </button>
          )}
        </div>
      )}

      {disabledReason && !editing && !closed && (
        <div className="border-y border-pop-bd/10 bg-pop-amber-soft px-3 py-1.5 text-[10px] text-pop-ink/80" data-testid="verify-disabled-reason">
          {disabledReason}
        </div>
      )}

      {/* 命令编辑抽屉（spec-field 持久化）；取消 = 丢弃草稿原样收回（保存/清除不是仅有的门） */}
      {editing && !closed && (
        <div className="border-t-2 border-pop-bd/10 bg-pop-bd/5 px-3 py-2 space-y-2" data-testid="verify-editor">
          <textarea
            className="h-16 w-full resize-y rounded-md border-2 border-pop-bd bg-pop-paper p-2 font-mono text-[11px]"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="如：pnpm --filter @octopus/server exec vitest run —— 注意命令里别写字面 $vars.（引擎替换语法）"
            data-testid="verify-command-input"
          />
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1 font-mono text-[10px] text-pop-dim" title="对 projects/*/ 每仓各跑一次（仓根为 cwd，命令写仓内相对；多仓任务用这个，cwd 被忽略）">
              <input type="checkbox" checked={perRepo} onChange={(e) => setPerRepo(e.target.checked)} data-testid="verify-per-repo-input" />
              逐仓
            </label>
            <input
              type="text"
              className={`w-36 rounded-md border-2 border-pop-bd bg-pop-paper px-1.5 py-0.5 font-mono text-[10.5px] ${perRepo ? "opacity-40" : ""}`}
              placeholder="cwd(可选)"
              value={cwdDraft}
              disabled={perRepo}
              onChange={(e) => setCwdDraft(e.target.value)}
              data-testid="verify-cwd-input"
            />
            <label className="font-mono text-[10px] text-pop-dim">超时秒</label>
            <input
              type="number" min={5} max={1800}
              className="w-20 rounded-md border-2 border-pop-bd bg-pop-paper px-1.5 py-0.5 font-mono text-[11px] tabular-nums"
              value={timeoutDraft}
              onChange={(e) => setTimeoutDraft(e.target.value)}
              data-testid="verify-timeout-input"
            />
            <div className="ml-auto flex gap-1.5">
              <Button size="sm" variant="ghost" className="h-6 text-[10px]" disabled={saveBusy} onClick={() => setEditing(false)} data-testid="verify-cancel">
                取消
              </Button>
              <Button size="sm" variant="ghost" className="h-6 text-[10px]" disabled={saveBusy} onClick={() => void save(null)} data-testid="verify-clear">
                清除配置
              </Button>
              <Button size="sm" className="h-6 text-[10px]" disabled={saveBusy || !draft.trim()} onClick={() => void save({ command: draft.trim(), ...(perRepo ? { per_repo: true } : {}), ...(!perRepo && cwdDraft.trim() ? { cwd: cwdDraft.trim() } : {}), timeoutS: Math.max(5, Math.min(1800, Number(timeoutDraft) || 600)) })} data-testid="verify-save">
                保存（随任务持久化）
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* L3 结果区：失败/中止的裁决行（原因头 + verdict 入口 + 输出折叠开关） */}
      {done && failish && !closed && (
        <div className="border-t border-pop-bd/10 bg-[#fff5f5] px-3 py-1.5 font-mono text-[10.5px] text-pop-ink/80" data-testid="verify-result">
          <b className="text-pop-red">✗ {verifyPillLabel(done.state)}</b>
          {done.exit_code != null ? ` · exit ${done.exit_code}` : ""}
          {" — "}
          <span className="text-pop-dim">{outOpen ? "输出在下" : "输出已折叠"}</span>
          {done.verdict_path && onOpenVerdict && (
            <button className="ml-2 text-[9.5px] font-black text-pop-navy underline decoration-dotted underline-offset-2" onClick={() => onOpenVerdict(done.verdict_path!)} title="点开机器裁决文件全文" data-testid="verify-verdict-open">
              verdict 文件
            </button>
          )}
          <button className="ml-2 text-[9.5px] font-black text-pop-navy underline decoration-dotted underline-offset-2" onClick={() => setOutOpen((v) => !v)} data-testid="verify-out-toggle">
            {outOpen ? "收起输出 ▴" : "看输出 ▾"}
          </button>
        </div>
      )}
      {/* 通过：结论行 + verdict 入口 + 折叠开关（输出窗保留，不再整区消失） */}
      {done && !failish && !closed && (
        <div className="border-t border-pop-bd/10 bg-[#fbf8ee] px-3 py-1.5 font-mono text-[10.5px] text-pop-dim" data-testid="verify-result">
          <b className="text-pop-green">✓ 全绿</b> · {new Date(done.ended_at ?? done.started_at).toLocaleString("zh-CN", { hour12: false })}
          {done.verdict_path ? (
            onOpenVerdict ? (
              <button className="ml-1 text-pop-navy underline decoration-dotted underline-offset-2" onClick={() => onOpenVerdict(done.verdict_path!)} title="点开机器裁决文件全文" data-testid="verify-verdict-open">
                {`· 机器裁决：${done.verdict_path}`}
              </button>
            ) : (
              <span className="ml-1">{`· 机器裁决已落盘：${done.verdict_path}`}</span>
            )
          ) : (
            <span className="ml-1">· verdict 落批次目录</span>
          )}
          {lines.length > 0 && (
            <button className="ml-2 text-[9.5px] font-black text-pop-navy underline decoration-dotted underline-offset-2" onClick={() => setOutOpen((v) => !v)} data-testid="verify-out-toggle">
              {outOpen ? "收起输出 ▴" : "看输出 ▾"}
            </button>
          )}
        </div>
      )}

      {/* 输出控制台（跑着常开；跑完跟折叠开关走，过/挂都保留）：pop 终端 chrome */}
      {consoleOn && (
        <div className="border-y-2 border-pop-bd bg-pop-ink px-3 py-2 font-mono text-[10.5px] leading-relaxed text-pop-paper" ref={consoleRef} data-testid="verify-console">
          {lines.length > 120 && (
            <button
              className="block text-left text-pop-dim underline decoration-dotted underline-offset-2 hover:text-pop-paper"
              onClick={() => setShowAll((v) => !v)}
              data-testid="verify-fold-hint"
            >
              {showAll
                ? `▾ 收回前 ${lines.length - 120} 行（回到末 120 行）`
                : `…前 ${lines.length - 120} 行已折叠 — 点击展开（完整留档看 verdict 文件）`}
            </button>
          )}
          {(showAll ? lines.slice(-3000) : lines.slice(-consoleCap)).map((l, i, arr) => (
            <div key={showAll ? `all-${lines.length - arr.length + i}` : `tail-${lines.length - arr.length + i}`} className={`whitespace-pre-wrap break-all ${/^\[stderr\]|error|Error|FAIL/.test(l) ? "text-pop-amber" : ""}`}>{l || " "}</div>
          ))}
          {live && <div className="pop-blink text-pop-green">▊</div>}
        </div>
      )}
    </div>
  )
}
