"use client"

import { useState, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Plus, CheckCircle2, XCircle, Loader2 } from "lucide-react"
import { installResource, ResourceApiError } from "@/lib/resource/api"

interface InstallDialogProps {
  onSuccess?: () => void
}

type DialogState = "idle" | "installing" | "success" | "failed"

export function InstallDialog({ onSuccess }: InstallDialogProps) {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<DialogState>("idle")
  const [ref, setRef] = useState("")
  const [error, setError] = useState<ResourceApiError | null>(null)
  const [result, setResult] = useState<{ name: string; version: string } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleInstall = async () => {
    if (!ref.trim()) return
    setState("installing")
    setError(null)
    try {
      const res = await installResource(ref.trim())
      setResult({ name: res.data.name, version: res.data.version })
      setState("success")
      onSuccess?.()
    } catch (e) {
      setError(e instanceof ResourceApiError ? e : new ResourceApiError(String(e), "UNKNOWN", 500))
      setState("failed")
    }
  }

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      // Reset state on close
      setState("idle")
      setRef("")
      setError(null)
      setResult(null)
    }
    setOpen(nextOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="mr-2 h-4 w-4" />
          安装资源
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>安装资源</DialogTitle>
          <DialogDescription>
            输入资源引用（如 <code className="text-xs bg-muted px-1 rounded">builtin:skill/octo-workflow-dev</code>）
          </DialogDescription>
        </DialogHeader>

        {state === "idle" && (
          <div className="space-y-4">
            <Input
              ref={inputRef}
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              placeholder="builtin:skill/name 或 local:/path/to/resource"
              onKeyDown={(e) => e.key === "Enter" && handleInstall()}
              autoFocus
            />
            <DialogFooter>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>取消</Button>
              <Button onClick={handleInstall} disabled={!ref.trim()}>安装</Button>
            </DialogFooter>
          </div>
        )}

        {state === "installing" && (
          <div className="flex items-center gap-3 py-4">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
            <span className="text-sm">正在安装 {ref}...</span>
          </div>
        )}

        {state === "success" && result && (
          <div className="space-y-4">
            <Alert className="border-green-500/50 bg-green-50 dark:bg-green-950/20">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              <AlertDescription className="text-green-800 dark:text-green-200">
                <strong>{result.name}</strong> v{result.version} 安装成功
              </AlertDescription>
            </Alert>
            <DialogFooter>
              <Button onClick={() => handleOpenChange(false)}>完成</Button>
            </DialogFooter>
          </div>
        )}

        {state === "failed" && error && (
          <div className="space-y-4">
            <Alert variant="destructive">
              <XCircle className="h-4 w-4" />
              <AlertDescription>
                <strong>{error.code}</strong>: {error.message}
                {error.hint && <p className="mt-1 text-xs opacity-80">{error.hint}</p>}
              </AlertDescription>
            </Alert>
            <DialogFooter>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>关闭</Button>
              <Button onClick={() => { setState("idle"); setError(null) }}>重试</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
