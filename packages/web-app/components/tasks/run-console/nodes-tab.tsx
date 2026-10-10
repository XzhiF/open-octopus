// packages/web-app/components/tasks/run-console/nodes-tab.tsx
//
// 票 04 · 「◆ 节点」页签 —— 把绑定工作流的一次执行做成任务清单（统一壳挂载位
// [data-tab-host="nodes"]）。执行中/暂停/接管/修复轮态可见；task-fix 修复轮的
// 节点在同一组件里自动推进直播（绑定流换的是 built-in/task-fix，行集照常列出）。
//
// 数据 = 既有读取面，零新增端点：
//   GET /api/workspaces/:ws/executions/:eid —— execution 行 + steps + workflow_content
//   GET /api/workspaces/:ws/executions/:eid/agent-events —— 展开行时懒加载事件流
// 推导（状态符 ✓/●/⏸/○/⏹/✗、聚合、汇总、⚑ 行）全部在 nodes-model.ts 纯函数层。
//
// 铁律（spec Out of Scope）：只读页签 —— 重试/重置等手术式操作留在执行详情视图，
// 这里只给深链（同「执行流程图 ↗」定稿：新标签页打开，不顶走弹窗）。
// 刷新：live 轮 5s 节流轮询 + 壳的 SSE→refetch 换 run 徽章时随 props 重拉。

"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { TaskExecutionBadge } from "@octopus/shared"
import { fetchAgentEvents, fetchExecutionDetail, type ExecutionDetailWire } from "@/lib/api-client"
import type { AgentEvent } from "@/lib/types"
import { deepLinkTarget, LIVE_STATUSES } from "../execution-summary"
import type { ConsoleShellMode } from "./tab-assembly"
import {
  buildEventLines, buildNodeRows, execStateLine, extractNodeDefs,
  filterEventsForNode, nodeSummary, type NodeRow,
} from "./nodes-model"

export interface NodesTabProps {
  /** 当前面相位的绑定执行（执行中=在跑轮；接管/中止=被打断的轮；修复轮=task-fix 轮）。 */
  run: TaskExecutionBadge | null
  /** 壳形态（08 在 takeover 时点亮；fixing 由 workflow_ref 自判，不依赖它）。 */
  mode: ConsoleShellMode
  /** 任务是否活着 —— 终态停轮询（与壳同一纪律）。 */
  live: boolean
}

// 票07 导出：ready 静态预览（static-nodes-tab）复用同一套行样式，两态同形。
export const GLYPH_TONE: Record<NodeRow["state"], string> = {
  done: "text-pop-green",
  fail: "text-pop-red",
  live: "text-pop-amber animate-pulse",
  paused: "text-pop-yellow",
  stop: "text-pop-dim",
  pend: "text-pop-dim",
  skip: "text-pop-dim",
}

export const TYPE_PILL: Record<string, string> = {
  Agent: "border-pop-pink/60 bg-pop-pink-soft text-pop-pink",
  Bash: "border-pop-cyan/60 bg-pop-cyan-soft text-pop-cyan",
  Loop: "border-pop-amber/60 bg-pop-amber-soft text-pop-amber",
  Swarm: "border-pop-green/60 bg-pop-green-soft text-pop-green",
  Approval: "border-pop-purple/60 bg-pop-purple-soft text-pop-purple",
}
export const TYPE_PILL_DIM = "border-pop-bd text-pop-dim"

const LINE_TONE: Record<string, string> = {
  ink: "text-pop-ink", dim: "text-pop-dim", green: "text-pop-green",
  red: "text-pop-red", pink: "text-pop-pink", amber: "text-pop-amber",
}

const STATE_TONE: Record<string, string> = {
  pink: "text-pop-pink", cyan: "text-pop-cyan", amber: "text-pop-yellow", red: "text-pop-red",
}

export function NodesTab({ run, mode, live }: NodesTabProps) {
  const runId = run?.id ?? null
  const ws = run?.workspace_id || null
  const runLive = !!run && LIVE_STATUSES.has(run.status)

  const [detail, setDetail] = useState<ExecutionDetailWire | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [events, setEvents] = useState<AgentEvent[] | null>(null)
  const [eventsBusy, setEventsBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  // 换绑执行：旧快照与展开/事件缓存全部作废（不同执行的事件绝不串门）。
  // （React 官方的 render 期状态调整模式 —— 同帧内消化，不触发多余网络。）
  const lastRunId = useRef<string | null>(null)
  if (lastRunId.current !== runId) {
    lastRunId.current = runId
    setDetail(null); setErr(null); setEvents(null); setExpanded(new Set())
  }

  useEffect(() => {
    if (!runId || !ws) return
    let alive = true
    const pull = () => {
      fetchExecutionDetail(ws, runId)
        .then((d) => { if (alive) { setDetail(d); setErr(null) } })
        .catch((e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : String(e)) })
    }
    pull()
    // 「随执行推进刷新」：活轮 5s 节流轮询；终态不轮（数据纪律同壳）。
    const timer = live && runLive ? setInterval(pull, 5000) : null
    return () => { alive = false; if (timer) clearInterval(timer) }
  }, [runId, ws, live, runLive])

  // 秒表：live 轮 1s 一跳（进行中的节点行走秒）。
  useEffect(() => {
    if (!live || !runLive) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [live, runLive])

  const rows = useMemo(() => {
    if (!detail) return null
    return buildNodeRows({
      defs: extractNodeDefs(detail.workflow_content),
      steps: detail.steps ?? [],
      execStatus: detail.status,
      mode,
      now,
    })
  }, [detail, mode, now])

  const loadEvents = useCallback(() => {
    if (!runId || !ws || events !== null || eventsBusy) return
    setEventsBusy(true)
    fetchAgentEvents(ws, runId)
      .then((r) => { if (Array.isArray(r.events)) setEvents(r.events); else setEvents([]) })
      .catch(() => setEvents([])) // 事件不可得照常 —— 展开面板给「暂无」
      .finally(() => setEventsBusy(false))
  }, [runId, ws, events, eventsBusy])

  const toggle = (row: NodeRow) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(row.id)) { next.delete(row.id); return next }
      next.add(row.id)
      return next
    })
    if (!expanded.has(row.id)) loadEvents()
  }

  // ── 无绑定执行（ready 未触发）：如实空态 ──
  if (!run) {
    return (
      <div data-testid="nodes-empty" className="mx-auto mt-10 max-w-[560px] rounded-xl border-[1.5px] border-dashed border-pop-bd bg-pop-idle/40 px-6 py-8 text-center font-mono text-[11px] leading-relaxed text-pop-dim">
        尚无绑定执行 —— 触发后这里按绑定流的节点顺序列出任务清单（只读；手术式操作去执行详情）。
      </div>
    )
  }

  const shortRef = run.workflow_ref.replace(/^built-in\//, "")
  const scope = run.phase_index != null ? `P${run.phase_index}·R${run.round_index ?? 1}` : "RUN"
  const stateLine = execStateLine({ execStatus: detail?.status ?? run.status, mode, workflowRef: run.workflow_ref })
  const sum = rows ? nodeSummary(rows) : null
  const link = deepLinkTarget(run)

  return (
    <div data-testid="nodes-tab" data-nodes-tab className="flex h-full min-h-0 flex-col gap-2">
      {/* 页签头（原型 .f-toolbar）：⚙ 流名 + 语境 + 深链 + N/M 完成 + 状态播报 */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 font-mono text-[10.5px]">
        <span data-testid="nodes-wf-pill" className="rounded-full border-[1.5px] border-pop-purple/60 bg-pop-purple-soft px-2 py-px font-black text-pop-purple">
          ⚙ {shortRef}
        </span>
        <span data-testid="nodes-scope" className="text-pop-dim">
          {scope} — 点行看节点事件
        </span>
        {link && (
          <button
            data-testid="nodes-deeplink"
            onClick={() => window.open(link, "_blank", "noopener")}
            title="在工作区打开该次执行的流程详情（新标签页）—— 重试/重置等手术式操作在修复面"
            className="rounded-[8px] border-[1.5px] border-pop-bd bg-pop-paper px-2 py-px font-black text-pop-dim transition-colors hover:border-pop-purple hover:text-pop-purple"
          >
            执行详情 <span className="font-normal">↗</span>
          </button>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-pop-dim">
          {sum && (
            <span data-testid="nodes-summary">
              <b className="font-black text-pop-green tabular-nums">{sum.done}</b>/{sum.total} 完成
            </span>
          )}
          {stateLine && (
            <span data-testid="nodes-state-line" className={`font-black ${STATE_TONE[stateLine.tone] ?? "text-pop-dim"}`}>
              · {stateLine.text}
            </span>
          )}
        </span>
      </div>

      {err && (
        <div data-testid="nodes-error" className="shrink-0 rounded-lg border-[1.5px] border-pop-red/50 bg-pop-idle px-2 py-1 font-mono text-[10.5px] text-pop-red">
          执行详情读取失败：{err}
        </div>
      )}

      {!rows && !err && (
        <div data-testid="nodes-loading" className="shrink-0 font-mono text-[10.5px] text-pop-dim">节点清单读取中…</div>
      )}

      {rows && (
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-0.5">
          {rows.length === 0 && (
            <div className="px-1 py-2 font-mono text-[10.5px] text-pop-dim">绑定流未声明节点，且暂无已执行节点记录。</div>
          )}
          {rows.map((r) => {
            const open = expanded.has(r.id)
            const nodeEvents = events ? filterEventsForNode(events, r.id) : []
            const lines = buildEventLines(nodeEvents)
            return (
              <div key={r.id} data-node-block={r.id}>
                <button
                  data-testid={`node-row-${r.id}`}
                  data-node-state={r.state}
                  data-node-current={r.isCurrent ? "true" : undefined}
                  aria-expanded={open}
                  onClick={() => toggle(r)}
                  className={`flex w-full items-center gap-2 rounded-lg border-[1.5px] px-2 py-1.5 text-left font-mono text-[11px] transition-transform hover:-translate-y-px ${
                    r.isCurrent
                      ? "border-pop-amber/70 bg-pop-amber-soft"
                      : r.state === "paused"
                        ? "border-pop-yellow/60 bg-pop-idle"
                        : r.stopLive
                          ? "border-pop-pink/60 bg-pop-pink-soft"
                          : "border-pop-bd/70 bg-pop-bg"
                  }`}
                >
                  <span aria-hidden className={`w-4 shrink-0 text-center font-black ${GLYPH_TONE[r.state]}`}>{r.glyph}</span>
                  <span aria-hidden className="w-3 shrink-0 text-center text-[9px] text-pop-dim">{open ? "▾" : ""}</span>
                  <span className="min-w-0 truncate font-black text-pop-ink">{r.name}</span>
                  {r.stopLive && (
                    <span className="shrink-0 rounded-[6px] border-[1.5px] border-pop-pink/60 px-1 font-mono text-[9px] font-black text-pop-pink">已终止</span>
                  )}
                  <span className={`shrink-0 rounded-full border-[1.5px] px-1.5 py-px font-mono text-[8.5px] font-black ${TYPE_PILL[r.typeBadge] ?? TYPE_PILL_DIM}`}>
                    {r.typeBadge}
                  </span>
                  <span className="ml-auto flex shrink-0 items-center gap-2 tabular-nums text-pop-dim">
                    <span>{r.durationText}</span>
                    <span className={r.costText === "—" ? "" : "text-pop-yellow"}>{r.costText}</span>
                  </span>
                </button>
                {open && (
                  <div data-testid={`node-events-${r.id}`} className="ml-5 mt-0.5 rounded-lg border-[1.5px] border-dashed border-pop-bd bg-pop-idle/40 px-2.5 py-1.5 font-mono text-[10.5px]">
                    {(r.state === "pend" || r.state === "skip") ? (
                      <div className="text-pop-dim">— {r.state === "skip" ? "已跳过" : "未执行"} · {r.state === "skip" ? "前序打回/分支未选中" : "等待前序节点完成"} —</div>
                    ) : eventsBusy && events === null ? (
                      <div className="text-pop-dim">事件读取中…</div>
                    ) : lines.length === 0 ? (
                      <div className="text-pop-dim">— 暂无事件 —</div>
                    ) : (
                      lines.map((l, i) => (
                        <div
                          key={i}
                          data-node-event
                          {...(l.intervention ? { "data-node-intervention": "true" } : {})}
                          className={`truncate ${LINE_TONE[l.tone] ?? "text-pop-ink"} ${l.intervention ? "bg-pop-pink-soft" : ""}`}
                          title={l.detail ? `${l.text} — ${l.detail}` : l.text}
                        >
                          <span aria-hidden className="mr-1.5 font-black">{l.glyph}</span>
                          {l.text}
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
