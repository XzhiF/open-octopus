// packages/server/src/services/knowledge/case-symptom.ts
//
// 同症状判例判定 — P3 票03 occurrences 合并的判据（spec §判例自动提取
// 「occurrences 合并：同症状判定…（归一化+jaccard）」）。
//
// 勘探注（server-sockets.md §4.2）：spec 所称「复用规则近义先例」在全仓不存在——
// 无归一化/jaccard 实现可 import，本模块按 spec 字样自建，纯函数零 IO、可单测。
//
// 制式：
//  * 归一化 = 小写 → NFKC 全角折半 → 标点/符号成词界（转空白）→ 连续空白压一 → trim。
//  * 分词 = ASCII 词段（字母数字连续段，数字串独立词）∪ CJK 段字符二元
//    （「登录接口」→ 登录/录接/接口；单字段原样入集）——CJK 无空格分词的最小可行形。
//  * 相似 = token 集 Jaccard（交/并）；阈值单源常量（宽松准入下的运营调参入口，
//    spec 判例质量风险预案：噪声高收紧阈值是参数不是架构）。
//  * 确定性：同分取调用方给定顺序的先位（调用方负责排序稳定，如 scanWikiEntries 字典序）。

/** 同症状判定阈值（jaccard ≥ 此值 ⇒ 并档 occurrences+1）。票面运营参数，测试钉值。 */
export const CASE_SYMPTOM_JACCARD_THRESHOLD = 0.5

/** 归一化：小写 / 全角折半 / 标点符号转词界 / 压空白。 */
export function normalizeSymptom(s: string): string {
  const half = s.toLowerCase().normalize("NFKC")
  // 词界化：非（字母数字/CJK/空白）一律转空格
  const delimited = half.replace(/[^0-9a-z㐀-䶿一-鿿぀-ヿ\s]/g, " ")
  return delimited.replace(/\s+/g, " ").trim()
}

/** 分词：ASCII 词段 ∪ CJK 字符二元。返回集合（jaccard 用集语义）。 */
export function symptomTokens(s: string): Set<string> {
  const norm = normalizeSymptom(s)
  const out = new Set<string>()
  for (const m of norm.matchAll(/[a-z0-9]+/g)) out.add(m[0])
  for (const m of norm.matchAll(/[㐀-䶿一-鿿぀-ヿ]+/g)) {
    const run = m[0]
    if (run.length === 1) out.add(run)
    else for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2))
  }
  return out
}

/** 集合 Jaccard；双方皆空 = 0（空对空不算同症状——防「全是标点」的畸形症状互相并档）。 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  for (const t of small) if (large.has(t)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

export interface SymptomHit {
  /** existing 数组下标（调用方给的序 = 决胜序） */
  index: number
  /** 命中的既有症状原文 */
  symptom: string
  score: number
}

/** 在既有判例症状列表中找同症状命中：分高者胜，同分取先位。无 ≥ 阈值命中 ⇒ undefined。 */
export function findSimilarSymptom(existing: string[], query: string): SymptomHit | undefined {
  const qt = symptomTokens(query)
  let best: SymptomHit | undefined
  for (let i = 0; i < existing.length; i++) {
    const score = jaccard(qt, symptomTokens(existing[i] ?? ""))
    if (score >= CASE_SYMPTOM_JACCARD_THRESHOLD && (best === undefined || score > best.score)) {
      best = { index: i, symptom: existing[i] ?? "", score }
    }
  }
  return best
}
