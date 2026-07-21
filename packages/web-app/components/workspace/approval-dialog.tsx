"use client"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter
} from "@/components/ui/dialog"
import { usePersistedState } from "@/hooks/use-persisted-state"
import type { ApprovalMetadata } from "@/lib/types"

interface ApprovalDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  approval: ApprovalMetadata
  onSubmit: (value: string, comment: string) => void
  loading?: boolean
  /** localStorage key prefix for persisting draft */
  storageKey: string
}

export function ApprovalDialog({
  open,
  onOpenChange,
  approval,
  onSubmit,
  loading = false,
  storageKey,
}: ApprovalDialogProps) {
  const [comment, setComment, clearComment] = usePersistedState<string>(
    `${storageKey}:comment`,
    "",
  )
  const [selectedValue, setSelectedValue, clearSelected] = usePersistedState<string | null>(
    `${storageKey}:selected`,
    null,
  )

  const handleSelect = (value: string) => {
    setSelectedValue(value)
  }

  const handleSubmit = () => {
    if (!selectedValue) return
    onSubmit(selectedValue, comment)
    clearComment()
    clearSelected()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-5xl flex flex-col h-[95vh] max-h-[95vh] overflow-hidden gap-4"
        onPointerDownOutside={(e) => e.preventDefault()}
      >
        <DialogHeader className="flex-shrink-0">
          <DialogTitle>审批确认</DialogTitle>
          <DialogDescription>
            工作流执行已暂停，等待您的审批
          </DialogDescription>
        </DialogHeader>

        {/* 审批提示 — flex-1 吸收剩余空间并独立滚动。
            overflow-hidden on DialogContent + flex-1 min-h-0 here 让长文本时
            prompt 区收缩滚动，footer 始终留在弹窗内可见。 */}
        <div className="flex-1 min-h-0 overflow-y-auto pr-2">
          <div className="rounded-lg bg-muted p-4">
            <p className="text-sm font-medium">审批说明</p>
            <p className="mt-1 text-sm text-muted-foreground whitespace-pre-wrap">
              {approval.prompt}
            </p>
          </div>
        </div>

        {/* 自定义备注（显式定义时显示在选项上方） */}
        {approval.commentLabel && (
          <div className="space-y-2 flex-shrink-0">
            <p className="text-sm font-medium">{approval.commentLabel}</p>
            <Textarea
              placeholder={approval.commentPlaceholder ?? ""}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              disabled={loading}
              rows={3}
            />
          </div>
        )}

        {/* 审批选项 */}
        <div className="space-y-2 flex-shrink-0">
          <p className="text-sm font-medium">请选择</p>
          <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(0, 1fr))" }}>
            {approval.options.map((opt) => (
              <Button
                key={opt.value}
                variant={selectedValue === opt.value ? "default" : "outline"}
                onClick={() => handleSelect(opt.value)}
                disabled={loading}
                className="justify-center truncate"
              >
                {opt.label}
              </Button>
            ))}
          </div>
        </div>

        {/* 默认备注（未显式定义时显示在选项下方） */}
        {!approval.commentLabel && (
          <div className="space-y-2 flex-shrink-0">
            <p className="text-sm font-medium">备注（可选）</p>
            <Textarea
              placeholder={approval.commentPlaceholder ?? "输入审批备注..."}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              disabled={loading}
              rows={3}
            />
          </div>
        )}

        <DialogFooter className="flex-shrink-0">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            取消
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!selectedValue || loading}
          >
            {loading ? "提交中..." : "提交审批"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}