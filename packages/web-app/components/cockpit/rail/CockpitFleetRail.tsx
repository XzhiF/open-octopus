'use client'

// 左栏编队（cockpit-v12 .rail，300px / z-index:7；≤1120 变抽屉读 railOpen）。
// 数据只从 useCockpitFleet() 来，不自己 fetch；行点击写 CockpitState.select()。
// 组内顺序严格沿用 sortRows 的结果（这里只做 cabin 筛选与分桶，不重排）。
// 数字纪律：job 的 pct 只在真实拿到时画条；null 一律不画，不猜 45%。

import { useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { CabinAttentionItem, CabinJobKind } from '@octopus/shared'
import { useCabinOptional } from '@/components/cabin/cabin-provider'
import { ATTENTION_AWAITING_META, ATTENTION_STAGE_META } from '@/components/cabin/cabin-meta'
import { useCockpitFleet } from '../fleet/CockpitFleetProvider'
import {
  groupOf,
  metaLine,
  statusLabel,
  type CockpitRow,
  type CockpitRowGroup,
} from '../fleet/fleet-model'
import { sameCockpitRef, type CockpitRef } from '../state/cockpit-state'
import { useCockpitState } from '../state/CockpitStateProvider'

const RAIL_LAYER_PRIORITY = 70
const POP_MS = 900

const GROUPS: ReadonlyArray<{ id: CockpitRowGroup; label: string }> = [
  { id: 'need', label: '需要你' },
  { id: 'run', label: '运行中' },
  { id: 'queue', label: '排队' },
  { id: 'done', label: '已完成' },
]

/** 类型字形（原型 JOB_KIND）；颜色由 rail.css 的 data-kind 决定。 */
const JOB_GLYPH: Record<CabinJobKind, string> = {
  task: '▣',
  workflow: '◈',
  subagent: '✦',
}

/** 舱色点：稳定 hash → 主题色，不依赖后端字段（跨舱只读展示）。 */
const CABIN_TONES = [
  'var(--ck-a)',
  'var(--ck-b)',
  'var(--ck-c)',
  'var(--pop-violet)',
  'var(--pop-cyan)',
]

function cabinTone(cabinId: string): string {
  let hash = 0
  for (let i = 0; i < cabinId.length; i += 1) {
    hash = (hash * 31 + cabinId.charCodeAt(i)) | 0
  }
  return CABIN_TONES[Math.abs(hash) % CABIN_TONES.length]
}

function rowRef(row: CockpitRow): CockpitRef {
  if (row.kind === 'job') return { kind: 'job', cabinId: row.cabinId, id: row.job.id }
  if (row.kind === 'task') return { kind: 'task', cabinId: row.cabinId, id: row.task.id }
  return { kind: 'attention', cabinId: row.cabinId, id: row.item.id }
}

function optionId(row: CockpitRow): string {
  return `ck12-rail-opt-${row.key.replace(/[^a-zA-Z0-9_-]/g, '-')}`
}

type RowTone = CockpitRowGroup | 'blocked'

function toneOf(row: CockpitRow): RowTone {
  const group = groupOf(row)
  if (row.kind === 'attention') {
    return row.item.stage === 'blocked' ? 'blocked' : group
  }
  if (row.kind === 'job' && (row.job.status === 'blocked' || row.job.status === 'failed')) {
    return 'blocked'
  }
  return group
}

/** 挂在 job 行上的 attention 小徽章：待验收 / 等你验收 / 受阻。 */
function attentionBadge(item: CabinAttentionItem): string {
  if (item.stage === 'blocked') return '受阻'
  return `等你${ATTENTION_STAGE_META[item.stage].label}`
}

function attentionStatus(item: CabinAttentionItem): string {
  return item.awaiting === 'person' ? '等你' : ATTENTION_AWAITING_META[item.awaiting].label
}

function rowTitle(row: CockpitRow): string {
  if (row.kind === 'job') return row.job.title
  if (row.kind === 'task') return row.task.name
  return row.item.title
}

/** attention-only 行：question 优先，其次仓库；舱名永远在末尾。 */
function rowMeta(row: CockpitRow): string {
  if (row.kind === 'attention') {
    return [row.item.question, row.cabinName].filter(Boolean).join(' · ')
  }
  return metaLine(row)
}

function rowStatus(row: CockpitRow): string {
  if (row.kind === 'attention') return attentionStatus(row.item)
  return statusLabel(row)
}

function rowPct(row: CockpitRow): number | null {
  return row.kind === 'attention' ? null : row.pct
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

interface CabinChip {
  id: string
  name: string
  count: number
}

export function CockpitFleetRail() {
  const { rows, counts, arrivals, loading, error, refetch } = useCockpitFleet()
  const { selection, select, railOpen, setRailOpen, layer } = useCockpitState()
  const cabinCtx = useCabinOptional()
  const entryCabinId = cabinCtx?.cabin?.id ?? null
  const entryCabinName = cabinCtx?.cabin?.name ?? null

  const [cabinFilter, setCabinFilter] = useState<string>('all')
  const [popped, setPopped] = useState<ReadonlySet<string>>(() => new Set())
  const railRef = useRef<HTMLElement | null>(null)

  // 舱筛选胶囊：全部 + 每舱计数。入口舱即使 0 行也保留（可切出「这个舱没有作业」）。
  const chips = useMemo<CabinChip[]>(() => {
    const map = new Map<string, CabinChip>()
    if (entryCabinId) {
      map.set(entryCabinId, { id: entryCabinId, name: entryCabinName ?? entryCabinId, count: 0 })
    }
    for (const row of rows) {
      const chip = map.get(row.cabinId)
      if (chip) chip.count += 1
      else map.set(row.cabinId, { id: row.cabinId, name: row.cabinName, count: 1 })
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  }, [rows, entryCabinId, entryCabinName])

  // 筛选舱从编队消失 → 回到「全部」；渲染侧先用 activeFilter 兜住，避免闪一帧空态。
  const activeFilter =
    cabinFilter !== 'all' && chips.some((chip) => chip.id === cabinFilter) ? cabinFilter : 'all'

  useEffect(() => {
    if (cabinFilter !== activeFilter) setCabinFilter(activeFilter)
  }, [cabinFilter, activeFilter])

  const visible = useMemo(
    () => (activeFilter === 'all' ? rows : rows.filter((row) => row.cabinId === activeFilter)),
    [rows, activeFilter],
  )

  // 分桶只决定「放在哪个组标题下」，桶内顺序 = sortRows 的既有顺序。
  const grouped = useMemo(() => {
    const buckets: Record<CockpitRowGroup, CockpitRow[]> = { need: [], run: [], queue: [], done: [] }
    for (const row of visible) buckets[groupOf(row)].push(row)
    return buckets
  }, [visible])

  const activeRow = selection
    ? visible.find((row) => sameCockpitRef(selection, rowRef(row)))
    : undefined

  // ── 新行 pop：arrivals 命中的 attention + 首次出现的 key，900ms 后收 ──
  const seenKeysRef = useRef<Set<string> | null>(null)
  const popTimerRef = useRef<number | null>(null)

  useEffect(() => {
    const seen = seenKeysRef.current
    seenKeysRef.current = new Set(rows.map((row) => row.key))

    const fresh = seen ? rows.filter((row) => !seen.has(row.key)).map((row) => row.key) : []
    const arrived = new Set(arrivals)
    const hit = rows
      .filter((row) => {
        if (row.kind === 'attention') return arrived.has(row.item.id)
        if (row.kind === 'job' && row.attention) return arrived.has(row.attention.id)
        return false
      })
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

  // ── 抽屉：点外部收（HUD 的 ☰ 留给它自己的 toggle） ──
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

  // ── Esc 只走 CockpitLayerStack（plans §1.4：编队抽屉 priority 70） ──
  useEffect(() => {
    if (!railOpen) return
    return layer.register('cockpit-fleet-rail', RAIL_LAYER_PRIORITY, () => setRailOpen(false))
  }, [railOpen, layer, setRailOpen])

  // ── ↑↓：在当前可见（筛选后）行内移动并 select。输入框聚焦时不接管 ──
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const selectionRef = useRef(selection)
  selectionRef.current = selection

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      if (event.altKey || event.metaKey || event.ctrlKey) return
      if (isEditableTarget(event.target)) return
      if (event.defaultPrevented) return

      const list = visibleRef.current
      if (list.length === 0) return

      event.preventDefault()
      const current = selectionRef.current
      const index = current ? list.findIndex((row) => sameCockpitRef(current, rowRef(row))) : -1
      const delta = event.key === 'ArrowDown' ? 1 : -1
      const nextIndex =
        index < 0
          ? delta > 0
            ? 0
            : list.length - 1
          : (index + delta + list.length) % list.length
      const next = list[nextIndex]
      if (next) select(rowRef(next))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [select])

  const hasRows = rows.length > 0

  return (
    <aside
      ref={railRef}
      id="ck12-fleet-rail"
      className={`ck12-rail${railOpen ? ' is-open' : ''}`}
      data-testid="cockpit-fleet-rail"
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
        <span className="ck12-rail-h-label">编队</span>
        <span className="ck12-rail-en">FLEET</span>
        <span className="ck12-rail-ln" aria-hidden="true" />
        <b className="ck12-rail-count">{visible.length}</b>
      </div>

      {counts && (
        <div className="ck12-rail-sub">
          {chips.length} 个舱 · <b className="m">{counts.need}</b> 等你 ·{' '}
          <b className="c">{counts.run}</b> 运行 · <b className="g">{counts.done}</b> 完成
        </div>
      )}

      {/* 有数据但本轮刷新失败：保留上一份编队，明确标 stale，不悄悄假装最新。 */}
      {error && hasRows && (
        <div className="ck12-rail-stale" title={error} data-testid="cockpit-rail-stale">
          刷新失败 · 显示上一份编队
          <button type="button" className="ck12-rail-retry" onClick={refetch}>重试</button>
        </div>
      )}

      <div className="ck12-rail-filter" role="toolbar" aria-label="按舱筛选">
        <button
          type="button"
          className={`ck12-rail-chip${activeFilter === 'all' ? ' is-on' : ''}`}
          aria-pressed={activeFilter === 'all'}
          onClick={() => setCabinFilter('all')}
        >
          全部 <b>{rows.length}</b>
        </button>
        {chips.map((chip) => (
          <button
            key={chip.id}
            type="button"
            className={`ck12-rail-chip${activeFilter === chip.id ? ' is-on' : ''}`}
            aria-pressed={activeFilter === chip.id}
            title={`${chip.name} · ${chip.count}`}
            onClick={() => setCabinFilter(chip.id)}
          >
            <i style={{ background: cabinTone(chip.id) }} aria-hidden="true" />
            {chip.name} <b>{chip.count}</b>
          </button>
        ))}
      </div>

      <div
        className="ck12-rail-list"
        role="listbox"
        aria-label="编队作业"
        tabIndex={0}
        aria-activedescendant={activeRow ? optionId(activeRow) : undefined}
      >
        {!hasRows ? (
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
        ) : visible.length === 0 ? (
          <div className="ck12-rail-empty">这个舱没有作业</div>
        ) : (
          GROUPS.map((group) => {
            const groupRows = grouped[group.id]
            if (groupRows.length === 0) return null
            const headingId = `ck12-rail-g-${group.id}`
            return (
              <div
                key={group.id}
                className="ck12-rail-group"
                role="group"
                aria-labelledby={headingId}
              >
                <div className="ck12-rail-g" data-group={group.id} id={headingId}>
                  <span>{group.label}</span>
                  <b>{groupRows.length}</b>
                  <span className="ck12-rail-ln" aria-hidden="true" />
                </div>
                {groupRows.map((row) => {
                  const ref = rowRef(row)
                  const selected = sameCockpitRef(selection, ref)
                  const pct = rowPct(row)
                  const status = rowStatus(row)
                  const title = rowTitle(row)
                  const meta = rowMeta(row)
                  const badge =
                    group.id === 'need' && row.kind === 'job' && row.attention
                      ? row.attention
                      : null
                  return (
                    <div
                      key={row.key}
                      id={optionId(row)}
                      role="option"
                      aria-selected={selected}
                      tabIndex={-1}
                      data-testid={`cockpit-rail-row-${row.key}`}
                      data-tone={toneOf(row)}
                      title={`${title} · ${status}`}
                      className={`ck12-rail-row${selected ? ' is-on' : ''}${
                        popped.has(row.key) ? ' is-pop' : ''
                      }`}
                      onClick={() => select(ref)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          select(ref)
                        }
                      }}
                    >
                      <span
                        className="ck12-rail-glyph"
                        data-kind={row.kind === 'job' ? row.job.kind : undefined}
                        data-stage={row.kind === 'attention' ? row.item.stage : undefined}
                        aria-hidden="true"
                      >
                        {row.kind === 'job'
                          ? JOB_GLYPH[row.job.kind]
                          : row.kind === 'task'
                            ? JOB_GLYPH.task
                            : '◉'}
                      </span>

                      <span className="ck12-rail-main">
                        <span className="ck12-rail-title">
                          {row.kind === 'task' && <span className="ck12-rail-kind">任务</span>}
                          <span className="ck12-rail-title-tx">{title}</span>
                        </span>
                        <span className="ck12-rail-meta">
                          <i
                            className="ck12-rail-cabin-dot"
                            style={{ background: cabinTone(row.cabinId) }}
                            aria-hidden="true"
                          />
                          <span className="ck12-rail-meta-tx">{meta}</span>
                        </span>
                      </span>

                      <span className="ck12-rail-right">
                        {badge && (
                          <span className="ck12-rail-badge" data-stage={badge.stage}>
                            <i aria-hidden="true" />
                            {attentionBadge(badge)}
                          </span>
                        )}
                        <span className="ck12-rail-facts">
                          <span className="ck12-rail-status">{status}</span>
                          {pct !== null && <span className="ck12-rail-pct">{pct}%</span>}
                        </span>
                        {pct !== null && (
                          <span className="ck12-rail-bar" aria-hidden="true">
                            <i style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
                          </span>
                        )}
                      </span>
                    </div>
                  )
                })}
              </div>
            )
          })
        )}
      </div>

      <div className="ck12-rail-foot">↑↓ 换一条 · 点击打开</div>
    </aside>
  )
}
