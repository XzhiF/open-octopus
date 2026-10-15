import type { KnowledgeEffectivenessRow } from "../../db/dao/knowledge-effectiveness-dao"

/**
 * effectiveness-confidence — P4 票07「confidence 滚动」公式与阈值的**单源纯函数面**。
 *
 * spec 故事 3：confidence = helpful/(helpful+not_helpful)，DB 为真源；**样本不足
 * （helpful+not_helpful < CONFIDENCE_MIN_SAMPLES）保持编译期初值不抖动**——理由：
 * 两三次裁决撑不起一条规则的生死（1/2 与 2/2 相差 0.5 的抖动会夜夜洗页 front-matter，
 * git 史与 INDEX diff 全是噪音）；初值本身就是编译期策展判断，未实测时它是唯一信号。
 * 阈值与低置信闸（≤0.2 且引用≥3，spec 故事 5）都是**可调运营参数、不是架构**：
 * 代码单源在此，SCHEMA.md 措辞同步属人工共演面（真盘文件由 owner 落笔，自动通道
 * 永不改写——manual-files 写保护同律）。
 *
 * 消费面三处共用本模块（防公式漂移）：effectiveness-sync 执行体（刷 front-matter 快照）、
 * patrol 低置信查（产 finding）、knowledge-read/wiki 路由（健康条与页元数据实时值）。
 * 与旧 effectiveness.ts（git 史 cc6b2d4b）无涉：这里只有账目算术，零判定零启发（红线3）。
 */

/** 样本不足闸：helpful+not_helpful 总记账 < 本值 ⇒ confidence 保持编译期初值（票面 AC1 阈值）。 */
export const CONFIDENCE_MIN_SAMPLES = 3

/** 低置信闸·上界：有效 confidence ≤ 本值 ⇒ 候选修订/退役（spec 故事 5，等号含）。 */
export const LOW_CONFIDENCE_MAX = 0.2

/** 低置信闸·引用下界：被消费 ≥ 本值才谈得上「差规则不赖账」（引用不足=还没被验证）。 */
export const LOW_CONFIDENCE_MIN_CITED = 3

/** 页/行账目聚合（helpful/not_helpful 两列才是置信度原料；cited 单独出面）。 */
export interface EffectivenessRoll {
  cited: number
  helpful: number
  notHelpful: number
  /** helpful+notHelpful */
  samples: number
  /** samples ≥ CONFIDENCE_MIN_SAMPLES——false 时 confidence 走初值不抖动 */
  measured: boolean
}

/** 聚合若干 knowledge_effectiveness 行（一页 = 页键行 ∪ 其锚点行；调用方负责取行）。 */
export function rollupEffectiveness(
  rows: Array<Pick<KnowledgeEffectivenessRow, "cited_count" | "helpful_count" | "not_helpful_count">>,
): EffectivenessRoll {
  let cited = 0
  let helpful = 0
  let notHelpful = 0
  for (const r of rows) {
    cited += r.cited_count
    helpful += r.helpful_count
    notHelpful += r.not_helpful_count
  }
  const samples = helpful + notHelpful
  return { cited, helpful, notHelpful, samples, measured: samples >= CONFIDENCE_MIN_SAMPLES }
}

/** 三位定标（与 v55 前旧列语义同精度口径的展示层收口）：0.333 而非 1/3 无限小数——
 *  front-matter 快照逐字比对靠它防抖动重提交。 */
export function roundConfidence(helpful: number, samples: number): number {
  return Math.round((helpful / samples) * 1000) / 1000
}

/**
 * 有效 confidence：已测 ⇒ 滚动公式；未测 ⇒ initial（编译期初值，不抖动）。
 * initial 由调用方按其面给定：页 front-matter confidence（页键同步面，缺省视同 DB
 * 兜底 0.5 = pageEntryView 口径）；wiki_articles.confidence 列（article API 面）。
 */
export function rollupConfidence(roll: EffectivenessRoll, initial: number): number {
  return roll.measured ? roundConfidence(roll.helpful, roll.samples) : initial
}

/** 原始 helpful 率（无样本闸——页脚与 confidence 并显，让 owner 看见「闸值 vs 现账」差）。 */
export function helpfulRateOf(roll: EffectivenessRoll): number | null {
  return roll.samples > 0 ? roundConfidence(roll.helpful, roll.samples) : null
}

/** 低置信判据（spec 故事 5 两条件 AND；confidence 传入 rollupConfidence 的产物）。 */
export function isLowConfidence(roll: EffectivenessRoll, confidence: number): boolean {
  return roll.cited >= LOW_CONFIDENCE_MIN_CITED && confidence <= LOW_CONFIDENCE_MAX
}

/**
 * 健康条「全库平均 confidence」口径：**只均已测行**的滚动值（样本不足行的初值是
 * 编译期猜测，混入均值会稀释实测信号）；全库未测 ⇒ null 诚实无数据。
 * 口径措辞随 SCHEMA.md 建议进文档（票面「健康条：全库平均 confidence 或低置信页数」
 * 取前者；低置信面已由 finding 通道单独显形）。
 */
export function avgMeasuredConfidence(
  rows: Array<Pick<KnowledgeEffectivenessRow, "cited_count" | "helpful_count" | "not_helpful_count">>,
): number | null {
  let sum = 0
  let n = 0
  for (const r of rows) {
    const roll = rollupEffectiveness([r])
    if (!roll.measured) continue
    sum += roundConfidence(roll.helpful, roll.samples)
    n++
  }
  if (n === 0) return null
  return Math.round((sum / n) * 1000) / 1000
}
