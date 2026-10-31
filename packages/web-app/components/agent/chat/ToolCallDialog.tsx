'use client'

// 运行中工具调用总览（2026-10-29 用户：原先是右列 tab，会被作业坞挡死 → 改成居中弹窗）。
// 由对话区右下角的悬浮按钮唤起，列当前会话的全部工具调用卡片。

import { X } from 'lucide-react'
import type { ToolCallRecord } from '@/lib/agent/types'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { ToolCallCard } from './ToolCallCard'

export function ToolCallDialog({
  open,
  onOpenChange,
  toolCalls,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  toolCalls: ToolCallRecord[]
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="ui-font top-[10%] max-h-[76vh] w-[620px] max-w-[calc(100vw_-_32px)] translate-y-0 gap-0 p-0 sm:max-w-[620px]"
      >
        {/* 标题条随内容滚动时吸顶，长列表也一直能关 */}
        <div className="sticky top-0 z-10 flex items-center justify-between rounded-t-2xl border-b border-pop-bd/60 bg-pop-paper px-4 py-3">
          <DialogTitle className="text-[13px] font-semibold text-pop-ink">
            工具调用 <span className="font-mono text-[11px] tabular-nums text-pop-dim">({toolCalls.length})</span>
          </DialogTitle>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label="关闭"
            className="grid size-6 place-items-center rounded-md text-pop-dim transition-colors hover:bg-pop-paper hover:text-pop-ink"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="space-y-2 p-3" data-tool-call-dialog-body>
          {toolCalls.map((tc) => (
            <ToolCallCard key={tc.id} toolCall={tc} />
          ))}
          {toolCalls.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">暂无工具调用</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
