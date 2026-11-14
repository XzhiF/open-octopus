'use client'

// S4 owns this file —— 作业面 chrome + 选中解析（job / task / attention 三型）。
// 五页签主体在 components/cabin/job-face.tsx；CockpitTaskFace 承载合成 task 行；
// CockpitAttentionFace 承载无 job_id 的 attention。
//
// chrome 只做三件事：
//   1. `.ck12-face` 容器（让位给左下立绘，宽度断点与安静层一致）；
//   2. 从 useCockpitFleet().rows 找选中行，拿 cabinName / attention；
//   3. 关闭 = select(null)，并注册进 layer（priority 最低 → Esc 最后才收面）。
// 跨舱查看时向归属舱拉一次 cabin（工作区/版本/主会话），失败就按缺省省略 —— 不猜。

import { useCallback, useEffect, useMemo, useState } from 'react'
import { getCabin, type CabinDetail } from '@/lib/cabin-api'
import { useCabinOptional } from '@/components/cabin/cabin-provider'
import { JobFace } from '@/components/cabin/job-face'
import { useCockpitState } from '../state/CockpitStateProvider'
import { cockpitRefKey, type CockpitRef } from '../state/cockpit-state'
import { useCockpitFleet } from '../fleet/CockpitFleetProvider'
import { groupOf, type CockpitRow } from '../fleet/fleet-model'
import { CockpitAttentionFace } from './CockpitAttentionFace'
import { CockpitTaskFace } from './CockpitTaskFace'

/** 作业面的 Esc 层 id / 优先级：最低（其它层都先关）。 */
export const FACE_LAYER_ID = 'cockpit-face'
export const FACE_LAYER_PRIORITY = 1

export interface CockpitFaceProps {
  /** 入口舱（跨舱查看时 ≠ selection.cabinId）；「对接」投递只对入口舱开放。 */
  entryCabinId: string
}

function refOfRow(row: CockpitRow): CockpitRef {
  if (row.kind === 'job') return { kind: 'job', cabinId: row.cabinId, id: row.job.id }
  if (row.kind === 'task') return { kind: 'task', cabinId: row.cabinId, id: row.task.id }
  return { kind: 'attention', cabinId: row.cabinId, id: row.item.id }
}

function rowMatches(row: CockpitRow, ref: CockpitRef): boolean {
  if (row.cabinId !== ref.cabinId) return false
  if (ref.kind === 'job') return row.kind === 'job' && row.job.id === ref.id
  if (ref.kind === 'task') return row.kind === 'task' && row.task.id === ref.id
  return row.kind === 'attention' && row.item.id === ref.id
}

export function CockpitFace({ entryCabinId }: CockpitFaceProps) {
  const { selection, tab, setTab, select, layer } = useCockpitState()
  const { rows, refetch } = useCockpitFleet()
  const cabinCtx = useCabinOptional()
  const [crossCabin, setCrossCabin] = useState<CabinDetail | null>(null)

  // 跨舱：归属舱的 workspace_id / version / main_session_id 不在编队行里，
  // 单独拉一次（只影响运行页签与头部元信息；失败就省略，不猜）。
  const selectedCabinId = selection?.cabinId ?? null
  useEffect(() => {
    if (!selectedCabinId || selectedCabinId === entryCabinId) {
      setCrossCabin(null)
      return
    }
    let alive = true
    setCrossCabin(null)
    getCabin(selectedCabinId).then(
      ({ cabin }) => { if (alive) setCrossCabin(cabin) },
      () => { /* 缺省：workspaceId 为空 → 运行摘要给明确空态 */ },
    )
    return () => { alive = false }
  }, [selectedCabinId, entryCabinId])

  const close = useCallback(() => select(null), [select])

  // 关闭注册进唯一 Esc 栈（最外层：只收面，不退出路由）。
  useEffect(() => {
    if (!selection) return
    return layer.register(FACE_LAYER_ID, FACE_LAYER_PRIORITY, () => select(null))
  }, [selection, layer, select])

  // 验收通过/打回后落下一行「需要你」（plans §1.3）。用当前快照挑：当前行
  // 一定被排除，剩下的 need 行就是 refetch 后仍然成立的那一批。
  const advance = useCallback((from: CockpitRef) => {
    const key = cockpitRefKey(from)
    const next = rows.find((row) => groupOf(row) === 'need' && cockpitRefKey(refOfRow(row)) !== key)
    if (next) select(refOfRow(next), 'overview')
  }, [rows, select])

  const row = useMemo(
    () => (selection ? rows.find((entry) => rowMatches(entry, selection)) ?? null : null),
    [rows, selection],
  )

  // attention 选中：优先纯 attention 行；若它其实挂在某条 job 上（job_id 命中），
  // 直接落到那条 job 的面（那里才有完整五页签）。
  const attentionOnJob = useMemo(() => {
    if (selection?.kind !== 'attention' || row) return null
    return rows.find((entry) => entry.kind === 'job' && entry.attention?.id === selection.id) ?? null
  }, [rows, selection, row])

  if (!selection) return null

  const selectedCabin = selection.cabinId === entryCabinId
    ? cabinCtx?.cabin ?? null
    : crossCabin
  const cabinName = row?.cabinName ?? attentionOnJob?.cabinName ?? null

  const body = (() => {
    if (attentionOnJob && attentionOnJob.kind === 'job') {
      return (
        <JobFace
          cabinId={attentionOnJob.cabinId}
          cabinVersion={selectedCabin?.version ?? 0}
          workspaceId={selectedCabin?.workspace_id ?? null}
          jobId={attentionOnJob.job.id}
          variant="cockpit"
          entryCabinId={entryCabinId}
          mainSessionId={selectedCabin?.main_session_id ?? null}
          focusedJobId={selectedCabin ? selectedCabin.focused_job_id : undefined}
          onMutated={refetch}
          cockpit={{
            cabinName,
            attention: attentionOnJob.attention ?? null,
            tab,
            onTabChange: setTab,
            onClose: close,
            onAcceptanceMutated: () => advance(selection),
          }}
        />
      )
    }

    if (selection.kind === 'job') {
      return (
        <JobFace
          cabinId={selection.cabinId}
          cabinVersion={selectedCabin?.version ?? 0}
          workspaceId={selectedCabin?.workspace_id ?? null}
          jobId={selection.id}
          variant="cockpit"
          entryCabinId={entryCabinId}
          mainSessionId={selectedCabin?.main_session_id ?? null}
          focusedJobId={selectedCabin ? selectedCabin.focused_job_id : undefined}
          onMutated={refetch}
          cockpit={{
            cabinName,
            attention: row?.kind === 'job' ? row.attention ?? null : null,
            tab,
            onTabChange: setTab,
            onClose: close,
            onAcceptanceMutated: () => advance(selection),
          }}
        />
      )
    }

    if (selection.kind === 'task') {
      return (
        <CockpitTaskFace
          cabinId={selection.cabinId}
          taskId={selection.id}
          entryCabinId={entryCabinId}
          cabinName={cabinName}
          tab={tab}
          onTabChange={setTab}
          onClose={close}
          onMutated={refetch}
          onAcceptanceMutated={() => advance(selection)}
        />
      )
    }

    return (
      <CockpitAttentionFace
        cabinId={selection.cabinId}
        attentionId={selection.id}
        onClose={close}
      />
    )
  })()

  return (
    <div
      className="ck12-face"
      data-testid="cockpit-face"
      data-entry-cabin={entryCabinId}
      data-selected-cabin={selection.cabinId}
    >
      {body}
    </div>
  )
}
