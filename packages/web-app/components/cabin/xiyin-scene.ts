'use client'

// 汐音的「场景」模型（2026-11-14）：立绘只属于作战舱，且每间舱各持一份形象状态。
//
// 一个场景 = 一间舱（key = `cabin:<id>`）：
//   · 事实输入全部来自这间舱自己的派生视图（CabinView，服务端 K3 算好）；
//   · prefs 存这间舱自己那行 cockpit_prefs（服务端）；
//   · 瞬时态（心情覆盖 / 主动搭话 / 静默）以 key 隔离：换舱即归零。
//
// 所以舱 A 的「运行中 / 需要你」不会让舱 B 的汐音跟着变，舱 B 打盹也不会
// 影响舱 A。原型依据：classic-v4.html 的 crewState() —— 心情只由当前舱决定。

import type { CabinStatus, CabinView } from '@octopus/shared'
import type { CabinDetail } from '@/lib/cabin-api'

export interface XiyinScene {
  /** `cabin:<id>` —— 变化即重置瞬时态（一舱一份形象状态）。 */
  key: string
  /** 归属名（助理菜单「归属」一行）。 */
  label: string
  /** 舱状态：initializing → boot、dormant → sleep、archived → sleep。 */
  status?: CabinStatus
  personAttention: number
  attentionTotal: number
  queued: number
  running: number
  dormant: boolean
  hasBlocked: boolean
  firstAttentionTitle: string | null
  streaming: boolean
}

export function cabinSceneKey(cabinId: string | null | undefined): string {
  return cabinId ? `cabin:${cabinId}` : 'cabin:unknown'
}

/** 舱场景：事实全部来自该舱自己的派生视图，绝不读别的舱 / 全局任务列表。 */
export function cabinScene(
  cabin: CabinDetail | null,
  view: CabinView | null,
  streaming: boolean,
): XiyinScene {
  const attention = view?.attention ?? []
  const person = attention.find((a) => a.awaiting === 'person')
  return {
    key: cabinSceneKey(cabin?.id),
    label: cabin?.name ?? '主 Agent',
    status: cabin?.status,
    personAttention: attention.filter((a) => a.awaiting === 'person').length,
    attentionTotal: attention.length,
    queued: view?.health.queued ?? 0,
    running: view?.health.running ?? 0,
    dormant: cabin?.status === 'dormant',
    hasBlocked: attention.some((a) => a.stage === 'blocked'),
    firstAttentionTitle: person?.title ?? null,
    streaming,
  }
}
