// S6 · 舰桥纯数据 / 派生。
//
// 模型别名真源是 lib/agent/composer-settings.ts（pro-max / pro / se）；
// 这里只定义「⌘⇧M 循环」的顺序与上下文构成条的取色兜底，不复制控件。

import type { ComposerEffort } from '@/lib/agent/composer-settings'

/** ⌘⇧M 循环顺序（与 ComposerModelPopover 的列表同序：由强到轻）。 */
export const BRIDGE_MODEL_ORDER = ['pro-max', 'pro', 'se'] as const

export type BridgeModelId = (typeof BRIDGE_MODEL_ORDER)[number]

/** 未知别名（网关映射后的真名）→ 回到第一个。 */
export function nextBridgeModel(current: string): BridgeModelId {
  const index = BRIDGE_MODEL_ORDER.indexOf(current as BridgeModelId)
  return BRIDGE_MODEL_ORDER[(index + 1) % BRIDGE_MODEL_ORDER.length]
}

/**
 * contextUsage.categories[].color 由 provider 原样带来（通常是 hex）；缺色时
 * 用 pop 语义色兜底。**不编造类别** —— 类别名 / tokens 永远是接口值。
 */
export const CATEGORY_FALLBACK_COLORS = [
  'var(--pop-cyan)',
  'var(--pop-violet)',
  'var(--pop-green)',
  'var(--pop-amber)',
  'var(--pop-red)',
  'var(--pop-pink)',
] as const

export function categoryColor(color: string | null | undefined, index: number): string {
  const value = color?.trim()
  return value ? value : CATEGORY_FALLBACK_COLORS[index % CATEGORY_FALLBACK_COLORS.length]
}

/** 百分比量纲是 0–100（SDK context_usage），不是 0–1 比率。 */
export function clampPercent(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

/** 模型别名在舰桥上的短标签（未就绪由调用方处理）。 */
export function modelShortLabel(model: string): string {
  return model.trim() || '未就绪'
}

/** effort 档位在 rig 上的缩写（仅在 title / 无障碍里用，不改变控件）。 */
export const EFFORT_HINT: Record<ComposerEffort, string> = {
  low: '低',
  medium: '中',
  high: '高',
  max: '最大',
}
