'use client'

// 左栏编队（cockpit-v12 .rail，300px / z-index:7；≤1120 变抽屉读 railOpen）。
// 数据只从 useCockpitFleet() 来（已经是入口舱单舱），不自己 fetch；行点击写
// CockpitState.select()。组内顺序严格沿用 sortRows 的结果（这里只做分桶，不重排）。
// 数字纪律：job 的 pct 只在真实拿到时画条；null 一律不画，不猜 45%。

import { useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { CabinAttentionItem, CabinJobKind } from '@octopus/shared'
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
import { projectNameFromKey, rowProjectKeys } from '../projects/project-model'
import { useCockpitState } from '../state/CockpitStateProvider'
import { useAskWindows } from '@/components/cabin/asks/ask-windows-provider'
import { askWindowTitle } from '@/components/cabin/asks/ask-window-model'

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

function rowRef(row: CockpitRow): CockpitRef | null {
  if (row.kind === 'job') return { kind: 'job', cabinId: row.cabinId, id: row.job.id }
  if (row.kind === 'task') return { kind: 'task', cabinId: row.cabinId, id: row.task.id }
  // 委派不是任务：点开是 doer 会话（证据面），不占用 cockpit 的 ref 命名空间。
  if (row.kind === 'delegation') return null
  return { kind: 'attention', cabinId: row.cabinId, id: row.item.id }
}

function optionId(row: CockpitRow): string {
  return `ck12-rail-opt-${row.key.replace(/[^a-zA-Z0-9_-]/g, '-')}`
}

function askOptionId(askId: string): string {
  return `ck12-rail-ask-${askId.replace(/[^a-zA-Z0-9_-]/g, '-')}`
}

/** 带决策票据的提问行：归「等你答」组，不再进 need 桶（避免同一条出现两次）。 */
function isAskRow(row: CockpitRow): boolean {
  return row.kind === 'attention' && row.item.stage === 'answer' && !!row.item.ask?.ask_id
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
  if (row.kind === 'delegation' && row.delegation.state === 'failed') return 'blocked'
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
  if (row.kind === 'delegation') return row.delegation.title
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
  if (row.kind === 'attention') return null
  // 主线程 agent 在跑、执行还没开始：不显示 0% 的假进度条（状态词已说明在推进）。
  if (row.kind === 'job' && row.job.agent_running && row.job.status !== 'running') return null
  return row.pct
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

export function CockpitFleetRail() {
  const { rows, counts, arrivals, loading, error, refetch } = useCockpitFleet()
  const { selection, select, railOpen, setRailOpen, layer, projectFilter, setProjectFilter } = useCockpitState()
  const askWindows = useAskWindows()
  const asks = askWindows.asks

  const [popped, setPopped] = useState<ReadonlySet<string>>(() => new Set())
  /** ↑↓ 落在「等你答」行时的键盘焦点（不是 selection —— 点提问不切面）。 */
  const [askActiveId, setAskActiveId] = useState<string | null>(null)
  const railRef = useRef<HTMLElement | null>(null)

  // 编队只含入口舱（2026-11-15）：不再有「全部 / 各舱」筛选胶囊。
  const visible = useMemo(() => {
    if (!projectFilter) return rows
    return rows.filter((row) => rowProjectKeys(row).includes(projectFilter))
  }, [rows, projectFilter])

  // 「等你答」行从编队分桶中挪出（组里只渲染一次；attention 仍是事实源）。
  const fleetRows = useMemo(() => visible.filter((row) => !isAskRow(row)), [visible])

  // 分桶只决定「放在哪个组标题下」，桶内顺序 = sortRows 的既有顺序。
  const grouped = useMemo(() => {
    const buckets: Record<CockpitRowGroup, CockpitRow[]> = { need: [], run: [], queue: [], done: [] }
    for (const row of fleetRows) buckets[groupOf(row)].push(row)
    return buckets
  }, [fleetRows])

  const activeRow = selection
    ? fleetRows.find((row) => {
      const ref = rowRef(row)
      return ref ? sameCockpitRef(selection, ref) : false
    })
    : undefined

  // 已经不在「等你答」里的 askId（答掉 / 切换舱）不保留键盘焦点。
  useEffect(() => {
    if (askActiveId && !asks.some((ask) => ask.askId === askActiveId)) setAskActiveId(null)
  }, [askActiveId, asks])

  const openAsk = (askId: string) => {
    setAskActiveId(askId)
    askWindows.open(askId)
  }

  /** 委派行没有 cockpit ref：点开它的 doer 会话（证据面）。 */
  const activate = (row: CockpitRow, ref: CockpitRef | null) => {
    if (ref) { select(ref); return }
    if (row.kind === 'delegation' && row.delegation.doer_session_id) {
      window.dispatchEvent(new CustomEvent('octopus:open-session', {
        detail: { sessionId: row.delegation.doer_session_id },
      }))
    }
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

  // ── ↑↓：在「等你答 + 编队行」的合并序列里移动。输入框聚焦时不接管 ──
  // 「等你答」行不在 selection 命名空间里（点它不切面），所以另起一个键盘焦点；
  // Enter 落在提问行上时开窗（design 26 §3.6）。
  const fleetRowsRef = useRef(fleetRows)
  fleetRowsRef.current = fleetRows
  const asksRef = useRef(asks)
  asksRef.current = asks
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  const askActiveRef = useRef(askActiveId)
  askActiveRef.current = askActiveId

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      if (event.altKey || event.metaKey || event.ctrlKey) return
      if (isEditableTarget(event.target)) return
      if (event.defaultPrevented) return

      const askList = asksRef.current
      const rowList = fleetRowsRef.current
      const total = askList.length + rowList.length
      if (total === 0) return

      const current = selectionRef.current
      const activeAsk = askActiveRef.current
      let index = -1
      if (activeAsk) {
        index = askList.findIndex((ask) => ask.askId === activeAsk)
      } else if (current) {
        const rowIndex = rowList.findIndex((row) => {
          const ref = rowRef(row)
          return ref ? sameCockpitRef(current, ref) : false
        })
        if (rowIndex >= 0) index = askList.length + rowIndex
      }

      event.preventDefault()
      const delta = event.key === 'ArrowDown' ? 1 : -1
      const nextIndex = index < 0
        ? (delta > 0 ? 0 : total - 1)
        : (index + delta + total) % total
      if (nextIndex < askList.length) {
        setAskActiveId(askList[nextIndex].askId)
        return
      }
      setAskActiveId(null)
      const row = rowList[nextIndex - askList.length]
      if (row) select(rowRef(row))
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
          <b className="m">{counts.need}</b> 等你 ·{' '}
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

      {projectFilter && (
        <div className="ck12-rail-pfilter" data-testid="cockpit-rail-project-filter">
          <span>只看 <b>{projectNameFromKey(projectFilter)}</b></span>
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
        className="ck12-rail-list"
        role="listbox"
        aria-label="编队作业"
        tabIndex={0}
        aria-activedescendant={
          askActiveId
            ? askOptionId(askActiveId)
            : activeRow ? optionId(activeRow) : undefined
        }
        onKeyDown={(event) => {
          // 行自己的 Enter 已在行上处理；这里只管「焦点在提问行」时的提交。
          if (event.key !== 'Enter' || event.target !== event.currentTarget) return
          if (!askActiveId) return
          event.preventDefault()
          openAsk(askActiveId)
        }}
      >
        {asks.length > 0 && (
          <div className="ck12-rail-group" role="group" aria-labelledby="ck12-rail-g-asks">
            <div className="ck12-rail-g" data-group="ask" id="ck12-rail-g-asks">
              <span>等你答</span>
              <b>{asks.length}</b>
              <span className="ck12-rail-ln" aria-hidden="true" />
            </div>
            {asks.map((ask) => {
              const active = askActiveId === ask.askId
              const question = ask.item.question ?? ask.env.decision ?? ''
              return (
                <div
                  key={ask.askId}
                  id={askOptionId(ask.askId)}
                  role="option"
                  aria-selected={active}
                  tabIndex={-1}
                  data-testid={`cockpit-rail-ask-${ask.askId}`}
                  data-tone="need"
                  title={`${askWindowTitle(ask.item)} · 等你答`}
                  className={`ck12-rail-row${active ? ' is-on' : ''}`}
                  onClick={() => openAsk(ask.askId)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      event.stopPropagation()
                      openAsk(ask.askId)
                    }
                  }}
                >
                  <span className="ck12-rail-glyph" data-stage="answer" aria-hidden="true">◉</span>
                  <span className="ck12-rail-main">
                    <span className="ck12-rail-title">
                      {ask.item.handle && <span className="ck12-rail-kind">{ask.item.handle}</span>}
                      <span className="ck12-rail-title-tx">{askWindowTitle(ask.item)}</span>
                    </span>
                    <span className="ck12-rail-meta">
                      <span className="ck12-rail-meta-tx">{question}</span>
                    </span>
                  </span>
                  <span className="ck12-rail-right">
                    <span className="ck12-rail-badge" data-stage="answer">
                      <i aria-hidden="true" />
                      回答
                    </span>
                  </span>
                </div>
              )
            })}
          </div>
        )}

        {!hasRows && asks.length === 0 ? (
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
        ) : fleetRows.length === 0 ? (
          asks.length > 0 ? null : <div className="ck12-rail-empty">这个舱没有作业</div>
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
                  const selected = ref ? sameCockpitRef(selection, ref) : false
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
                      onClick={() => activate(row, ref)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          activate(row, ref)
                        }
                      }}
                    >
                      <span
                        className="ck12-rail-glyph"
                        data-kind={row.kind === 'job' ? row.job.kind : row.kind === 'delegation' ? 'delegate' : undefined}
                        data-stage={row.kind === 'attention' ? row.item.stage : undefined}
                        aria-hidden="true"
                      >
                        {row.kind === 'job'
                          ? JOB_GLYPH[row.job.kind]
                          : row.kind === 'task'
                            ? JOB_GLYPH.task
                            : row.kind === 'delegation'
                              ? '≫'
                              : '◉'}
                      </span>

                      <span className="ck12-rail-main">
                        <span className="ck12-rail-title">
                          {row.kind === 'task' && <span className="ck12-rail-kind">任务</span>}
                          {row.kind === 'delegation' && (
                            <span className="ck12-rail-kind">{row.delegation.handle ?? 'D?'}</span>
                          )}
                          <span className="ck12-rail-title-tx">{title}</span>
                        </span>
                        <span className="ck12-rail-meta">
                          <i
                            className="ck12-rail-cabin-dot"
                            style={{ background: cabinTone(row.cabinId) }}
                            aria-hidden="true"
                          />
                          <span className="ck12-rail-meta-tx">
                            {rowProjectKeys(row).length > 0 && (
                              <span className="ck12-rail-proj">
                                {projectNameFromKey(rowProjectKeys(row)[0])}
                                {rowProjectKeys(row).length > 1 ? ` +${rowProjectKeys(row).length - 1}` : ''}
                                {' / '}
                              </span>
                            )}
                            {meta}
                          </span>
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
