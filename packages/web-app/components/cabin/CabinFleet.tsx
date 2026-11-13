'use client'

// classic-v3 编队面板（原型 .v3-fleet）：右侧 184px 悬浮列表，≥1321px 显示。
// 行 = cabin_jobs（派发事实 + 派生 status），点一行开「作业详情」。
// 历史舱没有 job 时回退为「运行中 / 待验收的任务」合成行（点击回任务线程）。

import { useEffect, useMemo, useRef, useState } from 'react'
import { Bot, GitBranch, ListTodo } from 'lucide-react'
import { listCabinJobs, type CabinJobView } from '@/lib/cabin-api'
import { cn } from '@/lib/utils'
import { useCabinContext } from './cabin-provider'
import { isEndedJob, jobStatusLabel, jobTone } from './job-status'
import { openTaskInChat, taskDisplayStatus, useCabinTasks, type CabinTaskRow } from './modules/ui'

const JOB_ICON = { task: ListTodo, workflow: GitBranch, subagent: Bot } as const

interface FleetRow {
  id: string
  kind: 'task' | 'workflow' | 'subagent'
  title: string
  status: string
  pct: number
  meta: string
  job?: CabinJobView
  task?: CabinTaskRow
}

function taskPct(task: CabinTaskRow | undefined): number {
  if (!task) return 0
  const phases = task.derived?.phaseViews ?? []
  if (phases.length === 0) {
    const s = taskDisplayStatus(task)
    return s === 'done' ? 100 : s === 'running' ? 50 : 0
  }
  const accepted = phases.filter((p) => p.status === 'accepted').length
  const current = phases.find((p) => p.status !== 'accepted')
  if (!current) return 100
  const rounds = current.rounds?.length ?? 0
  const doneRounds = Math.max(0, (current.currentRound ?? 1) - 1)
  const frac = rounds > 0 ? Math.min(1, doneRounds / rounds) : 0
  return Math.round(((accepted + frac) / phases.length) * 100)
}

export function CabinFleet() {
  const { cabinId, cabin, openJobDetail } = useCabinContext()
  const { tasks } = useCabinTasks(cabinId)
  const [jobs, setJobs] = useState<CabinJobView[]>([])
  const prevIdsRef = useRef<Set<string> | null>(null)
  const [popped, setPopped] = useState<Set<string>>(new Set())

  useEffect(() => {
    let alive = true
    const load = () => {
      listCabinJobs(cabinId)
        .then((list) => { if (alive) setJobs(list) })
        .catch(() => { /* keep last snapshot */ })
    }
    load()
    const timer = window.setInterval(load, 10_000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [cabinId])

  const rows = useMemo<FleetRow[]>(() => {
    const taskOf = (id: string | null | undefined) =>
      (id ? tasks.find((t) => t.id === id) : undefined)
    if (jobs.length > 0) {
      const rank = (status: string) => {
        const tone = jobTone(status)
        return tone === 'run' ? 0 : tone === 'blocked' ? 1 : tone === 'wait' ? 2 : 3
      }
      const live = jobs
        .filter((j) => !isEndedJob(j.status))
        .sort((a, b) => rank(a.status) - rank(b.status) || b.priority - a.priority)
      const ended = jobs
        .filter((j) => isEndedJob(j.status))
        .sort((a, b) => (b.ended_at ?? '').localeCompare(a.ended_at ?? ''))
        .slice(0, 3)
      return [...live, ...ended].map((j) => {
        const task = j.kind === 'task' ? taskOf(j.ref_id) : undefined
        return {
          id: j.id,
          kind: j.kind,
          title: j.title,
          status: j.status,
          pct: j.kind === 'task' ? taskPct(task) : isEndedJob(j.status) ? 100 : 45,
          meta: [j.iteration_code, j.transport].filter(Boolean).join(' · '),
          job: j,
          task,
        }
      })
    }
    // 回退：没有 job 账本的历史舱，用活态任务合成编队。
    return tasks
      .filter((t) => ['running', 'paused', 'awaiting_review', 'awaiting_archive'].includes(taskDisplayStatus(t)))
      .map((t) => ({
        id: `task:${t.id}`,
        kind: 'task' as const,
        title: t.name,
        status: taskDisplayStatus(t),
        pct: taskPct(t),
        meta: t.repo_group ?? '',
        task: t,
      }))
  }, [jobs, tasks])

  // 新作业飞入（轮询发现新 id 时播放一次）。
  useEffect(() => {
    const ids = new Set(rows.map((r) => r.id))
    const prev = prevIdsRef.current
    prevIdsRef.current = ids
    if (!prev) return
    const fresh = [...ids].filter((id) => !prev.has(id))
    if (fresh.length === 0) return
    setPopped(new Set(fresh))
    const timer = window.setTimeout(() => setPopped(new Set()), 900)
    return () => window.clearTimeout(timer)
  }, [rows])

  if (!cabin || rows.length === 0) return null

  return (
    <aside className="ck-fleet" data-testid="cabin-fleet" aria-label="编队">
      <div className="ck-fleet-h">
        <span>编队</span>
        <b>{rows.length}</b>
      </div>
      <div className="ck-fleet-list">
        {rows.map((row) => {
          const Icon = JOB_ICON[row.kind]
          const tone = jobTone(row.status)
          return (
            <button
              key={row.id}
              type="button"
              data-testid={`cabin-fleet-row-${row.id}`}
              data-tone={tone}
              title={`${row.title} · ${jobStatusLabel(row.status)} · ${row.pct}%`}
              onClick={() => {
                if (row.job) openJobDetail(row.job.id)
                else if (row.task) openTaskInChat(row.task.id)
              }}
              className={cn('ck-frow', tone, popped.has(row.id) && 'pop')}
            >
              <span className="g"><Icon className="size-[13px]" strokeWidth={1.8} /></span>
              <span className="n">{row.title}</span>
              <span className="s">
                <i className="d" />
                {jobStatusLabel(row.status)} · {row.pct}%
              </span>
              <span className="bar"><i style={{ width: `${row.pct}%` }} /></span>
            </button>
          )
        })}
      </div>
    </aside>
  )
}
