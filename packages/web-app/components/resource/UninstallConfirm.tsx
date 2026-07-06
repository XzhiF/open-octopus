"use client"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import type { ResourceType } from "@/lib/resource/types"

interface UninstallConfirmProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  name: string
  type: ResourceType
  onConfirm: () => void
  loading?: boolean
}

export function UninstallConfirm({ open, onOpenChange, name, type, onConfirm, loading }: UninstallConfirmProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="uninstall-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>确认卸载</AlertDialogTitle>
          <AlertDialogDescription>
            确定要卸载 {type}:{name} 吗？此操作将移除已安装的文件。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>取消</AlertDialogCancel>
          <AlertDialogAction
            data-testid="btn-confirm-uninstall"
            onClick={(e) => {
              e.preventDefault()
              onConfirm()
            }}
            disabled={loading}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {loading ? "卸载中..." : "卸载"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
