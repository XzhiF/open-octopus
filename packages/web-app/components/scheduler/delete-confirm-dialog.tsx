"use client"

import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { AlertTriangle, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"

interface DeleteConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  jobName: string
  onConfirm: () => void
  loading?: boolean
}

export function DeleteConfirmDialog({
  open,
  onOpenChange,
  jobName,
  onConfirm,
  loading = false,
}: DeleteConfirmDialogProps) {
  const [inputValue, setInputValue] = useState("")
  const canConfirm = inputValue === jobName

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setInputValue("")
    }
    onOpenChange(nextOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-5 text-scheduler-error" />
            确认删除
          </DialogTitle>
          <DialogDescription>
            此操作不可撤销。请输入任务名称{" "}
            <code className="bg-muted rounded px-1.5 py-0.5 text-sm font-mono">
              {jobName}
            </code>{" "}
            以确认删除。
          </DialogDescription>
        </DialogHeader>

        <div className="py-2">
          <Input
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder="输入任务名称以确认"
            aria-label="输入任务名称以确认删除"
            onKeyDown={(e) => {
              if (e.key === "Enter" && canConfirm && !loading) {
                onConfirm()
              }
            }}
          />
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={loading}
          >
            取消
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={!canConfirm || loading}
            className={cn(!canConfirm && "opacity-50")}
          >
            {loading && <Loader2 className="size-4 animate-spin" />}
            确认删除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
