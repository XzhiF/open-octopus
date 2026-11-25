// v21（design 31 §3.2）· 右栏「要我处理」inbox 的纯模型。
//
// 数据真源仍是编队行里的 attention（job 行上挂的那条 + 独立 attn: 行），
// 不另拉接口、不合并跨舱。分组口径与原型一致：
//   · 受阻  = stage === 'blocked'
//   · 待验收 = stage === 'review'
//   · 待你定 = 其余等人阶段（answer / adjudicate / approval / start）
// 只收 awaiting === 'person' 或 blocked 的项 —— 机器在跑的不用人处理。

import type { CabinAttentionItem } from '@octopus/shared'
import type { CockpitRow } from '../fleet/fleet-model'
import type { CockpitRef } from '../state/cockpit-state'

export type InboxGroup = 'ask' | 'rev' | 'blk' | 'done'

export interface InboxEntry {
  item: CabinAttentionItem
  cabinId: string
  /** 点「去处理」的目标：挂在 job 上 → job 面；否则 attention 面。 */
  ref: CockpitRef
  /** 行 key（job:/task:/attn:），给 flash / 选中定位用。 */
  rowKey: string
}

export interface InboxCounts {
  total: number
  ask: number
  rev: number
  blk: number
  done: number
}

export const INBOX_GROUP_LABEL: Record<InboxGroup, string> = {
  ask: '待你定',
  rev: '待验收',
  blk: '受阻',
  done: '已完成',
}

export function inboxGroupOf(item: CabinAttentionItem): InboxGroup {
  if (item.stage === 'blocked') return 'blk'
  if (item.stage === 'review') return 'rev'
  if (item.stage === 'notice') return 'done'
  return 'ask'
}

function refOf(row: CockpitRow, item: CabinAttentionItem): CockpitRef {
  if (row.kind === 'attention') return { kind: 'attention', cabinId: row.cabinId, id: row.item.id }
  if (row.kind === 'job') return { kind: 'job', cabinId: row.cabinId, id: row.job.id }
  if (row.kind === 'task') return { kind: 'task', cabinId: row.cabinId, id: row.task.id }
  if (item.job_id) return { kind: 'job', cabinId: row.cabinId, id: item.job_id }
  return { kind: 'attention', cabinId: row.cabinId, id: item.id }
}

/**
 * 从编队行收集待办（保持 attention 的既有顺序，person-first 由服务端保证）。
 * 同一条 attention 只出现一次。
 */
export function collectInbox(rows: readonly CockpitRow[]): InboxEntry[] {
  const seen = new Set<string>()
  const out: InboxEntry[] = []
  for (const row of rows) {
    const item = row.kind === 'job'
      ? row.attention
      : row.kind === 'attention' ? row.item : null
    if (!item) continue
    if (seen.has(item.id)) continue
    if (item.awaiting !== 'person' && item.stage !== 'blocked') continue
    seen.add(item.id)
    out.push({ item, cabinId: row.cabinId, ref: refOf(row, item), rowKey: row.key })
  }
  return out
}

export function inboxCounts(entries: readonly InboxEntry[], answered?: ReadonlySet<string>): InboxCounts {
  const counts: InboxCounts = { total: 0, ask: 0, rev: 0, blk: 0, done: 0 }
  for (const entry of entries) {
    if (answered?.has(entry.item.id)) continue
    counts.total += 1
    counts[inboxGroupOf(entry.item)] += 1
  }
  return counts
}

export function groupedInbox(
  entries: readonly InboxEntry[],
  answered?: ReadonlySet<string>,
): Array<{ group: InboxGroup; label: string; items: InboxEntry[] }> {
  const buckets: Record<InboxGroup, InboxEntry[]> = { ask: [], rev: [], blk: [], done: [] }
  for (const entry of entries) {
    if (answered?.has(entry.item.id)) continue
    buckets[inboxGroupOf(entry.item)].push(entry)
  }
  return (['ask', 'rev', 'blk', 'done'] as const)
    .filter((group) => buckets[group].length > 0)
    .map((group) => ({ group, label: INBOX_GROUP_LABEL[group], items: buckets[group] }))
}

export function findInbox(entries: readonly InboxEntry[], id: string | null): InboxEntry | null {
  if (!id) return null
  return entries.find((entry) => entry.item.id === id) ?? null
}

/** AskUserQuestion 原问题体（`{ questions: [...] }` 或裸数组）—— 历史形态两种都要认。 */
export function askQuestionsOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  const list = (value as { questions?: unknown } | null)?.questions
  return Array.isArray(list) ? list : []
}

/** 有决策信封（扁平可选项 / AskUserQuestion 原问题体）才算「能就地答」。
 *  v22 #5 起浮层不再就地渲染问答卡（改为去编队 chat 里答），这个判定留给
 *  classic 问答窗 / 调用方复用。 */
export function canAnswerInline(item: CabinAttentionItem): boolean {
  if (!item.ask?.ask_id) return false
  if ((item.ask.options?.length ?? 0) > 0) return true
  return askQuestionsOf(item.ask.questions).length > 0
}
