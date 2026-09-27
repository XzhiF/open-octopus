// packages/server/src/services/agent/recall-service.ts
//
// recall() — 系统 agent 的第一个读工具（KB P0 止血 · P1 B3 迁 PG）。
//
// 双检索面（P1 B3：FTS5 虚表退役 → PG 真表检索面，见 db/dao/* 与 db/pg/README）：
//   1. experiences 真表   （经验库；org + scope 过滤）
//   2. messages 真表面    （会话记忆摘要 is_summary=true；org + source 过滤）
//
// 与写侧伪工具（record_daily / create_experience …）的本质区别：这是真实
// SDK MCP 工具（经 providers 的 createInProcessMcpServer 注入），返回值回灌
// 模型上下文，模型可基于命中内容继续推理。
//
// 分数语义：DAO 检索面统一给 (0,1)，越大越相关；结果按分数降序。
// B3 段2：两 DAO 主路径均为 pg_search BM25（idx_messages_bm25 /
// idx_experiences_bm25，paradedb.score s/(1+s) 归一），ILIKE 两段式只在
// tantivy 抛错或零命中时兜底（分层常数 0.9/0.4）。中文链路不再经 jieba
// 预分词 —— 文档侧 CJK 单字切由 tantivy 完成，召回口径见 db/pg/README。

import { z } from 'zod'
import {
  createInProcessMcpServer,
  type InProcessMcpServer,
  type InProcessToolDef,
} from '@octopus/providers'
import { AgentSessionDAO, EvolutionDAO } from '../../db/dao'
import { pgSql } from '../../db/dao/registry'

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
export async function recall(query: string, opts: RecallOptions): Promise<RecallHit[]> {
  const topK = Math.min(Math.max(opts.topK ?? DEFAULT_TOP_K, 1), MAX_TOP_K)
  const hits: RecallHit[] = []

  hits.push(...(await recallExperiences(query, opts.org, opts.scope, topK)))
  // session 面没有 scope 维度：带 scope 过滤时不掺入，避免「过滤语义错位」的假命中
  if (!opts.scope) {
    hits.push(...(await recallSessions(query, opts.org, opts.source, topK)))
  }

  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, topK)
}

async function recallExperiences(query: string, org: string, scope: string | undefined, limit: number): Promise<RecallHit[]> {
  const rows = await new EvolutionDAO(pgSql()).searchExperiencesForRecall(query, org, scope, limit)
  return rows.map((r) => ({
    kind: 'experience' as const,
    id: String(r.id),
    title: r.skill_name,
    content: r.content,
    score: r.score,
    source: r.skill_name,
    scope: r.scope ?? null,
    created_at: r.created_at,
  }))
}

async function recallSessions(query: string, org: string, source: string | undefined, limit: number): Promise<RecallHit[]> {
  const rows = await new AgentSessionDAO(pgSql()).searchSessionMemory(query, limit, source, org)
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

// ── 检索面「重建」入口（P1 B3 后语义收缩） ───────────────────────
//
// PG 侧 BM25/检索面直接打在 messages/experiences 真表上，由引擎自动维护 ——
// 不再有「重灌影子表」。本函数保留为幂等计数入口（REST 端点与测试的
// 现约不断）：返回当前两面的可检索行数。
// 触发方式：
//   · REST: POST /api/agent/memory/rebuild-fts（misc-routes）
//   · 测试/脚本: 直接 import rebuildSearchIndexes()

export interface RebuildResult {
  session_indexed: number
  experience_indexed: number
}

export async function rebuildSearchIndexes(): Promise<RebuildResult> {
  const sessionIndexed = await new AgentSessionDAO(pgSql()).rebuildFtsIndex()
  const experienceIndexed = await new EvolutionDAO(pgSql()).countExperiences()
  return { session_indexed: sessionIndexed, experience_indexed: experienceIndexed }
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
    handler: async (args) => {
      const query = String(args.query ?? '')
      const scope = typeof args.scope === 'string' && args.scope ? args.scope : undefined
      const limit = typeof args.limit === 'number' ? args.limit : undefined
      try {
        const hits = await recall(query, { org, topK: limit, scope })
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
