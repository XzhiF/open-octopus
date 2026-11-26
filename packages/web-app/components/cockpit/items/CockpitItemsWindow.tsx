'use client'

// 事项窗（2026-11-24 用户）—— 舱内零散小待办。
//
//   · 入口 = HUD「☑ 事项」；壳 = 目录窗 / 便签窗同一套（.ck12-treewin）：
//     ✕ 左置、玻璃底、顶部渐变发丝线、标题栏可拖、双击 / ⛶ 全屏，Esc 走层栈。
//   · 左 = 未决 / 记录 / 全部（行首勾选 = 多选投递；行首 ✓ 对已关闭项静态）；
//     右 = 编辑（标题 / 类型 / 正文 / 流转时间 + 完成 · 搁置 · 删除 / 重开）。
//   · 底 = 已选 N 条 + 投递两档（带到输入框 / 投递给主对话）。
//   · 数据在服务端 cabin_items（items-store 做读缓存 + 乐观写）；删除 5s 可撤销。
//   · 投递逻辑在 useItemDelivery：主对话在跑 → 排队条；空闲 → 直接进主对话。

import {
  useCallback, useEffect, useMemo, useRef, useState,
  type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent,
} from 'react'
import { toast } from 'sonner'
import type { CabinItemDTO, CabinItemKind, CabinItemStatus } from '@octopus/shared'
import { cabinAudio } from '@/lib/cabin-audio'
import { useCockpitState } from '../state/CockpitStateProvider'
import { CockpitFaceHead } from '../face/CockpitFaceHead'
import { DossierWindowContext, type DossierWindowApi } from '../face/dossier-window'
import {
  applyItemLocal, closeItemsRemote, commitItem, createItem, deleteItemRemote,
  hideItemLocal, isItemOpen, itemLabel, reopenItemRemote, restoreItemLocal,
  setCabinItemsOpen, useCabinItems, useCabinItemsOpen,
} from './items-store'
import { useItemDelivery } from './use-item-delivery'

const ITEMS_LAYER_ID = 'cockpit-items-window'
/** 与便签 / 知识中心同档：Esc 先收最上的一扇窗，再收作业面。 */
const ITEMS_LAYER_PRIORITY = 67

const UNDO_MS = 5000
const COMMIT_DELAY = 600

const KINDS: CabinItemKind[] = ['optimize', 'fix', 'idea']
const KIND_LABEL: Record<CabinItemKind, string> = { optimize: '优化', fix: '修复', idea: '想法' }
const STATUS_LABEL: Record<CabinItemStatus, string> = {
  todo: '未决',
  delivered: '交付中',
  done: '已完成',
  dropped: '已搁置',
}
type Tab = 'open' | 'record' | 'all'

interface ItemsGeo {
  x: number
  y: number
  w: number
  h: number
}
/** 与便签窗同口径：会话内记住几何。 */
let savedGeo: ItemsGeo | null = null
let savedMax = false

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value))
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function fmtStamp(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

function itemTitle(item: CabinItemDTO): string {
  return item.title.trim() || '（未命名事项）'
}

export function CockpitItemsWindow() {
  const { entryCabinId, layer, chat } = useCockpitState()
  const open = useCabinItemsOpen()
  const { items, loading, error } = useCabinItems(entryCabinId)
  const { deliver, stage } = useItemDelivery(entryCabinId)

  const [activeId, setActiveId] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('open')
  const [query, setQuery] = useState('')
  const [picks, setPicks] = useState<string[]>([])
  const [draft, setDraft] = useState<{ id: string; title: string; body: string } | null>(null)
  const [pending, setPending] = useState<{ item: CabinItemDTO; index: number } | null>(null)
  const [saving, setSaving] = useState<'done' | 'dropped' | null>(null)

  const [geo, setGeo] = useState<ItemsGeo | null>(savedGeo)
  const [maxed, setMaxed] = useState(savedMax)
  const [viewport, setViewport] = useState(() => ({
    w: typeof window === 'undefined' ? 1600 : window.innerWidth,
    h: typeof window === 'undefined' ? 900 : window.innerHeight,
  }))

  const winRef = useRef<HTMLDivElement | null>(null)
  const titleRef = useRef<HTMLInputElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const draftRef = useRef(draft)
  const activeIdRef = useRef<string | null>(null)
  const commitTimerRef = useRef<number | null>(null)
  const pendingRef = useRef<{ item: CabinItemDTO; index: number; timer: number } | null>(null)
  const dragCleanupRef = useRef<(() => void) | null>(null)
  const wasOpenRef = useRef(false)

  useEffect(() => { draftRef.current = draft }, [draft])

  const openCount = useMemo(() => items.filter(isItemOpen).length, [items])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items
      .filter((item) => {
        if (q && !`${item.title} ${item.body}`.toLowerCase().includes(q)) return false
        if (tab === 'open') return isItemOpen(item)
        if (tab === 'record') return !isItemOpen(item)
        return true
      })
      .sort((a, b) =>
        (isItemOpen(a) ? 0 : 1) - (isItemOpen(b) ? 0 : 1)
        || b.created_at.localeCompare(a.created_at))
  }, [items, query, tab])

  const active = useMemo(
    () => items.find((item) => item.id === activeId) ?? null,
    [items, activeId],
  )

  const picked = useMemo(
    () => picks.map((id) => items.find((item) => item.id === id)).filter((item): item is CabinItemDTO => isItemOpen(item)),
    [picks, items],
  )

  const chatReady = !!chat
  const busy = chat?.streaming ?? false

  // ── 关闭时腾空未写的编辑 / 未落的删除 ──────────────────────────────────
  const flushCommit = useCallback(() => {
    if (commitTimerRef.current !== null) {
      window.clearTimeout(commitTimerRef.current)
      commitTimerRef.current = null
    }
    const d = draftRef.current
    if (!d) return
    void commitItem(entryCabinId, d.id, { title: d.title, body: d.body })
  }, [entryCabinId])

  const scheduleCommit = useCallback(() => {
    if (commitTimerRef.current !== null) window.clearTimeout(commitTimerRef.current)
    commitTimerRef.current = window.setTimeout(() => {
      commitTimerRef.current = null
      const d = draftRef.current
      if (d) void commitItem(entryCabinId, d.id, { title: d.title, body: d.body })
    }, COMMIT_DELAY)
  }, [entryCabinId])

  const flushPendingDelete = useCallback(() => {
    const p = pendingRef.current
    if (!p) return
    window.clearTimeout(p.timer)
    pendingRef.current = null
    setPending(null)
    void deleteItemRemote(entryCabinId, p.item.id).catch((err: unknown) => {
      toast.error(`删除失败：${err instanceof Error ? err.message : String(err)}`)
    })
  }, [entryCabinId])

  const close = useCallback(() => {
    flushCommit()
    flushPendingDelete()
    setCabinItemsOpen(false)
    cabinAudio.blip(520, 0.04)
  }, [flushCommit, flushPendingDelete])

  // 关窗（含卸载）：落盘编辑、落实删除。
  useEffect(() => {
    const wasOpen = wasOpenRef.current
    wasOpenRef.current = open
    if (!open && wasOpen) {
      flushCommit()
      flushPendingDelete()
    }
  }, [open, flushCommit, flushPendingDelete])

  useEffect(() => () => {
    if (commitTimerRef.current !== null) window.clearTimeout(commitTimerRef.current)
    dragCleanupRef.current?.()
  }, [])

  // ── Esc：与便签 / 知识中心同档 ─────────────────────────────────────────
  useEffect(() => {
    if (!open) return
    return layer.register(ITEMS_LAYER_ID, ITEMS_LAYER_PRIORITY, close)
  }, [open, layer, close])

  // ── 选中项跟随页签 / 列表 ─────────────────────────────────────────────
  useEffect(() => {
    if (!open) return
    const visibleId = activeId && filtered.some((item) => item.id === activeId)
      ? activeId
      : filtered[0]?.id ?? null
    if (visibleId === activeIdRef.current) return
    flushCommit()
    activeIdRef.current = visibleId
    if (visibleId !== activeId) setActiveId(visibleId)
    const item = items.find((x) => x.id === visibleId) ?? null
    setDraft(item ? { id: item.id, title: item.title, body: item.body } : null)
  }, [open, activeId, filtered, items, flushCommit])

  useEffect(() => {
    if (!open) return
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [open])

  // ── 新建 / 编辑 ────────────────────────────────────────────────────────
  const create = useCallback(async () => {
    flushCommit()
    try {
      const item = await createItem(entryCabinId, { title: '', body: '', kind: 'optimize' })
      setTab('open')
      setQuery('')
      setActiveId(item.id)
      cabinAudio.blip(700, 0.04)
      window.requestAnimationFrame(() => titleRef.current?.focus())
    } catch (err) {
      toast.error(`新建事项失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }, [entryCabinId, flushCommit])

  const select = useCallback((id: string) => {
    if (id === activeIdRef.current) return
    flushCommit()
    activeIdRef.current = id
    setActiveId(id)
    const item = items.find((x) => x.id === id)
    setDraft(item ? { id: item.id, title: item.title, body: item.body } : null)
    cabinAudio.blip(660, 0.03)
  }, [flushCommit, items])

  const onTitle = useCallback((value: string) => {
    const d = draftRef.current
    if (!d) return
    const next = { ...d, title: value }
    draftRef.current = next
    setDraft(next)
    applyItemLocal(entryCabinId, d.id, { title: value })
    scheduleCommit()
  }, [entryCabinId, scheduleCommit])

  const onBody = useCallback((value: string) => {
    const d = draftRef.current
    if (!d) return
    const next = { ...d, body: value }
    draftRef.current = next
    setDraft(next)
    applyItemLocal(entryCabinId, d.id, { body: value })
    scheduleCommit()
  }, [entryCabinId, scheduleCommit])

  const onKind = useCallback((kind: CabinItemKind) => {
    const d = draftRef.current
    if (!d) return
    applyItemLocal(entryCabinId, d.id, { kind })
    void commitItem(entryCabinId, d.id, { kind })
    cabinAudio.blip(640, 0.03)
  }, [entryCabinId])

  // ── 删除（5s 撤销）/ 关项 / 重开 ───────────────────────────────────────
  const remove = useCallback((id: string) => {
    flushCommit()
    flushPendingDelete()
    const hidden = hideItemLocal(entryCabinId, id)
    if (!hidden) return
    const timer = window.setTimeout(() => {
      pendingRef.current = null
      setPending(null)
      void deleteItemRemote(entryCabinId, hidden.item.id).catch((err: unknown) => {
        toast.error(`删除失败：${err instanceof Error ? err.message : String(err)}`)
      })
    }, UNDO_MS)
    pendingRef.current = { item: hidden.item, index: hidden.index, timer }
    setPending({ item: hidden.item, index: hidden.index })
    setPicks((prev) => prev.filter((x) => x !== id))
    cabinAudio.blip(520, 0.04)
  }, [entryCabinId, flushCommit, flushPendingDelete])

  const undoDelete = useCallback(() => {
    const p = pendingRef.current
    if (!p) return
    window.clearTimeout(p.timer)
    pendingRef.current = null
    setPending(null)
    restoreItemLocal(entryCabinId, p.item, p.index)
    activeIdRef.current = p.item.id
    setActiveId(p.item.id)
    setDraft({ id: p.item.id, title: p.item.title, body: p.item.body })
    cabinAudio.blip(780, 0.05)
  }, [entryCabinId])

  const closeItem = useCallback(async (outcome: 'done' | 'dropped') => {
    const d = draftRef.current
    if (!d || saving) return
    flushCommit()
    setSaving(outcome)
    try {
      await closeItemsRemote(entryCabinId, [d.id], outcome)
      cabinAudio.blip(outcome === 'done' ? 780 : 520, 0.05)
      toast(outcome === 'done' ? '已勾掉 · 记录已留' : '已搁置 · 记录已留')
    } catch (err) {
      toast.error(`关项失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(null)
    }
  }, [entryCabinId, flushCommit, saving])

  const reopen = useCallback(async () => {
    const d = draftRef.current
    if (!d) return
    const item = await reopenItemRemote(entryCabinId, d.id)
    if (!item) {
      toast.error('重新打开失败')
      return
    }
    setTab('open')
    cabinAudio.blip(660, 0.03)
  }, [entryCabinId])

  // ── 投递 ───────────────────────────────────────────────────────────────
  const deliverList = useCallback((list: CabinItemDTO[]) => {
    // 先落盘最新正文：服务端兜底按 cabin_items 真源比对，不能让 600ms 防抖
    // 把刚写的正文挡在投递之后（2026-11-26 用户事故）。
    flushCommit()
    const result = deliver(list)
    if (!result.ok) {
      toast.error(result.reason === 'no-chat' ? '主对话未就绪 · 先完成舱初始化' : '没有可投递的事项')
      return
    }
    setPicks([])
    setCabinItemsOpen(false)
    if (result.queued) toast(`主对话在跑 · 已排队（第 ${result.position} 位）`)
    else toast(`已投递 ${list.length} 条 · 收到回执后确认关项`)
  }, [deliver, flushCommit])

  const stageList = useCallback((list: CabinItemDTO[]) => {
    flushCommit()
    if (!stage(list)) {
      toast.error('主对话未就绪 · 先完成舱初始化')
      return
    }
    setPicks([])
    setCabinItemsOpen(false)
    toast('已带到输入框 · 发出去才算交付')
  }, [stage, flushCommit])

  const togglePick = useCallback((id: string) => {
    const item = items.find((x) => x.id === id)
    if (!isItemOpen(item)) return
    setPicks((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
    cabinAudio.blip(680, 0.03)
  }, [items])

  const switchTab = useCallback((next: Tab) => {
    flushCommit()
    setTab(next)
    cabinAudio.blip(660, 0.03)
  }, [flushCommit])

  // ── 窗口化 ─────────────────────────────────────────────────────────────
  const toggleMax = useCallback(() => {
    if (!maxed) {
      const el = winRef.current
      if (el) {
        const r = el.getBoundingClientRect()
        const snapshot = {
          x: Math.round(r.left), y: Math.round(r.top),
          w: Math.round(r.width), h: Math.round(r.height),
        }
        savedGeo = snapshot
        setGeo(snapshot)
      }
      savedMax = true
      setMaxed(true)
    } else {
      savedMax = false
      setMaxed(false)
    }
    cabinAudio.blip(660, 0.03)
  }, [maxed])

  const startDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (maxed) return
    const target = event.target as HTMLElement
    if (target.closest('button, textarea, input, select, a, [data-no-drag]')) return
    if (!target.closest('.ck12-jh')) return
    const el = winRef.current
    if (!el) return
    event.preventDefault()
    const r = el.getBoundingClientRect()
    const start = { x: r.left, y: r.top, w: r.width, h: r.height }
    const sx = event.clientX
    const sy = event.clientY
    const move = (ev: PointerEvent) => {
      const next = {
        x: clamp(start.x + ev.clientX - sx, 4, Math.max(4, window.innerWidth - start.w - 4)),
        y: clamp(start.y + ev.clientY - sy, 52, Math.max(52, window.innerHeight - start.h - 4)),
        w: start.w,
        h: start.h,
      }
      savedGeo = next
      setGeo(next)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      dragCleanupRef.current = null
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    dragCleanupRef.current = up
  }, [maxed])

  const onHeaderDoubleClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (target.closest('button, textarea, input, select, a')) return
    if (!target.closest('.ck12-jh')) return
    toggleMax()
  }, [toggleMax])

  const winApi = useMemo<DossierWindowApi>(
    () => ({ maximized: maxed, toggleMax }),
    [maxed, toggleMax],
  )

  if (!open) return null

  const panelStyle: CSSProperties | undefined = maxed
    ? {
      left: 5,
      top: 52,
      width: Math.max(420, viewport.w - 10),
      height: Math.max(300, viewport.h - 58),
      transform: 'none',
    }
    : geo
      ? { left: geo.x, top: geo.y, width: geo.w, height: geo.h, transform: 'none' }
      : undefined

  const recordCount = items.length - openCount
  const canDeliverPicked = picked.length > 0 && chatReady

  return (
    <div
      ref={winRef}
      className={`ck12-treewin ck12-itemswin${maxed || geo ? ' is-geo' : ''}`}
      style={panelStyle}
      role="dialog"
      aria-label="事项 · 舱内小待办"
      data-testid="cockpit-itemswin"
      data-maximized={maxed ? '1' : undefined}
      onPointerDownCapture={startDrag}
      onDoubleClick={onHeaderDoubleClick}
    >
      <DossierWindowContext.Provider value={winApi}>
        <CockpitFaceHead
          testId="cockpit-itemswin-head"
          closeTestId="cockpit-items-close"
          glyph="☑"
          title="事项 · 舱内小待办"
          sub="ITEMS · 随手记 · 投递给主对话 · 完成回执留记录"
          onClose={close}
          closeLabel="关闭事项"
        />
      </DossierWindowContext.Provider>

      <div className="ck12-itemswin-b">
        <div className="ck12-itw">
          <aside className="ck12-it-side">
            <div className="ck12-it-search">
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索事项"
                aria-label="搜索事项"
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                className="ck12-it-new"
                title="新建事项"
                aria-label="新建事项"
                data-testid="cockpit-item-new"
                onClick={() => void create()}
              >
                ＋
              </button>
            </div>

            <div className="ck12-it-tabs" role="tablist" aria-label="事项页签">
              {([
                ['open', '未决', openCount],
                ['record', '记录', recordCount],
                ['all', '全部', items.length],
              ] as Array<[Tab, string, number]>).map(([key, label, count]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={tab === key}
                  className={`ck12-it-tab${tab === key ? ' on' : ''}`}
                  data-testid={`cockpit-items-tab-${key}`}
                  onClick={() => switchTab(key)}
                >
                  {label} <b>{count}</b>
                </button>
              ))}
            </div>

            <div className="ck12-it-list" role="listbox" aria-label="事项列表">
              {filtered.length === 0 ? (
                <div className="ck12-it-empty sm">
                  <span className="big" aria-hidden="true">{loading ? '◌' : '⌕'}</span>
                  <b>{loading ? '载入事项…' : error ? '读取失败' : query ? '没有匹配的事项' : tab === 'record' ? '还没有记录' : '这里是空的'}</b>
                  {error && <span>{error}</span>}
                </div>
              ) : filtered.map((item) => {
                const on = item.id === activeId
                const pickedOn = picks.includes(item.id)
                return (
                  <div
                    key={item.id}
                    className={`ck12-it-row${on ? ' on' : ''}${pickedOn ? ' picked' : ''}${isItemOpen(item) ? '' : ' closed'}`}
                    role="option"
                    aria-selected={on}
                    tabIndex={0}
                    data-testid={`cockpit-item-row-${item.id}`}
                    onClick={() => select(item.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        select(item.id)
                      }
                    }}
                  >
                    {isItemOpen(item) ? (
                      <button
                        type="button"
                        className={`ck12-it-ck${pickedOn ? ' on' : ''}`}
                        title="选中投递"
                        aria-label="选中投递"
                        aria-pressed={pickedOn}
                        onClick={(event) => {
                          event.stopPropagation()
                          togglePick(item.id)
                        }}
                      >
                        ✓
                      </button>
                    ) : (
                      <span className="ck12-it-ck off" title="已关闭 · 不可投递" aria-hidden="true">✓</span>
                    )}
                    <span className="ck12-it-id">{itemLabel(item)}</span>
                    <span className="ck12-it-tt">{itemTitle(item)}</span>
                    <span className={`ck12-it-kd k-${item.kind}`}>{KIND_LABEL[item.kind]}</span>
                    <span className={`ck12-it-st s-${item.status}`}>{STATUS_LABEL[item.status]}</span>
                  </div>
                )
              })}
            </div>
          </aside>

          <section className="ck12-it-main">
            {active && draft && draft.id === active.id ? (
              <>
                <div className="ck12-it-head">
                  <input
                    ref={titleRef}
                    className="ck12-it-title"
                    value={draft.title}
                    onChange={(event) => onTitle(event.target.value)}
                    placeholder="一句话说清这条事项"
                    aria-label="事项标题"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <span className="ck12-it-no">{itemLabel(active)}</span>
                </div>
                <div className="ck12-it-kindrow">
                  <span className="kl">类型</span>
                  {KINDS.map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      className={`ck12-it-kb${active.kind === kind ? ' on' : ''}`}
                      aria-pressed={active.kind === kind}
                      onClick={() => onKind(kind)}
                    >
                      {KIND_LABEL[kind]}
                    </button>
                  ))}
                  <span className="sp" />
                  <span className={`ck12-it-state s-${active.status}`}>{STATUS_LABEL[active.status]}</span>
                </div>
                <textarea
                  className="ck12-it-body"
                  value={draft.body}
                  onChange={(event) => onBody(event.target.value)}
                  placeholder={'补充上下文：复现步骤 / 期望行为 / 约束…'}
                  aria-label="事项正文"
                  spellCheck={false}
                />
                <div className="ck12-it-meta">
                  <span>创建 {fmtStamp(active.created_at)}</span>
                  {active.delivered_at && <span className="dl">交付 {fmtStamp(active.delivered_at)} · 主对话</span>}
                  {active.closed_at && (
                    <span className={active.status === 'done' ? 'ok' : 'no'}>
                      关闭 {fmtStamp(active.closed_at)} · {STATUS_LABEL[active.status]}
                    </span>
                  )}
                </div>
                <div className="ck12-it-acts">
                  {isItemOpen(active) ? (
                    <>
                      <button
                        type="button"
                        className="ck12-it-act primary"
                        disabled={active.status === 'delivered' || !chatReady}
                        title={active.status === 'delivered' ? '已交付，等回执' : !chatReady ? '主对话未就绪' : '投递给主对话'}
                        data-testid="cockpit-item-deliver"
                        onClick={() => deliverList([active])}
                      >
                        投递给主对话
                      </button>
                      <button
                        type="button"
                        className="ck12-it-act"
                        disabled={active.status === 'delivered' || !chatReady}
                        data-testid="cockpit-item-stage"
                        onClick={() => stageList([active])}
                      >
                        带到输入框
                      </button>
                      <button
                        type="button"
                        className="ck12-it-act ok"
                        disabled={saving !== null}
                        data-testid="cockpit-item-done"
                        onClick={() => void closeItem('done')}
                      >
                        ✓ 完成
                      </button>
                      <button
                        type="button"
                        className="ck12-it-act"
                        disabled={saving !== null}
                        data-testid="cockpit-item-drop"
                        onClick={() => void closeItem('dropped')}
                      >
                        搁置
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="ck12-it-act"
                      data-testid="cockpit-item-reopen"
                      onClick={() => void reopen()}
                    >
                      重新打开
                    </button>
                  )}
                  <span className="sp" />
                  <button
                    type="button"
                    className="ck12-it-act danger"
                    data-testid="cockpit-item-delete"
                    onClick={() => remove(active.id)}
                  >
                    删除
                  </button>
                </div>
              </>
            ) : (
              <div className="ck12-it-empty">
                <span className="big" aria-hidden="true">☑</span>
                <b>还没有选中事项</b>
                <span>左边点一条，或者新建一条小待办。</span>
              </div>
            )}
          </section>
        </div>

        <div className="ck12-it-foot">
          <span className="sel" data-testid="cockpit-items-picked">已选 <b>{picked.length}</b> 条</span>
          <span className="q">主对话 · {chatReady ? (busy ? '正在跑 · 投递将排队' : '空闲') : '未就绪'}</span>
          <span className="sp" />
          <button
            type="button"
            className="ck12-it-btn"
            disabled={!canDeliverPicked}
            data-testid="cockpit-items-stage-picked"
            onClick={() => stageList(picked)}
          >
            带到输入框
          </button>
          <button
            type="button"
            className="ck12-it-btn primary"
            disabled={!canDeliverPicked}
            data-testid="cockpit-items-deliver-picked"
            onClick={() => deliverList(picked)}
          >
            投递给主对话 →
          </button>
        </div>

        {pending && (
          <div className="ck12-it-undo" role="status">
            已删除「{itemTitle(pending.item)}」
            <button type="button" onClick={undoDelete}>撤销</button>
          </div>
        )}
      </div>
    </div>
  )
}
