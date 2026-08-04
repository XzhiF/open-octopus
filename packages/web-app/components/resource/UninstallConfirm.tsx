"use client"

import { useState } from "react"
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
import { Checkbox } from "@/components/ui/checkbox"
import type { ResourceType } from "@/lib/resource/types"

interface UninstallConfirmProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  name: string
  type: ResourceType
  activated?: boolean
  onConfirm: (keepBackup?: boolean) => void
  loading?: boolean
}

export function UninstallConfirm({ open, onOpenChange, name, type, activated, onConfirm, loading }: UninstallConfirmProps) {
  const [keepBackup, setKeepBackup] = useState(false)

  // If activated, show "deactivate first" warning
  if (activated) {
    return (
      <AlertDialog open={open} onOpenChange={onOpenChange}>
        <AlertDialogContent data-testid="uninstall-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>无法卸载</AlertDialogTitle>
            <AlertDialogDescription>
              资源 {type}:{name} 当前已激活。请先停用再卸载。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => onOpenChange(false)}>
              确定
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    )
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="uninstall-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>确认卸载</AlertDialogTitle>
          <AlertDialogDescription>
            确定要卸载 {type}:{name} 吗？此操作将移除已安装的文件。
          </AlertDialogDescription>
        </AlertDialogHeader>

        {type === "clone" && (
          <div className="flex items-center gap-2 py-2">
            <Checkbox
              id="keep-backup"
              checked={keepBackup}
              onCheckedChange={(checked) => setKeepBackup(checked === true)}
            />
            <label htmlFor="keep-backup" className="text-sm text-muted-foreground cursor-pointer">
              保留备份以便将来恢复
            </label>
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>取消</AlertDialogCancel>
          <AlertDialogAction
            data-testid="btn-confirm-uninstall"
            onClick={(e) => {
              e.preventDefault()
              onConfirm(type === "clone" ? keepBackup : undefined)
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
