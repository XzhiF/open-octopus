'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import type { VersionStage } from '@/lib/agent/types'

interface PublishVersionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (data: { version: string; stage: VersionStage; changelog: string }) => Promise<void>
}

const STAGE_OPTIONS: { value: VersionStage; label: string; description: string }[] = [
  { value: 'alpha', label: 'Alpha', description: '开发中' },
  { value: 'beta', label: 'Beta', description: '测试中' },
  { value: 'rc', label: 'RC', description: '候选发布' },
  { value: 'stable', label: 'Stable', description: '正式发布' },
]

export function PublishVersionDialog({ open, onOpenChange, onSubmit }: PublishVersionDialogProps) {
  const [version, setVersion] = useState('')
  const [stage, setStage] = useState<VersionStage>('stable')
  const [changelog, setChangelog] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isValid = /^(\d+)\.(\d+)\.(\d+)(-(alpha|beta|rc)(\.\d+)?)?$/.test(version.trim())

  async function handleSubmit() {
    if (!isValid) return
    setSubmitting(true)
    setError(null)
    try {
      await onSubmit({ version: version.trim(), stage, changelog: changelog.trim() })
      setVersion('')
      setStage('stable')
      setChangelog('')
      onOpenChange(false)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '发布失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onPointerDownOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>发布新版本</DialogTitle>
          <DialogDescription>
            创建当前分身配置的不可变快照。版本号使用 Maven 格式 (如 1.0.0, 1.2.0-beta.1)。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="version">版本号</Label>
            <Input
              id="version"
              placeholder="1.0.0"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              autoFocus
            />
            {version && !isValid && (
              <p className="text-xs text-red-500">
                格式: major.minor.patch[-qualifier]，如 1.0.0, 1.2.0-beta.1
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="stage">发布阶段</Label>
            <Select value={stage} onValueChange={(v) => setStage(v as VersionStage)}>
              <SelectTrigger id="stage">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STAGE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label} — {opt.description}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="changelog">变更说明</Label>
            <Textarea
              id="changelog"
              placeholder="本次版本的主要变更..."
              value={changelog}
              onChange={(e) => setChangelog(e.target.value)}
              rows={4}
            />
          </div>

          {error && (
            <div className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-600">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            取消
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!isValid || submitting}
            className="bg-agent-primary hover:bg-agent-primary-hover text-agent-primary-foreground"
          >
            {submitting ? '发布中...' : '发布版本'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
