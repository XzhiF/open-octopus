'use client'

// classic-v3 作业详情窗 —— 薄容器（S4 抽取后）：
//   只从 CabinProvider 读 cabinId / cabin / selectedJobId / refresh，
//   其余（五页签、10s 轮询、任务实体、动作）全部在 components/cabin/job-face.tsx。
//   variant="window" 保证旧窗 DOM/行为逐字不变（CabinV3 / CabinModulesP3 回归）。

import { useCabinContext } from '../cabin-provider'
import { JobFace } from '../job-face'

export function CabinJobDetail() {
  const { cabinId, cabin, selectedJobId, refresh } = useCabinContext()

  if (!selectedJobId) {
    return (
      <div className="grid h-full min-h-40 place-items-center text-[12px] text-pop-dim" data-testid="cabin-job-empty">
        从编队点一条作业
      </div>
    )
  }

  return (
    <JobFace
      cabinId={cabinId}
      cabinVersion={cabin?.version ?? 0}
      workspaceId={cabin?.workspace_id ?? null}
      jobId={selectedJobId}
      variant="window"
      entryCabinId={cabinId}
      mainSessionId={cabin?.main_session_id ?? null}
      focusedJobId={cabin ? cabin.focused_job_id : undefined}
      onMutated={() => { void refresh() }}
    />
  )
}
