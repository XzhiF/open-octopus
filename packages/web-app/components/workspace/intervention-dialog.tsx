"use client"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter
} from "@/components/ui/dialog"
import { usePersistedState } from "@/hooks/use-persisted-state"

interface InterventionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (intervention: string) => void
  loading?: boolean
  /** localStorage key for persisting draft */
  storageKey: string
  /** Display mode: retry (failed) or resume (paused) */
  mode?: "retry" | "resume"
}

export function InterventionDialog({
  open,
  onOpenChange,
  onSubmit,
  loading = false,
  storageKey,
  mode = "resume",
}: InterventionDialogProps) {
  const [intervention, setIntervention, clearIntervention] = usePersistedState<string>(
    `${storageKey}:${mode}`,
    "",
  )

  const isRetry = mode === "retry"
  const title = isRetry ? "重试工作流" : "人工介入"
  const description = isRetry
    ? "工作流执行失败，请输入干预指令指导 AI 重新执行"
    : "工作流已暂停，请输入您的干预指令来指导后续执行"
  const submitLabel = isRetry ? "重试" : "继续"
  const placeholder = isRetry
    ? "请输入您的干预指令，例如：\n- 检查参数 xxx 是否正确，然后重新执行\n- 修改配置 yyy 为 zzz，再重试\n- 跳过当前步骤，继续执行下一步"
    : "请输入您的干预指令，例如：\n- 跳过当前步骤，继续执行下一步\n- 修改参数 xxx 为 yyy，然后重新执行\n- 终止工作流"

  const handleSubmit = () => {
    onSubmit(intervention)
    clearIntervention()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onPointerDownOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* 干预指令输入 */}
          <div className="space-y-2">
            <p className="text-sm font-medium">干预指令</p>
            <Textarea
              placeholder={placeholder}
              value={intervention}
              onChange={(e) => setIntervention(e.target.value)}
              disabled={loading}
              rows={5}
              className="resize-none"
            />
            <p className="text-xs text-muted-foreground">
              提示：可选填写干预指令来指导 AI 后续执行，留空则直接继续
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            取消
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={loading}
          >
            {loading ? "提交中..." : submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
