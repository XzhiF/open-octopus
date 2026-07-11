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
import { Label } from "@/components/ui/label"
import { addSource } from "@/lib/resource/api"

interface SourceAddDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
}

export function SourceAddDialog({ open, onOpenChange, onSuccess }: SourceAddDialogProps) {
  const [url, setUrl] = useState("")
  const [name, setName] = useState("")
  const [branch, setBranch] = useState("main")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleAdd = async () => {
    if (!url) return
    setLoading(true)
    setError(null)
    try {
      const result = await addSource(url, name || undefined, branch)
      onOpenChange(false)
      setUrl("")
      setName("")
      setBranch("main")
      onSuccess()
    } catch (err) {
      setError(err instanceof Error ? err.message : "添加失败")
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>添加集合源</DialogTitle>
          <DialogDescription>
            从 GitHub 仓库克隆并发现可用的 Skills、Agents、Workflows
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="source-url">Git URL *</Label>
            <Input
              id="source-url"
              placeholder="https://github.com/user/repo"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="source-name">名称 (可选)</Label>
            <Input
              id="source-name"
              placeholder="留空则从 URL 自动提取"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="source-branch">分支</Label>
            <Input
              id="source-branch"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
            />
          </div>
          {error && (
            <div className="text-sm text-destructive">{error}</div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={handleAdd} disabled={!url || loading} data-testid="btn-add-source">
            {loading ? "克隆中..." : "添加"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
