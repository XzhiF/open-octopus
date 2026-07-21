"use client"

import { useState, useEffect } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
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
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Trash2 } from "lucide-react"
import type { ManifestEntry } from "@octopus/shared"

interface RepoEditDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  entry: ManifestEntry | null
  groups: string[]
  org: string
  onSaved: () => void
}

export function RepoEditDialog({
  open,
  onOpenChange,
  entry,
  groups,
  org,
  onSaved,
}: RepoEditDialogProps) {
  const [name, setName] = useState("")
  const [gitUrl, setGitUrl] = useState("")
  const [branch, setBranch] = useState("main")
  const [group, setGroup] = useState("")
  const [tags, setTags] = useState("")
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)

  const isNew = !entry
  const canSave = name.trim() !== "" && gitUrl.trim() !== "" && group.trim() !== "" && !saving

  useEffect(() => {
    if (open) {
      if (entry) {
        setName(entry.name)
        setGitUrl(entry.git_url)
        setBranch(entry.branch)
        setGroup(entry.group)
        setTags(entry.manual_tags.join(", "))
      } else {
        setName("")
        setGitUrl("")
        setBranch("main")
        setGroup(groups[0] ?? "")
        setTags("")
      }
      setError(null)
      setDeleteConfirmOpen(false)
    }
  }, [open, entry, groups])

  async function handleSave() {
    if (!canSave) return
    setSaving(true)
    setError(null)

    const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:3001"
    const manual_tags = tags
      .split(",")
      .map(t => t.trim())
      .filter(Boolean)

    try {
      const url = isNew
        ? `${serverUrl}/api/repos`
        : `${serverUrl}/api/repos/${encodeURIComponent(entry!.name)}`
      const method = isNew ? "POST" : "PUT"

      const payload = isNew
        ? { name: name.trim(), git_url: gitUrl.trim(), branch: branch.trim() || "main", group: group.trim(), manual_tags, org }
        : { git_url: gitUrl.trim(), branch: branch.trim() || "main", group: group.trim(), manual_tags, org }

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error?.message ?? `HTTP ${res.status}`)
      }

      onOpenChange(false)
      onSaved()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!entry) return
    setDeleting(true)
    setError(null)

    const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:3001"

    try {
      const res = await fetch(
        `${serverUrl}/api/repos/${encodeURIComponent(entry.name)}?org=${encodeURIComponent(org)}`,
        { method: "DELETE" }
      )

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error?.message ?? `HTTP ${res.status}`)
      }

      setDeleteConfirmOpen(false)
      onOpenChange(false)
      onSaved()
    } catch (err: unknown) {
      setDeleteConfirmOpen(false)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{isNew ? "新增仓库" : "编辑仓库"}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="repo-name">名称</Label>
              <Input
                id="repo-name"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="my-project"
                disabled={!isNew}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="repo-url">Git URL</Label>
              <Input
                id="repo-url"
                value={gitUrl}
                onChange={e => setGitUrl(e.target.value)}
                placeholder="git@github.com:org/repo.git"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="repo-branch">分支</Label>
                <Input
                  id="repo-branch"
                  value={branch}
                  onChange={e => setBranch(e.target.value)}
                  placeholder="main"
                />
              </div>

              <div className="space-y-2">
                <Label>分组</Label>
                <Select value={group} onValueChange={setGroup}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="选择分组" />
                  </SelectTrigger>
                  <SelectContent>
                    {groups.map(g => (
                      <SelectItem key={g} value={g}>{g}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="repo-tags">标签</Label>
              <Input
                id="repo-tags"
                value={tags}
                onChange={e => setTags(e.target.value)}
                placeholder="typescript, monorepo"
              />
              <p className="text-xs text-muted-foreground">逗号分隔</p>
            </div>

            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}
          </div>

          <DialogFooter className="flex justify-between sm:justify-between">
            <div>
              {!isNew && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setDeleteConfirmOpen(true)}
                  disabled={saving}
                >
                  <Trash2 className="h-4 w-4 mr-1" />
                  删除
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
                取消
              </Button>
              <Button onClick={handleSave} disabled={!canSave}>
                {saving ? "保存中..." : "保存"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除</AlertDialogTitle>
            <AlertDialogDescription>
              确定要删除仓库 "{entry?.name}" 吗？此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? "删除中..." : "确认删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
