// packages/web-app/components/tasks/run-console/static-nodes-tab.tsx
//
// 票 07 · ready「◆ 节点」静态预览 —— 待执行且该 phase 尚无执行行时，节点页不再
// 「无节点」：列出**绑定流 YAML 顶层节点的声明序**（原型 ⓬ readyNodesHtml），全 ○
// 未执行、用时/成本 `—`，展开一行给「— 未执行 · 等待触发 —」占位（原型 nodeEvents
// 的 ready 分支逐字）。触发转 running 后调用方切回票 04 NodesTab 动态模型
// （判据 = 该 phase 是否已有执行行，在壳层），两态同一行样式无缝衔接。
//
// 数据 = 既有读取面复用，零新端点、引擎零改动：
//   GET /api/workflows/built-in/:ref（built-in 域原文，phase-binding-dialog 同通路）
//   GET /api/tasks/:id/home-file?path=workflows/<file>（自建流回落，task-home 域）
// 解析顺序镜像 server workflow-ref-resolver.resolveWorkflowRef：① built-in 先试；
// ② task home —— 带 .yaml/.yml 后缀的 ref 按原样试一次，裸名依次补 .yaml/.yml。
// 行推导在 nodes-model.assembleStaticNodePreview 纯函数层（○ = NODE_GLYPH.pend）。

"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { getHomeFile } from "@/lib/tasks-api"
import { getBuiltInWorkflowDetail } from "@/lib/workflow-presets-api"
import { assembleStaticNodePreview, nodeSummary, type NodeRow } from "./nodes-model"
import { EMPTY_SHELL, GLYPH_TONE, TYPE_PILL, TYPE_PILL_DIM } from "./nodes-tab"

export interface StaticNodesTabProps {
  taskId: string
  /** 当前面相位的绑定流 ref（task_spec phase.workflowRef）；空 = 未绑定（如实空态）。 */
  workflowRef: string | null | undefined
  /** 相位的 1-based index（页签头「P<ph> 绑定流 …」语境）。 */
  phaseIndex: number | null
}

/** 镜像 server 解析序的前端版（见文件头）。两域都 miss → null，绝不猜测内容。 */
async function resolveWorkflowYaml(taskId: string, ref: string): Promise<string | null> {
  try {
    const d = await getBuiltInWorkflowDetail(ref)
    if (typeof d?.content === "string" && d.content) return d.content
  } catch { /* miss → task-home 域 */ }
  const candidates = /\.(ya?ml)$/.test(ref) ? [ref] : [`${ref}.yaml`, `${ref}.yml`]
  for (const file of candidates) {
    try {
      const f = await getHomeFile(taskId, `workflows/${file}`)
      if (typeof f?.content === "string" && f.content) return f.content
    } catch { /* 404/403 → 下一个候选名 */ }
  }
  return null
}

// 三态壳类串走 nodes-tab.EMPTY_SHELL 单源（standards③）。

export function StaticNodesTab({ taskId, workflowRef, phaseIndex }: StaticNodesTabProps) {
  const ref = workflowRef?.trim() || null
  // content 三态：undefined=读取中 · null=两域都 miss · string=YAML 原文
  const [content, setContent] = useState<string | null | undefined>(undefined)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // 换相位/换 ref：旧快照与展开态作废（不同绑定流的清单绝不串门 —— 同 NodesTab
  // 换绑执行的 render 期重置纪律）。
  const lastKey = useRef<string | null>(null)
  const key = `${taskId}|${ref ?? ""}`
  if (lastKey.current !== key) {
    lastKey.current = key
    setContent(undefined)
    setExpanded(new Set())
  }

  useEffect(() => {
    if (!ref) return
    let alive = true
    resolveWorkflowYaml(taskId, ref)
      .then((c) => { if (alive) setContent(c) })
      .catch(() => { if (alive) setContent(null) })
    return () => { alive = false }
  }, [taskId, ref])

  const rows = useMemo<NodeRow[]>(() => (content ? assembleStaticNodePreview(content) : []), [content])
  const sum = nodeSummary(rows)
  const shortRef = ref?.replace(/^built-in\//, "") ?? ""

  // ── 三态如实：未绑定 / 读取失败 / 无节点声明（都不编造清单）──
  if (!ref) {
    return (
      <div data-testid="static-nodes-unbound" className={EMPTY_SHELL}>
        该相位尚未绑定工作流 —— 回草稿面板把 phase 的绑定流选好，这里就会按流的节点顺序列出待执行清单。
      </div>
    )
  }
  if (content === undefined) {
    return <div data-testid="static-nodes-loading" className="shrink-0 font-mono text-[10.5px] text-pop-dim">绑定流读取中…</div>
  }
  if (content === null) {
    return (
      <div data-testid="static-nodes-error" className={EMPTY_SHELL}>
        绑定流内容读取失败：<b className="text-pop-ink">{ref}</b><br />
        请核对流是否已安装（built-in 域）或存在于任务目录 workflows/（自建流域）。
      </div>
    )
  }
  if (rows.length === 0) {
    return (
      <div data-testid="static-nodes-empty" className={EMPTY_SHELL}>
        绑定流 {shortRef} 未声明顶层节点 —— 触发后这里照常列出实际执行行。
      </div>
    )
  }

  return (
    <div data-testid="static-nodes-tab" className="flex h-full min-h-0 flex-col gap-2">
      {/* 页签头（原型 readyNodesHtml .f-toolbar 三件套） */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 font-mono text-[10.5px]">
        <span data-testid="static-nodes-wf-pill" className="rounded-full border-[1.5px] border-pop-purple/60 bg-pop-purple-soft px-2 py-px font-black text-pop-purple">
          ⚙ {shortRef}
        </span>
        <span className="text-pop-dim">
          P{phaseIndex ?? 1} 绑定流 {shortRef} · 触发后开跑 — 点行看占位
        </span>
        <span data-testid="static-nodes-summary" className="ml-auto flex shrink-0 items-center gap-1.5 text-pop-dim">
          <b className="font-black text-pop-dim tabular-nums">{sum.done}</b>/{sum.total} 完成 · 等待触发
        </span>
      </div>

      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-0.5">
        {rows.map((r) => {
          const open = expanded.has(r.id)
          return (
            <div key={r.id} data-static-node-block={r.id}>
              <button
                data-static-node-row={r.id}
                data-testid={`static-node-row-${r.id}`}
                aria-expanded={open}
                onClick={() => setExpanded((prev) => {
                  const next = new Set(prev)
                  if (next.has(r.id)) next.delete(r.id)
                  else next.add(r.id)
                  return next
                })}
                className="flex w-full items-center gap-2 rounded-lg border-[1.5px] border-pop-bd/70 bg-pop-bg px-2 py-1.5 text-left font-mono text-[11px] transition-transform hover:-translate-y-px"
              >
                <span aria-hidden className={`w-4 shrink-0 text-center font-black ${GLYPH_TONE[r.state]}`}>{r.glyph}</span>
                <span aria-hidden className="w-3 shrink-0 text-center text-[9px] text-pop-dim">{open ? "▾" : ""}</span>
                <span className="min-w-0 truncate font-black text-pop-ink">{r.name}</span>
                <span className={`shrink-0 rounded-full border-[1.5px] px-1.5 py-px font-mono text-[8.5px] font-black ${TYPE_PILL[r.typeBadge] ?? TYPE_PILL_DIM}`}>
                  {r.typeBadge}
                </span>
                <span className="ml-auto flex shrink-0 items-center gap-2 tabular-nums text-pop-dim">
                  <span>{r.durationText}</span>
                  <span>{r.costText}</span>
                </span>
              </button>
              {open && (
                <div data-testid={`static-node-events-${r.id}`} className="ml-5 mt-0.5 rounded-lg border-[1.5px] border-dashed border-pop-bd bg-pop-idle/40 px-2.5 py-1.5 font-mono text-[10.5px]">
                  <div className="text-pop-dim">— 未执行 · 等待触发 —</div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
