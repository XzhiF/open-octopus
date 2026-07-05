"use client"

import { useState } from "react"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

interface AddTrustDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (protocol: string, pkg: string) => Promise<void>
  existingTrusted?: { protocol: string; location: string }[]  // F13: for duplicate detection
}

export function AddTrustDialog({ open, onOpenChange, onConfirm, existingTrusted = [] }: AddTrustDialogProps) {
  const [input, setInput] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  const handleConfirm = async () => {
    const trimmed = input.trim()
    if (!trimmed) return

    // Parse "protocol:location" format
    const colonIndex = trimmed.indexOf(":")
    if (colonIndex < 1) {
      setError("格式不正确，请使用 protocol:location 格式，例如 npm:superpowers-zh")
      return
    }

    const protocol = trimmed.slice(0, colonIndex)
    const pkg = trimmed.slice(colonIndex + 1)

    if (!protocol || !pkg) {
      setError("协议和包名不能为空")
      return
    }

    // F13: Check for duplicate source — inline warning
    const isDuplicate = existingTrusted.some(
      t => t.protocol === protocol && t.location === pkg,
    )
    if (isDuplicate) {
      setError(`来源 ${protocol}:${pkg} 已在信任列表中，无需重复添加`)
      return
    }

    setLoading(true)
    setError("")
    try {
      await onConfirm(protocol, pkg)
      setInput("")
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "添加失败")
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) { setInput(""); setError("") } onOpenChange(v) }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>添加信任来源</DialogTitle>
          <DialogDescription>
            信任的来源在安装资源时将跳过信任确认步骤
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 py-2">
          <Label htmlFor="trust-source-input">来源引用</Label>
          <Input
            id="trust-source-input"
            placeholder="npm:superpowers-zh"
            value={input}
            onChange={(e) => { setInput(e.target.value); setError("") }}
            onKeyDown={(e) => { if (e.key === "Enter") handleConfirm() }}
          />
          <p className="text-xs text-muted-foreground">
            格式: protocol:location，例如 npm:superpowers-zh 或 github:XzhiF/agents
          </p>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={handleConfirm} disabled={!input.trim() || loading}>
            {loading ? "添加中..." : "确认添加"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
