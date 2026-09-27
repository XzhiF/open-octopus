/**
 * cjk-segmenter — jieba 预分词 + FTS5 MATCH 构造单元测试。
 */
import { describe, it, expect } from 'vitest'
import {
  segIndex, segTokens, buildFtsMatch, escapeFtsToken, bm25ToScore,
} from '../../../cjk-segmenter'

describe('cjk-segmenter', () => {
  describe('segIndex（入库侧分词）', () => {
    it('中文切成词并以空格连接', () => {
      const out = segIndex('中文全文检索依赖分词器')
      expect(out.split(' ')).toContain('检索')
      expect(out.split(' ')).toContain('中文')
    })

    it('cut_for_search 产出子词提升召回', () => {
      const out = segIndex('数据库死锁')
      const tokens = out.split(' ')
      expect(tokens).toContain('数据库')
    })

    it('ASCII 词保持原样（unicode61 会自行小写折叠）', () => {
      const out = segIndex('BM25 ranking works')
      expect(out).toContain('BM25')
    })

    it('过滤纯标点 token — 索引与查询两侧一致', () => {
      const out = segIndex('好，太好了！')
      expect(out).not.toContain('，')
      expect(out).not.toContain('！')
    })

    it('空文本返回空串', () => {
      expect(segIndex('')).toBe('')
      expect(segIndex('   ')).toBe('')
    })
  })

  describe('segTokens（查询侧分词）', () => {
    it('双字查询切成 token 数组', () => {
      expect(segTokens('高铁')).toEqual(['高铁'])
    })

    it('查询与索引切法一致（对称性）', () => {
      const text = '锁竞争激烈导致吞吐下降'
      const qTokens = segTokens('锁竞争')
      const dTokens = segIndex(text).split(' ')
      // 查询 token 至少部分与文档 token 重叠（AND 不中时 OR 腿必须中）
      expect(qTokens.some((t) => dTokens.includes(t))).toBe(true)
    })
  })

  describe('buildFtsMatch / escapeFtsToken', () => {
    it('AND 模式：token 以空格（隐式 AND）连接且逐词加引号', () => {
      const m = buildFtsMatch('中文 检索', 'and')
      expect(m).toBe('"中文" "检索"')
    })

    it('OR 模式：token 以 OR 连接', () => {
      const m = buildFtsMatch('锁竞争', 'or')
      expect(m).toBe('"锁" OR "竞争"')
    })

    it('内部双引号被转义 — 不会产生非法 FTS 语法', () => {
      const m = buildFtsMatch('他说"检索"很棒', 'and')
      expect(() => escapeFtsToken('他说"检索"很棒')).not.toThrow()
      // 转义后引号成对：每个字面量 " 变为 ""
      const quoteCount = (m?.match(/"/g) ?? []).length
      expect(quoteCount % 2).toBe(0)
    })

    it('特殊 FTS 语法字符（NEAR/AND/*）被引号封死', () => {
      const m = buildFtsMatch('NEAR(a b)*', 'and')
      expect(m).toBeTruthy()
      expect(m!).toContain('"')
    })

    it('无有效 token 时返回 null（调用方显式返回空结果）', () => {
      expect(buildFtsMatch('，。！ ', 'and')).toBeNull()
      expect(buildFtsMatch('', 'or')).toBeNull()
    })
  })

  describe('bm25ToScore', () => {
    it('越负越相关 → 分数越高', () => {
      expect(bm25ToScore(-5)).toBeGreaterThan(bm25ToScore(-1))
    })

    it('分数落在 (0, 1)', () => {
      for (const r of [-0.5, -2, -20]) {
        const s = bm25ToScore(r)
        expect(s).toBeGreaterThan(0)
        expect(s).toBeLessThan(1)
      }
    })
  })
})
