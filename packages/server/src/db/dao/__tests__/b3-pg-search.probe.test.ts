/**
 * B3 段2 探针（批内交付证据，跑完保留为最小 smoke · 姿势同 B2 safety-bm25.probe）：
 * idx_messages_bm25 / idx_experiences_bm25 经 DAO 端到端 —— BM25 主路径、
 * paradedb.score 方向与归一、CJK 单字召回、tantivy 抛错的 ILIKE 兜底、
 * pattern_tags jsonb 列参与检索。跑两遍（固定 shuffle seed）验无顺序依赖（§8 网③）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import crypto from 'crypto'
import { AgentSessionDAO } from '../agent-session-dao'
import { EvolutionDAO } from '../evolution-dao'
import { describePg, setupPgSchema, type PgFixture } from '../../pg/__tests__/dao-fixture'

const ORG = 'b3-probe-org'

describePg('B3 pg_search BM25 — sessions/messages + experiences 检索面', () => {
  let pg: PgFixture
  let sess: AgentSessionDAO
  let evo: EvolutionDAO

  beforeAll(async () => {
    pg = await setupPgSchema()
    sess = new AgentSessionDAO(pg.sql)
    evo = new EvolutionDAO(pg.sql)

    // 索引形状：bm25 AM + 三张真表（messages/experiences/reports）
    const am = (await pg.sql`
      SELECT c.relname AS name, am.amname AS am
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      JOIN pg_am am ON am.oid = c.relam
      WHERE c.relname IN ('idx_messages_bm25', 'idx_experiences_bm25', 'idx_reports_bm25')
    `) as unknown as Array<{ name: string; am: string }>
    expect(am.map(r => r.name).sort()).toEqual(
      ['idx_experiences_bm25', 'idx_messages_bm25', 'idx_reports_bm25'],
    )
    for (const r of am) expect(r.am).toBe('bm25')

    const now = new Date().toISOString()
    const seed = async (id: string, title: string, summaries: Array<[string, string]>) => {
      await pg.sql.unsafe(
        "INSERT INTO sessions (id, org, title, clone_name, session_type, is_active, is_deleted, created_at, updated_at) VALUES ($1, $2, $3, 'main', 'chat', true, false, $4, $4)",
        [id, ORG, title, now],
      )
      for (const [content, source] of summaries) {
        await sess.insertSummaryMessage(crypto.randomUUID(), id, content, now, source)
      }
    }
    await seed('p1', '检索专项', [
      ['检索检索检索，深度优化中文检索链路', 'main'], // 高频 tf
      ['缓存淘汰策略复盘', 'clone-x'],
    ])
    await seed('p2', '弱相关', [['一次简单检索记录', 'main']])

    await evo.insertExperienceV2({
      skill_name: 'octo-search', content: '中文全文检索依赖分词器，unicode61 单 token 缺陷',
      source_session_id: null, org: ORG, created_at: now, scope: 'agent', scope_ref: null,
      pattern_tags: '["检索优化", "分词"]', outcome: null, source_type: 'session',
      execution_id: null, node_id: null,
    })
    await evo.insertExperienceV2({
      skill_name: 'other', content: '与标签同名冲突的条目',
      source_session_id: null, org: 'other-org', created_at: now, scope: 'agent', scope_ref: null,
      pattern_tags: '[]', outcome: null, source_type: 'session',
      execution_id: null, node_id: null,
    })
  })

  afterAll(async () => { await pg.close() })

  it('会话摘要 BM25：tf 更高者排前，score 落 (0,1) 且降序', async () => {
    const rows = await sess.searchSessionMemory('检索', 5, undefined, ORG)
    expect(rows.length).toBe(2)
    expect(rows[0].summary).toContain('深度优化')
    expect(rows[0].score).toBeGreaterThan(rows[1].score)
    for (const r of rows) {
      expect(r.score).toBeGreaterThan(0)
      expect(r.score).toBeLessThan(1)
    }
  })

  it('会话摘要 BM25：CJK 单字切让「锁竞争」在主路径直接命中（不再需要 OR 兜底腿）', async () => {
    const now = new Date().toISOString()
    await pg.sql.unsafe(
      "INSERT INTO sessions (id, org, title, clone_name, session_type, is_active, is_deleted, created_at, updated_at) VALUES ($1, $2, $3, 'main', 'chat', true, false, $4, $4)",
      ['p3', ORG, '死锁分析', now],
    )
    await sess.insertSummaryMessage(crypto.randomUUID(), 'p3', '数据库死锁竞争激烈', now, 'main')
    const rows = await sess.searchSessionMemory('锁竞争', 5, undefined, ORG)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.some(r => r.session_id === 'p3')).toBe(true)
  })

  it('tantivy 抛错查询走 ILIKE 兜底且能命中（不抛异常）', async () => {
    // `高铁:(调度` 含字段语法 + 未闭合括号 —— BM25 必抛，兜底腿按 queryTokens
    // AND 子串匹配「高铁调度…」原文
    const now = new Date().toISOString()
    await pg.sql.unsafe(
      "INSERT INTO sessions (id, org, title, clone_name, session_type, is_active, is_deleted, created_at, updated_at) VALUES ($1, $2, $3, 'main', 'chat', true, false, $4, $4)",
      ['p4', 'b3-ilike-org', '高铁专项', now],
    )
    await sess.insertSummaryMessage(crypto.randomUUID(), 'p4', '高铁调度系统采用中文检索方案', now, 'main')
    const rows = await sess.searchSessionMemory('高铁:(调度', 5, undefined, 'b3-ilike-org')
    expect(rows.length).toBe(1)
    expect(rows[0].score).toBeGreaterThan(0) // 兜底腿分层常数同样落 (0,1)
  })

  it('经验召回 BM25：org 隔离 + score 归一 (0,1)', async () => {
    const rows = await evo.searchExperiencesForRecall('检索', ORG, undefined, 5)
    expect(rows.length).toBe(1)
    expect(rows[0].skill_name).toBe('octo-search')
    expect(rows[0].score).toBeGreaterThan(0)
    expect(rows[0].score).toBeLessThan(1)
    expect(await evo.searchExperiencesForRecall('检索', 'no-such-org', undefined, 5)).toEqual([])
  })

  it('searchByScope：pattern_tags jsonb 列参与 BM25（标签词命中）', async () => {
    const rows = await evo.searchByScope('检索优化', undefined, 10)
    expect(rows.length).toBe(1)
    expect(rows[0].skill_name).toBe('octo-search')
    // 返回的是原文，不是切词串
    expect(rows[0].content).toContain('unicode61')
  })

  it('searchExperiences v1：BM25 主路径命中 + 抛错兜底返回数组', async () => {
    const hits = await evo.searchExperiences('分词', 10)
    expect(hits.length).toBe(1)
    await expect(evo.searchExperiences('weird:(unparseable', 10)).resolves.toBeInstanceOf(Array)
  })
})
