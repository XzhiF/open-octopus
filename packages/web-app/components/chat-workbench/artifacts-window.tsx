'use client'

// 2026-10-28 task-thread M5: artifacts as its own window (moved out of the
// acceptance/run-console tabs).

import { useEffect, useState } from 'react'
import { getArtifactManifest } from '@/lib/tasks-api'
import type { ArtifactManifestBody } from '@/lib/types'
import { ArtifactsTab } from '@/components/tasks/run-console/artifacts-tab'

export function ArtifactsWindow({ taskId, versionKey }: { taskId: string; versionKey?: string | number }) {
  const [body, setBody] = useState<ArtifactManifestBody | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    setLoading(true)
    getArtifactManifest(taskId)
      .then((next) => { if (alive) setBody(next) })
      .catch(() => { if (alive) setBody(null) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [taskId, versionKey])

  return (
    <div className="h-full min-h-0 overflow-y-auto" data-testid="artifacts-window">
      <ArtifactsTab taskId={taskId} body={body} loading={loading} />
    </div>
  )
}
