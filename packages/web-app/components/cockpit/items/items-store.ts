'use client'

// 舱内事项（2026-11-24 用户）—— 极小的外部 store。
//
// 为什么不是 useState + useCabin：事项同时被 4 个地方读（HUD 徽标 / 事项窗 /
// 主对话回执卡 / 投递排队条），拆成各自的 fetch 会各看各的。这里按 cabinId
// 收敛成一份缓存：写操作先本地成账，再回服务端对齐；30s TTL + in-flight 去重。
//
// 数据真源仍是服务端 cabin_items 表；本 store 只做读缓存与乐观更新。

import { useCallback, useEffect, useSyncExternalStore } from 'react'
import {
  cabinItemLabel, formatCabinItemDeliveryText, type CabinItemDTO,
} from '@octopus/shared'
import {
  closeCabinItems, createCabinItem, deleteCabinItem, fetchCabinItems,
  reopenCabinItem, updateCabinItem, type CabinItemInput,
} from '@/lib/cabin-api'

const TTL_MS = 30_000

export interface CabinItemsState {
  items: CabinItemDTO[]
  /** 未决条数（todo + delivered）。 */
  open: number
  loading: boolean
  /** 非 null = 上次拉取失败；items 保留上一份（stale）。 */
  error: string | null
  loaded: boolean
  at: number
}

const EMPTY: CabinItemsState = { items: [], open: 0, loading: false, error: null, loaded: false, at: 0 }

const states = new Map<string, CabinItemsState>()
const listeners = new Map<string, Set<() => void>>()
const inflight = new Map<string, Promise<void>>()

export function isItemOpen(item: CabinItemDTO | null | undefined): boolean {
  return !!item && (item.status === 'todo' || item.status === 'delivered')
}

function openCount(items: CabinItemDTO[]): number {
  return items.filter(isItemOpen).length
}

function emit(cabinId: string): void {
  for (const listener of [...(listeners.get(cabinId) ?? [])]) listener()
}

function setState(cabinId: string, next: CabinItemsState): void {
  states.set(cabinId, next)
  emit(cabinId)
}

function patchItems(cabinId: string, updater: (items: CabinItemDTO[]) => CabinItemDTO[]): void {
  const cur = states.get(cabinId) ?? EMPTY
  const items = updater(cur.items)
  setState(cabinId, { ...cur, items, open: openCount(items), at: Date.now() })
}

function replaceItem(cabinId: string, item: CabinItemDTO): void {
  patchItems(cabinId, (items) => items.map((x) => (x.id === item.id ? item : x)))
}

export function loadCabinItems(cabinId: string, force = false): Promise<void> {
  const cur = states.get(cabinId)
  if (!force && cur?.loaded && Date.now() - cur.at < TTL_MS) return Promise.resolve()
  const running = inflight.get(cabinId)
  if (running) return running
  if (!cur) setState(cabinId, { ...EMPTY, loading: true })
  else setState(cabinId, { ...cur, loading: true, error: null })
  const task = fetchCabinItems(cabinId)
    .then((payload) => {
      setState(cabinId, {
        items: payload.items,
        open: payload.open,
        loading: false,
        error: null,
        loaded: true,
        at: Date.now(),
      })
    })
    .catch((err: unknown) => {
      const prev = states.get(cabinId) ?? EMPTY
      setState(cabinId, {
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      })
    })
    .finally(() => { inflight.delete(cabinId) })
  inflight.set(cabinId, task)
  return task
}

export function invalidateCabinItems(cabinId: string): void {
  states.delete(cabinId)
  inflight.delete(cabinId)
  emit(cabinId)
  void loadCabinItems(cabinId, true)
}

function subscribeCabin(cabinId: string, listener: () => void): () => void {
  const set = listeners.get(cabinId) ?? new Set<() => void>()
  set.add(listener)
  listeners.set(cabinId, set)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(cabinId)
  }
}

export function useCabinItems(cabinId: string | null | undefined): CabinItemsState {
  const subscribe = useCallback(
    (listener: () => void) => (cabinId ? subscribeCabin(cabinId, listener) : () => {}),
    [cabinId],
  )
  const getSnapshot = useCallback(
    () => (cabinId ? states.get(cabinId) ?? EMPTY : EMPTY),
    [cabinId],
  )
  const state = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY)
  useEffect(() => {
    if (cabinId) void loadCabinItems(cabinId)
  }, [cabinId])
  return state
}

// ── 写操作（乐观 → 服务端）──────────────────────────────────────────────

export async function createItem(cabinId: string, input: CabinItemInput): Promise<CabinItemDTO> {
  const item = await createCabinItem(cabinId, input)
  patchItems(cabinId, (items) => [item, ...items])
  return item
}

/** 输入中即时反映到列表（不发请求）；失焦 / 防抖后再 commit。 */
export function applyItemLocal(cabinId: string, itemId: string, patch: Partial<CabinItemDTO>): void {
  patchItems(cabinId, (items) => items.map((x) => (x.id === itemId ? { ...x, ...patch } : x)))
}

export async function commitItem(cabinId: string, itemId: string, patch: CabinItemInput): Promise<CabinItemDTO | null> {
  try {
    const item = await updateCabinItem(cabinId, itemId, patch)
    replaceItem(cabinId, item)
    return item
  } catch {
    return null
  }
}

/** 删除先本地消失（5s 内可撤销），时间到再回服务端。返回被删的那条与位置。 */
export function hideItemLocal(cabinId: string, itemId: string): { item: CabinItemDTO; index: number } | null {
  const cur = states.get(cabinId)
  if (!cur) return null
  const index = cur.items.findIndex((x) => x.id === itemId)
  if (index < 0) return null
  const item = cur.items[index]
  patchItems(cabinId, (items) => items.filter((x) => x.id !== itemId))
  return { item, index }
}

export function restoreItemLocal(cabinId: string, item: CabinItemDTO, index: number): void {
  patchItems(cabinId, (items) => {
    if (items.some((x) => x.id === item.id)) return items
    const next = [...items]
    next.splice(Math.min(index, next.length), 0, item)
    return next
  })
}

export async function deleteItemRemote(cabinId: string, itemId: string): Promise<void> {
  await deleteCabinItem(cabinId, itemId)
}

export function markDeliveredLocal(cabinId: string, ids: string[]): void {
  const set = new Set(ids)
  const now = new Date().toISOString()
  patchItems(cabinId, (items) => items.map((x) =>
    set.has(x.id) && x.status === 'todo'
      ? { ...x, status: 'delivered', delivered_at: now, updated_at: now }
      : x,
  ))
}

export async function closeItemsRemote(
  cabinId: string, ids: string[], outcome: 'done' | 'dropped',
): Promise<CabinItemDTO[]> {
  const rows = await closeCabinItems(cabinId, ids, outcome)
  for (const row of rows) replaceItem(cabinId, row)
  return rows
}

export async function reopenItemRemote(cabinId: string, itemId: string): Promise<CabinItemDTO | null> {
  try {
    const item = await reopenCabinItem(cabinId, itemId)
    replaceItem(cabinId, item)
    return item
  } catch {
    return null
  }
}

// ── 投递文案 ────────────────────────────────────────────────────────────

export function itemLabel(item: CabinItemDTO): string {
  return cabinItemLabel(item)
}

/** 投递正文：标题做索引，**正文逐字**（2026-11-26 用户事故：只发标题，
 *  汐音拿不到需求原文）。截断 / 总量上限都由 shared 同一份口径处理；
 *  来源仍由消息 meta 承载，不靠正文约定。 */
export function itemDeliveryText(items: CabinItemDTO[]): string {
  return formatCabinItemDeliveryText(items)
}

// ── 投递排队（主对话在跑时先候着）───────────────────────────────────────

export interface ItemDelivery {
  cabinId: string
  itemIds: string[]
  /** 可读标签（#IT-12 …），排队条展示用。 */
  labels: string[]
  text: string
}

let deliveryQueue: ItemDelivery[] = []
const queueListeners = new Set<() => void>()

function emitQueue(): void {
  for (const listener of [...queueListeners]) listener()
}

export function enqueueDelivery(delivery: ItemDelivery): void {
  deliveryQueue = [...deliveryQueue, delivery]
  emitQueue()
}

export function cancelDeliveryQueue(): void {
  if (deliveryQueue.length === 0) return
  deliveryQueue = []
  emitQueue()
}

/** 取出本舱的排队项（全部合并），排队条随即清空。 */
export function takeDeliveryQueue(cabinId: string): ItemDelivery[] {
  const take = deliveryQueue.filter((d) => d.cabinId === cabinId)
  if (take.length === 0) return []
  deliveryQueue = deliveryQueue.filter((d) => d.cabinId !== cabinId)
  emitQueue()
  return take
}

/** 全量排队（组件按 cabinId 过滤）。快照必须引用稳定，所以不在这里 filter。 */
export function useItemDeliveryQueue(): ItemDelivery[] {
  const subscribe = useCallback((listener: () => void) => {
    queueListeners.add(listener)
    return () => { queueListeners.delete(listener) }
  }, [])
  return useSyncExternalStore(subscribe, () => deliveryQueue, () => EMPTY_QUEUE)
}
const EMPTY_QUEUE: ItemDelivery[] = []

// ── 窗口开合（与 notes-store 同模式）────────────────────────────────────

let itemsOpen = false
const openListeners = new Set<() => void>()

function emitOpen(): void {
  for (const listener of [...openListeners]) listener()
}

export function setCabinItemsOpen(next: boolean): void {
  if (itemsOpen === next) return
  itemsOpen = next
  emitOpen()
}

export function toggleCabinItems(): void {
  setCabinItemsOpen(!itemsOpen)
}

export function useCabinItemsOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      openListeners.add(listener)
      return () => { openListeners.delete(listener) }
    },
    () => itemsOpen,
    () => false,
  )
}

/** 测试用：清空缓存 / 排队 / 开合状态。 */
export function resetCabinItemsForTests(): void {
  states.clear()
  listeners.clear()
  inflight.clear()
  deliveryQueue = []
  queueListeners.clear()
  itemsOpen = false
  openListeners.clear()
}
