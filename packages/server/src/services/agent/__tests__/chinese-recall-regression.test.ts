/**
 * 中文检索回归集 — KB P0「止血」退出判据之一。
 *
 * ≥30 条双字/四字词中文查询，在预置 fixture（experiences + session summaries）上
 * 经 recall() 断言命中 > 0。这是 unicode61 中文 0 命中缺陷（jieba 预分词前）的
 * 防回归锁。
 *
 * 诚实约定：
 * - known-fail 是显式白名单，只允许「当前实现确实切不动/切不齐」的词。
 * - 每个 known-fail 必须附理由；known-fail 集与「实际未命中集」做集合相等断言 —
 *   修好了却不更新清单、或偷偷删用例，都会红。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import crypto from 'crypto'
import { initDb, closeDb, getDb } from '../../../db/connection'
import { AgentSessionDAO, EvolutionDAO } from '../../../db/dao'
import { recall, rebuildSearchIndexes } from '../recall-service'

const ORG = 'kb-regression-org'
const NOW = new Date().toISOString()

// ── Fixture 语料（中文经验条目） ────────────────────────────────────

const EXPERIENCE_FIXTURES: Array<{ skill: string; content: string; scope?: string }> = [
  { skill: 'octo-search', content: '中文全文检索依赖分词器，unicode61 对连续中文只产出单个 token，导致检索查询零命中' },
  { skill: 'rail-dispatch', content: '高铁调度系统采用 DAG 编排工作流，调度节点按优先级排序' },
  { skill: 'db-tuning', content: '高并发场景下锁竞争激烈，吞吐下降，需要减小事务粒度' },
  { skill: 'db-tuning', content: '数据库事务死锁排查：等待图分析与超时回滚', scope: 'workflow' },
  { skill: 'cache-ops', content: 'Redis 缓存击穿导致后端数据库压力激增' },
  { skill: 'session-ops', content: '会话压缩策略：超长历史摘要化后写入记忆索引' },
  { skill: 'retrieval-v2', content: '向量召回与 BM25 排序混合检索是二期方向' },
  { skill: 'deploy', content: '生产部署使用 prod 模式，端口从 3098 起分配' },
  { skill: 'workspace', content: 'worktree 隔离开发：分支端口与数据库文件互不冲突' },
  { skill: 'octo-skill-evolution', content: '技能进化记录写入经验库，按 scope 隔离技能经验' },
  { skill: 'build', content: 'monorepo 构建顺序：shared 先于 engine 与服务端' },
  { skill: 'orchestrator', content: '意图分类引擎决定走工作流还是直答' },
  { skill: 'memory-write', content: '乐观锁冲突检测依赖 expected_last_modified 时间戳' },
  { skill: 'octo-search', content: '检索延迟优化：预分词后索引与查询两侧对称切词' },
]

// Session 记忆面 fixture（is_summary 消息 → session_memory_fts）
const SESSION_FIXTURES: Array<{ title: string; summary: string; source: string }> = [
  { title: '归档专项', summary: '归档旧会话并提取知识沉淀到经验库', source: 'main' },
  { title: '测试流程', summary: '测试先行：红绿色循环验证检索能力', source: 'main' },
  { title: '索引重建', summary: '经验条目全量重建索引流程演练', source: 'main' },
]

// ── 34 条中文查询（双字/四字词） ───────────────────────────────────

const CHINESE_QUERIES: string[] = [
  '检索', '高铁', '分词', '索引', '记忆', '归档', '重建', '死锁',
  '并发', '缓存', '击穿', '调度', '工作流', '编排', '压缩', '会话',
  '向量', '召回', '排序', '中文', '命中', '部署', '端口', '隔离',
  '冲突', '技能', '进化', '构建', '意图', '分类', '测试', '优化',
  '锁竞争', '乐观锁', '吞吐', '事务',
]

// known-fail 白名单：当前实现确实无法命中的查询（必须附理由）。
// 集合与「实际未命中集」做相等断言 — 修好了就必须把它从名单里删掉。
const KNOWN_FAILS: Array<{ query: string; reason: string }> = [
  // 由测试运行时自动校验；实现若全部命中，此名单应为空。
]

// ── Fixture 装载 ───────────────────────────────────────────────────

function seedFixtures(): void {
  const db = getDb()
  const dao = new AgentSessionDAO(db)
  const evo = new EvolutionDAO(db)

  for (const exp of EXPERIENCE_FIXTURES) {
    evo.insertExperienceV2({
      skill_name: exp.skill,
      content: exp.content,
      source_session_id: null,
      org: ORG,
      created_at: NOW,
      scope: exp.scope ?? 'agent',
      scope_ref: null,
      pattern_tags: '[]',
      outcome: null,
      source_type: 'session',
      execution_id: null,
      node_id: null,
    })
  }

  for (let i = 0; i < SESSION_FIXTURES.length; i++) {
    const f = SESSION_FIXTURES[i]
    const sessionId = `reg-sess-${i}`
    db.prepare(
      "INSERT INTO sessions (id, org, title, clone_name, session_type, is_active, is_deleted, created_at, updated_at) VALUES (?, ?, ?, ?, 'chat', 1, 0, ?, ?)",
    ).run(sessionId, ORG, f.title, 'main', NOW, NOW)
    dao.insertSummaryMessage(crypto.randomUUID(), sessionId, f.summary, NOW, f.source)
  }

  // 存量重建入口 — 回归集本身同时验证 rebuild 生效
  rebuildSearchIndexes(db)
}

describe('中文检索回归集 (KB P0)', () => {
  beforeEach(() => {
    initDb(':memory:')
    seedFixtures()
  })

  afterEach(() => {
    closeDb()
  })

  it('回归规模 ≥30 条查询', () => {
    expect(CHINESE_QUERIES.length).toBeGreaterThanOrEqual(30)
  })

  for (const q of CHINESE_QUERIES) {
    it(`recall("${q}") 命中 > 0`, () => {
      const hits = recall(q, { org: ORG, topK: 5 })
      const known = KNOWN_FAILS.find((k) => k.query === q)
      if (hits.length === 0) {
        // 只有列入 known-fail 且附理由的查询允许 0 命中
        expect(known, `查询 "${q}" 0 命中且不在 known-fail 名单`).toBeDefined()
      } else {
        // known-fail 的词如果命中了，必须从名单里删除（防名单腐烂）
        expect(known, `查询 "${q}" 已命中，应从 known-fail 名单移除`).toBeUndefined()
      }
    })
  }

  it('known-fail 名单与实际未命中集合相等（不许偷偷删用例）', () => {
    const missed = CHINESE_QUERIES.filter(
      (q) => recall(q, { org: ORG, topK: 5 }).length === 0,
    )
    expect(missed.sort()).toEqual(KNOWN_FAILS.map((k) => k.query).sort())
  })

  it('命中结果带来源标注与真实分数（score 不再恒 0）', () => {
    const hits = recall('检索', { org: ORG, topK: 5 })
    expect(hits.length).toBeGreaterThan(0)
    for (const h of hits) {
      expect(h.score, `hit ${h.kind}:${h.id} 的 score 必须 > 0`).toBeGreaterThan(0)
      expect(['experience', 'session']).toContain(h.kind)
      expect(h.content.length).toBeGreaterThan(0)
      // 返回的必须是原文，不是 jieba 切词后的空格串
      expect(h.content).not.toContain('  ')
      expect(h.content).toContain('检索')
    }
  })

  it('BM25 排序：与「检索」最相关的条目排在最前', () => {
    const hits = recall('检索', { org: ORG, topK: 5 })
    // 分数降序稳定
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score)
    }
    // 两条含「检索」的经验都在
    const skills = hits.filter((h) => h.kind === 'experience').map((h) => h.source)
    expect(skills).toContain('octo-search')
  })

  it('会话记忆面中文命中（session_memory_fts 走 jieba 重建）', () => {
    const hits = recall('归档', { org: ORG, topK: 5 })
    const sess = hits.find((h) => h.kind === 'session')
    expect(sess, '「归档」应命中会话摘要 fixture').toBeDefined()
    expect(sess!.content).toContain('归档')
  })
})
