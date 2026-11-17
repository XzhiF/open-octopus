'use client'

// classic-v3 编队面板（原型 .v3-fleet → v6）：右侧悬浮列表，≥1321px 显示。
// 行 = cabin_jobs（派发事实 + 派生 status），点一行开「作业详情」。
// v6（2026-11-17）：**只放作战实体**（任务 / 工作流 / 分身）。「要我处理」
// （待你定 / 待验收 / 受阻）已拆到编队上方的独立 inbox（CabinInbox），
// 这里不再混入提问行 —— 编队点行 = 看详情，inbox 点行 = 去处理。
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
  /** 任务主线程 agent 在跑（生命周期可能仍是「待执行」）。 */
  live: boolean
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
    // 答完决策 1.2s 补一拍：主线程流启动后立刻显示「作者在推进」。
    const answerTimers = new Set<number>()
    const onAnswered = () => {
      const id = window.setTimeout(() => {
        answerTimers.delete(id)
        load()
      }, 1_200)
      answerTimers.add(id)
    }
    window.addEventListener('octopus:author-ask-answered', onAnswered)
    return () => {
      alive = false
      window.clearInterval(timer)
      window.removeEventListener('octopus:author-ask-answered', onAnswered)
      for (const id of answerTimers) window.clearTimeout(id)
    }
  }, [cabinId])

  const rows = useMemo<FleetRow[]>(() => {
    const taskOf = (id: string | null | undefined) =>
      (id ? tasks.find((t) => t.id === id) : undefined)
    if (jobs.length > 0) {
      const rank = (j: CabinJobView) => {
        // 作者 agent 在跑（刚答完决策、答案已转达）优先于一切待执行作业。
        if (j.agent_running) return 0
        const tone = jobTone(j.status)
        return tone === 'run' ? 0 : tone === 'blocked' ? 1 : tone === 'wait' ? 2 : 3
      }
      const live = jobs
        .filter((j) => !isEndedJob(j.status))
        .sort((a, b) => rank(a) - rank(b))
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
          meta: j.transport,
          live: !!j.agent_running,
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
        live: false,
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

  const runningCount = rows.filter((r) => r.live || (!isEndedJob(r.status) && jobTone(r.status) === 'run')).length

  return (
    <aside className="ck-fleet" data-testid="cabin-fleet" aria-label="编队">
      <div className="ck-fleet-h">
        <span className="lh">
          {runningCount > 0 && <i className="live" />}
          编队
        </span>
        <b>{rows.length}</b>
      </div>
      <div className="ck-fleet-list">
        {rows.map((row) => {
          const Icon = JOB_ICON[row.kind]
          const isLive = row.live && row.status !== 'running'
          const isDone = ['done', 'completed', 'completed_with_failures'].includes(row.status)
          const statusText = isLive ? '作者在推进' : jobStatusLabel(row.status)
          const tone = row.live ? 'run' : isDone ? 'done' : jobTone(row.status)
          // 作者在写方案 / 澄清时，执行进度还没开始：不画 0% 的假进度。
          const showPct = !isLive
          return (
            <button
              key={row.id}
              type="button"
              data-testid={`cabin-fleet-row-${row.id}`}
              data-tone={tone}
              data-live={row.live ? 'true' : undefined}
              title={`${row.title} · ${statusText}${showPct ? ` · ${row.pct}%` : ''}`}
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
                {statusText}{showPct ? ` · ${row.pct}%` : ''}
              </span>
              {showPct && <span className="bar"><i style={{ width: `${row.pct}%` }} /></span>}
            </button>
          )
        })}
      </div>
      <div className="ck-fleet-foot">点行 = 详情 · 不作答</div>
    </aside>
  )
}
