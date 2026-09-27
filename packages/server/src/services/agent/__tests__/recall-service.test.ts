/**
 * recall-service — 系统 agent 第一个读工具的核心行为测试。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import crypto from 'crypto'
import { initDb, closeDb, getDb } from '../../../db/connection'
import { AgentSessionDAO, EvolutionDAO } from '../../../db/dao'
import { recall, rebuildSearchIndexes, buildRecallMcpServer, buildRecallToolDef, RECALL_MCP_SERVER_NAME, RECALL_TOOL_NAME, type RecallHit } from '../recall-service'

const ORG_A = 'recall-org-a'
const ORG_B = 'recall-org-b'

function seedExp(skill: string, content: string, org = ORG_A, scope = 'agent'): void {
  new EvolutionDAO(getDb()).insertExperienceV2({
    skill_name: skill, content, source_session_id: null, org, created_at: new Date().toISOString(),
    scope, scope_ref: null, pattern_tags: '[]', outcome: null, source_type: 'session',
    execution_id: null, node_id: null,
  })
}

describe('recall-service', () => {
  beforeEach(() => {
    initDb(':memory:')
    const db = getDb()
    const dao = new AgentSessionDAO(db)
    const now = new Date().toISOString()

    seedExp('octo-search', '中文检索依赖 jieba 预分词')
    seedExp('rail', '高铁调度与检索路径规划', ORG_B)
    seedExp('cache', '缓存击穿与雪崩的成因辨析', ORG_A, 'workflow')

    db.prepare(
      "INSERT INTO sessions (id, org, title, clone_name, session_type, is_active, is_deleted, created_at, updated_at) VALUES (?, ?, ?, ?, 'chat', 1, 0, ?, ?)",
    ).run('sa', ORG_A, '记忆会议', 'main', now, now)
    dao.insertSummaryMessage(crypto.randomUUID(), 'sa', '讨论了检索链路重建方案', now, 'main')
    rebuildSearchIndexes()
  })

  afterEach(() => closeDb())

  it('rebuildSearchIndexes 覆盖两个 FTS 面并返回计数', () => {
    const r = rebuildSearchIndexes()
    expect(r.experience_indexed).toBe(3)
    expect(r.session_indexed).toBe(1)
    // 幂等
    const r2 = rebuildSearchIndexes()
    expect(r2).toEqual(r)
  })

  it('中文查询命中双来源（experience + session）', () => {
    const hits = recall('检索', { org: ORG_A, topK: 10 })
    const kinds = new Set(hits.map((h) => h.kind))
    expect(kinds.has('experience')).toBe(true)
    expect(kinds.has('session')).toBe(true)
  })

  it('org 隔离：只返回本 org 条目', () => {
    for (const h of recall('高铁', { org: ORG_A, topK: 10 })) {
      expect.fail(`ORG_A 不应命中 org_b 条目: ${h.content}`)
    }
    expect(recall('高铁', { org: ORG_A, topK: 10 })).toEqual([])
    const hitsB = recall('高铁', { org: ORG_B, topK: 10 })
    expect(hitsB.length).toBe(1)
  })

  it('scope 过滤只作用于经验面', () => {
    const hits = recall('缓存', { org: ORG_A, topK: 10, scope: 'workflow' })
    expect(hits.length).toBe(1)
    expect(hits[0].kind).toBe('experience')
    expect(hits[0].scope).toBe('workflow')
    // session 面无 scope 维度，scope 存在时不掺入 session hits
    expect(recall('检索', { org: ORG_A, topK: 10, scope: 'workflow' }).every((h) => h.kind === 'experience')).toBe(true)
  })

  it('topK 截断且按分数降序', () => {
    seedExp('more', '更多检索与向量召回的检索笔记')
    rebuildSearchIndexes()
    const hits = recall('检索', { org: ORG_A, topK: 2 })
    expect(hits.length).toBeLessThanOrEqual(2)
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score)
    }
  })

  it('空/标点查询 → 显式空结果不抛异常', () => {
    expect(() => recall('', { org: ORG_A })).not.toThrow()
    expect(recall('', { org: ORG_A })).toEqual([])
    expect(recall('！！', { org: ORG_A })).toEqual([])
  })

  it('返回内容必须是原文而非切词串', () => {
    const hits = recall('检索', { org: ORG_A, topK: 10 })
    for (const h of hits) {
      expect(h.content).not.toMatch(/\S \S*检索 \S/)
      expect(h.content).toContain('检索')
    }
  })

  it('hit 携带来源标注字段', () => {
    const hits: RecallHit[] = recall('缓存', { org: ORG_A, topK: 5 })
    const h = hits[0]
    expect(h.source).toBe('cache') // experience → skill_name
    expect(h.created_at).toBeTruthy()
    const sess = recall('检索', { org: ORG_A, topK: 10 }).find((x) => x.kind === 'session')
    expect(sess!.title).toBe('记忆会议')
    expect(sess!.source).toBe('main')
  })

  // ── MCP 工具面（注册进系统 agent 的 SDK 工具） ──────────────

  it('buildRecallToolDef: handler 回灌 JSON hits（读工具真实返回值，非事后伪工具）', async () => {
    const def = buildRecallToolDef(ORG_A)
    expect(def.name).toBe('recall')
    const res = await def.handler({ query: '检索' })
    expect(res.isError).toBeFalsy()
    const parsed = JSON.parse(res.text) as { query: string; hits: RecallHit[] }
    expect(parsed.query).toBe('检索')
    expect(parsed.hits.length).toBeGreaterThan(0)
    expect(parsed.hits[0].content).toContain('检索')
  })

  it('buildRecallToolDef: scope/limit 透传', async () => {
    const def = buildRecallToolDef(ORG_A)
    const res = await def.handler({ query: '缓存', scope: 'workflow', limit: 1 })
    const parsed = JSON.parse(res.text) as { hits: RecallHit[] }
    expect(parsed.hits.length).toBeLessThanOrEqual(1)
    expect(parsed.hits.every((h) => h.kind === 'experience')).toBe(true)
  })

  it('buildRecallToolDef: 查询崩溃时返回 isError，不伪装成空命中', async () => {
    const def = buildRecallToolDef('recall-org-a')
    closeDb() // 制造真实 DB 异常（getDb 抛 not initialized）
    const res = await def.handler({ query: '检索' })
    expect(res.isError).toBe(true)
    const parsed = JSON.parse(res.text) as { error?: string }
    expect(parsed.error).toContain('recall failed')
  })

  it('buildRecallMcpServer: SDK server 实例构造成功，工具名符合 mcp__ 前缀', () => {
    const server = buildRecallMcpServer(ORG_A) as unknown as {
      name: string; type: string; instance: { server?: { _registeredTools?: Record<string, unknown> } }
    }
    expect(server.name).toBe(RECALL_MCP_SERVER_NAME)
    expect(server.type).toBe('sdk')
    expect(server.instance).toBeTruthy()
    expect(RECALL_TOOL_NAME).toBe(`mcp__${RECALL_MCP_SERVER_NAME}__recall`)
  })
})
