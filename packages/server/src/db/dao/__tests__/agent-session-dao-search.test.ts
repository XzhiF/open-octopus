/**
 * agent-session-dao 搜索路径测试 — KB P0「永不命中也不报错」静默路径修复。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import crypto from 'crypto'
import { initDb, closeDb, getDb } from '../../connection'
import { AgentSessionDAO } from '../agent-session-dao'

const ORG = 'dao-test-org'

function seedSession(db: ReturnType<typeof getDb>, id: string, title: string, summaries: Array<{ content: string; source: string }>): void {
  const now = new Date().toISOString()
  db.prepare(
    "INSERT INTO sessions (id, org, title, clone_name, session_type, is_active, is_deleted, created_at, updated_at) VALUES (?, ?, ?, ?, 'chat', 1, 0, ?, ?)",
  ).run(id, ORG, title, 'main', now, now)
  const dao = new AgentSessionDAO(db)
  for (const s of summaries) {
    dao.insertSummaryMessage(crypto.randomUUID(), id, s.content, now, s.source)
  }
}

describe('AgentSessionDAO — session_memory_fts 搜索', () => {
  let db: ReturnType<typeof getDb>
  let dao: AgentSessionDAO

  beforeEach(() => {
    db = initDb(':memory:')
    dao = new AgentSessionDAO(db)
    seedSession(db, 's1', '高铁专项', [
      { content: '高铁调度系统采用中文检索优化方案', source: 'main' },
      { content: 'the cache eviction policy was revised', source: 'clone-a' },
    ])
    seedSession(db, 's2', '无关会话', [
      { content: '今天讨论了数据库备份策略', source: 'main' },
    ])
    dao.rebuildFtsIndex()
  })

  afterEach(() => closeDb())

  it('中文双字查询命中（预分词后 unicode61 可用）', () => {
    const rows = dao.searchSessionMemory('高铁', 5)
    expect(rows.length).toBe(1)
    expect(rows[0].session_id).toBe('s1')
    // 返回的是原文（通过 rowid 关联 messages），不是切词串
    expect(rows[0].summary).toContain('高铁调度系统')
  })

  it('命中结果携带真实 bm25 分数（> 0，非恒 0）', () => {
    const rows = dao.searchSessionMemory('检索', 5)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0].score).toBeGreaterThan(0)
    expect(rows[0].score).toBeLessThan(1)
  })

  it('英文查询保持命中', () => {
    const rows = dao.searchSessionMemory('cache eviction', 5)
    expect(rows.length).toBe(1)
    expect(rows[0].source).toBe('clone-a')
  })

  it('source 过滤生效', () => {
    expect(dao.searchSessionMemory('高铁', 5, 'clone-a').length).toBe(0)
    expect(dao.searchSessionMemory('高铁', 5, 'main').length).toBe(1)
  })

  it('org 过滤生效 — 跨 org 会话不外泄', () => {
    seedSession(db, 's3', '别的组织', [{ content: '高铁票价讨论', source: 'main' }])
    db.prepare("UPDATE sessions SET org = 'other-org' WHERE id = 's3'").run()
    dao.rebuildFtsIndex()
    const rows = dao.searchSessionMemory('高铁', 10, undefined, ORG)
    expect(rows.every((r) => r.session_id !== 's3')).toBe(true)
    const all = dao.searchSessionMemory('高铁', 10)
    expect(all.some((r) => r.session_id === 's3')).toBe(true)
  })

  it('含引号/特殊语法的查询不抛异常（转义为字符串字面量）', () => {
    expect(() => dao.searchSessionMemory('他说"高铁"NEAR(调度)*', 5)).not.toThrow()
  })

  it('空查询/纯标点查询 → 显式空结果，不抛异常', () => {
    expect(dao.searchSessionMemory('', 5)).toEqual([])
    expect(dao.searchSessionMemory('，。！', 5)).toEqual([])
  })

  it('无命中查询返回空数组（语义清晰，不是异常降级）', () => {
    expect(dao.searchSessionMemory('量子隧穿', 5)).toEqual([])
  })

  it('OR 兜底腿：AND 无结果时部分命中词仍可召回', () => {
    // 「锁竞争」切成 锁+竞争；文档只有 竞争（死锁切不出 锁）→ AND 0 → OR 命中
    seedSession(db, 's4', '死锁分析', [{ content: '数据库死锁竞争激烈', source: 'main' }])
    dao.rebuildFtsIndex()
    const rows = dao.searchSessionMemory('锁竞争', 5, undefined, ORG)
    expect(rows.length).toBeGreaterThan(0)
  })

  it('rebuildFtsIndex 返回条数且幂等', () => {
    const n1 = dao.rebuildFtsIndex()
    expect(n1).toBe(3) // s1 两条 + s2 一条
    const n2 = dao.rebuildFtsIndex()
    expect(n2).toBe(n1)
    expect(dao.searchSessionMemory('高铁', 5).length).toBe(1)
  })
})
