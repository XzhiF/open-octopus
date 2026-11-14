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

/** 编队行已有的作业摘要 → 作业面载入态的头部（不必等详情接口）。 */
function hintOf(row: CockpitRow | null) {
  if (!row || row.kind !== 'job') return null
  return { title: row.job.title, kind: row.job.kind, status: row.job.status }
}

export function CockpitFace({ entryCabinId }: CockpitFaceProps) {
  const { selection, tab, setTab, select, layer } = useCockpitState()
  const { rows, counts, error, refetch } = useCockpitFleet()
  const cabinCtx = useCabinOptional()
  const [crossCabin, setCrossCabin] = useState<CabinDetail | null>(null)
  // counts !== null = 编队至少成功接过一次真值（FleetProvider 契约）。
  const loadedOnce = counts !== null

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

  // 跨舱：归属舱的 workspace_id / version / main_session_id 不在编队行里，
  // 单独拉一次（只影响运行页签与头部元信息；失败就省略，不猜）。
  // 等编队回来且选中项确实在编队里才拉 —— 过期深链（?job=…&cabin=…）在
  // URL 被改写前不再请求一个已删的舱。
  const selectedCabinId = selection?.cabinId ?? null
  const selectionKnown = !!row || !!attentionOnJob
  useEffect(() => {
    if (!loadedOnce || !selectionKnown) return
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
  }, [loadedOnce, selectionKnown, selectedCabinId, entryCabinId])

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

  if (!selection) return null

  const selectedCabin = selection.cabinId === entryCabinId
    ? cabinCtx?.cabin ?? null
    : crossCabin
  const cabinName = row?.cabinName ?? attentionOnJob?.cabinName ?? null

  const body = (() => {
    // 编队还没接过真值：不挂作业面（JobFace/CockpitTaskFace 会立刻拉详情）。
    // 深链里的 job/task 可能已经删了 —— 先等编队回来校验，避免一串注定 404
    // 的请求（随后 CockpitUrlSync 才把 URL 改写掉）。
    if (!loadedOnce) {
      // 编队加载失败时不能一直写「载入编队…」——给出原因和重试。
      if (error) {
        return (
          <div className="ck12-face-empty" data-testid="cockpit-face-error">
            编队加载失败 · {error}
            <button type="button" className="ck12-rail-retry" onClick={refetch}>重试</button>
            {error.includes('超时') && (
              <span className="ck12-face-hint">
                超时多半是浏览器连接被占满（同时开着多个页面/窗口）。关掉其它页面后点重试。
              </span>
            )}
          </div>
        )
      }
      return <div className="ck12-face-empty">载入编队…</div>
    }

    // 选中项不在当前编队（已结束且被 done 截断 / 已删除）：URL 同步会立刻
    // 回退到有效行；这段窗口里不发任何请求，也不闪一张假的作业面。
    if (!row && !attentionOnJob) {
      return (
        <div className="ck12-face-empty" data-testid="cockpit-face-stale">
          这件作业已不在编队 · 正在切到下一件…
        </div>
      )
    }

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
            hint: hintOf(attentionOnJob),
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
            hint: hintOf(row),
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
