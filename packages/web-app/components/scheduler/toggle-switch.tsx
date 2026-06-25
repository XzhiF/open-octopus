"use client"

import { useState } from "react"
import { Switch } from "@/components/ui/switch"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog"
import { toast } from "@/hooks/use-toast"
import { Loader2 } from "lucide-react"

interface ToggleSwitchProps {
  jobId: string
  enabled: boolean
  jobName: string
  onToggle: () => Promise<void>
}

export function ToggleSwitch({
  jobId: _jobId,
  enabled,
  jobName,
  onToggle,
}: ToggleSwitchProps) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [loading, setLoading] = useState(false)

  const actionText = enabled ? "暂停" : "启用"

  const handleConfirm = async () => {
    setLoading(true)
    try {
      await onToggle()
      toast({
        title: `任务已${enabled ? "暂停" : "启用"}`,
        description: `"${jobName}" 已成功${enabled ? "暂停" : "启用"}`,
      })
      setDialogOpen(false)
    } catch {
      toast({
        title: "操作失败",
        description: "无法切换任务状态，请稍后重试",
        variant: "destructive",
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <Switch
        checked={enabled}
        onCheckedChange={() => setDialogOpen(true)}
        aria-label={`${actionText}任务 "${jobName}"`}
      />

      <AlertDialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认{actionText}</AlertDialogTitle>
            <AlertDialogDescription>
              确定要{actionText}调度任务 "{jobName}" 吗？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={loading}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirm}
              disabled={loading}
            >
              {loading && <Loader2 className="size-4 animate-spin" />}
              确认{actionText}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
