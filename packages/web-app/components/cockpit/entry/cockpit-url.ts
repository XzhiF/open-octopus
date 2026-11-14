// 全域座舱 URL 纯函数（S1；S9 在此之上补 origin / 跨舱规则）。
//
// 契约（plans §1.1）：
//   /cabin/:cabinId/cockpit?job=<jobId>&tab=<overview|relay|run|changes|accept>
//   /cabin/:cabinId/cockpit?task=<taskId>
//   /cabin/:cabinId/cockpit?attn=<attentionId>
// 参数优先级 job > task > attn；都缺 → 由 resolveDefaultRef 决定。
//
// 跨舱：面可以看别的舱的作业，此时额外带 `&cabin=<所属舱>`（只在 ref.cabinId
// 与入口舱不同时写）。不带时 ref.cabinId 回落为入口舱。

import {
  isCockpitTab,
  type CockpitRef,
  type CockpitTab,
} from '../state/cockpit-state'

export const COCKPIT_PATH_SUFFIX = '/cockpit'

export interface ParsedCockpitUrl {
  ref: CockpitRef | null
  tab: CockpitTab | null
}

export function cockpitPath(entryCabinId: string): string {
  return `/cabin/${encodeURIComponent(entryCabinId)}${COCKPIT_PATH_SUFFIX}`
}

function toParams(search: string | URLSearchParams): URLSearchParams {
  return typeof search === 'string' ? new URLSearchParams(search) : search
}

function cleanId(value: string | null): string | null {
  if (!value) return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

/** 从查询串解析选中项。所属舱缺省 = 入口舱（跨舱时由 `cabin` 给出）。 */
export function parseCockpitUrl(
  search: string | URLSearchParams,
  entryCabinId: string,
): ParsedCockpitUrl {
  const params = toParams(search)
  const tabValue = params.get('tab')
  const tab = isCockpitTab(tabValue) ? tabValue : null
  const ownerCabinId = cleanId(params.get('cabin')) ?? entryCabinId

  const job = cleanId(params.get('job'))
  if (job) return { ref: { kind: 'job', cabinId: ownerCabinId, id: job }, tab }

  const task = cleanId(params.get('task'))
  if (task) return { ref: { kind: 'task', cabinId: ownerCabinId, id: task }, tab }

  const attention = cleanId(params.get('attn'))
  if (attention) return { ref: { kind: 'attention', cabinId: ownerCabinId, id: attention }, tab }

  return { ref: null, tab }
}

/** 序列化选中项 + 页签。overview 是默认页签，省略以保持 URL 干净。 */
export function serializeCockpitHref(
  entryCabinId: string,
  ref: CockpitRef | null,
  tab?: CockpitTab | null,
): string {
  const params = new URLSearchParams()
  if (ref) {
    const key = ref.kind === 'attention' ? 'attn' : ref.kind
    params.set(key, ref.id)
    if (ref.cabinId && ref.cabinId !== entryCabinId) params.set('cabin', ref.cabinId)
  }
  if (tab && tab !== 'overview') params.set('tab', tab)
  const query = params.toString()
  const base = cockpitPath(entryCabinId)
  return query ? `${base}?${query}` : base
}

/** 座舱自己拥有的查询参数；同步 URL 时只重写这些，其余（?demo=1 等）原样保留。 */
export const COCKPIT_OWNED_PARAMS = ['job', 'task', 'attn', 'tab', 'cabin'] as const

/** 把当前 query 里不归座舱管的参数并到目标 href 上（顺序：座舱参数在前）。 */
export function cockpitHrefPreserving(
  entryCabinId: string,
  ref: CockpitRef | null,
  tab: CockpitTab | null | undefined,
  currentSearch: string | URLSearchParams,
): string {
  const base = serializeCockpitHref(entryCabinId, ref, tab)
  const query = base.includes('?') ? base.slice(base.indexOf('?') + 1) : ''
  const next = new URLSearchParams(query)
  const preserved = new URLSearchParams(toParams(currentSearch))
  for (const key of COCKPIT_OWNED_PARAMS) preserved.delete(key)
  for (const [key, value] of preserved) next.append(key, value)
  const merged = next.toString()
  return merged ? `${cockpitPath(entryCabinId)}?${merged}` : cockpitPath(entryCabinId)
}

// ── 默认选中（plans §1.3）─────────────────────────────────────────────// 需要你（attention priority 降序）→ 运行中第一条 → 排队第一条 → 空态。
// S2 的 CockpitRow 由调用方投影成这个最小形状，避免 S1 依赖编队模型。

export type CockpitCandidateGroup = 'need' | 'run' | 'queue' | 'done'

export interface CockpitCandidate {
  ref: CockpitRef
  group: CockpitCandidateGroup
  /** 仅 need 组使用：attention 的 priority。 */
  priority?: number
}

export function resolveDefaultRef(candidates: readonly CockpitCandidate[]): CockpitRef | null {
  let need: CockpitCandidate | null = null
  for (const candidate of candidates) {
    if (candidate.group !== 'need') continue
    if (!need || (candidate.priority ?? 0) > (need.priority ?? 0)) need = candidate
  }
  if (need) return need.ref

  const running = candidates.find((candidate) => candidate.group === 'run')
  if (running) return running.ref

  const queued = candidates.find((candidate) => candidate.group === 'queue')
  if (queued) return queued.ref

  return null
}
