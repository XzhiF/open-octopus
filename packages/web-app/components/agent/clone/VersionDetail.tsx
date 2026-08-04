'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { FileText, Settings, RotateCcw, Archive, GitCompare } from 'lucide-react'
import type { AgentVersionInfo, AgentSnapshot } from '@/lib/agent/types'

interface VersionDetailProps {
  version: AgentVersionInfo
  onRollback: (version: string) => void
  onArchive: (version: string) => void
  onViewDiff: (version: string) => void
  isArchived: boolean
}

function parseSnapshot(raw: string): AgentSnapshot | null {
  try {
    return JSON.parse(raw) as AgentSnapshot
  } catch {
    return null
  }
}

export function VersionDetail({ version, onRollback, onArchive, onViewDiff, isArchived }: VersionDetailProps) {
  const [showPersona, setShowPersona] = useState(false)
  const [showConfig, setShowConfig] = useState(false)
  const [showRollbackConfirm, setShowRollbackConfirm] = useState(false)

  const snapshot = parseSnapshot(version.snapshot)

  return (
    <div className="border-t border-agent-divider bg-muted/30 px-4 py-3 space-y-3">
      {/* Changelog */}
      {version.changelog && (
        <div>
          <h5 className="text-xs font-medium text-muted-foreground mb-1">变更说明</h5>
          <p className="text-sm whitespace-pre-wrap">{version.changelog}</p>
        </div>
      )}

      {/* Snapshot info */}
      {snapshot && (
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline" className="text-xs">
            {snapshot.skills.length} 个技能
          </Badge>
          <Badge variant="outline" className="text-xs">
            persona: {snapshot.persona.length} 字符
          </Badge>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => setShowPersona(true)}
        >
          <FileText className="h-3.5 w-3.5" />
          查看 Persona
        </Button>

        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => setShowConfig(true)}
        >
          <Settings className="h-3.5 w-3.5" />
          查看 Config
        </Button>

        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => onViewDiff(version.version)}
        >
          <GitCompare className="h-3.5 w-3.5" />
          对比...
        </Button>

        {!isArchived && (
          <>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-amber-600 hover:text-amber-700"
              onClick={() => setShowRollbackConfirm(true)}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              回滚
            </Button>

            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-muted-foreground"
              onClick={() => onArchive(version.version)}
            >
              <Archive className="h-3.5 w-3.5" />
              归档
            </Button>
          </>
        )}
      </div>

      {/* Persona viewer dialog */}
      <Dialog open={showPersona} onOpenChange={setShowPersona}>
        <DialogContent className="sm:max-w-2xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle>Persona — v{version.version}</DialogTitle>
            <DialogDescription>persona.md 内容</DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[60vh]">
            <pre className="text-xs font-mono whitespace-pre-wrap p-4 bg-muted rounded-md">
              {snapshot?.persona ?? '(无法解析快照)'}
            </pre>
          </ScrollArea>
        </DialogContent>
      </Dialog>

      {/* Config viewer dialog */}
      <Dialog open={showConfig} onOpenChange={setShowConfig}>
        <DialogContent className="sm:max-w-2xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle>Config — v{version.version}</DialogTitle>
            <DialogDescription>config.json 内容</DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[60vh]">
            <pre className="text-xs font-mono whitespace-pre-wrap p-4 bg-muted rounded-md">
              {snapshot ? JSON.stringify(snapshot.config, null, 2) : '(无法解析快照)'}
            </pre>
          </ScrollArea>
        </DialogContent>
      </Dialog>

      {/* Rollback confirmation dialog */}
      <Dialog open={showRollbackConfirm} onOpenChange={setShowRollbackConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认回滚</DialogTitle>
            <DialogDescription>
              将此分身回滚到版本 {version.version}。当前配置将被替换为该版本的快照。此操作可以在后续通过再次回滚来撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRollbackConfirm(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setShowRollbackConfirm(false)
                onRollback(version.version)
              }}
            >
              确认回滚
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
