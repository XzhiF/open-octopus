'use client'

// v21（design 31 §3.1）· 左栏编队 —— 单列 hex 卡。
//
//   · 排序：状态优先（受阻 → 等你 → 在跑 → 待命 → 已归档），同状态按创建时间
//     升序（旧 → 新）；纯 attention 行不进编队（归右栏 inbox）。
//   · 默认 6 行；超出时底部「更多 +N ⌄ / 收起 ⌃」，展开只重渲染本栏。
//   · v22 #5（2026-11-23 用户）：行体 / 💬 = 打开这条作战的独立 chat 窗（默认
//     和主通讯台一样大、盖在上面）；▦ = 作战详情。行不再切换主通讯台。
//   · 数字纪律：pct 只在真实拿到时画条；null 一律不画，不猜。
//   · v22 #6（2026-11-23 用户）：作战中行副行最右挂活秒表（⏱ mm:ss，每秒走字）
//     —— 与流式卡的计时同一套读数，一眼看出它没卡住；只这一格每秒重渲染。
//
// 数据只从 useCockpitFleet() 来（已经是入口舱单舱），不自己 fetch。

import { useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { CabinDelegationView } from '@/lib/cabin-api'
import { formatRunClock } from '@/lib/format'
import { useCockpitFleet } from '../fleet/CockpitFleetProvider'
import {
  fleetStatusOf,
  sortFleet,
  statusLabel,
  type CockpitRow,
  type FleetStatus,
} from '../fleet/fleet-model'
import { sameCockpitRef, type CockpitRef } from '../state/cockpit-state'
import { projectNameFromKey, rowProjectKeys } from '../projects/project-model'
import { useCockpitState } from '../state/CockpitStateProvider'
import { useCockpitThreads } from '../chat/use-cockpit-threads'
import { openFleetChat } from '../chat/open-fleet-window'
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
  done: '已归档',
}

/** 原型四个项目色 —— 用项目 key 稳定 hash 取一个，不依赖服务端多给字段。 */
const ACCENTS = ['#35C7F0', '#8B7CF6', '#FFB020', '#3DDC97']

function accentOf(row: CockpitRow): string {
  const anchor = row.kind === 'job' ? rowProjectKeys(row)[0] ?? row.key : row.key
  let hash = 0
  for (let i = 0; i < anchor.length; i += 1) hash = (hash * 31 + anchor.charCodeAt(i)) | 0
  return ACCENTS[Math.abs(hash) % ACCENTS.length]
}

/** 类型字形（原型 KIND）；attention 行不进编队。 */
function glyphOf(row: CockpitRow): string {
  if (row.kind === 'task') return '◆'
  if (row.kind === 'delegation') return '≫'
  if (row.kind !== 'job') return '◆'
  const kind = row.job.kind
  return kind === 'workflow' ? '⬡' : kind === 'subagent' ? '◈' : '◆'
}

function rowRef(row: CockpitRow): CockpitRef | null {
  if (row.kind === 'job') return { kind: 'job', cabinId: row.cabinId, id: row.job.id }
  if (row.kind === 'task') return { kind: 'task', cabinId: row.cabinId, id: row.task.id }
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
  // 主线程 agent 在跑、执行还没开始：不显示 0% 的假进度条。
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
    return [project, `委派 ${delegation.handle ?? ''}`.trim()].filter(Boolean).join(' · ')
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

function statusTextOf(row: CockpitRow, status: FleetStatus): string {
  if (row.kind === 'job' && row.attention) return attentionStageLabel(row.attention)
  if (status === 'wait') return '等你答'
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

/** v22 #6（2026-11-23 用户）：作战中的活秒表 —— 每秒 +1，同流式卡的 ⏱ 读数。
 *  自带 interval，只有这一格文本重渲染，整条编队不跟着每秒重建。 */
function RunClock({ start }: { start: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [start])
  const label = formatRunClock(Math.max(0, now - start))
  return (
    <span
      className="ck12-fltime"
      data-testid="cockpit-rail-clock"
      title={`已作战 ${label} · 每秒走字 = 还活着`}
    >
      ⏱ {label}
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
  const doneCount = visible.filter((row) => fleetStatusOf(row) === 'done').length

  /** v22 #5：行体 / 💬 = 这条作战的独立 chat 窗；没有会话的行退回详情。 */
  const openChat = (row: CockpitRow) => {
    if (byKey.has(row.key)) { openFleetChat(wins, threadApi, row.key, chatWindow); return }
    const ref = rowRef(row)
    if (ref) select(ref)
  }
  /** ▦ = 作战详情（落在「运行」页签）；不改主通讯台。 */
  const openDetail = (row: CockpitRow) => {
    const ref = rowRef(row)
    if (ref) select(ref, 'run')
  }

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
        <span>归档 <b>{doneCount}</b></span>
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
          const status = fleetStatusOf(row)
          const pct = pctOf(row)
          const startedAt = status === 'run' ? startedAtOf(row) : null
          const accent = accentOf(row)
          const title = titleOf(row)
          const talkable = byKey.has(row.key)
          const chatOpen = wins.windows.some((win) => win.threadKey === row.key && !win.min)
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
              data-tone={status}
              title={talkable
                ? `${title} · ${statusTextOf(row, status)} · 点行进对话`
                : `${title} · ${statusTextOf(row, status)} · 点击看详情`}
              className={`ck12-flrow is-${status}${selected ? ' is-on' : ''}${
                chatOpen ? ' is-chat' : ''
              }${popped.has(row.key) ? ' is-pop' : ''}${flash.key === row.key ? ` is-arrived-${flash.nonce % 2}` : ''}`}
              style={{ ['--accent' as string]: accent, ['--p' as string]: String(pct ?? 0) }}
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
                  {pct !== null && status !== 'done' && (
                    <span className="ck12-flpct">{Math.round(pct)}%</span>
                  )}
                </span>
                <span className="ck12-flsub">
                  <span className={`ck12-flst is-${status}`}>{statusTextOf(row, status)}</span>
                  <span className="ck12-flsub-t">{subOf(row, status)}</span>
                  {startedAt !== null && <RunClock start={startedAt} />}
                </span>
                {pct !== null && status !== 'done' && (
                  <span className="ck12-flbar" aria-hidden="true">
                    <i style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
                  </span>
                )}
              </span>

              {showActs && (
                <span className="ck12-flacts">
                  {talkable && (
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
                      {unread > 0 && <i className="ck12-flact-und">{unread > 9 ? '9+' : unread}</i>}
                    </button>
                  )}
                  {ref && (
                    <button
                      type="button"
                      className="ck12-flact"
                      aria-label={`详情 ${title}`}
                      title="▦ 详情 · 作战详情（不动主通讯台）"
                      data-testid={`cockpit-rail-detail-${row.key}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        openDetail(row)
                      }}
                    >
                      ▦
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
