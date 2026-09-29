/**
 * query-tokens — pg_search 时代的查询侧轻量分词（P1 B3 段2，接替 cjk-segmenter）。
 *
 * jieba 预分词链路随 FTS5 一起退役：BM25 主路径把原始查询串直接交给 tantivy
 * 解析器（文档侧 CJK 单字切分，词面切分不再需要）。本模块只服务两件事：
 *   1. 「空/纯标点查询 → 显式空结果」判定 —— 与旧 segTokens 的 HAS_WORD_CHAR
 *      口径一致：至少含一个字母/数字才算有效 token。
 *   2. ILIKE 兜底路径（tantivy 抛错或 BM25 零命中时）的 token 提取：按
 *      Unicode 字母/数字连续段切，CJK 整段是一个 token（子串匹配语义），
 *      不再做词级切分 —— 兜底路径只要求「不比旧 AND 腿更瞎」，精度靠 BM25 主路径。
 * 与 bm25ToScore 退役同理：paradedb.score 越大越相关，scoreNorm 映射到 (0,1)
 * 保持 DAO 出口契约（recall/REST 消费方按 (0,1) 排序）。
 */

/** 字母/数字连续段切词（ASCII 词与 CJK 段分开），去重、保序；纯标点/空白 → 空数组。 */
export function queryTokens(query: string): string[] {
  if (!query) return []
  return [...new Set(query.match(/[a-zA-Z0-9_]+|[\p{L}\p{N}]+/gu) ?? [])]
}

/**
 * paradedb.score（正数，越大越相关）→ (0,1) 归一：s/(1+s)。
 * s≈0 的极端命中给 0.001 —— 保持「命中必 score > 0」契约（同旧 bm25ToScore）。
 */
export function scoreNorm(raw: unknown): number {
  const s = Number(raw)
  const v = Number.isFinite(s) && s > 0 ? s : 0
  if (v === 0) return 0.001
  return v / (1 + v)
}
