// packages/web-app/components/tasks/fold-context.tsx
//
// 折叠中枢（2026-09-20 两版迭代后定稿）——
// 用户要的是**验货台 tab 内每一块**（项目代码的变动 / 当场复检 / 跑起来看 /
// 人工走查）各自可折，不是整弹窗的大折叠 + 一键盘（后者已按反馈整体撤下）。
//   • 各面板自带 header 最左 FoldHandle；折上 = 结论徽章顶上（提交数/复检态/…）。
//   • 折叠状态按任务记忆（localStorage octopus-fold:<taskId>）。
//   • 无 provider（面板被独立挂载时）→ 无把手、常开，老宿主零行为变化。

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
        closed ? "border-pop-navy bg-pop-navy-soft text-pop-navy" : "border-pop-bd/25 text-pop-dim hover:border-pop-navy hover:text-pop-navy"
      } ${className}`}
    >
      {closed ? "▸" : "▾"}
    </button>
  )
}
