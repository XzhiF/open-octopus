'use client'

import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { GitCompare } from 'lucide-react'
import type { AgentVersionInfo, VersionDiffResponse } from '@/lib/agent/types'

interface VersionDiffProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  versions: AgentVersionInfo[]
  initialFrom?: string
  initialTo?: string
  fetchDiff: (from: string, to: string) => Promise<VersionDiffResponse>
}

/**
 * Render a simple unified diff with colored lines.
 */
function DiffBlock({ content, label }: { content: string; label: string }) {
  if (!content || content.trim() === '') {
    return (
      <div>
        <h5 className="text-xs font-medium text-muted-foreground mb-2">{label}</h5>
        <p className="text-xs text-muted-foreground italic">无差异</p>
      </div>
    )
  }

  const lines = content.split('\n')
  return (
    <div>
      <h5 className="text-xs font-medium text-muted-foreground mb-2">{label}</h5>
      <ScrollArea className="max-h-[40vh]">
        <pre className="text-xs font-mono p-3 bg-muted rounded-md">
          {lines.map((line, i) => {
            let className = ''
            if (line.startsWith('+')) className = 'text-green-700 bg-green-50'
            else if (line.startsWith('-')) className = 'text-red-700 bg-red-50'
            else if (line.startsWith('@@')) className = 'text-blue-600 font-medium'
            return (
              <div key={i} className={className}>
                {line || ' '}
              </div>
            )
          })}
        </pre>
      </ScrollArea>
    </div>
  )
}

export function VersionDiff({
  open,
  onOpenChange,
  versions,
  initialFrom,
  initialTo,
  fetchDiff,
}: VersionDiffProps) {
  const [fromVersion, setFromVersion] = useState(initialFrom ?? '')
  const [toVersion, setToVersion] = useState(initialTo ?? '')
  const [diff, setDiff] = useState<VersionDiffResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset when dialog opens with new initial values
  useEffect(() => {
    if (open) {
      setFromVersion(initialFrom ?? '')
      setToVersion(initialTo ?? '')
      setDiff(null)
      setError(null)
    }
  }, [open, initialFrom, initialTo])

  async function handleCompare() {
    if (!fromVersion || !toVersion) return
    setLoading(true)
    setError(null)
    setDiff(null)
    try {
      const result = await fetchDiff(fromVersion, toVersion)
      setDiff(result)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '获取 diff 失败')
    } finally {
      setLoading(false)
    }
  }

  const publishedVersions = versions.filter((v) => v.status === 'published' || v.status === 'archived')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[85vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitCompare className="h-5 w-5" />
            版本对比
          </DialogTitle>
          <DialogDescription>
            选择两个版本查看 persona、config、skills 的差异。
          </DialogDescription>
        </DialogHeader>

        {/* Version selectors */}
        <div className="flex items-end gap-3">
          <div className="flex-1 space-y-1">
            <label className="text-xs font-medium text-muted-foreground">From</label>
            <Select value={fromVersion} onValueChange={setFromVersion}>
              <SelectTrigger>
                <SelectValue placeholder="选择版本" />
              </SelectTrigger>
              <SelectContent>
                {publishedVersions.map((v) => (
                  <SelectItem key={v.id} value={v.version}>
                    {v.version}
                    <Badge variant="outline" className="ml-2 text-xs">{v.stage}</Badge>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex-1 space-y-1">
            <label className="text-xs font-medium text-muted-foreground">To</label>
            <Select value={toVersion} onValueChange={setToVersion}>
              <SelectTrigger>
                <SelectValue placeholder="选择版本" />
              </SelectTrigger>
              <SelectContent>
                {publishedVersions.map((v) => (
                  <SelectItem key={v.id} value={v.version}>
                    {v.version}
                    <Badge variant="outline" className="ml-2 text-xs">{v.stage}</Badge>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Button
            onClick={handleCompare}
            disabled={!fromVersion || !toVersion || fromVersion === toVersion || loading}
            className="gap-1.5"
          >
            {loading ? <Spinner className="h-4 w-4" /> : <GitCompare className="h-4 w-4" />}
            对比
          </Button>
        </div>

        {error && (
          <div className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-600">
            {error}
          </div>
        )}

        {/* Diff results */}
        {diff && (
          <Tabs defaultValue="persona" className="flex-1">
            <TabsList className="w-full">
              <TabsTrigger value="persona" className="flex-1">Persona</TabsTrigger>
              <TabsTrigger value="config" className="flex-1">Config</TabsTrigger>
              <TabsTrigger value="skills" className="flex-1">Skills</TabsTrigger>
            </TabsList>
            <TabsContent value="persona" className="mt-2">
              <DiffBlock content={diff.persona_diff} label="persona.md" />
            </TabsContent>
            <TabsContent value="config" className="mt-2">
              <DiffBlock content={diff.config_diff} label="config.json" />
            </TabsContent>
            <TabsContent value="skills" className="mt-2">
              <DiffBlock content={diff.skills_diff} label="skills" />
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  )
}
