'use client'

import { useState } from 'react'
import { Users, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAgentClones } from '@/hooks/useAgentClones'
import { CloneCardGrid } from './CloneCardGrid'
import { CloneCreateWizard } from './CloneCreateWizard'
import { CloneMergeDialog } from './CloneMergeDialog'
import { CloneDeleteDialog } from './CloneDeleteDialog'
import { CloneChatView } from './CloneChatView'
import { AgentEmptyState } from '../shared/AgentEmptyState'
import type { CloneInfo } from '@/lib/agent/types'

export function CloneTab() {
  const { clones, loading, error, refetch } = useAgentClones()
  const [showWizard, setShowWizard] = useState(false)
  const [mergeTarget, setMergeTarget] = useState<CloneInfo | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<CloneInfo | null>(null)
  const [activeChatClone, setActiveChatClone] = useState<CloneInfo | null>(null)

  // D3: Click clone → enter multi-session chat view
  if (activeChatClone) {
    return (
      <CloneChatView
        clone={activeChatClone}
        onBack={() => setActiveChatClone(null)}
      />
    )
  }

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
        <Button
          onClick={() => setShowWizard(true)}
          size="sm"
          className="gap-1.5 bg-agent-primary hover:bg-agent-primary-hover text-agent-primary-foreground"
        >
          <Plus className="h-4 w-4" />
          创建分身
        </Button>
      </div>

      {error && (
        <div className="mx-4 mt-4 rounded-md bg-agent-error-light border border-agent-error/20 p-3 text-sm text-agent-error">
          {error}
        </div>
      )}

      {/* Clone grid */}
      <div className="flex-1 overflow-auto p-4">
        <CloneCardGrid
          clones={clones}
          loading={loading}
          onMerge={setMergeTarget}
          onDelete={setDeleteTarget}
          onEnterChat={setActiveChatClone}
        />
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
    </div>
  )
}
