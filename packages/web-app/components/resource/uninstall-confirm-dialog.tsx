"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
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
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Loader2, AlertTriangle } from "lucide-react"
import {
  uninstallResource,
  getResourceDeps,
  ResourceApiError,
  type ResourceType,
  type DepNode,
} from "@/lib/resource/api"

interface UninstallConfirmDialogProps {
  name: string
  type: ResourceType
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess?: () => void
}

export function UninstallConfirmDialog({
  name,
  type,
  open,
  onOpenChange,
  onSuccess,
}: UninstallConfirmDialogProps) {
  const router = useRouter()
  const [reverseDeps, setReverseDeps] = useState<DepNode[]>([])
  const [checking, setChecking] = useState(true)
  const [uninstalling, setUninstalling] = useState(false)
  const [confirmInput, setConfirmInput] = useState("")
  const [error, setError] = useState<ResourceApiError | null>(null)

  useEffect(() => {
    if (!open) return
    setChecking(true)
    setConfirmInput("")
    setError(null)
    getResourceDeps(type, name)
      .then((res) => setReverseDeps(res.data.reverse))
      .catch(() => setReverseDeps([]))
      .finally(() => setChecking(false))
  }, [open, type, name])

  const hasDeps = reverseDeps.length > 0
  const canConfirm = !hasDeps || confirmInput === name

  const handleUninstall = async () => {
    setUninstalling(true)
    setError(null)
    try {
      await uninstallResource(name, type)
      onOpenChange(false)
      onSuccess?.()
      router.push("/resources")
    } catch (e) {
      setError(e instanceof ResourceApiError ? e : new ResourceApiError(String(e), "UNKNOWN", 500))
    } finally {
      setUninstalling(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5" />
            卸载 {name}
          </AlertDialogTitle>
          <AlertDialogDescription>
            此操作将移除已安装的 {type}「{name}」，卸载后可重新安装。
          </AlertDialogDescription>
        </AlertDialogHeader>

        {checking ? (
          <div className="flex items-center gap-2 py-4">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">检查依赖关系...</span>
          </div>
        ) : hasDeps ? (
          <div className="space-y-3">
            <Alert variant="destructive">
              <AlertDescription>
                有 {reverseDeps.length} 个资源依赖此项，卸载将影响它们。
              </AlertDescription>
            </Alert>
            <div className="flex flex-wrap gap-1">
              {reverseDeps.map((dep) => (
                <Badge key={dep.name} variant="outline">{dep.name}</Badge>
              ))}
            </div>
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                输入 <code className="font-mono bg-muted px-1 rounded">{name}</code> 确认卸载
              </p>
              <Input
                value={confirmInput}
                onChange={(e) => setConfirmInput(e.target.value)}
                placeholder={name}
              />
            </div>
          </div>
        ) : null}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>
              {error.code}: {error.message}
              {error.hint && <p className="mt-1 text-xs opacity-80">{error.hint}</p>}
            </AlertDescription>
          </Alert>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={uninstalling}>取消</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleUninstall}
            disabled={!canConfirm || uninstalling}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {uninstalling ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                卸载中...
              </>
            ) : (
              "确认卸载"
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
