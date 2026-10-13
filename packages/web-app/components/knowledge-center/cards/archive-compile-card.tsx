'use client'

import { CompileDiffCard } from './compile-diff-card'
import type { KcCardViewProps } from './registry'

/**
 * 📦 归档编译卡 — task archiving 自动编译后（原型「通知卡（对话流内，免操作）」）。
 * 数据面同 diff 卡（KcArchiveCompileCardData extends KcCompileDiffCardData），
 * 渲染复用 CompileDiffCard 的 archive 形态（标题带任务名 + 「对策展人说」钮）。
 */
export function ArchiveCompileCard(props: KcCardViewProps) {
  return <CompileDiffCard {...props} archive />
}
