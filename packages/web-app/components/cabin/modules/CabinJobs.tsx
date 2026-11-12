'use client'

// 统一作业窗（原型 wbJobs · C8）：task/workflow/subagent 分色 + 派生 status +
// 提优先（priority+触发 bump）+ 聚焦（focused_job_id）+ trace 下钻。

import { useCallback, useEffect, useState } from 'react'
import { Activity, Boxes, ChevronRight, LayoutGrid, X } from 'lucide-react'
import { toast } from 'sonner'
import {
  listCabinJobs, setCabinFocus, setCabinJobPriority, type CabinJobView,
} from '@/lib/cabin-api'
import { useCabinContext } from '../cabin-provider'
import { Empty, SBadge, WBtn, WbH, WbNote, type SBadgeColor } from './ui'

const JOB_KIND: Record<string, { label: string; color: SBadgeColor }> = {
  task: { label: '任务', color: 'cyan' },
  workflow: { label: '工作流', color: 'violet' },
  subagent: { label: '子代理', color: 'purple' },
}

export function CabinJobs() {
  const { cabinId, cabin, refresh, openModule, setTraceJob } = useCabinContext()
  const [jobs, setJobs] = useState<CabinJobView[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      setJobs(await listCabinJobs(cabinId))
    } catch {
      setJobs([])
    } finally {
      setLoading(false)
    }
  }, [cabinId])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const timer = setInterval(() => { void load() }, 10_000)
    return () => clearInterval(timer)
  }, [load])

  const focJob = jobs.find((j) => j.id === cabin?.focused_job_id)

  const bump = async (j: CabinJobView) => {
    try {
      await setCabinJobPriority(cabinId, j.id, j.priority + 1)
      toast.success(`已提优先 · P${j.priority + 1}（任务类同时 bump next_fire_at）`)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '提优先失败')
    }
  }

  const focus = async (j: CabinJobView) => {
    if (!cabin) return
    try {
      await setCabinFocus(cabinId, cabin.version, j.id)
      toast.success(`已聚焦「${j.title}」· orchestrator 优先驱动`)
      await refresh()
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '聚焦失败')
    }
  }

  const unfocus = async () => {
    if (!cabin) return
    try {
      await setCabinFocus(cabinId, cabin.version, null)
      toast('已退出聚焦')
      await refresh()
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '退出聚焦失败')
    }
  }

  return (
    <div data-testid="cabin-jobs-body">
      <WbH icon={Boxes} title="统一作业" cap="task / workflow / subagent · 优先级 + 聚焦" />
      <WbNote className="mb-3">
        作业是任务/工作流/临时子代理的统一抽象（cabin_jobs）。只存派发事实+引用底层实体，status 派生。
        提优先→priority+触发；聚焦→focused_job_id，orchestrator 优先驱动、human-wake 抢占（带上限防饥饿）。
      </WbNote>

      {focJob && (
        <div className="mb-2.5 flex items-center gap-2 rounded-lg border-[1.5px] border-pop-violet bg-pop-violet/10 px-3 py-2 text-[11px] text-pop-ink" data-testid="cabin-jobs-focus-banner">
          聚焦中 · <b>{focJob.title}</b>
          <WBtn onClick={() => { void unfocus() }} testId="cabin-jobs-unfocus">
            <X className="size-2.5" />退出聚焦
          </WBtn>
        </div>
      )}

      {loading ? (
        <Empty>读取作业账本…</Empty>
      ) : jobs.length === 0 ? (
        <Empty>暂无作业 · 调度者在主对话派发任务</Empty>
      ) : jobs.map((j) => {
        const kind = JOB_KIND[j.kind] ?? { label: j.kind, color: 'dim' as SBadgeColor }
        const isFoc = j.id === cabin?.focused_job_id
        return (
          <div
            key={j.id}
            data-job-row={j.id}
            className={`mt-2 flex items-center gap-3 rounded-[9px] border-[1.5px] bg-pop-paper px-3 py-2 ${isFoc ? 'border-pop-violet' : 'border-pop-bd'}`}
          >
            <span className="flex shrink-0 items-center gap-1.5 text-[11.5px] text-pop-ink">
              <SBadge color={kind.color}>{kind.label}</SBadge>
              <span className="max-w-[220px] truncate font-semibold">{j.title}</span>
            </span>
            <span className="min-w-0 flex-1 truncate text-[10.5px] text-pop-dim">
              {j.iteration_code ?? ''} · {j.status} · {j.transport}
            </span>
            <SBadge color="dim">P{j.priority}</SBadge>
            <WBtn title="提优先" testId={`cabin-job-priority-${j.id}`} onClick={() => { void bump(j) }}>
              <ChevronRight className="size-2.5" />
            </WBtn>
            <WBtn pri={isFoc} title="聚焦" testId={`cabin-job-focus-${j.id}`} onClick={() => { void focus(j) }}>
              <LayoutGrid className="size-2.5" />
            </WBtn>
            <WBtn
              title="查看 trace"
              testId={`cabin-job-trace-${j.id}`}
              onClick={() => { setTraceJob(j.id); openModule('trace') }}
            >
              <Activity className="size-2.5" />
            </WBtn>
          </div>
        )
      })}
    </div>
  )
}
