'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { TaskDetail, TaskView } from '@/lib/tasks-api'
import { getArtifactManifest, getTask } from '@/lib/tasks-api'
import type { ArtifactManifestBody } from '@/lib/types'
import { listBuiltInWorkflows, type BuiltInWorkflowSummary } from '@/lib/workflow-presets-api'
import { SpecPanel } from '@/components/tasks/authoring/spec-panel'
import { useBatchTree } from '@/components/tasks/authoring/use-batch-tree'
import { computeSpecRows, type SpecGateHits } from '@/components/tasks/authoring/spec-gate'
import { Spinner } from '@/components/ui/spinner'

const EMPTY_HITS: SpecGateHits = { phases: [], spec: [], bind: [], inputs: [], repos: [], runbook: [] }

/** Read-only plan window (spec editing surface); artifacts live in their own window. */
export function TaskPlanWindow({ task, onOpenArtifacts }: { task: TaskView; onOpenArtifacts?: () => void }) {
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [catalog, setCatalog] = useState<BuiltInWorkflowSummary[]>([])
  const [artifacts, setArtifacts] = useState<ArtifactManifestBody | null>(null)
  const batchTree = useBatchTree(task.id, { versionKey: detail?.version })

  const refresh = useCallback(async () => {
    try {
      setDetail(await getTask(task.id))
    } catch {
      /* keep the last snapshot */
    }
  }, [task.id])

  useEffect(() => {
    void refresh()
    listBuiltInWorkflows().then(setCatalog).catch(() => setCatalog([]))
  }, [refresh])

  // 产出摘要只读清单（phase × 轮次）；随任务 version 刷新，不占规格窗口的写路径。
  useEffect(() => {
    let alive = true
    getArtifactManifest(task.id)
      .then((body) => { if (alive) setArtifacts(body) })
      .catch(() => { if (alive) setArtifacts(null) })
    return () => { alive = false }
  }, [task.id, detail?.version])

  const spec = detail?.task_spec
  const rows = useMemo(() => {
    if (!spec) return null
    return computeSpecRows({
      phases: spec.phases ?? [],
      spec,
      catalog,
      batches: batchTree.batches,
      batchLoading: batchTree.loading,
      batchError: batchTree.error,
      projectCount: (task.project_ids ?? []).length,
      composite: Array.isArray(spec.subunits) && spec.subunits.length >= 2,
    })
  }, [spec, catalog, batchTree.batches, batchTree.loading, batchTree.error, task.project_ids])

  if (!detail || !rows) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-5 text-pop-dim" />
      </div>
    )
  }

  return (
    <SpecPanel
      task={detail}
      onMutated={() => void refresh()}
      batchTree={batchTree}
      rows={rows}
      gateHits={EMPTY_HITS}
      artifacts={artifacts}
      onOpenArtifacts={onOpenArtifacts}
      readOnly
    />
  )
}
