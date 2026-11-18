'use client'

// S4 owns this file —— 作业头（variant="cockpit"）。
// v21 三轮（原型 cockpit-v21.html .panel / .ph / .dtabs）：
//   行1：✕（左置）→ 状态表情 + 标题 / 副行「项目 · 分支 · 编号」→ 右侧只有 ⛶；
//   行2：平行四边形页签（.dtab）—— 五轮起按原型放进滚动正文（.pb），
//   由 <CockpitJobTabs> 渲染，不再挂在头部。
// v21 五轮（用户）：右上不再放任何动作按钮 —— 项目签 / 中止 / 谈 / 决断 / 调试 /
//   去处理全撤（原型 .ph 只有 ⛶）。作业操作走它自己的入口：
//   谈 = 左栏行 💬，决断 = 右栏「要我处理」，调试 = 详情页签，舱籍 = HUD 舱籍 chip。
//
// 视觉真源：docs/cabin-design/cockpit-v21.html 的 .ph / .dtabs；样式在 v21b.css。

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import type { CabinJobKind } from '@octopus/shared'
import { cn } from '@/lib/utils'
import { formatDuration } from '@/lib/format'
import { jobTone, type JobTone } from '@/components/cabin/job-status'
import {
  COCKPIT_TABS,
  COCKPIT_TAB_LABELS,
  type CockpitTab,
} from '../state/cockpit-state'
import { useDossierWindow } from './dossier-window'

/** 原型 STATE_EMO：状态表情跟着 tone 走（字面量逐字取自原型）。 */
const TONE_EMOJI: Record<JobTone, string> = {
  run: '⚡',
  wait: '❗',
  blocked: '💦',
  ended: '✅',
  idle: '●',
}

/**
 * created_at → ended_at ?? now 的紧凑时长；任一值非法 → null（整段省略）。
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
  /** 关闭 = 收面（select(null)）；必须由调用方接到 CockpitState。 */
  onClose: () => void

  /** 行2：分支（task_spec.branch） */
  branch?: string | null
  /** 行2：项目名（编队行的 project_keys 派生；缺省回落舱名）。 */
  projectName?: string | null
  /** 行2：任务 / 作业编号短号（原型 t-2641）。 */
  jobNo?: string | null
  /** 行2：正在做什么（最后一条 event summary / attention.title / 状态文案） */
  doing?: string | null
  /** 行2：执行者短 id，缺省回落到舱名（§1.5） */
  executor?: string | null
  cabinName?: string | null
  startedAt?: string | null
  endedAt?: string | null
  /** 行2：本作业消耗（已按计费设置格式化；null = 省略该段） */
  costLabel?: string | null
}

export function CockpitJobHeader({
  loading = false,
  title,
  status,
  onClose,
  branch,
  projectName,
  jobNo,
  executor,
  cabinName,
}: CockpitJobHeaderProps) {
  const win = useDossierWindow()
  const tone = jobTone(status)
  const emoji = TONE_EMOJI[tone]
  // 原型 .ph 副行：项目 · 分支 · 编号（拿不到的段整段省略）。
  // 项目优先用编队行派生名，没有锚点才退回舱名；编号缺省退回执行者短 id。
  const subtitle = [projectName ?? cabinName, branch, jobNo ?? executor].filter(Boolean).join(' · ')

  return (
    <div className="ck12-jh" data-testid="cockpit-job-header" data-loading={loading ? '1' : '0'}>
      <div className="ck12-dh">
        {/* header 的第一个可聚焦元素 = 关闭，且视觉在左（§1.6 硬要求）。 */}
        <button
          type="button"
          className="ck12-jh-x"
          data-testid="cockpit-job-close"
          aria-label="收起作业面"
          title="收起（Esc）"
          onClick={onClose}
        >
          <X className="size-3" aria-hidden="true" />
        </button>

        <span className="ck12-dh-pt">
          <b title={title ?? undefined}>{loading ? '载入作业…' : `${emoji} ${title ?? '—'}`}</b>
          {!loading && subtitle && <span>{subtitle}</span>}
        </span>

        <span className="ck12-dh-sp" />
        {/* v21 五轮：右上只有原型 .pwin 的 ⛶（全屏 / 还原，也可双击标题栏）。
            不再有项目签 / 中止 / 谈 / 决断 / 调试 / 去处理 —— 那些都回到各自入口。 */}
        {!loading && win && (
          <button
            type="button"
            className="ck12-pwin"
            data-testid="cockpit-dossier-max"
            aria-label={win.maximized ? '还原面板' : '全屏面板'}
            title="全屏 / 还原（也可双击标题栏）"
            onClick={win.toggleMax}
          >
            {win.maximized ? '⤡' : '⛶'}
          </button>
        )}
      </div>
    </div>
  )
}

/** 详情页签（原型 .dtabs）：v21 五轮按原型放进滚动正文，和内容一起滚走。
 *  受控组件 —— tab / onTabChange 由宿主（URL 同步的 CockpitState）给。 */
export function CockpitJobTabs({
  tab,
  onTabChange,
}: {
  tab?: CockpitTab | null
  onTabChange?: (tab: CockpitTab) => void
}) {
  return (
    <div className="ck12-dtabs" role="tablist" aria-label="作业页签">
      {COCKPIT_TABS.map((key) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={tab === key}
          data-testid={`cockpit-tab-${key}`}
          className={cn('ck12-dtab', tab === key && 'on')}
          onClick={() => onTabChange?.(key)}
        >
          {COCKPIT_TAB_LABELS[key]}
        </button>
      ))}
    </div>
  )
}
