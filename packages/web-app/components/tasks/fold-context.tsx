// packages/web-app/components/tasks/fold-context.tsx
//
// 验收弹窗「全框折叠」中枢（2026-09-20 原型定稿 fold.html，用户可操作确认）：
//   • 每框可折 —— 折上不是变小，而是 header 变形为「一行结论」：徽章摘要顶上，
//     折叠丢的是过程，不丢结论。
//   • 一键盘三态循环：全展开 → 收信息框（主卡留：交付卡/LIVE 卡/动作区）→ 全收
//     （连主卡）→ 全展开。手动折任一框即回手动档，不与用户较劲。
//   • 按任务记忆（localStorage octopus-fold:<taskId>），刷新/重开弹窗还在。
//   • 无 provider（AcceptanceSurface 等独立挂载场景）→ 全部照常展开、无把手，
//     老宿主零行为变化。

"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"

export type FoldGroup = "info" | "main"

interface FoldApi {
  mode: 0 | 1 | 2
  closed: (id: string, group: FoldGroup) => boolean
  toggle: (id: string, group: FoldGroup) => void
  cycle: () => void
}

const FoldCtx = createContext<FoldApi | null>(null)

const storeKey = (taskId: string) => `octopus-fold:${taskId}`
type FoldState = { mode: 0 | 1 | 2; boxes: Record<string, boolean> }
const load = (taskId: string): FoldState => {
  try {
    const s = JSON.parse(localStorage.getItem(storeKey(taskId)) ?? "") as FoldState
    if (s && typeof s.mode === "number" && s.boxes) return s
  } catch { /* 无存档/坏档 → 默认 */ }
  return { mode: 0, boxes: {} }
}

export function FoldProvider({ taskId, children }: { taskId: string; children: React.ReactNode }) {
  const [state, setState] = useState<FoldState>(() => load(taskId))
  useEffect(() => { setState(load(taskId)) }, [taskId])
  useEffect(() => {
    try { localStorage.setItem(storeKey(taskId), JSON.stringify(state)) } catch { /* 隐私模式等写失败不炸 */ }
  }, [taskId, state])

  const closed = useCallback((id: string, group: FoldGroup) =>
    state.mode === 2 ? true : state.mode === 1 ? group === "info" : !!state.boxes[id], [state])
  const toggle = useCallback((id: string, group: FoldGroup) => {
    setState((s) => {
      const cur = s.mode === 2 ? true : s.mode === 1 ? group === "info" : !!s.boxes[id]
      return { mode: 0, boxes: { ...s.boxes, [id]: !cur } }
    })
  }, [])
  const cycle = useCallback(() => setState((s) => ({ mode: ((s.mode + 1) % 3) as 0 | 1 | 2, boxes: {} })), [])

  const api = useMemo<FoldApi>(() => ({ mode: state.mode, closed, toggle, cycle }), [state.mode, closed, toggle, cycle])
  return <FoldCtx.Provider value={api}>{children}</FoldCtx.Provider>
}

/** null = 无 provider（独立挂载）→ 永不折叠、不显把手。 */
export function useFold(): FoldApi | null {
  return useContext(FoldCtx)
}

/** 把手：自绘 header 的框（交付卡/LIVE 卡/验货台区块）用；自带 stopPropagation。 */
export function FoldHandle({ id, group = "info", closed, onToggle, className = "" }: {
  id: string; group?: FoldGroup; closed: boolean; onToggle: () => void; className?: string
}) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onToggle() }}
      title={closed ? "展开" : "折叠"}
      aria-label={`fold-${id}`}
      data-fold-toggle={id}
      className={`grid size-[18px] shrink-0 place-items-center rounded-[6px] border-[1.5px] font-mono text-[9px] font-black transition-colors ${
        closed ? "border-pop-navy bg-pop-navy-soft text-pop-ink" : "border-pop-bd text-pop-dim hover:border-pop-navy hover:text-pop-ink"
      } ${className}`}
    >
      {closed ? "▸" : "▾"}
    </button>
  )
}

export function FoldMasterChip({ className = "" }: { className?: string }) {
  const fold = useFold()
  if (!fold) return null
  const label = ["一键盘：全展开", "一键盘：信息框已收", "一键盘：全部已收"][fold.mode]
  const hint = ["点一下收拢", "再点连主卡一起收", "再点全展开"][fold.mode]
  return (
    <button
      onClick={fold.cycle}
      title={hint}
      data-testid="fold-master"
      className={`shrink-0 rounded-[9px] border-[1.5px] border-pop-bd px-2 py-0.5 font-mono text-[9.5px] font-black shadow-pop-sm transition-colors ${
        fold.mode === 2 ? "bg-pop-navy text-pop-ink" : fold.mode === 1 ? "bg-pop-navy-soft text-pop-ink" : "bg-pop-paper text-pop-ink"
      } ${className}`}
    >
      ⇕ {label}
    </button>
  )
}

/** 紧凑变体（无 tab 条时落 rail 头部行）：只显 ⇕ + 当前态色。 */
export function FoldMasterBar() {
  const fold = useFold()
  if (!fold) return null
  return (
    <button
      onClick={fold.cycle}
      title={`${["一键盘：全展开 → 点一下收拢", "信息框已收 — 再点连主卡一起收", "全部已收 — 再点全展开"][fold.mode]}（${["全展开", "收信息框", "全收"][fold.mode]}）`}
      data-testid="fold-master-bar"
      className={`grid size-[18px] place-items-center rounded-[6px] border-[1.5px] font-mono text-[10px] font-black shadow-pop-sm ${
        fold.mode === 2 ? "border-pop-bd bg-pop-navy text-pop-ink" : fold.mode === 1 ? "border-pop-bd bg-pop-navy-soft text-pop-ink" : "border-pop-bd bg-pop-paper text-pop-dim hover:border-pop-navy hover:text-pop-ink"
      }`}
    >
      ⇕
    </button>
  )
}

/** 波普 Box 的可折版 —— 与 run-console 的 Box 同肤，折上显 badge（一行结论）。 */
export function FoldBox({ id, tag, badge, tail, group = "info", tone, className, children }: {
  id: string; tag: string; badge?: string; tail?: React.ReactNode; group?: FoldGroup
  tone?: string; className?: string; children: React.ReactNode
}) {
  const fold = useFold()
  const closed = fold ? fold.closed(id, group) : false
  const header = (
    <header
      onClick={fold ? () => fold.toggle(id, group) : undefined}
      className={`flex items-center gap-2 border-b-[1.5px] px-3 py-1.5 ${closed ? "border-pop-navy bg-pop-navy-soft" : "border-pop-bd"} ${fold ? "cursor-pointer select-none hover:bg-pop-yellow-soft/40" : ""}`}
    >
      <span className={`font-mono text-[9.5px] font-black tracking-[.09em] ${closed ? "text-pop-ink" : "text-pop-dim"}`}>{tag}</span>
      {closed && badge && <span className="truncate font-mono text-[10px] font-black text-pop-ink" data-fold-badge={id}>{badge}</span>}
      {tail && !closed && <span className="ml-auto font-mono text-[10px] text-pop-dim">{tail}</span>}
      {closed && !badge && <span className="ml-auto font-mono text-[9px] text-pop-dim">▸</span>}
    </header>
  )
  return (
    <section
      data-fold-box={id}
      data-fold-closed={closed ? "true" : undefined}
      className={`overflow-hidden rounded-[13px] border-[1.5px] bg-pop-paper shadow-pop-sm ${tone ?? "border-pop-bd"} ${closed ? "shadow-none" : ""} ${className ?? ""}`}
    >
      {header}
      {!closed && <div className="px-3 py-2">{children}</div>}
    </section>
  )
}
