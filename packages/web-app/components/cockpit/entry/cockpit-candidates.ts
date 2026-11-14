// S9 owns this file —— CockpitRow → CockpitRef / 默认选中候选的投影。
//
// cockpit-url.ts 保持「不依赖 S2 编队模型」的边界（S1 定的）：那边只认
// CockpitCandidate 这个最小形状；真正的 CockpitRow 投影放在这里。
//
// 用途：
//   · use-cockpit-url-sync：默认选中（§1.3）与无效 ref 回退；
//   · CockpitShortcuts 的 ⌥1「最紧要的一条」。
//
// 数字纪律：这里只读行上已有的真字段（priority / group），不造优先级。

import { groupOf, type CockpitRow } from '../fleet/fleet-model'
import type { CockpitRef } from '../state/cockpit-state'
import type { CockpitCandidate } from './cockpit-url'

/** 行 → 选中项。三型行与 fleet-model 的 key 一一对应。 */
export function rowCockpitRef(row: CockpitRow): CockpitRef {
  if (row.kind === 'job') return { kind: 'job', cabinId: row.cabinId, id: row.job.id }
  if (row.kind === 'task') return { kind: 'task', cabinId: row.cabinId, id: row.task.id }
  return { kind: 'attention', cabinId: row.cabinId, id: row.item.id }
}

function priorityOf(row: CockpitRow): number {
  if (row.kind === 'attention') return row.item.priority
  if (row.kind === 'job') return row.attention?.priority ?? row.job.priority
  return 0
}

export function rowCandidate(row: CockpitRow): CockpitCandidate {
  return { ref: rowCockpitRef(row), group: groupOf(row), priority: priorityOf(row) }
}

export function candidatesOf(rows: readonly CockpitRow[]): CockpitCandidate[] {
  return rows.map(rowCandidate)
}

/**
 * 选中项是否还能在编队里找到。
 * `mergeAttention` 会把 job_id 命中的 attention 合并进 job 行（不再单独成行），
 * 所以 `?attn=<id>` 命中 job 行上的 attention 也算有效 —— 否则深链会被误判失效。
 * 跨舱 ref 直接在全部行里找（rows 本来就跨舱）。
 */
export function refInRows(ref: CockpitRef, rows: readonly CockpitRow[]): boolean {
  for (const row of rows) {
    if (row.cabinId !== ref.cabinId) continue
    if (ref.kind === 'job' && row.kind === 'job' && row.job.id === ref.id) return true
    if (ref.kind === 'task' && row.kind === 'task' && row.task.id === ref.id) return true
    if (ref.kind === 'attention') {
      if (row.kind === 'attention' && row.item.id === ref.id) return true
      if (row.kind === 'job' && row.attention?.id === ref.id) return true
    }
  }
  return false
}
