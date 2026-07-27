'use client'

import { useState, useEffect, useCallback } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { Users, Plus, Cpu, User } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAgentClones } from '@/hooks/useAgentClones'
import { CloneCardGrid } from './CloneCardGrid'
import { CloneCreateWizard } from './CloneCreateWizard'
import { CloneMergeDialog } from './CloneMergeDialog'
import { CloneDeleteDialog } from './CloneDeleteDialog'
import { CloneDetailView } from './CloneDetailView'
import { CloneFilePanel } from './CloneFilePanel'
import { AgentEmptyState } from '../shared/AgentEmptyState'
import type { CloneInfo } from '@/lib/agent/types'

export function CloneTab() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const { clones, loading, error, refetch } = useAgentClones()
  const [showWizard, setShowWizard] = useState(false)
  const [mergeTarget, setMergeTarget] = useState<CloneInfo | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<CloneInfo | null>(null)
  const [fileMgmtClone, setFileMgmtClone] = useState<CloneInfo | null>(null)

  // ── URL-persisted clone selection ──
  const cloneParam = searchParams.get('clone')

  const activeChatClone = clones.find(c => c.name === cloneParam) ?? null

  const enterClone = useCallback((clone: CloneInfo) => {
    const url = new URL(window.location.href)
    url.searchParams.set('clone', clone.name)
    router.replace(url.toString())
  }, [router])

  const exitClone = useCallback(() => {
    const url = new URL(window.location.href)
    url.searchParams.delete('clone')
    router.replace(url.toString())
  }, [router])

  // D3: Click clone → enter three-column detail view (URL-persisted)
  if (activeChatClone) {
    return (
      <CloneDetailView
        clone={activeChatClone}
        onBack={exitClone}
      />
    )
  }

  const systemClones = clones.filter(c => c.type === 'built-in')
  const userClones = clones.filter(c => c.type === 'user')

  if (!loading && clones.length === 0 && !showWizard) {
    return (
      <AgentEmptyState
        icon={Users}
        title="还没有分身"
        description="Agent 会在合适时机建议创建分身来处理并行任务。你也可以手动创建。"
        actionLabel="创建分身"
        onAction={() => setShowWizard(true)}
      />
    )
  }

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-agent-divider bg-agent-surface-raised">
        <h2 className="text-sm font-medium">分身管理 ({clones.length})</h2>
      </div>

      {error && (
        <div className="mx-4 mt-4 rounded-md bg-agent-error-light border border-agent-error/20 p-3 text-sm text-agent-error">
          {error}
        </div>
      )}

      {/* Clone sections */}
      <div className="flex-1 overflow-auto p-4 space-y-6">
        {/* System clones section */}
        <section>
          <div className="flex items-center gap-2 mb-3">
            <Cpu className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-medium text-muted-foreground">
              系统分身 ({systemClones.length})
            </h3>
          </div>
          <CloneCardGrid
            clones={systemClones}
            loading={loading}
            showActions={false}
            onMerge={setMergeTarget}
            onDelete={setDeleteTarget}
            onEnterChat={enterClone}
            onManageFiles={setFileMgmtClone}
          />
        </section>

        {/* User clones section */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <User className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-medium text-muted-foreground">
                用户分身 ({userClones.length})
              </h3>
            </div>
            <Button
              onClick={() => setShowWizard(true)}
              size="sm"
              className="gap-1.5 bg-agent-primary hover:bg-agent-primary-hover text-agent-primary-foreground"
            >
              <Plus className="h-4 w-4" />
              创建分身
            </Button>
          </div>
          <CloneCardGrid
            clones={userClones}
            loading={loading}
            showActions={true}
            onMerge={setMergeTarget}
            onDelete={setDeleteTarget}
            onEnterChat={enterClone}
            onManageFiles={setFileMgmtClone}
          />
          {!loading && userClones.length === 0 && (
            <div className="text-center py-8 text-sm text-muted-foreground border border-dashed border-agent-divider rounded-lg">
              还没有用户分身，点击上方按钮创建
            </div>
          )}
        </section>
      </div>

      {/* Wizard */}
      {showWizard && (
        <CloneCreateWizard
          onClose={() => setShowWizard(false)}
          onCreated={() => { setShowWizard(false); refetch() }}
        />
      )}

      {/* Merge dialog */}
      <CloneMergeDialog
        clone={mergeTarget}
        onClose={() => setMergeTarget(null)}
        onMerged={() => { setMergeTarget(null); refetch() }}
      />

      {/* Delete dialog */}
      <CloneDeleteDialog
        clone={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onDeleted={() => { setDeleteTarget(null); refetch() }}
      />

      {/* File management panel */}
      <CloneFilePanel
        clone={fileMgmtClone}
        onClose={() => setFileMgmtClone(null)}
      />
    </div>
  )
}
