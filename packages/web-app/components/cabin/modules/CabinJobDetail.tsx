'use client'

// classic-v3 作战详情窗 —— 薄容器（S4 抽取后）：
//   只从 CabinProvider 读 cabinId / cabin / selectedJobId / refresh，
//   其余（页签主体、10s 轮询、任务实体、动作）全部在 components/cabin/job-face.tsx。
//   variant="window" 决定外壳（窗 chrome）；页签清单 2026-11-19 起与全域面同一套
//   （CabinV3 / CabinModulesP3 仍是回归闸门）。

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
      workspaceId={cabin?.workspace_id ?? null}
      jobId={selectedJobId}
      variant="window"
      entryCabinId={cabinId}
      mainSessionId={cabin?.main_session_id ?? null}
      onMutated={() => { void refresh() }}
    />
  )
}
