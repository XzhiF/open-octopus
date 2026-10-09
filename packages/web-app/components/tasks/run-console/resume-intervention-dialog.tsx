// packages/web-app/components/tasks/run-console/resume-intervention-dialog.tsx
//
// 「▶ 恢复执行 — 注入干预」三分支弹框（票 06 · 原型 taskboard-v2.html openInject）。
// 只做皮肤与受控输入 —— 分支判据/载荷全在 intervention.ts 的 decideResume（纯测面），
// 这里连按下去的是哪个键都不决定。
//
// 三键（原型逐字）：
//   取消（保持暂停） → cancel  —— 纯关窗，一次 API 都不打（spec：恢复框取消=纯前端关窗）
//   直接继续 ▶       → plain   —— resumeTask(id)，textarea 写了什么不算数
//   ⚑ 注入干预并继续 → inject  —— resumeTask(id, 原文)；超 4000 禁用（服务端 400 同额）

"use client"

import { useEffect, useState } from "react"
import { Spinner } from "@/components/ui/spinner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { INTERVENTION_MAX, isOverLimit, type ResumeDialogAction } from "./intervention"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 暂停轮的语境名（执行名/工作流名兜底 —— 客户端不知道引擎节点 id，
   *  真实目标节点名以 ⚑ 行落进日志为准，见 intervention.ts）。 */
  targetNodeLabel: string
  /** 在飞请求（resume）时锁键，防双发。 */
  busy?: boolean
  onAction: (action: ResumeDialogAction, text: string) => void
}

export function ResumeInterventionDialog({ open, onOpenChange, targetNodeLabel, busy = false, onAction }: Props) {
  const [text, setText] = useState("")
  // 每次开框从空白起步 —— 上一次没提交出去的话不该幽灵还魂。
  useEffect(() => { if (open) setText("") }, [open])

  const over = isOverLimit(text)
  const act = (action: ResumeDialogAction) => { if (!busy) onAction(action, text) }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && busy) return; onOpenChange(o) }}>
      <DialogContent className="sm:max-w-[560px]" aria-describedby={undefined} data-testid="resume-intervene-dialog">
        <DialogHeader>
          <DialogTitle className="text-[15px]">
            ▶ 恢复执行 — 注入干预
            <small className="mt-1 block font-mono text-[10.5px] font-normal text-pop-dim">
              干预会以 ⚑ 高亮行进日志，并作为额外上下文交给挂起节点「{targetNodeLabel}」
            </small>
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-2" data-inject-panel>
          <Textarea
            rows={5}
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="例：实现方向不对 — 不要动 Dialog 尺寸逻辑，直接换固定壳；保留 1.5px 边框语言…"
            className="min-h-[110px] text-xs"
            data-inject-text data-testid="inject-textarea"
          />
          <div className="flex items-center justify-between font-mono text-[10px]">
            <span className={over ? "font-black text-pop-red" : "text-pop-dim"}>留空 = 不注入，原样继续。</span>
            <span className={over ? "font-black text-pop-red tabular-nums" : "text-pop-dim tabular-nums"} data-inject-count>
              {text.length}/{INTERVENTION_MAX}
            </span>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" size="sm" className="h-7 text-xs" disabled={busy} onClick={() => act("cancel")} data-inject-cancel data-testid="inject-cancel">
              取消（保持暂停）
            </Button>
            <Button
              size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={() => act("plain")} data-inject-plain data-testid="inject-plain"
            >
              直接继续 ▶
            </Button>
            <Button
              size="sm" className="h-auto py-1.5 text-xs whitespace-normal"
              disabled={busy || over}
              title={over ? `干预上限 ${INTERVENTION_MAX} 字符（服务端同额 400）` : undefined}
              onClick={() => act("inject")} data-inject-confirm data-testid="inject-confirm"
            >
              {busy ? <Spinner className="mr-1 size-3" /> : null}⚑ 注入干预并继续
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
