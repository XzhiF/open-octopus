// packages/web-app/components/tasks/run-console/takeover-branch-dialog.tsx
//
// 「✋ 执行中遇到问题 — 本 Round 怎么办」三分支决策框（票 08 · 原型 openBranch）。
// 只做皮肤与受控输入 —— 选项词表 / 按钮文案随选 / 提交闸门全在 takeover.ts
// （纯函数单测面），这里连按下去走哪条分支都不决定（onGo 回调交给壳）。
//
// 头部语境行 = 已跑时长 · 成本 · 当前节点（spec US18；数据壳里现成，props 注入）。
// Esc 由 Radix 层序先关框再关窗（同 06 裁决）。

"use client"

import { useEffect, useState } from "react"
import { Spinner } from "@/components/ui/spinner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { BRANCH_OPTIONS, branchGoLabel, branchSubmitBlocked, type BranchChoice } from "./takeover"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 头部语境（原型：<已跑 X · $Y · 当前节点「Z」>）。壳算好传入，本框不查数。 */
  contextLine: string
  /** 预选分支（接管中「改派 task-fix」钮直接进 ③ 的入口复用本框时给 "fix"）。 */
  initialChoice?: BranchChoice
  /** 在飞请求（takeover/fix-round）时锁键，防双发。 */
  busy?: boolean
  /** 用户选定 go 且闸门放行后回调（关窗由壳决定 —— ① 需要 pause 成没成才开注入框）。 */
  onGo: (choice: BranchChoice, note: string) => void
}

export function TakeoverBranchDialog({ open, onOpenChange, contextLine, initialChoice = "inject", busy = false, onGo }: Props) {
  const [sel, setSel] = useState<BranchChoice>(initialChoice)
  const [note, setNote] = useState("")
  const [blockedHint, setBlockedHint] = useState<string | null>(null)
  // 每次开框从「预选分支 + 空 note」起步（原型 window._br='B' 重置语义；
  // 上一次没提交出去的话不该幽灵还魂）。
  useEffect(() => { if (open) { setSel(initialChoice); setNote(""); setBlockedHint(null) } }, [open, initialChoice])

  const submit = () => {
    if (busy) return
    const blocked = branchSubmitBlocked(sel, note)
    if (blocked) { setBlockedHint(blocked); return }
    onGo(sel, note.trim())
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && busy) return; onOpenChange(o) }}>
      <DialogContent className="sm:max-w-[580px]" aria-describedby={undefined} data-testid="takeover-branch-dialog">
        <DialogHeader>
          <DialogTitle className="text-[15px]">
            ✋ 执行中遇到问题 — 本 Round 怎么办
            <small className="mt-1 block font-mono text-[10.5px] font-normal text-pop-dim">{contextLine}</small>
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-2" data-branch-panel>
          <div className="flex flex-col gap-2">
            {BRANCH_OPTIONS.map((opt) => {
              const on = sel === opt.id
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => { setSel(opt.id); setBlockedHint(null) }}
                  aria-pressed={on}
                  data-testid={`branch-option-${opt.id}`}
                  className={
                    "flex items-start gap-2.5 rounded-[12px] border-[1.5px] px-3 py-2.5 text-left font-mono text-[11px] transition-colors " +
                    (on ? "border-pop-pink/55 bg-pop-pink-soft text-pop-ink" : "border-pop-bd bg-pop-paper text-pop-dim hover:text-pop-ink")
                  }
                >
                  <span className={"mt-0.5 grid size-[13px] shrink-0 place-items-center rounded-full border-[1.5px] " + (on ? "border-pop-pink" : "border-pop-dim")}>
                    <span className={"block size-[6px] rounded-full " + (on ? "bg-pop-pink" : "bg-transparent")} />
                  </span>
                  <span className="min-w-0">
                    <span className="font-black">{opt.label}</span>
                    <small className="mt-0.5 block text-[9.5px] text-pop-dim">{opt.hint}</small>
                  </span>
                </button>
              )
            })}
          </div>
          <Textarea
            rows={3}
            value={note}
            onChange={(e) => { setNote(e.target.value); setBlockedHint(null) }}
            placeholder="给 ②③ 的指令 / 说明 — 例：变更页签够了，剩余收敛为：行号对齐 + hover 描边，做完就交"
            className="min-h-[72px] text-xs"
            data-testid="branch-note"
          />
          {blockedHint && (
            <p className="font-mono text-[10.5px] font-black text-pop-red" data-testid="branch-blocked-hint">{blockedHint}</p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" size="sm" className="h-7 text-xs" disabled={busy} onClick={() => onOpenChange(false)} data-testid="branch-cancel">
              取消
            </Button>
            <Button
              size="sm" className="h-auto py-1.5 text-xs whitespace-normal"
              disabled={busy}
              onClick={submit}
              data-testid="branch-go"
            >
              {busy ? <Spinner className="mr-1 size-3" /> : null}{branchGoLabel(sel)}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
