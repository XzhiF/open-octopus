/**
 * query-tokens 单测（P1 B3 段2，cjk-segmenter 退役后的查询侧轻量分词）。
 * 纯函数，无 DB —— SQLite/PG 双模式都跑。
 */
import { describe, it, expect } from 'vitest'
import { queryTokens, scoreNorm } from '../query-tokens'

describe('queryTokens（非 jieba，字母/数字连续段）', () => {
  it('英文按空白/标点切段', () => {
    expect(queryTokens('cache eviction policy')).toEqual(['cache', 'eviction', 'policy'])
  })

  it('中文连续段是一个整 token（子串匹配语义，词面切分交给 BM25 主路径）', () => {
    expect(queryTokens('锁竞争')).toEqual(['锁竞争'])
    expect(queryTokens('中文 检索')).toEqual(['中文', '检索'])
  })

  it('中英混排按段切', () => {
    expect(queryTokens('BM25排序调优')).toEqual(['BM25', '排序调优'])
  })

  it('去重且保序', () => {
    expect(queryTokens('检索 检索 优化')).toEqual(['检索', '优化'])
  })

  it('空/纯标点 → 空数组（显式 0 结果判定的依据）', () => {
    expect(queryTokens('')).toEqual([])
    expect(queryTokens('   ')).toEqual([])
    expect(queryTokens('，。！')).toEqual([])
    expect(queryTokens('...***')).toEqual([])
  })

  it('tantivy 语法输入拆出的 token 不含语法字符（ILIKE 兜底安全）', () => {
    expect(queryTokens('他说"高铁"NEAR(调度)*')).toEqual(['他说', '高铁', 'NEAR', '调度'])
  })
})

describe('scoreNorm（paradedb.score → (0,1)）', () => {
  it('单调递增且落在 (0,1)', () => {
    expect(scoreNorm(0.5)).toBeLessThan(scoreNorm(2))
    const s = scoreNorm(7.3)
    expect(s).toBeGreaterThan(0)
    expect(s).toBeLessThan(1)
  })

  it('0/负数/NaN 命中兜底给 0.001（保持命中必 >0 契约）', () => {
    expect(scoreNorm(0)).toBe(0.001)
    expect(scoreNorm(-3)).toBe(0.001)
    expect(scoreNorm(NaN)).toBe(0.001)
    expect(scoreNorm('4')).toBe(0.8) // int8/float 字符串回传形态也吃
  })
})
