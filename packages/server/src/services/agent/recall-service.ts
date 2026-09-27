// packages/server/src/services/agent/recall-service.ts
//
// recall() — 系统 agent 的第一个读工具（KB P0 止血）。
//
// BM25 over jieba 预分词的 FTS5，双检索面：
//   1. experiences_fts  （经验库；org + scope 过滤）
//   2. session_memory_fts（会话记忆摘要；org + source 过滤）
//
// 与写侧伪工具（record_daily / create_experience …）的本质区别：这是真实
// SDK MCP 工具（经 providers 的 createInProcessMcpServer 注入），返回值同步
// 回灌模型上下文，模型可基于命中内容继续推理。
//
// 分数语义：FTS5 bm25() → bm25ToScore 映射到 (0,1)，越大越相关；结果按分数
// 降序。不再有「score 恒 0」的占位。

import { z } from 'zod'
import {
  createInProcessMcpServer,
  type InProcessMcpServer,
  type InProcessToolDef,
} from '@octopus/providers'
import { getDb } from '../../db/connection'
import { AgentSessionDAO } from '../../db/dao'
import { buildFtsMatch, bm25ToScore, segIndex } from '../../cjk-segmenter'

type SqliteDb = ReturnType<typeof getDb>

// ── Types ──────────────────────────────────────────────────────

export interface RecallHit {
  kind: 'experience' | 'session'
  id: string
  /** experience → skill_name；session → 会话标题 */
  title: string
  /** 原文（经 rowid 回连源表），绝不是切词串 */
  content: string
  /** bm25 映射到 (0,1)，越大越相关 */
  score: number
  /** experience → skill_name；session → 'main' | clone 名 */
  source: string
  /** experience scope（'agent' | 'workflow' | …）；session 面无此维度 */
  scope: string | null
  created_at: string
}

export interface RecallOptions {
  org: string
  topK?: number
  /** 限定经验 scope；给出时会场面不参与（session 无 scope 维度） */
  scope?: string
  /** 限定记忆来源（'main' | clone 名），只作用于会场面 */
  source?: string
}

const DEFAULT_TOP_K = 5
const MAX_TOP_K = 20

// ── recall ─────────────────────────────────────────────────────

/**
 * 统一读入口：跨经验库 + 会话记忆做 BM25 检索，合并排序返回。
 * 空查询/纯标点 → 显式空数组（不是异常，也不是「语法合法但永空」的静默坑）。
 */
export function recall(query: string, opts: RecallOptions): RecallHit[] {
  const topK = Math.min(Math.max(opts.topK ?? DEFAULT_TOP_K, 1), MAX_TOP_K)
  const hits: RecallHit[] = []

  hits.push(...recallExperiences(query, opts.org, opts.scope, topK))
  // session 面没有 scope 维度：带 scope 过滤时不掺入，避免「过滤语义错位」的假命中
  if (!opts.scope) {
    hits.push(...recallSessions(query, opts.org, opts.source, topK))
  }

  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, topK)
}

/** AND 优先（精度），AND 落空退 OR（召回，接住切词歧义）。返回两种 MATCH 或 null。 */
function matchForms(query: string): { and: string | null; or: string | null } {
  const and = buildFtsMatch(query, 'and')
  const or = buildFtsMatch(query, 'or')
  return { and, or: or === and ? null : or }
}

function recallExperiences(query: string, org: string, scope: string | undefined, limit: number): RecallHit[] {
  const { and, or } = matchForms(query)
  if (!and) return []
  const db = getDb()

  const run = (match: string): RecallHit[] => {
    let sql = `
      SELECT e.id AS id, e.skill_name AS skill_name, e.content AS content,
             e.scope AS scope, e.created_at AS created_at,
             bm25(experiences_fts) AS rank
      FROM experiences_fts
      JOIN experiences e ON e.id = experiences_fts.rowid
      WHERE experiences_fts MATCH ? AND e.org = ?`
    const params: unknown[] = [match, org]
    if (scope) {
      sql += ` AND e.scope = ?`
      params.push(scope)
    }
    sql += ` ORDER BY rank LIMIT ?`
    params.push(limit)

    const rows = db.prepare(sql).all(...params) as Array<{
      id: number; skill_name: string; content: string; scope: string; created_at: string; rank: number
    }>
    return rows.map((r) => ({
      kind: 'experience' as const,
      id: String(r.id),
      title: r.skill_name,
      content: r.content,
      score: bm25ToScore(r.rank),
      source: r.skill_name,
      scope: r.scope ?? null,
      created_at: r.created_at,
    }))
  }

  const hits = run(and)
  return hits.length > 0 || !or ? hits : run(or)
}

function recallSessions(query: string, org: string, source: string | undefined, limit: number): RecallHit[] {
  const dao = new AgentSessionDAO(getDb())
  const rows = dao.searchSessionMemory(query, limit, source, org)
  return rows.map((r) => ({
    kind: 'session' as const,
    id: r.session_id,
    title: r.session_title,
    content: r.summary,
    score: r.score,
    source: r.source,
    scope: null,
    created_at: r.created_at,
  }))
}

// ── 存量索引重建（显式入口，绝不上启动路径） ─────────────────────
//
// 预分词改造前，两张 FTS 表存的是原文（中文对 unicode61 是单一大 token，
// 永不命中）。本函数把两张表按「查询侧同款切法」全量重灌。
// 触发方式：
//   · REST: POST /api/agent/memory/rebuild-fts（misc-routes）
//   · 测试/脚本: 直接 import rebuildSearchIndexes()

export interface RebuildResult {
  session_indexed: number
  experience_indexed: number
}

export function rebuildSearchIndexes(db: SqliteDb = getDb()): RebuildResult {
  const sessionIndexed = new AgentSessionDAO(db).rebuildFtsIndex()

  // experiences_fts：standalone FTS5（非 external-content），列布局不动，
  // 只重灌内容 —— content/pattern_tags 存 jieba 切词串，原文仍在 experiences 表。
  db.prepare('DELETE FROM experiences_fts').run()
  const rows = db.prepare(`
    SELECT id, skill_name, content, scope, scope_ref, pattern_tags
    FROM experiences
    ORDER BY id
  `).all() as Array<{
    id: number; skill_name: string; content: string
    scope: string; scope_ref: string | null; pattern_tags: string | null
  }>
  const insert = db.prepare(`
    INSERT INTO experiences_fts (rowid, skill_name, content, scope, scope_ref, pattern_tags)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  for (const r of rows) {
    insert.run(
      r.id,
      segIndex(r.skill_name),
      segIndex(r.content),
      r.scope ?? 'agent',
      r.scope_ref ?? null,
      segIndex(r.pattern_tags ?? '[]'),
    )
  }
  return { session_indexed: sessionIndexed, experience_indexed: rows.length }
}

// ── MCP 工具面（注册进系统 agent 的 SDK 工具列表） ─────────────────

export const RECALL_MCP_SERVER_NAME = 'octopus-memory'

/** 系统 agent 的 tool 全名（SDK 前缀规则：mcp__{server}__{tool}）。 */
export const RECALL_TOOL_NAME = `mcp__${RECALL_MCP_SERVER_NAME}__recall`

export const RECALL_TOOL_PROMPT = `
## Recall Tool (Read)

检索你自己沉淀的经验库与会话记忆（BM25 相关度排序，中文可用）：

- **${RECALL_TOOL_NAME}**: Search your accumulated experiences and session memories. Input: { query: string (中文/English 关键词均可), scope?: string ('agent' | 'workflow' | ... 限定经验 scope), limit?: number (1-20, default 5) }. Output: JSON hits [{kind, title, content, score, source, created_at}] sorted by relevance.

### When to use recall (✅)
- 回答前查证「以前是否处理过同类问题 / 有无沉淀经验」
- 用户提及历史决策、旧会话内容、某技能过去的教训
- 在 record_daily / create_experience 之前，先查是否已有同主题记忆（避免重复沉淀）

### When NOT to use recall (❌)
- 与你的历史记忆无关的通用知识问题
- 同一轮对话里对同一 query 反复重试（0 命中就是没有，换关键词才有意义）

0 命中时返回空 hits 列表 —— 相信它，不要臆造记忆。
`

/**
 * recall 工具的 InProcessToolDef —— 与 MCP server 装配解耦，便于对 handler 直接测试。
 * buildRecallMcpServer 只是把它塞进 createInProcessMcpServer。
 */
export function buildRecallToolDef(org: string): InProcessToolDef {
  return {
    name: 'recall',
    description:
      'Search the agent long-term memory: BM25 over experiences and session summaries (Chinese-friendly). Returns ranked hits with source attribution.',
    schema: {
      query: z.string().describe('Keyword query, Chinese or English'),
      scope: z.string().optional().describe('Restrict to experience scope (e.g. "agent", "workflow")'),
      limit: z.number().int().min(1).max(MAX_TOP_K).optional().describe('Max hits to return (default 5)'),
    },
    handler: (args) => {
      const query = String(args.query ?? '')
      const scope = typeof args.scope === 'string' && args.scope ? args.scope : undefined
      const limit = typeof args.limit === 'number' ? args.limit : undefined
      try {
        const hits = recall(query, { org, topK: limit, scope })
        return { text: JSON.stringify({ query, hits }) }
      } catch (err) {
        // 显式报错而不是伪装成空结果 —— 模型必须能区分「没查到」与「查坏了」
        const msg = err instanceof Error ? err.message : String(err)
        return { text: JSON.stringify({ query, error: `recall failed: ${msg}` }), isError: true }
      }
    },
  }
}

/**
 * 为某个 org 构造 recall 的进程内 MCP server。
 * 调用方塞进 provider.sendQuery(…, { mcpServers: { [RECALL_MCP_SERVER_NAME]: server } })。
 */
export function buildRecallMcpServer(org: string): InProcessMcpServer {
  return createInProcessMcpServer(RECALL_MCP_SERVER_NAME, [buildRecallToolDef(org)])
}
