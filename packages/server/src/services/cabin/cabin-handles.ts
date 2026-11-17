// packages/server/src/services/cabin/cabin-handles.ts
//
// design 25 §4.1：句柄与颜色是**派生**的，不落库。
//   · 序号 = 本舱同类实体的创建顺序（稳定，不随状态变）；
//   · 颜色 = hash(id) % 6（与 shared 的 cabinHandleColor 同一个函数）。
//
// 任务用 `#1`，委派用 `D1` —— 扫一眼就能区分「立项的」与「跑一趟的」。

import { cabinHandleColor, cabinHandleFor, type CabinWorkKind } from "@octopus/shared"

export interface HandleInfo {
  handle: string
  color: number
  ordinal: number
}

export interface HandleSeed {
  id: string
  created_at: string
}

/** 按 created_at（再按 id 兜底）稳定排序后分配序号。 */
export function assignHandles(
  rows: HandleSeed[],
  kind: CabinWorkKind,
): Map<string, HandleInfo> {
  // 稳定排序：created_at 相同的行保持调用方给来的顺序（DAO 已按 rowid / 创建序
  // 返回）。之前用 id 兜底会在同一毫秒建两条委派时把 D1/D2 排反。
  const ordered = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at))
  const out = new Map<string, HandleInfo>()
  ordered.forEach((row, index) => {
    const ordinal = index + 1
    out.set(row.id, {
      handle: cabinHandleFor(kind, ordinal),
      ordinal,
      color: cabinHandleColor(row.id),
    })
  })
  return out
}

/** 一段文本里引用某实体时用的短前缀：`#1 支付回调`。 */
export function labelledTitle(handle: string, title: string): string {
  return `${handle} ${title}`
}
