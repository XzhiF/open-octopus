"use client"

import { useState } from "react"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"

interface AddBlockDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (protocol: string, pkg: string, reason?: string) => Promise<void>
}

export function AddBlockDialog({ open, onOpenChange, onConfirm }: AddBlockDialogProps) {
  const [sourceInput, setSourceInput] = useState("")
  const [reason, setReason] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  const handleConfirm = async () => {
    const trimmed = sourceInput.trim()
    if (!trimmed) return

    const colonIndex = trimmed.indexOf(":")
    if (colonIndex < 1) {
      setError("格式不正确，请使用 protocol:location 格式")
      return
    }

    const protocol = trimmed.slice(0, colonIndex)
    const pkg = trimmed.slice(colonIndex + 1)

    if (!protocol || !pkg) {
      setError("协议和包名不能为空")
      return
    }

    setLoading(true)
    setError("")
    try {
      await onConfirm(protocol, pkg, reason.trim() || undefined)
      setSourceInput("")
      setReason("")
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "添加失败")
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) { setSourceInput(""); setReason(""); setError("") } onOpenChange(v) }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>添加阻止来源</DialogTitle>
          <DialogDescription>
            阻止的来源即使使用 --trust 也不允许注册或安装
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="block-source-input">来源引用</Label>
            <Input
              id="block-source-input"
              placeholder="npm:malicious-pkg"
              value={sourceInput}
              onChange={(e) => { setSourceInput(e.target.value); setError("") }}
            />
            <p className="text-xs text-muted-foreground">
              格式: protocol:location
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="block-reason">阻止原因（可选）</Label>
            <Textarea
              id="block-reason"
              placeholder="例如: 恶意代码、安全漏洞..."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={!sourceInput.trim() || loading}
          >
            {loading ? "添加中..." : "确认阻止"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
