'use client'

import { useState, useCallback, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Plus, History } from 'lucide-react'
import { VersionList } from './VersionList'
import { VersionDiff } from './VersionDiff'
import { PublishVersionDialog } from './PublishVersionDialog'
import {
  listCloneVersions,
  publishCloneVersion,
  rollbackCloneVersion,
  archiveCloneVersion,
  diffCloneVersions,
  listMainAgentVersions,
  publishMainAgentVersion,
  rollbackMainAgentVersion,
  archiveMainAgentVersion,
  diffMainAgentVersions,
} from '@/lib/agent/api'
import type { AgentVersionInfo, VersionStage, VersionDiffResponse } from '@/lib/agent/types'

interface CloneVersionsTabProps {
  /** Clone name, or '__main__' for the Main Agent */
  agentName: string
}

export function CloneVersionsTab({ agentName }: CloneVersionsTabProps) {
  const [versions, setVersions] = useState<AgentVersionInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [publishOpen, setPublishOpen] = useState(false)
  const [diffOpen, setDiffOpen] = useState(false)
  const [diffFrom, setDiffFrom] = useState('')
  const [diffTo, setDiffTo] = useState('')

  const isMainAgent = agentName === '__main__'

  // ── API adapters ─────────────────────────────────────────────────

  const fetchVersions = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const result = isMainAgent
        ? await listMainAgentVersions()
        : await listCloneVersions(agentName)
      setVersions(result.versions)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '加载版本列表失败')
    } finally {
      setLoading(false)
    }
  }, [agentName, isMainAgent])

  const handlePublish = useCallback(
    async (data: { version: string; stage: VersionStage; changelog: string }) => {
      if (isMainAgent) {
        await publishMainAgentVersion(data)
      } else {
        await publishCloneVersion(agentName, data)
      }
      await fetchVersions()
    },
    [agentName, isMainAgent, fetchVersions],
  )

  const handleRollback = useCallback(
    async (version: string) => {
      try {
        if (isMainAgent) {
          await rollbackMainAgentVersion(version)
        } else {
          await rollbackCloneVersion(agentName, version)
        }
        await fetchVersions()
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : '回滚失败')
      }
    },
    [agentName, isMainAgent, fetchVersions],
  )

  const handleArchive = useCallback(
    async (version: string) => {
      try {
        if (isMainAgent) {
          await archiveMainAgentVersion(version)
        } else {
          await archiveCloneVersion(agentName, version)
        }
        await fetchVersions()
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : '归档失败')
      }
    },
    [agentName, isMainAgent, fetchVersions],
  )

  const handleOpenDiff = useCallback((from: string, to: string) => {
    setDiffFrom(from)
    setDiffTo(to)
    setDiffOpen(true)
  }, [])

  const handleFetchDiff = useCallback(
    async (from: string, to: string): Promise<VersionDiffResponse> => {
      if (isMainAgent) {
        return diffMainAgentVersions(from, to)
      }
      return diffCloneVersions(agentName, from, to)
    },
    [agentName, isMainAgent],
  )

  // ── Load on mount ────────────────────────────────────────────────

  useEffect(() => {
    fetchVersions()
  }, [fetchVersions])

  // ── Render ───────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-9 w-28" />
        </div>
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-agent-divider">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">版本历史 ({versions.length})</h3>
        </div>
        <Button
          size="sm"
          onClick={() => setPublishOpen(true)}
          className="gap-1.5 bg-agent-primary hover:bg-agent-primary-hover text-agent-primary-foreground"
        >
          <Plus className="h-4 w-4" />
          发布新版本
        </Button>
      </div>

      {/* Error */}
      {error && (
        <div className="mx-4 mt-3 rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-600">
          {error}
          <button
            className="ml-2 underline"
            onClick={() => { setError(null); fetchVersions() }}
          >
            重试
          </button>
        </div>
      )}

      {/* Version list */}
      <div className="flex-1 overflow-auto p-4">
        <VersionList
          versions={versions}
          onRollback={handleRollback}
          onArchive={handleArchive}
          onCompare={handleOpenDiff}
        />
      </div>

      {/* Publish dialog */}
      <PublishVersionDialog
        open={publishOpen}
        onOpenChange={setPublishOpen}
        onSubmit={handlePublish}
      />

      {/* Diff dialog */}
      <VersionDiff
        open={diffOpen}
        onOpenChange={setDiffOpen}
        versions={versions}
        initialFrom={diffFrom}
        initialTo={diffTo}
        fetchDiff={handleFetchDiff}
      />
    </div>
  )
}
