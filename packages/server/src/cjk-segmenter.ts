/**
 * cjk-segmenter — jieba 预分词 + FTS5 MATCH 构造（KB P0 中文检索止血）。
 *
 * 背景：FTS5 unicode61 把连续中文当作单一 token，双字中文查询「永不命中但
 * 也不报语法错误」——静默 0 结果。策略：索引侧与查询侧都先过 jieba 切词，
 * 以空格连接后喂给 unicode61（虚拟表结构不动，只改写入的文本形态）。
 *
 * 两侧对称性是召回的前提：
 * - 索引侧 `segIndex`：cut_for_search —— 长词拆出子词（数据库 → 数据/据库/数据库），
 *   提升查询端命中面；保留词频重复（bm25 的 tf 依赖它）。
 * - 查询侧 `segTokens`：cut(HMM) —— 只取正常词切分，逐 token 加引号转义，
 *   绝不把用户输入当 FTS 裸语法拼接（" / NEAR / * 等一律封成字符串字面量）。
 * - AND 优先保精度；AND 空则 OR 兜底保召回（「锁竞争」切成 锁+竞争、文档只有
 *   「死锁 竞争」这类切词歧义由 OR 腿接住）。
 */
import { cut, cut_for_search } from 'jieba-wasm'

/** 至少含一个字母/数字才算有效 token（纯标点/空白/符号在两侧都被丢弃） */
const HAS_WORD_CHAR = /[\p{L}\p{N}]/u

function clean(tokens: string[], dedupe: boolean): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of tokens) {
    const t = raw.trim()
    if (!t || !HAS_WORD_CHAR.test(t)) continue
    if (dedupe) {
      if (seen.has(t)) continue
      seen.add(t)
    }
    out.push(t)
  }
  return out
}

/**
 * 入库侧分词：jieba 检索引擎切分（含子词），空格连接。
 * 纯 ASCII 文本退化为按分隔符切词，语义不变。
 */
export function segIndex(text: string): string {
  if (!text) return ''
  try {
    return clean(cut_for_search(text, true), false).join(' ')
  } catch {
    // jieba-wasm 理论不会抛；防御性回退到原文（至少 ASCII 检索不降级）
    return text
  }
}

/**
 * 查询侧分词：jieba 精确模式切词，返回去重 token 列表。
 */
export function segTokens(query: string): string[] {
  if (!query) return []
  try {
    return clean(cut(query, true), true)
  } catch {
    return clean(query.split(/\s+/), true)
  }
}

/** 把单个 token 封成 FTS5 字符串字面量：" 双写转义 */
export function escapeFtsToken(token: string): string {
  return `"${token.replace(/"/g, '""')}"`
}

/**
 * 由自然语言查询构造 FTS5 MATCH 表达式。
 * column 给定时逐 token 限定列（`col:"词"`），避免副列（如标题/元数据列）
 * 污染内容面召回。
 * 无有效 token → 返回 null（调用方必须显式返回空结果，而不是把空串塞进 MATCH）。
 */
export function buildFtsMatch(query: string, mode: 'and' | 'or', column?: string): string | null {
  const tokens = segTokens(query)
  if (tokens.length === 0) return null
  const term = (t: string): string => (column ? `${column}:${escapeFtsToken(t)}` : escapeFtsToken(t))
  return tokens.map(term).join(mode === 'or' ? ' OR ' : ' ')
}

/**
 * FTS5 bm25() rank（越小越相关，典型为负）→ (0,1) 相关度分数（越大越相关）。
 * score = 1 - 1/(1+|rank|)：单调、有界，仅用于本结果集内排序，不可跨表比较绝对值。
 */
export function bm25ToScore(rank: number): number {
  const v = Number.isFinite(rank) ? Math.abs(rank) : 0
  if (v === 0) return 0.001 // 命中但 rank≈0 的极端情形：保持 score > 0 语义
  return 1 - 1 / (1 + v)
}
