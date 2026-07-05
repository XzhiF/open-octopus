"use client"

import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { AlertTriangle } from "lucide-react"

interface ConfirmUninstallDialogProps {
  resourceName: string | null
  onConfirm: (name: string) => void
  onCancel: () => void
}

export function ConfirmUninstallDialog({
  resourceName,
  onConfirm,
  onCancel,
}: ConfirmUninstallDialogProps) {
  return (
    <AlertDialog open={!!resourceName} onOpenChange={(open) => { if (!open) onCancel() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-5 text-destructive" />
            确认卸载
          </AlertDialogTitle>
          <AlertDialogDescription>
            确定要卸载 <strong className="text-foreground">{resourceName}</strong> 吗？
            此操作不可恢复。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => resourceName && onConfirm(resourceName)}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            确认卸载
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
