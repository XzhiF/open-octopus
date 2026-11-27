'use client'

// v21（design 31 §3.1）· 左栏编队 —— 单列 hex 卡。
//
//   · 排序：状态优先（受阻 → 等你 → 在跑 → 待命 → 已完成 → 已归档），
//     同状态按创建时间（旧 → 新；归档档相反：新 → 旧）；纯 attention 行不进编队
//     （归右栏 inbox）。
//   · 默认 6 行；超出时底部「更多 +N ⌄ / 收起 ⌃」，展开只重渲染本栏。
//   · v22 #5（2026-11-23 用户）：行体 / 💬 = 打开这条作战的独立 chat 窗（默认
//     和主通讯台一样大、盖在上面）；▦ = 作战详情。行不再切换主通讯台。
//   · 数字纪律：pct 只在真实拿到时显示数字；null 一律不显示，不猜。
//   · v22 #6（2026-11-23 用户）：作战中行副行最右挂活秒表（mm:ss，每秒走字）
//     —— 与流式卡的计时同一套读数，一眼看出它没卡住；只这一格每秒重渲染。
//   · 2026-11-25 用户：编队行去掉进度条 / 六边进度环 —— 运行中 = 天蓝左缘竖条
//     + 秒表前的 braille 转字（与 chat 流尾工作行同一套帧，10fps）。
//
// 数据只从 useCockpitFleet() 来（已经是入口舱单舱），不自己 fetch。

import { useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { CabinDelegationView } from '@/lib/cabin-api'
import { formatRunClock } from '@/lib/format'
import { useCockpitFleet } from '../fleet/CockpitFleetProvider'
import {
  fleetStageOf,
  fleetStatusOf,
  isLiveRow,
  sortFleet,
  statusLabel,
  type CockpitRow,
  type FleetStatus,
} from '../fleet/fleet-model'
import { sameCockpitRef, defaultTabForRef, type CockpitRef } from '../state/cockpit-state'
import { projectNameFromKey, rowProjectKeys } from '../projects/project-model'
import { accentOfRow } from '../fleet/project-accent'
import { taskDisplayStatus } from '@/components/cabin/modules/ui'
import { jobStatusLabel } from '@/components/cabin/job-status'
import { useCockpitState } from '../state/CockpitStateProvider'
import { useCockpitThreads } from '../chat/use-cockpit-threads'
import { openFleetChat, openNewSessionWindow } from '../chat/open-fleet-window'
import { attentionStageLabel } from '../fx/CockpitBrief'

const RAIL_LAYER_PRIORITY = 70
const POP_MS = 900
/** 默认只显示 6 行；「更多」展开全部。 */
const FLEET_LIMIT = 6

const STATUS_LABEL: Record<FleetStatus, string> = {
  blocked: '受阻',
  wait: '等你答',
  run: '作战中',
  queue: '待命',
  // done 组按实体细分（见 statusTextOf）：非会话作业跑完 = 已完成。
  done: '已完成',
  archived: '已归档',
}

/** 类型字形（原型 KIND）；attention 行不进编队。
 *  会话（delegation）用 ❯ —— 它是一条聊天会话，不是任务/工作流。 */
function glyphOf(row: CockpitRow): string {
  if (row.kind === 'task') return '◆'
  if (row.kind === 'delegation') return '❯'
  if (row.kind !== 'job') return '◆'
  const kind = row.job.kind
  return kind === 'workflow' ? '⬡' : kind === 'subagent' ? '◈' : '◆'
}

function rowRef(row: CockpitRow): CockpitRef | null {
  if (row.kind === 'job') {
    return { kind: 'job', cabinId: row.cabinId, id: row.job.id }
  }
  if (row.kind === 'task') return { kind: 'task', cabinId: row.cabinId, id: row.task.id }
  if (row.kind === 'delegation') return { kind: 'delegation', cabinId: row.cabinId, id: row.delegation.id }
  if (row.kind === 'attention') return { kind: 'attention', cabinId: row.cabinId, id: row.item.id }
  return null
}

function titleOf(row: CockpitRow): string {
  if (row.kind === 'job') return row.job.title
  if (row.kind === 'task') return row.task.name
  if (row.kind === 'delegation') return row.delegation.title
  return row.item.title
}

function pctOf(row: CockpitRow): number | null {
  if (row.kind === 'attention' || row.kind === 'delegation') return null
  // 主线程 agent 在跑、执行还没开始：不显示 0% 的假进度。
  if (row.kind === 'job' && row.job.agent_running && row.job.status !== 'running') return null
  return row.pct
}

/** 副行：项目 + 归属/委派 + 真实状态信息；不编造 doing。 */
function subOf(row: CockpitRow, status: FleetStatus): string {
  const project = row.kind === 'job' && rowProjectKeys(row).length > 0
    ? projectNameFromKey(rowProjectKeys(row)[0])
    : null
  if (row.kind === 'delegation') {
    const delegation: CabinDelegationView = row.delegation
    // 同一本账，只差创建者：人自开的写「会话」，汐音派的写「委派」。
    const label = delegation.origin === 'user' ? '会话' : '委派'
    return [project, `${label} ${delegation.handle ?? ''}`.trim()].filter(Boolean).join(' · ')
  }
  if (row.kind === 'job' && row.attention) {
    return [project, attentionStageLabel(row.attention)].filter(Boolean).join(' · ')
  }
  if (row.kind === 'task') {
    return [project, row.task.repo_group].filter(Boolean).join(' · ')
  }
  if (row.kind === 'job') {
    return [project, row.job.transport].filter(Boolean).join(' · ')
  }
  return project ?? statusLabel(row)
}

/** 原始生命周期状态（行摘要）：归档闸用。 */
function rawStatusOf(row: CockpitRow): string | null {
  if (row.kind === 'task') return taskDisplayStatus(row.task)
  if (row.kind === 'job') return row.job.status ?? null
  if (row.kind === 'delegation') return row.delegation.state ?? null
  return null
}

/** 待归档 / 归档中：详情默认落在「归档」页签，行尾 ▦ 换成 📦（v22 原型同款）。 */
const ARCHIVE_STATUSES = new Set(['awaiting_archive', 'archiving'])
function onArchiveGate(row: CockpitRow): boolean {
  const raw = rawStatusOf(row)
  return raw != null && ARCHIVE_STATUSES.has(raw)
}

function statusTextOf(row: CockpitRow, status: FleetStatus): string {
  const raw = rawStatusOf(row)
  if (raw === 'awaiting_archive') return '待归档'
  if (raw === 'archiving') return '归档中'
  if (row.kind === 'job' && row.attention) return attentionStageLabel(row.attention)
  if (status === 'wait') return '等你答'
  // 2026-11-25 用户：完结 ≠ 归档。会话做完只是「待命」（还能继续聊），
  // 已归档是独立终态；任务走完归档闸才写「已归档」。
  if (status === 'archived') return '已归档'
  if (status === 'done') {
    if (row.kind === 'delegation') return statusLabel(row)
    if (row.kind === 'job' && raw && raw !== 'unknown') return jobStatusLabel(raw)
    return '已完成'
  }
  return STATUS_LABEL[status]
}

/** 行的起跑时刻（attention 行没有）。作战中秒表的起点；非法/缺失 → null（不画）。 */
function startedAtOf(row: CockpitRow): number | null {
  if (row.kind === 'attention') return null
  const iso = row.kind === 'job' ? row.job.created_at
    : row.kind === 'task' ? row.task.created_at
      : row.delegation.created_at
  if (!iso) return null
  const at = Date.parse(iso)
  return Number.isNaN(at) ? null : at
}

/** chat 流尾工作行同款 braille 转字（2026-11-25 用户）：10fps 循环，表示「还在干活」。 */
const RUN_SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** v22 #6（2026-11-23 用户）：干活行的活秒表 —— 每秒 +1，同流式卡的读数。
 *  v23 十六轮（2026-11-24 用户）：口径统一成「已作战」= job 起点 → now，
 *  作战中 / 待验收在跑 / 待命在跑 共用；≥1h 只显示 h:mm（完整值在 title）。
 *  2026-11-25 用户：秒表前加一枚 braille 转字（与 chat 工作行同一套帧，10fps），
 *  替换原来的 ⏱ 字形；reduced-motion 下冻结首帧。
 *  自带 interval，只有这一格文本重渲染，整条编队不跟着每秒重建。
 *  backgroundWait = 作者在等后台任务：点、字、转字一并转琥珀色（仍是静态，不闪）。 */
function RunClock({ start, backgroundWait = false }: { start: number; backgroundWait?: boolean }) {
  const [now, setNow] = useState(() => Date.now())
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [start])
  useEffect(() => {
    if (
      typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) return
    const timer = window.setInterval(() => setFrame((f) => (f + 1) % RUN_SPIN.length), 100)
    return () => window.clearInterval(timer)
  }, [])
  const ms = Math.max(0, now - start)
  const label = formatRunClock(ms, { compact: true })
  const full = formatRunClock(ms)
  return (
    <span
      className={`ck12-fltime${backgroundWait ? ' is-bgw' : ''}`}
      data-testid="cockpit-rail-clock"
      title={`已作战 ${full} · ${backgroundWait ? '作者在等后台，回合还活着' : '每秒走字 = 还活着'}`}
    >
      <span className="ck12-flspin" aria-hidden="true">{RUN_SPIN[frame]}</span> {label}
    </span>
  )
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

export function CockpitFleetRail() {
  const { rows, counts, arrivals, loading, error, refetch } = useCockpitFleet()
  const {
    selection, select, railOpen, setRailOpen, layer, projectFilter, setProjectFilter,
    flash, threads: threadApi, wins, chatWindow,
  } = useCockpitState()

  const [popped, setPopped] = useState<ReadonlySet<string>>(() => new Set())
  const [fleetOpen, setFleetOpen] = useState(false)
  const railRef = useRef<HTMLElement | null>(null)
  const { byKey } = useCockpitThreads()

  const visible = useMemo(() => {
    const fleet = sortFleet(rows)
    if (!projectFilter) return fleet
    return fleet.filter((row) => rowProjectKeys(row).includes(projectFilter))
  }, [rows, projectFilter])

  const shown = fleetOpen ? visible : visible.slice(0, FLEET_LIMIT)
  const hidden = visible.length - shown.length

  const runCount = visible.filter((row) => fleetStatusOf(row) === 'run').length
  const queueCount = visible.filter((row) => fleetStatusOf(row) === 'queue').length
  const archivedCount = visible.filter((row) => fleetStatusOf(row) === 'archived').length

  /** v22 #5：行体 / 💬 = 这条作战的独立 chat 窗；没有会话的行退回详情。
   *  2026-11-27：人自开会话就是 delegation 行 —— 有 doer 会话，走同一扇窗入口。 */
  const openChat = (row: CockpitRow) => {
    const thread = byKey.get(row.key)
    if (thread) { openFleetChat(wins, threadApi, row.key, chatWindow, thread.sessionId); return }
    const ref = rowRef(row)
    if (ref) select(ref)
  }
  /** ▦ = 详情（会话落「对接」，任务/作业落「运行」）；待归档 / 归档中直接落「归档」页签。 */
  const openDetail = (row: CockpitRow) => {
    const ref = rowRef(row)
    if (ref) select(ref, onArchiveGate(row) ? 'archive' : defaultTabForRef(ref))
  }

  /** v23（2026-11-27 用户）：编队「新会话」—— 空白草稿窗，发第一条消息才创建会话，
   *  不占汐音的回合，也不会有上下文串味。 */
  const openNewSession = () => { openNewSessionWindow(wins, chatWindow) }

  // ── 新行 pop：arrivals 命中的 attention + 首次出现的 key，900ms 后收 ──
  const seenKeysRef = useRef<Set<string> | null>(null)
  const popTimerRef = useRef<number | null>(null)

  useEffect(() => {
    const seen = seenKeysRef.current
    seenKeysRef.current = new Set(rows.map((row) => row.key))

    const fresh = seen ? rows.filter((row) => !seen.has(row.key)).map((row) => row.key) : []
    const arrived = new Set(arrivals)
    const hit = rows
      .filter((row) => (
        (row.kind === 'attention' && arrived.has(row.item.id))
        || (row.kind === 'job' && !!row.attention && arrived.has(row.attention.id))
      ))
      .map((row) => row.key)

    const next = [...new Set([...fresh, ...hit])]
    if (next.length === 0) return

    setPopped((prev) => new Set([...prev, ...next]))
    if (popTimerRef.current !== null) window.clearTimeout(popTimerRef.current)
    popTimerRef.current = window.setTimeout(() => {
      popTimerRef.current = null
      setPopped(new Set())
    }, POP_MS)
  }, [rows, arrivals])

  useEffect(
    () => () => {
      if (popTimerRef.current !== null) window.clearTimeout(popTimerRef.current)
    },
    [],
  )

  // ── 抽屉：点外部收（≤900 才显示；HUD ☰ / 更多→编队 打开） ──
  useEffect(() => {
    if (!railOpen) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (railRef.current?.contains(target)) return
      if (target.closest('[aria-controls="ck12-fleet-rail"]')) return
      setRailOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [railOpen, setRailOpen])

  // ── Esc 只走 CockpitLayerStack（编队抽屉 priority 70） ──
  useEffect(() => {
    if (!railOpen) return
    return layer.register('cockpit-fleet-rail', RAIL_LAYER_PRIORITY, () => setRailOpen(false))
  }, [railOpen, layer, setRailOpen])

  // ── ↑↓：在可见编队行内移动；输入框聚焦时不接管 ──
  const shownRef = useRef(shown)
  shownRef.current = shown
  const selectionRef = useRef(selection)
  selectionRef.current = selection

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      if (event.altKey || event.metaKey || event.ctrlKey) return
      if (isEditableTarget(event.target)) return
      if (event.defaultPrevented) return

      const list = shownRef.current
      if (list.length === 0) return
      const current = selectionRef.current
      const index = current
        ? list.findIndex((row) => {
          const ref = rowRef(row)
          return ref ? sameCockpitRef(current, ref) : false
        })
        : -1

      event.preventDefault()
      const delta = event.key === 'ArrowDown' ? 1 : -1
      const nextIndex = index < 0
        ? (delta > 0 ? 0 : list.length - 1)
        : (index + delta + list.length) % list.length
      const row = list[nextIndex]
      if (row) select(rowRef(row))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [select])

  const hasRows = visible.length > 0
  const filterName = projectFilter ? projectNameFromKey(projectFilter) : null

  return (
    <aside
      ref={railRef}
      id="ck12-fleet-rail"
      className={`ck12-rail${railOpen ? ' is-open' : ''}`}
      data-testid="cockpit-fleet-rail"
      data-open={fleetOpen ? 'true' : 'false'}
      aria-label="编队"
    >
      <div className="ck12-rail-h">
        <button
          type="button"
          className="ck12-rail-close"
          aria-label="收起编队"
          title="收起编队"
          onClick={() => setRailOpen(false)}
        >
          <X className="size-3" aria-hidden="true" />
        </button>
        <span className="ck12-fr-mark" aria-hidden="true">⬡</span>
        <span className="ck12-rail-h-label">
          <span>编队</span>
          <b>{visible.length}</b>
          {runCount > 0 && <i className="ck12-fr-live" aria-hidden="true" />}
        </span>
        <span className="ck12-fr-sp" />
        <button
          type="button"
          className="ck12-fr-new"
          title="新建会话 · 发第一条消息才创建，不占汐音"
          data-testid="cockpit-fleet-new"
          onClick={openNewSession}
        >
          新会话
        </button>
        <button
          type="button"
          className="ck12-fr-all"
          title={fleetOpen ? '收起编队列表' : '展开全部编队'}
          data-testid="cockpit-fleet-all"
          onClick={() => setFleetOpen((open) => !open)}
        >
          {fleetOpen ? '收起 ←' : '全部 →'}
        </button>
      </div>

      <div className="ck12-fr-sub">
        <span>在跑 <b>{runCount}</b></span>
        <span>待命 <b>{queueCount}</b></span>
        <span>归档 <b>{archivedCount}</b></span>
      </div>

      {/* 有数据但本轮刷新失败：保留上一份编队，明确标 stale，不悄悄假装最新。 */}
      {error && rows.length > 0 && (
        <div className="ck12-rail-stale" title={error} data-testid="cockpit-rail-stale">
          刷新失败 · 显示上一份编队
          <button type="button" className="ck12-rail-retry" onClick={refetch}>重试</button>
        </div>
      )}

      {filterName && (
        <div className="ck12-rail-pfilter" data-testid="cockpit-rail-project-filter">
          <span>只看 <b>{filterName}</b></span>
          <b>{visible.length} 条作业</b>
          <button
            type="button"
            aria-label="清除项目筛选"
            title="清除项目筛选"
            onClick={() => setProjectFilter(null)}
          >
            ✕
          </button>
        </div>
      )}

      <div
        className="ck12-raillist"
        role="listbox"
        aria-label="编队作业"
        tabIndex={0}
        aria-activedescendant={
          selection
            ? (() => {
              const active = shown.find((row) => {
                const ref = rowRef(row)
                return ref ? sameCockpitRef(selection, ref) : false
              })
              return active
                ? `ck12-fleet-opt-${active.key.replace(/[^a-zA-Z0-9_-]/g, '-')}`
                : undefined
            })()
            : undefined
        }
      >
        {shown.map((row) => {
          const ref = rowRef(row)
          const selected = ref ? sameCockpitRef(selection, ref) : false
          // stage = 生命周期口径（chip / 行色 / 窄栏点）；live = 真有 agent 在干活。
          // 待验收的作者还在推进时不改 chip，只加流动态 + 统一秒表。
          const stage = fleetStageOf(row)
          const live = isLiveRow(row)
          const rawStatus = rawStatusOf(row)
          const archGate = onArchiveGate(row)
          const pct = rawStatus === 'awaiting_archive' ? null : pctOf(row)
          // 人自开的会话生命周期很长（created_at 是会话始建时间）——本轮起跑时刻
          // 用 running 那一次写入的 updated_at，不拿会话年龄冒充本轮耗时。
          const startedAt = !live
            ? null
            : row.kind === 'delegation' && row.delegation.origin === 'user'
              ? (() => {
                const at = Date.parse(row.delegation.updated_at)
                return Number.isNaN(at) ? null : at
              })()
              : startedAtOf(row)
          const backgroundWait = live && row.kind === 'job' && row.live_phase === 'background-wait'
          const liveText = live
            ? (backgroundWait
              ? '作者在等后台'
              : row.kind === 'delegation' && row.delegation.origin === 'user' ? '会话在跑' : '作者在跑')
            : null
          const endedStage = stage === 'done' || stage === 'archived'
          const statusText = statusTextOf(row, stage)
          const accent = accentOfRow(row)
          const title = titleOf(row)
          const delegationSessionId = row.kind === 'delegation' ? row.delegation.doer_session_id : null
          const talkable = byKey.has(row.key)
          const chatOpen = wins.windows.some((win) => !win.min && (
            win.threadKey === row.key || (!!delegationSessionId && win.sessionId === delegationSessionId)
          ))
          const unread = threadApi.unread[row.key] ?? 0
          const showActs = talkable || !!ref
          return (
            <div
              key={row.key}
              id={`ck12-fleet-opt-${row.key.replace(/[^a-zA-Z0-9_-]/g, '-')}`}
              role="option"
              aria-selected={selected}
              tabIndex={-1}
              data-testid={`cockpit-rail-row-${row.key}`}
              data-tone={stage}
              title={talkable
                ? `${title} · ${statusText}${liveText ? ` · ${liveText}` : ''} · 点行进对话`
                : `${title} · ${statusText}${liveText ? ` · ${liveText}` : ''} · 点击看详情`}
              className={`ck12-flrow is-${stage}${live ? ' is-flow' : ''}${selected ? ' is-on' : ''}${
                chatOpen ? ' is-chat' : ''
              }${popped.has(row.key) ? ' is-pop' : ''}${flash.key === row.key ? ` is-arrived-${flash.nonce % 2}` : ''}`}
              style={{ ['--accent' as string]: accent }}
              onClick={() => (talkable ? openChat(row) : openDetail(row))}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  if (talkable) openChat(row)
                  else openDetail(row)
                }
              }}
            >
              <span className="ck12-flhw" aria-hidden="true">
                <span className="ck12-flhg">{glyphOf(row)}</span>
              </span>

              <span className="ck12-flbody">
                <span className="ck12-fltop">
                  <b className="ck12-fl-title">{title}</b>
                  {pct !== null && !endedStage && (
                    <span className="ck12-flpct">{Math.round(pct)}%</span>
                  )}
                </span>
                <span className="ck12-flsub">
                  <span className={`ck12-flst is-${stage}${rawStatus === 'awaiting_archive' ? ' is-arch' : rawStatus === 'archiving' ? ' is-archrun' : ''}`}>{statusText}</span>
                  {/* 干活行把副行让给秒表（细节在悬停 title），避免和计时抢宽度。 */}
                  {!live && <span className="ck12-flsub-t">{subOf(row, stage)}</span>}
                  {startedAt !== null && (
                    <RunClock start={startedAt} backgroundWait={backgroundWait} />
                  )}
                </span>
              </span>

              {showActs && (
                <span className="ck12-flacts">
                  {talkable && (
                    <span className="ck12-flactwrap">
                      <button
                        type="button"
                        className="ck12-flact is-pri"
                        aria-label={`对话 ${title}`}
                        title="💬 对话 · 独立 chat 窗"
                        data-testid={`cockpit-rail-chat-${row.key}`}
                        onClick={(event) => {
                          event.stopPropagation()
                          openChat(row)
                        }}
                      >
                        💬
                      </button>
                      {/* 徽标挂在按钮外面：按钮是六边形 clip-path，挂里面会被裁掉一半。 */}
                      {unread > 0 && (
                        <i className="ck12-flact-und">{unread > 9 ? '9+' : unread}</i>
                      )}
                    </span>
                  )}
                  {ref && (
                    <button
                      type="button"
                      className={`ck12-flact${archGate ? ' is-arch' : ''}`}
                      aria-label={`${archGate ? '归档' : '详情'} ${title}`}
                      title={archGate
                        ? '📦 归档 · 详情 · 归档页签'
                        : row.kind === 'delegation'
                          ? '▦ 会话详情（对接 / 文件 / 运行 / 调试 / 消耗 / 子代理）'
                          : '▦ 详情 · 作战详情（不动主通讯台）'}
                      data-testid={`cockpit-rail-detail-${row.key}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        openDetail(row)
                      }}
                    >
                      {archGate ? '📦' : '▦'}
                    </button>
                  )}
                </span>
              )}
            </div>
          )
        })}

        {!hasRows && (
          <div className="ck12-rail-empty" data-testid="cockpit-rail-empty">
            {error ? (
              <>
                <span className="ck12-rail-error">编队加载失败 · {error}</span>
                <button type="button" className="ck12-rail-retry" onClick={refetch}>
                  重试
                </button>
              </>
            ) : loading ? '载入编队…' : '编队空着 · 从主对话派一条'}
          </div>
        )}
      </div>

      {!fleetOpen && hidden > 0 ? (
        <div className="ck12-fr-foot">
          <button
            type="button"
            className="ck12-fr-more"
            data-testid="cockpit-fleet-more"
            onClick={() => setFleetOpen(true)}
          >
            <span className="ck12-fr-more-l">更多</span>
            <b>+{hidden}</b>
            <span aria-hidden="true">⌄</span>
          </button>
        </div>
      ) : fleetOpen && visible.length > FLEET_LIMIT ? (
        <div className="ck12-fr-foot">
          <button
            type="button"
            className="ck12-fr-more"
            data-testid="cockpit-fleet-more"
            onClick={() => setFleetOpen(false)}
          >
            <span className="ck12-fr-more-l">收起</span>
            <b>⌃</b>
          </button>
        </div>
      ) : null}
    </aside>
  )
}
