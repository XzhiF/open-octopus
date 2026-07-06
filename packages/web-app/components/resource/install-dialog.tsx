"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Loader2 } from "lucide-react"
import { installResource } from "@/lib/resource/api"
import { useResourceOrg } from "./resource-context"

interface InstallDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function InstallDialog({ open, onOpenChange }: InstallDialogProps) {
  const router = useRouter()
  const org = useResourceOrg()
  const [ref, setRef] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleInstall = async () => {
    if (!ref.trim()) return
    setLoading(true)
    setError(null)
    try {
      await installResource(org, ref.trim())
      onOpenChange(false)
      setRef("")
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "安装失败")
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>安装资源</DialogTitle>
          <DialogDescription>
            通过来源引用安装 Skill、Agent 或 Workflow
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="ref">来源引用</Label>
            <Input
              id="ref"
              data-testid="install-ref-input"
              autoFocus
              placeholder="builtin:brainstorming 或 local:/path/to/skill"
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && ref.trim()) handleInstall() }}
            />
            <p className="text-xs text-muted-foreground">
              支持格式: builtin:&lt;name&gt; / local:&lt;path&gt;
            </p>
          </div>

          {error && (
            <div
              role="alert"
              aria-describedby="install-error"
              className="rounded border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            取消
          </Button>
          <Button data-testid="btn-install" onClick={handleInstall} disabled={loading || !ref.trim()}>
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            安装
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
