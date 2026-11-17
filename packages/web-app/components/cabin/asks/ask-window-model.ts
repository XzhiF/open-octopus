// 问答窗的数据模型（design 26 §3.1 / §5.4）—— 全部纯函数，便于单测。
//
// 数据流：CabinProvider.view.attention（服务端派生，唯一事实源）
//   → pendingAsks(attention, answeredIds) 过滤出「等你答」
//   → 编队组渲染行 / 打开窗
//
// 位置纪律（用户 2026-11-16 口径）：**不跟随点击行的 y、不按剩余高度缩窗**。
// 落点固定：cockpit 在编队右侧、classic 在编队左侧；多开只沿 x 错开 32px。

import type { CabinAttentionItem, CabinAskEnvelope } from '@octopus/shared'

export interface PendingAsk {
  askId: string
  item: CabinAttentionItem
  env: CabinAskEnvelope
}

/**
 * 可作答的提问行：
 *   · stage === 'answer' 且带决策票据（ask.ask_id）；
 *   · 本地已答（乐观集合）与跨行重复的 askId 不出现；
 *   · 工作流执行提问没有票据，不进这个组（继续走旧入口）。
 * 顺序沿用 attention 的既有排序（person-first），这里不重排。
 */
export function pendingAsks(
  attention: readonly CabinAttentionItem[] | null | undefined,
  answeredIds?: ReadonlySet<string>,
): PendingAsk[] {
  if (!attention || attention.length === 0) return []
  const seen = new Set<string>()
  const out: PendingAsk[] = []
  for (const item of attention) {
    if (item.stage !== 'answer') continue
    const env = item.ask
    if (!env?.ask_id) continue
    if (answeredIds?.has(env.ask_id) || answeredIds?.has(item.id)) continue
    if (seen.has(env.ask_id)) continue
    seen.add(env.ask_id)
    out.push({ askId: env.ask_id, item, env })
  }
  return out
}

export interface AskWindowDims {
  w: number
  wNarrow: number
  narrowAt: number
  top: number
  stagger: number
  gap: number
}

/** cockpit：窗贴编队右缘；≤1480 视口用窄档。量纲取自 cockpit-v15 原型。 */
export const COCKPIT_WIN: AskWindowDims = {
  w: 560,
  wNarrow: 460,
  narrowAt: 1480,
  top: 74,
  stagger: 32,
  gap: 10,
}

/** classic：窗贴编队左缘；≤1320（编队隐藏）时贴右。量纲取自 classic-v5 原型。 */
export const CLASSIC_WIN: AskWindowDims = {
  w: 520,
  wNarrow: 520,
  narrowAt: 0,
  top: 56,
  stagger: 32,
  gap: 10,
}

/** classic 编队面板隐藏断点（cabin-cockpit.css @media max-width:1320px）。 */
export const CLASSIC_FLEET_HIDDEN_AT = 1321

export interface AskPlacementEnv {
  /** cockpit：编队栏右边缘（px）；拿不到为 null。 */
  railRight?: number | null
  /** classic：编队面板左边缘（px）；隐藏 / 拿不到为 null。 */
  fleetLeft?: number | null
  /** 已开窗数量（不含本扇）。 */
  openCount: number
  viewport: { w: number; h: number }
}

export interface AskPlacement {
  left: number
  top: number
  width: number
}

export function windowWidthFor(mode: 'cockpit' | 'classic', viewportW: number): number {
  const dims = mode === 'cockpit' ? COCKPIT_WIN : CLASSIC_WIN
  const base = mode === 'cockpit' && viewportW <= COCKPIT_WIN.narrowAt ? dims.wNarrow : dims.w
  return Math.min(base, Math.max(240, viewportW - 24))
}

export function clampLeft(left: number, width: number, viewportW: number): number {
  return Math.max(8, Math.min(left, Math.max(8, viewportW - width - 8)))
}

/**
 * 固定落点。返回 { left, top, width }，**不返回 height** —— 高度由 CSS 决定，
 * 任何时候都不按行 / 剩余空间缩窗。
 */
export function askRect(
  mode: 'cockpit' | 'classic',
  env: AskPlacementEnv,
): AskPlacement {
  const width = windowWidthFor(mode, env.viewport.w)
  const dims = mode === 'cockpit' ? COCKPIT_WIN : CLASSIC_WIN
  const stagger = Math.max(0, env.openCount) * dims.stagger
  let left: number
  if (mode === 'cockpit') {
    const base = typeof env.railRight === 'number' ? env.railRight + COCKPIT_WIN.gap : 10
    left = base + stagger
  } else {
    const fleetVisible = typeof env.fleetLeft === 'number' && env.viewport.w >= CLASSIC_FLEET_HIDDEN_AT
    left = fleetVisible
      ? env.fleetLeft! - width - CLASSIC_WIN.gap - stagger
      : env.viewport.w - width - 24
  }
  return { left: clampLeft(left, width, env.viewport.w), top: dims.top, width }
}

/** 窗标题：attention 标题去掉服务端后缀（`· 待回答`）。 */
export function askWindowTitle(item: CabinAttentionItem): string {
  return item.title.replace(/\s*·\s*待回答$/, '')
}

/** 窗右上角上下文串：仓库 / 工作树 / 阶段。只拼真实字段。 */
export function askWindowContext(item: CabinAttentionItem, env: CabinAskEnvelope): string {
  const phase = env.phase && typeof env.phase.index === 'number'
    ? `P${env.phase.index}${env.phase.round ? ` · R${env.phase.round}` : ''}`
    : null
  return [item.repo, item.wt, phase].filter((v): v is string => !!v).join(' · ')
}
