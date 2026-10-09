// packages/web-app/components/tasks/run-console/fix-dispatch-dialog.tsx
//
// 「⚙ 派发通用修复流 — task-fix.yaml」指令框（票 08 · 原型 dispatchFix）。
// 两个入口共用：三分支框选 ③（note 预填）与接管态右栏「⚙ 改派 task-fix」。
// 指令必填闸门在 takeover.ts::fixDispatchBlocked（纯函数单测面），这里只呈现。

"use client"

import { useEffect, useState } from "react"
import { Spinner } from "@/components/ui/spinner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { fixDispatchBlocked } from "./takeover"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 被终止的绑定流名（原型头部小字语境；壳从 live/takeover 轮行取）。 */
  boundWorkflowLabel: string
  /** 三分支框带过来的草稿指令（可空 —— 本框仍强制必填）。 */
  prefill?: string
  busy?: boolean
  onDispatch: (instruction: string) => void
}

export function FixDispatchDialog({ open, onOpenChange, boundWorkflowLabel, prefill = "", busy = false, onDispatch }: Props) {
  const [text, setText] = useState("")
  const [hint, setHint] = useState<string | null>(null)
  // 每次开框 = 拿最新 prefill 起步（取消再开不该留旧稿）。
  useEffect(() => { if (open) { setText(prefill); setHint(null) } }, [open, prefill])

  const dispatch = () => {
    if (busy) return
    const blocked = fixDispatchBlocked(text)
    if (blocked) { setHint(blocked); return }
    onDispatch(text.trim())
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && busy) return; onOpenChange(o) }}>
      <DialogContent className="sm:max-w-[560px]" aria-describedby={undefined} data-testid="fix-dispatch-dialog">
        <DialogHeader>
          <DialogTitle className="text-[15px]">
            ⚙ 派发通用修复流 — task-fix.yaml
            <small className="mt-1 block font-mono text-[10.5px] font-normal text-pop-dim">
              终止绑定流「{boundWorkflowLabel}」后，按你的指令开发、修复、补充产物
            </small>
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <Textarea
            rows={4}
            autoFocus
            value={text}
            onChange={(e) => { setText(e.target.value); setHint(null) }}
            placeholder="给 task-fix 的指令（必填）— 例：只补齐行号对齐和 hover 描边，产物报告照旧生成"
            className="min-h-[96px] text-xs"
            data-testid="fix-instruction"
          />
          <p className="font-mono text-[10px] text-pop-dim">
            通用流固定动作：解析指令 → 开发/修复 → 回归 → 调整 · 补产物（报告/证据）→ 自动交付转待验收。
          </p>
          {hint && <p className="font-mono text-[10.5px] font-black text-pop-red" data-testid="fix-blocked-hint">{hint}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" size="sm" className="h-7 text-xs" disabled={busy} onClick={() => onOpenChange(false)} data-testid="fix-cancel">
              取消
            </Button>
            <Button
              size="sm" className="h-auto py-1.5 text-xs whitespace-normal border-pop-cyan bg-pop-cyan text-pop-bg hover:brightness-110"
              disabled={busy}
              onClick={dispatch}
              data-testid="fix-dispatch-go"
            >
              {busy ? <Spinner className="mr-1 size-3" /> : null}派发 · 开跑 ⚡
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
