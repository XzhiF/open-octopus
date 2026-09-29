// P1 B3: AgentSessionDAO 已迁 postgres.js —— 本文件从 initDb(:memory:) 切到
// PG 随机测试库（每例一座，README 施工图快路径）。用例语义与条数逐条保持。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import crypto from 'crypto'
import { AgentSessionDAO } from '../agent-session-dao'
import { describePg, setupPgSchema, type PgFixture } from '../../pg/__tests__/dao-fixture'

const ORG = 'dao-test-org'

let pg: PgFixture
let dao: AgentSessionDAO

async function seedSession(id: string, title: string, summaries: Array<{ content: string; source: string }>): Promise<void> {
  const now = new Date().toISOString()
  await pg.sql.unsafe(
    "INSERT INTO sessions (id, org, title, clone_name, session_type, is_active, is_deleted, created_at, updated_at) VALUES ($1, $2, $3, $4, 'chat', true, false, $5, $6)",
    [id, ORG, title, 'main', now, now],
  )
  for (const s of summaries) {
    await dao.insertSummaryMessage(crypto.randomUUID(), id, s.content, now, s.source)
  }
}

describePg('AgentSessionDAO — 会话记忆检索面', () => {
  beforeEach(async () => {
    pg = await setupPgSchema()
    dao = new AgentSessionDAO(pg.sql)
    await seedSession('s1', '高铁专项', [
      { content: '高铁调度系统采用中文检索优化方案', source: 'main' },
      { content: 'the cache eviction policy was revised', source: 'clone-a' },
    ])
    await seedSession('s2', '无关会话', [
      { content: '今天讨论了数据库备份策略', source: 'main' },
    ])
    await dao.rebuildFtsIndex()
  })

  afterEach(async () => { await pg.close() })

  it('中文双字查询命中（PG 检索面中文可用）', async () => {
    const rows = await dao.searchSessionMemory('高铁', 5)
    expect(rows.length).toBe(1)
    expect(rows[0].session_id).toBe('s1')
    // 返回的是原文（messages.content 真表列），不是切词串
    expect(rows[0].summary).toContain('高铁调度系统')
  })

  it('命中结果携带真实相关度分数（> 0 且 < 1，非恒 0）', async () => {
    const rows = await dao.searchSessionMemory('检索', 5)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0].score).toBeGreaterThan(0)
    expect(rows[0].score).toBeLessThan(1)
  })

  it('英文查询保持命中', async () => {
    const rows = await dao.searchSessionMemory('cache eviction', 5)
    expect(rows.length).toBe(1)
    expect(rows[0].source).toBe('clone-a')
  })

  it('source 过滤生效', async () => {
    expect((await dao.searchSessionMemory('高铁', 5, 'clone-a')).length).toBe(0)
    expect((await dao.searchSessionMemory('高铁', 5, 'main')).length).toBe(1)
  })

  it('org 过滤生效 — 跨 org 会话不外泄', async () => {
    await seedSession('s3', '别的组织', [{ content: '高铁票价讨论', source: 'main' }])
    await pg.sql.unsafe("UPDATE sessions SET org = 'other-org' WHERE id = 's3'")
    await dao.rebuildFtsIndex()
    const rows = await dao.searchSessionMemory('高铁', 10, undefined, ORG)
    expect(rows.every((r) => r.session_id !== 's3')).toBe(true)
    const all = await dao.searchSessionMemory('高铁', 10)
    expect(all.some((r) => r.session_id === 's3')).toBe(true)
  })

  it('含引号/特殊语法的查询不抛异常（转义/兜底路径）', async () => {
    await expect(dao.searchSessionMemory('他说"高铁"NEAR(调度)*', 5)).resolves.toBeInstanceOf(Array)
  })

  it('空查询/纯标点查询 → 显式空结果，不抛异常', async () => {
    expect(await dao.searchSessionMemory('', 5)).toEqual([])
    expect(await dao.searchSessionMemory('，。！', 5)).toEqual([])
  })

  it('无命中查询返回空数组（语义清晰，不是异常降级）', async () => {
    expect(await dao.searchSessionMemory('量子隧穿', 5)).toEqual([])
  })

  it('OR 兜底腿：AND 无结果时部分命中词仍可召回', async () => {
    // 「锁竞争」切成 锁+竞争；文档只有 死锁+竞争 → AND(锁) 0 → OR 命中
    await seedSession('s4', '死锁分析', [{ content: '数据库死锁竞争激烈', source: 'main' }])
    await dao.rebuildFtsIndex()
    const rows = await dao.searchSessionMemory('锁竞争', 5, undefined, ORG)
    expect(rows.length).toBeGreaterThan(0)
  })

  it('rebuildFtsIndex 返回条数且幂等', async () => {
    const n1 = await dao.rebuildFtsIndex()
    expect(n1).toBe(3) // s1 两条 + s2 一条
    const n2 = await dao.rebuildFtsIndex()
    expect(n2).toBe(n1)
    expect((await dao.searchSessionMemory('高铁', 5)).length).toBe(1)
  })
})
