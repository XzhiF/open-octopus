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
//   L3 结果区 = 状态驱动的输出：**跑着常开随流；挂了尾窗顶出+「看输出」开关；
//       过了整区不显示**（verdict 行即全部）。旧 Terminal(>_) 手动钮退役 ——
//       它既被误认成折叠钮，显示时机又无需用户决定。
//
// Honesty rules baked in:
//   - never auto-runs (button only, threat model in the server service header);
//   - ws gone / no config / already running → explicit disabled reasons;
//   - verdict .md written by server lands in 叙述 tab (this panel just points).

"use client"

import { useEffect, useRef, useState } from "react"
import { Play, RotateCcw, Square } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { AcceptanceVerify } from "@octopus/shared"
import { formatDuration } from "@/lib/format"
import { FoldHandle, useFold } from "../fold-context"
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

export function VerifyPanel({ cfg, summary, lines, running, busy, disabledReason, onSaveCommand, onRun, onAbort }: VerifyPanelProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(cfg?.command ?? "")
  const [cwdDraft, setCwdDraft] = useState(cfg?.cwd ?? "")
  const [perRepo, setPerRepo] = useState(!!cfg?.per_repo)
  const [timeoutDraft, setTimeoutDraft] = useState(String(cfg?.timeoutS ?? 600))
  const [saveBusy, setSaveBusy] = useState(false)
  const consoleRef = useRef<HTMLDivElement>(null)
  const [elapsedS, setElapsedS] = useState(0)
  // 挂/断后的尾输出窗开关（L3「看输出」）；跑着时控制台无条件在。
  const [outOpen, setOutOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)

  // 新一次跑批 = 输出窗复位。
  useEffect(() => {
    setShowAll(false)
    setOutOpen(false)
  }, [summary?.started_at])

  // 运行中的秒表。
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
      ? { t: `✓ passed${dur}`, cls: "bg-pop-green-soft text-[#0c7a4d]", st: "passed" }
      : done
        ? { t: `✗ ${done.state}${dur}`, cls: "bg-[#ffe3e9] text-pop-red", st: done.state }
        : cfg
          ? { t: "未跑", cls: "bg-pop-idle text-pop-dim", st: "idle" }
          : { t: "未配置", cls: "bg-pop-idle text-pop-dim", st: "none" }
  // 控制台出现时机：跑着/有未裁决的流在（断线重连 lines 先到）→ 常开；
  // 挂了 → 「看输出」开关；过了 → 整区消失（日志留 verdict 文件）。
  const consoleOn = !closed && !editing && (live || (lines.length > 0 && !done) || (!!failish && outOpen))
  // 尾窗行数：挂了收起态只看末 40 行；跑着/展开看满窗（显式变量，勿再写一行内联三元）。
  const consoleCap = live || !failish ? 120 : (outOpen ? 3000 : 40)
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
          ) : cfg && !editing ? (
            <Button size="sm" className="h-6 border-[2.5px] border-pop-bd bg-pop-green px-3 font-mono text-[10.5px] font-black text-white shadow-pop-sm pop-press" disabled={busy || !!disabledReason || closed} onClick={onRun} data-testid="verify-run" title={disabledReason ?? "在工作区现场执行，产出带新鲜时间戳的机器裁决"}>
              <Play className="size-3 mr-1" /> ▶ 复检
            </Button>
          ) : !cfg && !editing ? (
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

      {/* L3 结果区：失败/中止的裁决行（原因头 + 输出开关） */}
      {done && failish && !closed && (
        <div className="border-t border-pop-bd/10 bg-[#fff5f5] px-3 py-1.5 font-mono text-[10.5px] text-pop-ink/80" data-testid="verify-result">
          <b className="text-pop-red">✗ {done.state}</b>
          {done.exit_code != null ? ` · exit ${done.exit_code}` : ""}
          {" — "}
          <span className="text-pop-dim">{outOpen ? "输出在下" : done.verdict_path ? "原因与完整输出看 verdict 文件" : "verdict 落批次目录（叙述 tab 可见）"}</span>
          <button className="ml-2 text-[9.5px] font-black text-pop-navy underline decoration-dotted underline-offset-2" onClick={() => setOutOpen((v) => !v)} data-testid="verify-out-toggle">
            {outOpen ? "收起输出 ▴" : "看输出 ▾"}
          </button>
        </div>
      )}
      {/* 通过：一行结论即全部，日志不占面 */}
      {done && !failish && !closed && (
        <div className="border-t border-pop-bd/10 bg-[#fbf8ee] px-3 py-1.5 font-mono text-[10.5px] text-pop-dim" data-testid="verify-result">
          <b className="text-pop-green">✓ 全绿</b> · {new Date(done.ended_at ?? done.started_at).toLocaleString("zh-CN", { hour12: false })}
          <span className="ml-1">{done.verdict_path ? `· 机器裁决已落盘：${done.verdict_path}` : "· verdict 落批次目录（叙述 tab 可见）"}</span>
        </div>
      )}

      {/* 输出控制台（跑着常开 / 挂了开关开；过了永不开）：pop 终端 chrome */}
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
