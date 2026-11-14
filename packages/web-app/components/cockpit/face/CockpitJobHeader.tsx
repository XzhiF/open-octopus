'use client'

// S4 owns this file —— 作业头（variant="cockpit"）。
// 行1：✕（第一个可聚焦元素）→ 类型 → 标题 → 状态 → spacer → 5 页签；
// 行2：按 §1.5 派生表拼 分支 · 在做 · 舱/执行者 · ⏱ · ¥，空值整段省略。
// 视觉真源：docs/cabin-design/cockpit-v12.html 的 .jobhead（h1 28px / h2 20px /
// gap 3 / .jtab 24px 胶囊）；类名统一 ck12-jh-*，样式在 app/cockpit/face.css。
//
// 本组件只做呈现：数据由 JobFace / CockpitTaskFace 派生后传入，动作节点
// （暂停/恢复/中止等）也由调用方拼好放进 `actions`，这里不碰任何 API。

import { useEffect, useState, type ReactNode } from 'react'
import { ArrowRight } from 'lucide-react'
import type { CabinAttentionItem, CabinJobKind } from '@octopus/shared'
import { cn } from '@/lib/utils'
import { formatDuration } from '@/lib/format'
import { jobStatusLabel, jobTone } from '@/components/cabin/job-status'
import {
  COCKPIT_TABS,
  COCKPIT_TAB_LABELS,
  type CockpitTab,
} from '../state/cockpit-state'

const KIND_LABEL: Record<CabinJobKind, string> = {
  task: '任务',
  workflow: '工作流',
  subagent: '子代理',
}

const KIND_CLASS: Record<CabinJobKind, string> = {
  task: 'is-task',
  workflow: 'is-workflow',
  subagent: 'is-subagent',
}

/**
 * attention 阶段 → 主操作落到的页签（plans Step 4 task 2）：
 * review→验收、answer/adjudicate→对接、blocked→运行。
 * approval 是运行中的审批闸，同样落在运行页签（不另造第四种去处）。
 */
export function tabForAttentionStage(stage: CabinAttentionItem['stage']): CockpitTab {
  switch (stage) {
    case 'review':
      return 'accept'
    case 'answer':
    case 'adjudicate':
      return 'relay'
    case 'blocked':
    case 'approval':
      return 'run'
  }
}

/** created_at → ended_at ?? now 的紧凑时长；任一值非法 → null（整段省略）。
 *  格式化走 `lib/format.formatDuration` 的 compact 档（全站单源，C4 门禁）。 */
export function elapsedLabel(
  startISO: string | null | undefined,
  endISO: string | null | undefined,
  now: number,
): string | null {
  if (!startISO) return null
  const start = Date.parse(startISO)
  if (Number.isNaN(start)) return null
  const parsedEnd = endISO ? Date.parse(endISO) : now
  const end = Number.isNaN(parsedEnd) ? now : parsedEnd
  const ms = end - start
  return ms <= 0 ? '0s' : formatDuration(ms, { compact: true })
}

/** 作业概览「耗时」读数：作业没结束时每秒自己刷新，终态定格。
 *  两种面（job / 合成 task）共用，避免各写一份 setInterval。 */
export function CockpitElapsed({ start, end }: { start: string | null; end: string | null }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!start || end) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [start, end])
  return <>{elapsedLabel(start, end, now) ?? '—'}</>
}

export interface CockpitJobHeaderProps {
  /** 载入中：只渲染关闭 + 占位标题（关闭仍是第一个可聚焦元素）。 */
  loading?: boolean
  kind?: CabinJobKind | null
  title?: string | null
  status?: string | null
  tab?: CockpitTab | null
  onTabChange?: (tab: CockpitTab) => void
  /** 关闭 = 收面（select(null)）；必须由调用方接到 CockpitState。 */
  onClose: () => void

  /** 行2：分支（task_spec.branch） */
  branch?: string | null
  /** 行2：正在做什么（最后一条 event summary / attention.title / 状态文案） */
  doing?: string | null
  /** 行2：执行者短 id，缺省回落到舱名（§1.5） */
  executor?: string | null
  cabinName?: string | null
  startedAt?: string | null
  endedAt?: string | null
  /** 行2：本作业消耗（已按计费设置格式化；null = 省略该段） */
  costLabel?: string | null

  /** 有 attention 才给：渲染「去处理 →」，点击切到对应页签。 */
  onGoHandle?: () => void
  /** 按 kind 的真实动作（JobFace/CockpitTaskFace 拼好）。 */
  actions?: ReactNode
}

export function CockpitJobHeader({
  loading = false,
  kind,
  title,
  status,
  tab,
  onTabChange,
  onClose,
  branch,
  doing,
  executor,
  cabinName,
  startedAt,
  endedAt,
  costLabel,
  onGoHandle,
  actions,
}: CockpitJobHeaderProps) {
  // 走表：作业还在跑时 ⏱ 每秒刷新；终态/未开始不挂定时器。
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (loading || !startedAt || endedAt) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [loading, startedAt, endedAt])

  // 「行2」按 §1.5 派生表拼段：空值整段省略，分隔符只在两段之间出现。
  // 左组可截断（分支 · 在做），右侧元信息不换行（舱/执行者 · ⏱ · ¥）。
  const left: ReactNode[] = []
  const meta: ReactNode[] = []
  const push = (
    bucket: ReactNode[],
    key: string,
    text: string | null | undefined,
    className?: string,
  ) => {
    if (!text) return
    bucket.push(
      <span key={key} className={className} title={text}>{text}</span>,
    )
  }
  push(left, 'branch', branch, 'ck12-jh-branch')
  push(left, 'doing', doing, 'ck12-jh-doing')
  push(meta, 'who', executor || cabinName, 'ck12-jh-who')
  const elapsed = elapsedLabel(startedAt, endedAt, now)
  push(meta, 'elapsed', elapsed ? `⏱ ${elapsed}` : null, 'ck12-jh-time')
  push(meta, 'cost', costLabel, 'ck12-jh-cost')

  const renderSegs = (items: ReactNode[]) =>
    items.map((item, index) => (
      <span key={index} className="ck12-jh-seg">
        {index > 0 && <span className="ck12-jh-sep" aria-hidden="true">·</span>}
        {item}
      </span>
    ))

  const hasRow2 = left.length > 0 || meta.length > 0 || !!actions || !!onGoHandle

  return (
    <div className="ck12-jh" data-testid="cockpit-job-header" data-loading={loading ? '1' : '0'}>
      <div className="ck12-jh-h1">
        {/* header 的第一个可聚焦元素 = 关闭，且视觉在左（§1.6 硬要求）。 */}
        <button
          type="button"
          className="ck12-jh-x"
          data-testid="cockpit-job-close"
          aria-label="收起作业面"
          title="收起（Esc）"
          onClick={onClose}
        >
          ✕
        </button>

        {loading ? (
          <h2 className="ck12-jh-title is-loading">载入作业…</h2>
        ) : (
          <>
            {kind && (
              <span className={cn('ck12-jh-kind', KIND_CLASS[kind])}>
                {KIND_LABEL[kind]}
              </span>
            )}
            <h2 className="ck12-jh-title" title={title ?? undefined}>{title ?? '—'}</h2>
            {status && (
              <span className={cn('ck12-jh-status', `is-${jobTone(status)}`)}>
                {jobStatusLabel(status)}
              </span>
            )}
            <span className="ck12-jh-spacer" />
            <div className="ck12-jh-tabs" role="tablist" aria-label="作业页签">
              {COCKPIT_TABS.map((key) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={tab === key}
                  data-testid={`cockpit-tab-${key}`}
                  className={cn('ck12-jh-tab', tab === key && 'on')}
                  onClick={() => onTabChange?.(key)}
                >
                  {COCKPIT_TAB_LABELS[key]}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {!loading && hasRow2 && (
        <div className="ck12-jh-h2">
          {left.length > 0 && <div className="ck12-jh-left">{renderSegs(left)}</div>}
          <span className="ck12-jh-spacer" />
          {meta.length > 0 && <div className="ck12-jh-meta">{renderSegs(meta)}</div>}
          <span className="ck12-jh-acts">
            {actions}
            {onGoHandle && (
              <button
                type="button"
                className="ck12-jh-go"
                data-testid="cockpit-job-go"
                onClick={onGoHandle}
              >
                去处理 <ArrowRight className="ck12-jh-go-arrow" aria-hidden="true" />
              </button>
            )}
          </span>
        </div>
      )}
    </div>
  )
}

/**
 * task 类作业的真实动作（暂停 / 恢复 / 中止）—— 只用 lib/tasks-api 现有函数。
 * 只在服务端真会接受的组合上出现（running：暂停+中止；paused：继续；
 * ready：中止），不新写状态机。
 */
export function TaskRunActions({
  status,
  busy,
  onPause,
  onResume,
  onAbort,
}: {
  status: string | null | undefined
  busy?: string | null
  onPause: () => void
  onResume: () => void
  onAbort: () => void
}) {
  if (status === 'running') {
    return (
      <>
        <button
          type="button"
          className="ck12-jh-btn"
          data-testid="cockpit-job-pause"
          disabled={!!busy}
          onClick={onPause}
        >
          暂停
        </button>
        <button
          type="button"
          className="ck12-jh-btn is-danger"
          data-testid="cockpit-job-abort"
          disabled={!!busy}
          onClick={onAbort}
        >
          中止
        </button>
      </>
    )
  }
  if (status === 'paused') {
    return (
      <button
        type="button"
        className="ck12-jh-btn"
        data-testid="cockpit-job-resume"
        disabled={!!busy}
        onClick={onResume}
      >
        继续
      </button>
    )
  }
  if (status === 'ready' || status === 'pending') {
    return (
      <button
        type="button"
        className="ck12-jh-btn is-danger"
        data-testid="cockpit-job-abort"
        disabled={!!busy}
        onClick={onAbort}
      >
        中止
      </button>
    )
  }
  return null
}
