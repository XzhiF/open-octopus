/**
 * TokenUsageDAO — 计量域（node_token_usages / llm_calls + 派生账本读模型）。
 * P1 B4：better-sqlite3 → postgres.js（BasePgDAO）。
 *
 * 行形态契约（pg-mappers 出口归一，旧 Row 接口不动直到 B6）：
 *   - llm_calls.timestamp/duration_ms/ttft_ms: PG bigint(int8) ↔ 旧 JS number
 *     （postgres.js 把 int8 给成 string —— 出口 num()/numOrNull() 归一）。
 *   - node_token_usages.created_at: PG timestamptz(Date) ↔ 旧 ISO 文本。
 *   - COUNT/SUM(int) PG 返回 int8/numeric（驱动侧 string）→ num()/numOrNull()。
 *   - cost_usd 派生列 = float8（IEEE-754 f8，与 SQLite REAL 同族 —— gold 逐位
 *     相等的前提；表达式单源见 ../price-sql）。
 *
 * 方言改写（本批）：
 *   - S9：insertLlmCallBatch 的 named-@ 逐行循环 → 一条多行 VALUES 批量
 *     （单语句天然原子，原 this.transaction() 随形消失；INSERT OR IGNORE →
 *     ON CONFLICT (id) DO NOTHING，changes 语义保留）。
 *   - S6：GROUP_CONCAT → string_agg。
 *   - datetime('now', '-N days') → now() - make_interval(days => ?)。
 *   - DATE(ts)/date(epoch,'unixepoch') → to_char(… AT TIME ZONE 'UTC')（UTC 口径同旧）。
 *   - ROUND(double,n) 不存在 → ::numeric 版 ROUND；除 int 侧统一 DOUBLE PRECISION。
 *   - PG 不允许：裸别名进 HAVING、FROM 子查询缺别名、CTE 里 SELECT 非分组列
 *     （SQLite 宽容的 bare-column 在此补齐分组键，语义不变）。
 *   - ORDER BY 可空列 DESC → 显式 NULLS LAST 对齐 SQLite（NULL 最小 → DESC 殿后）。
 *   - llm_calls / node_token_usages 对 node_executions 的 FK 在 PG 侧混合期撤除
 *     （行生产者 ExecutionDAO 属 B5，见 pg/README「B6 FK 恢复清单」）。
 *
 * 混合期读侧说明：executions/node_executions/workspaces 的**新**写入仍落 SQLite
 * （B5 迁移），本 DAO 对它们的 JOIN/子查询读 PG（数据搬迁快照 + 测试 PG 造数）；
 * execution 级联删 llm_calls/ntu 的旧路径仍在 execution/workspace-dao（B5 接管）。
 */
import { BasePgDAO, type PgSql } from "./base-pg"
import type { NodeTokenUsageRow, LlmCallRow } from "../types"
import {
  LEDGER_SQL, costSummary, normalizeModelId,
  type TokenUsage, type LedgerTotals, type LedgerCost, type LedgerRow,
  type LlmUsageRow, type LlmUsageSummary,
} from "@octopus/shared"
import { type NodeUsageSource } from "./usage-ledger"
import { pricedCallsSql, PRICED_AGG } from "../price-sql"
import { iso, isoOrNull, num, numOrNull } from "./pg-mappers"

/** llm_calls_costed 视图行 = 账本全列 + 查询时派生的 cost_usd(USD 基准)/vendor。 */
export type LlmCallCostedRow = LlmCallRow & { cost_usd: number | null; vendor: string | null }

/** 账本行的 snake→camel 列名映射（唯一一处），喂给 ledger 公式层。 */
export function toLedgerRows(rows: readonly LlmCallCostedRow[]): LlmUsageRow[] {
  return rows.map((r) => ({
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheCreationTokens: r.cache_creation_tokens,
    costUsd: r.cost_usd,
    model: r.model,
  }))
}

/** PG 驱动的 llm_calls(_costed) 原始行（int8 = timestamp 族为 string）。 */
interface LlmCallPgRow {
  id: string
  node_execution_id: string | null
  execution_id: string | null
  turn_index: number
  call_index: number
  message_id: string | null
  model: string | null
  stop_reason: string | null
  timestamp: string | number
  duration_ms: string | number
  ttft_ms: string | number | null
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  org: string | null
  workspace_id: string | null
  workflow_ref: string | null
  node_id: string | null
  session_id: string | null
  instance_id: string | null
  source_path: string | null
}
interface LlmCallCostedPgRow extends LlmCallPgRow {
  cost_usd: number | null
  vendor: string | null
}

/** llm_calls 原始行 → 旧契约行（int8 归一 number；派生列 numOrNull）。 */
function fromLlmCall(r: LlmCallCostedPgRow): LlmCallCostedRow {
  return {
    id: r.id,
    node_execution_id: r.node_execution_id,
    execution_id: r.execution_id,
    turn_index: r.turn_index,
    call_index: r.call_index,
    message_id: r.message_id,
    model: r.model,
    stop_reason: r.stop_reason,
    timestamp: num(r.timestamp),
    duration_ms: num(r.duration_ms),
    ttft_ms: numOrNull(r.ttft_ms),
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    cache_read_tokens: r.cache_read_tokens,
    cache_creation_tokens: r.cache_creation_tokens,
    org: r.org,
    workspace_id: r.workspace_id,
    workflow_ref: r.workflow_ref,
    node_id: r.node_id,
    session_id: r.session_id,
    instance_id: r.instance_id,
    source_path: r.source_path as LlmCallRow["source_path"],
    cost_usd: numOrNull(r.cost_usd),
    vendor: r.vendor,
  }
}

interface NtuPgRow {
  id: string
  node_execution_id: string
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  source?: string
  created_at: Date | string
}

function fromNtu(r: NtuPgRow): NodeTokenUsageRow {
  return {
    id: r.id,
    node_execution_id: r.node_execution_id,
    model: r.model,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    cache_read_tokens: r.cache_read_tokens,
    cache_creation_tokens: r.cache_creation_tokens,
    created_at: iso(r.created_at),
  }
}

/** insertLlmCall / 批插共用的 22 列清单（唯一写侧列序）。 */
const LLM_CALL_COLS = `id, node_execution_id, execution_id, turn_index, call_index, message_id,
        model, stop_reason, timestamp, duration_ms, ttft_ms,
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
        org, workspace_id, workflow_ref, node_id, session_id, instance_id, source_path`

const LLM_CALL_COLS_PER_ROW = 22
/** PG 协议参数上限 65535；400 行/批 = 8800 参，留足余量。 */
const LLM_CALL_BATCH_CHUNK = 400

function llmCallParams(row: LlmCallRow): unknown[] {
  return [
    row.id, row.node_execution_id, row.execution_id, row.turn_index, row.call_index,
    row.message_id, row.model, row.stop_reason, row.timestamp, row.duration_ms,
    row.ttft_ms, row.input_tokens, row.output_tokens, row.cache_read_tokens,
    row.cache_creation_tokens,
    row.org, row.workspace_id, row.workflow_ref, row.node_id, row.session_id, row.instance_id,
    row.source_path ?? null,
  ]
}

const LLM_CALL_PLACEHOLDER_ROW = `(${Array(LLM_CALL_COLS_PER_ROW).fill('?').join(', ')})`

export class TokenUsageDAO extends BasePgDAO {
  constructor(db: PgSql) { super(db) }

  /**
   * billing NEW-r2：本 DAO 不持算价对象 —— 钱不落账本，一切费用查询经
   * llm_calls_costed 视图（../price-sql 生成的 DDL，B4 起双引擎共用同一条生成串）
   * 按窗口现算。汇率在视图内实时读 billing_setting（改汇率 → 全局折价重算，
   * 与价表同族语义）。
   */

  /**
   * 通用派生费用聚合：对 llm_calls 套价格匹配片段，按 where(原生列条件) 现算全局
   * LedgerCost 三态（全无价 → usd NULL；空集 → complete vacuous true）。
   */
  private async derivedCost(where: string[] = [], params: unknown[] = []): Promise<LedgerCost> {
    const { sql, params: innerParams } = pricedCallsSql(where, params)
    const row = await this.q1<{ usd: number | null; complete: number }>(`
      SELECT ${PRICED_AGG.sumCost()} AS usd, ${PRICED_AGG.complete()} AS complete
      FROM (${sql}) q
    `, innerParams)
    return { usd: numOrNull(row?.usd), complete: row?.complete === 1 }
  }

  /** 单节点费用（NEW-r2：node_end SSE / 节点视图的现算钱，与报表同源）。 */
  async costForNodeExecution(nodeExecutionId: string): Promise<LedgerCost> {
    return this.derivedCost(["l.node_execution_id = ?"], [nodeExecutionId])
  }

  /**
   * NEW-r2: 对 llm_calls_costed 按列分组派生费用（一次扫描；JS 侧与 token 行合流）。
   * key = keyCols 值以 "|" 连接（NULL → "null"）。usd 全未定价→NULL 不焊 0；
   * complete = 组内全部有价（空组 vacuous true，对齐 LEDGER_SQL.costComplete）。
   */
  private async costGroupedBy(keyCols: string[], where: string[] = [], params: unknown[] = []): Promise<Map<string, { usd: number | null; complete: boolean }>> {
    const { sql, params: innerParams } = pricedCallsSql(where, params)
    const cols = keyCols.map(k => `q.${k}`)
    const rows = await this.q<Record<string, unknown> & { usd: number | null; total: string | number; priced: string | number }>(`
      SELECT ${cols.join(", ")},
             ${PRICED_AGG.sumCost()} AS usd,
             COUNT(*) AS total,
             ${PRICED_AGG.countPriced()} AS priced
      FROM (${sql}) q
      GROUP BY ${cols.join(", ")}
    `, innerParams)
    const map = new Map<string, { usd: number | null; complete: boolean }>()
    for (const r of rows) {
      map.set(keyCols.map(k => String(r[k] ?? "null")).join("|"), { usd: numOrNull(r.usd), complete: num(r.total) === num(r.priced) })
    }
    return map
  }

  // ── node_token_usages ───────────────────────────────────────────

  async findByNodeExecution(nodeExecutionId: string): Promise<NodeTokenUsageRow[]> {
    const rows = await this.q<NtuPgRow>(
      "SELECT * FROM node_token_usages WHERE node_execution_id = ?", [nodeExecutionId],
    )
    return rows.map(fromNtu)
  }

  async findByExecution(executionId: string): Promise<NodeTokenUsageRow[]> {
    const rows = await this.q<NtuPgRow>(`
      SELECT ntu.* FROM node_token_usages ntu
      JOIN node_executions ne ON ntu.node_execution_id = ne.id
      WHERE ne.execution_id = ?
    `, [executionId])
    return rows.map(fromNtu)
  }

  async findByExecutionPerStep(executionId: string): Promise<Array<NodeTokenUsageRow & { node_id: string }>> {
    const rows = await this.q<NtuPgRow & { node_id: string }>(`
      SELECT ne.node_id, ntu.* FROM node_token_usages ntu
      JOIN node_executions ne ON ntu.node_execution_id = ne.id
      WHERE ne.execution_id = ?
    `, [executionId])
    return rows.map(r => ({ ...fromNtu(r), node_id: r.node_id }))
  }

  /**
   * node_token_usages 唯一写入口（C3 · UsageLedger + billing NEW-r2）。三条旧路径
   * （ExecutionDAO.insertNodeTokenUsage / 本表旧 insert / HarnessDAO.insertHarnessTokenUsage）
   * 收编于此：UPSERT 累加 + source 判别。
   *
   * NEW-r2：cost_usd 快照列已删 —— 本表回归纯 token 账（节点/执行费用的钱从
   * llm_calls 查询时派生，见 derivedCost / 各 ranking）。model 落库前归一化
   * （shared normalizeModelId，与 llm_calls 同一规范名空间）。
   * B4：ON CONFLICT DO UPDATE 的裸列名按 PG 要求限定表名。
   */
  async recordNodeUsage(input: {
    id: string
    nodeExecutionId: string
    model: string
    usage: Pick<TokenUsage, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheCreationTokens'>
    /** @deprecated SDK/calibrate 上报价不再作为落库 cost 来源（KD2）；NEW-r2 起本入口彻底无 cost。参数仅为调用方兼容保留。 */
    costUsd?: number | null
    source: NodeUsageSource
    createdAt: string
  }): Promise<{ changes: number }> {
    const model = normalizeModelId(input.model) ?? input.model
    return this.exec(`
      INSERT INTO node_token_usages (id, node_execution_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        input_tokens = node_token_usages.input_tokens + excluded.input_tokens,
        output_tokens = node_token_usages.output_tokens + excluded.output_tokens,
        cache_read_tokens = node_token_usages.cache_read_tokens + excluded.cache_read_tokens,
        cache_creation_tokens = node_token_usages.cache_creation_tokens + excluded.cache_creation_tokens,
        created_at = excluded.created_at
    `, [
      input.id, input.nodeExecutionId, model,
      input.usage.inputTokens, input.usage.outputTokens,
      input.usage.cacheReadTokens, input.usage.cacheCreationTokens,
      input.source, input.createdAt,
    ])
  }

  async deleteByNodeExecution(nodeExecutionId: string): Promise<{ changes: number }> {
    return this.exec("DELETE FROM node_token_usages WHERE node_execution_id = ?", [nodeExecutionId])
  }

  async deleteByExecution(executionId: string): Promise<{ changes: number }> {
    return this.exec(`
      DELETE FROM node_token_usages WHERE node_execution_id IN (
        SELECT id FROM node_executions WHERE execution_id = ?
      )
    `, [executionId])
  }

  /** 全局费用（NEW-r2：源 = llm_calls 全账本派生 —— 含聊天/压缩行，与报表同源同规则）。 */
  async totalCost(): Promise<LedgerCost> {
    return this.derivedCost()
  }

  // ── llm_calls ───────────────────────────────────────────────────

  /** NEW-r2：读侧统一走派生视图 —— 行上带查询时算好的 cost_usd/vendor。 */
  async findLlmCallsByExecution(executionId: string, nodeId?: string): Promise<LlmCallCostedRow[]> {
    let query = `SELECT * FROM llm_calls_costed WHERE execution_id = ?`
    const params: unknown[] = [executionId]
    if (nodeId) { query += ` AND node_id = ?`; params.push(nodeId) }
    query += ` ORDER BY turn_index, call_index`
    const rows = await this.q<LlmCallCostedPgRow>(query, params)
    return rows.map(fromLlmCall)
  }

  /**
   * 会话口径的逐 call 行（v49：聊天角标 / 会话明细）。**不做 message 去重** ——
   * 执行端点的去重是给「并行票共享会话、同一条消息被多个在跑节点各记一行」那个
   * bug 生的（写侧 insertLlmCallBatch 同样显式豁免 execution_id 为空的行）；
   * 聊天行是 recordProviderResultUsage「每 modelUsage 一行」的真实拆分，
   * 按 message_id 去重会把混合模型轮次的第二个模型吞掉。
   */
  async findLlmCallsBySession(sessionId: string): Promise<LlmCallCostedRow[]> {
    const rows = await this.q<LlmCallCostedPgRow>(
      `SELECT * FROM llm_calls_costed WHERE session_id = ? ORDER BY timestamp, id`, [sessionId],
    )
    return rows.map(fromLlmCall)
  }

  /**
   * 执行级总量 —— token 总量仍以 ntu 为账（运行中逐轮累加，与 steps/REST 终态同源，
   * C3/Q4 的「运行中↔完成跳变根除」结论不变）；NEW-r2 起 **cost 改从 llm_calls
   * 按 execution_id 派生**（与 billing 报表同源，节点完成时随 persist 到位）。
   * totalLlmTurns 仍是明细计数（llm_calls 行），与总量无关。
   */
  async aggregateByExecution(executionId: string): Promise<{
    usage: TokenUsage
    totals: LedgerTotals
    totalLlmTurns: number
    errorCount: number
  }> {
    const row = await this.q1<{
      totalInputTokens: number
      totalOutputTokens: number
      totalCacheReadTokens: number
      totalCacheCreationTokens: number
      tokens: string | number | null
      cache_hit_rate: number | null
    }>(`
      SELECT
        COALESCE(SUM(ntu.input_tokens), 0) as "totalInputTokens",
        COALESCE(SUM(ntu.output_tokens), 0) as "totalOutputTokens",
        COALESCE(SUM(ntu.cache_read_tokens), 0) as "totalCacheReadTokens",
        COALESCE(SUM(ntu.cache_creation_tokens), 0) as "totalCacheCreationTokens",
        ${LEDGER_SQL.sumTokens('ntu.')} as tokens,
        ${LEDGER_SQL.cacheHitRate('ntu.')} as cache_hit_rate
      FROM node_token_usages ntu
      JOIN node_executions ne ON ntu.node_execution_id = ne.id
      WHERE ne.execution_id = ?
    `, [executionId])

    const cost = await this.derivedCost(["l.execution_id = ?"], [executionId])

    const turns = await this.q1<{ n: string | number }>(
      "SELECT COUNT(*) as n FROM llm_calls WHERE execution_id = ?", [executionId],
    )

    // gold 逐位相等总验（票2B-3）抓出的迁移真 bug：裸 camelCase 别名 PG 小写化
    // （errorCount→errorcount），出口按旧契约 camelCase 读键必双引号 —— 2B-1 同族。
    const errors = await this.q1<{ errorCount: string | number }>(`
      SELECT COUNT(*) as "errorCount" FROM node_executions
      WHERE execution_id = ? AND status = 'failed'
    `, [executionId])

    return {
      usage: {
        inputTokens: num(row?.totalInputTokens),
        outputTokens: num(row?.totalOutputTokens),
        cacheReadTokens: num(row?.totalCacheReadTokens),
        cacheCreationTokens: num(row?.totalCacheCreationTokens),
      },
      totals: {
        tokens: num(row?.tokens),
        cost,
        cacheHitRate: numOrNull(row?.cache_hit_rate),
      },
      totalLlmTurns: num(turns?.n),
      errorCount: num(errors?.errorCount),
    }
  }

  /** 工作区时间窗内的费用（NEW-r2：源 = llm_calls 派生，与报表同一张账）。 */
  async costForWorkspaceSince(workspaceId: string, createdSinceIso: string): Promise<LedgerCost> {
    const sinceMs = Date.parse(createdSinceIso)
    const where = ["l.workspace_id = ?"]
    const params: unknown[] = [workspaceId]
    if (Number.isFinite(sinceMs)) { where.push("l.timestamp >= ?"); params.push(sinceMs) }
    return this.derivedCost(where, params)
  }

  /** 指定执行集合的费用（workflow 打分等跨执行总量，NEW-r2：llm_calls 派生）。 */
  async costForExecutions(executionIds: readonly string[]): Promise<LedgerCost> {
    if (executionIds.length === 0) return { usd: null, complete: true }
    const marks = executionIds.map(() => '?').join(',')
    return this.derivedCost([`l.execution_id IN (${marks})`], [...executionIds])
  }

  /**
   * 按归属键分组的账本用量摘要（v49：看板逐任务花费 = 逐 execution + 逐 session 两趟）。
   * 一次 GROUP BY 扫完一组键；聚合表达式全部取自 LEDGER_SQL / PRICED_AGG 单源，
   * 禁手写公式。`extraRawWhere` 只允许原生 llm_calls 列（视图谓词下推吃索引）——
   * 会话侧传 `['l.execution_id IS NULL']` 把带执行归属的行让给 execution 趟，防双计。
   */
  async aggregateLlmCallsBy(
    keyCol: 'execution_id' | 'session_id',
    ids: readonly string[],
    extraRawWhere: readonly string[] = [],
  ): Promise<Map<string, LlmUsageSummary>> {
    const out = new Map<string, LlmUsageSummary>()
    const uniq = [...new Set(ids)].filter((v): v is string => typeof v === 'string' && v.length > 0)
    if (uniq.length === 0) return out
    // 分片避开参数上限；动态占位符数量不进任何语句缓存（防变体灌爆）。
    const CHUNK = 400
    for (let i = 0; i < uniq.length; i += CHUNK) {
      const slice = uniq.slice(i, i + CHUNK)
      const marks = slice.map(() => '?').join(',')
      const { sql, params } = pricedCallsSql([`l.${keyCol} IN (${marks})`, ...extraRawWhere], [...slice])
      const rows = await this.q<{
        k: string | null
        i: string | number; o: string | number; cr: string | number; cc: string | number
        tokens: string | number | null; hit: number | null
        usd: number | null; total: string | number; priced: string | number; complete: number
      }>(`
        SELECT q.${keyCol} AS k,
               SUM(q.input_tokens) AS i,
               SUM(q.output_tokens) AS o,
               SUM(q.cache_read_tokens) AS cr,
               SUM(q.cache_creation_tokens) AS cc,
               ${LEDGER_SQL.sumTokens('q.')} AS tokens,
               ${LEDGER_SQL.cacheHitRate('q.')} AS hit,
               ${PRICED_AGG.sumCost('q')} AS usd,
               COUNT(*) AS total,
               ${PRICED_AGG.countPriced('q')} AS priced,
               ${PRICED_AGG.complete('q')} AS complete
        FROM (${sql}) q
        GROUP BY q.${keyCol}
      `, params)
      for (const r of rows) {
        if (r.k == null) continue
        const usage: TokenUsage = {
          inputTokens: num(r.i), outputTokens: num(r.o), cacheReadTokens: num(r.cr), cacheCreationTokens: num(r.cc),
        }
        out.set(r.k, {
          totalCalls: num(r.total),
          usage,
          totals: { tokens: num(r.tokens), cost: { usd: numOrNull(r.usd), complete: r.complete === 1 }, cacheHitRate: numOrNull(r.hit) },
        })
      }
    }
    return out
  }

  /** 单节点（node_id 语义）的逐 call 费用行 → LedgerRow（JS 镜像公式消费方，NEW-r2：源 = llm_calls 派生）。 */
  async findLedgerRowsByNodeId(executionId: string, nodeId: string): Promise<LedgerRow[]> {
    const rows = await this.q<{
      model: string | null; input_tokens: number; output_tokens: number
      cache_read_tokens: number; cache_creation_tokens: number; cost_usd: number | null
    }>(`
      SELECT q.model, q.input_tokens, q.output_tokens,
             q.cache_read_tokens, q.cache_creation_tokens, q.cost_usd
      FROM llm_calls_costed q
      WHERE q.execution_id = ? AND q.node_id = ?
    `, [executionId, nodeId])
    return rows.map(r => ({
      inputTokens: r.input_tokens, outputTokens: r.output_tokens,
      cacheReadTokens: r.cache_read_tokens, cacheCreationTokens: r.cache_creation_tokens,
      costUsd: numOrNull(r.cost_usd),
    }))
  }

  async findLlmCallsByNodeExecution(nodeExecutionId: string): Promise<LlmCallCostedRow[]> {
    const rows = await this.q<LlmCallCostedPgRow>(
      "SELECT * FROM llm_calls_costed WHERE node_execution_id = ?", [nodeExecutionId],
    )
    return rows.map(fromLlmCall)
  }

  // findLlmCallsByWorkspace —— v48 起零调用方，随快照账一并删除。

  async insertLlmCall(row: LlmCallRow): Promise<{ changes: number }> {
    return this.exec(`
      INSERT INTO llm_calls (${LLM_CALL_COLS})
      VALUES ${LLM_CALL_PLACEHOLDER_ROW}
      ON CONFLICT (id) DO NOTHING
    `, llmCallParams(row))
  }

  async deleteLlmCallsByExecution(executionId: string): Promise<{ changes: number }> {
    return this.exec(`
      DELETE FROM llm_calls WHERE node_execution_id IN (
        SELECT id FROM node_executions WHERE execution_id = ?
      )
    `, [executionId])
  }

  async cleanupOlderThan(timestamp: number): Promise<{ changes: number }> {
    return this.exec("DELETE FROM llm_calls WHERE timestamp < ?", [timestamp])
  }

  // ── Batch inserts（S9 · B4 重写）────────────────────────────────────

  /**
   * 多行 VALUES 批量插入（原 named-@ 逐行循环 + DAO 内事务 → 一条 SQL，
   * 原子性由单语句保证；INSERT OR IGNORE → ON CONFLICT (id) DO NOTHING，
   * changes 语义保留 —— 冲突行不计数，与旧逐行 .run() 汇总一致）。
   */
  async insertLlmCallBatch(rows: LlmCallRow[]): Promise<void> {
    if (rows.length === 0) return
    // 写侧兜底去重 (2026-09-21)：并行票曾共享会话 —— 同一条 LLM 消息被多个在跑节点
    // 各自缓冲、各自 flush，一条消息给三个节点各记一行，∑/请求数/成本全线膨胀
    // （phase-2 实测 547 行 vs 320 条真消息）。同一 execution 内按 message_id 只保
    // 一行（跨批 + 批内）；message_id 为空的行不去重、照原样插。
    const msgIdsByExec = new Map<string, string[]>()
    for (const r of rows) {
      // NEW-r2：execution_id 可空（clone_chat 等无执行归属的行）→ 无归属不去重
      if (!r.message_id || !r.execution_id) continue
      const list = msgIdsByExec.get(r.execution_id)
      if (list) list.push(r.message_id)
      else msgIdsByExec.set(r.execution_id, [r.message_id])
    }
    const existing = new Set<string>()
    for (const [execId, ids] of msgIdsByExec) {
      const placeholders = ids.map(() => "?").join(",")
      const found = await this.q<{ message_id: string }>(
        `SELECT message_id FROM llm_calls WHERE execution_id = ? AND message_id IN (${placeholders})`,
        [execId, ...ids],
      )
      for (const f of found) existing.add(`${execId}|${f.message_id}`)
    }
    const seen = new Set<string>()
    const kept = rows.filter((r) => {
      if (!r.message_id) return true
      const key = `${r.execution_id}|${r.message_id}`
      if (existing.has(key) || seen.has(key)) return false
      seen.add(key)
      return true
    })
    if (kept.length === 0) return
    for (let i = 0; i < kept.length; i += LLM_CALL_BATCH_CHUNK) {
      const chunk = kept.slice(i, i + LLM_CALL_BATCH_CHUNK)
      const values = chunk.map(() => LLM_CALL_PLACEHOLDER_ROW).join(", ")
      const params = chunk.flatMap(llmCallParams)
      await this.exec(
        `INSERT INTO llm_calls (${LLM_CALL_COLS}) VALUES ${values} ON CONFLICT (id) DO NOTHING`,
        params,
      )
    }
  }

  // ── Leaderboard queries ──────────────────────────────────────────────
  // NEW-r2：token 仍以 ntu 为账；cost 全部从 llm_calls_costed 视图派生
  // （costGroupedBy 一次扫描分组，JS 侧合流 —— 返回形状不变）。

  async getWorkspaceRanking(limit: number): Promise<Array<{
    workspace_id: string; workspace_name: string; total_tokens: number;
    total_cost_usd: number | null; cost_complete: number;
    model: string; input_tokens: number; output_tokens: number;
    cache_read_tokens: number; cache_creation_tokens: number; model_cost_usd: number | null
  }>> {
    const wsRows = await this.q<{ workspace_id: string; workspace_name: string; total_tokens: string | number }>(`
      SELECT w.id AS workspace_id, w.name AS workspace_name,
             ${LEDGER_SQL.sumTokens('ntu.')} AS total_tokens
      FROM node_token_usages ntu
      JOIN node_executions ne ON ntu.node_execution_id = ne.id
      JOIN executions e ON ne.execution_id = e.id
      JOIN workspaces w ON e.workspace_id = w.id
      GROUP BY w.id, w.name
      ORDER BY total_tokens DESC LIMIT ?
    `, [limit])
    if (wsRows.length === 0) return []
    const ids = wsRows.map(r => r.workspace_id)
    const marks = ids.map(() => "?").join(",")
    const modelRows = await this.q<{
      workspace_id: string; model: string; input_tokens: string | number; output_tokens: string | number;
      cache_read_tokens: string | number; cache_creation_tokens: string | number
    }>(`
      SELECT w.id AS workspace_id, ntu.model,
             SUM(ntu.input_tokens) AS input_tokens, SUM(ntu.output_tokens) AS output_tokens,
             SUM(ntu.cache_read_tokens) AS cache_read_tokens,
             SUM(ntu.cache_creation_tokens) AS cache_creation_tokens
      FROM node_token_usages ntu
      JOIN node_executions ne ON ntu.node_execution_id = ne.id
      JOIN executions e ON ne.execution_id = e.id
      JOIN workspaces w ON e.workspace_id = w.id
      WHERE w.id IN (${marks})
      GROUP BY w.id, ntu.model
      ORDER BY w.id, ntu.model
    `, ids)
    const wsCost = await this.costGroupedBy(["workspace_id"], [`l.workspace_id IN (${marks})`], ids)
    const wmCost = await this.costGroupedBy(["workspace_id", "model"], [`l.workspace_id IN (${marks})`], ids)
    const out: Array<{
      workspace_id: string; workspace_name: string; total_tokens: number;
      total_cost_usd: number | null; cost_complete: number;
      model: string; input_tokens: number; output_tokens: number;
      cache_read_tokens: number; cache_creation_tokens: number; model_cost_usd: number | null
    }> = []
    for (const ws of wsRows) {
      const c = wsCost.get(ws.workspace_id)
      for (const m of modelRows.filter(r => r.workspace_id === ws.workspace_id)) {
        const mc = wmCost.get(`${m.workspace_id}|${m.model}`)
        out.push({
          workspace_id: ws.workspace_id, workspace_name: ws.workspace_name, total_tokens: num(ws.total_tokens),
          total_cost_usd: c?.usd ?? null, cost_complete: c?.complete ? 1 : 0,
          model: m.model, input_tokens: num(m.input_tokens), output_tokens: num(m.output_tokens),
          cache_read_tokens: num(m.cache_read_tokens), cache_creation_tokens: num(m.cache_creation_tokens),
          model_cost_usd: mc?.usd ?? null,
        })
      }
    }
    return out
  }

  async getExecutionRanking(limit: number): Promise<Array<{
    execution_id: string; workflow_ref: string; workflow_name: string | null;
    workspace_id: string; workspace_name: string; total_tokens: number;
    input_tokens: number; output_tokens: number; cache_read_tokens: number;
    cache_creation_tokens: number; total_cost_usd: number | null; cost_complete: number
  }>> {
    const rows = await this.q<{
      execution_id: string; workflow_ref: string; workflow_name: string | null;
      workspace_id: string; workspace_name: string; total_tokens: string | number;
      input_tokens: string | number; output_tokens: string | number; cache_read_tokens: string | number;
      cache_creation_tokens: string | number
    }>(`
      SELECT
        e.id AS execution_id, e.workflow_ref AS workflow_ref, e.workflow_name AS workflow_name,
        w.id AS workspace_id, w.name AS workspace_name,
        ${LEDGER_SQL.sumTokens('ntu.')} AS total_tokens,
        SUM(ntu.input_tokens) AS input_tokens, SUM(ntu.output_tokens) AS output_tokens,
        SUM(ntu.cache_read_tokens) AS cache_read_tokens,
        SUM(ntu.cache_creation_tokens) AS cache_creation_tokens
      FROM executions e
      JOIN workspaces w ON e.workspace_id = w.id
      JOIN node_executions ne ON ne.execution_id = e.id
      JOIN node_token_usages ntu ON ntu.node_execution_id = ne.id
      GROUP BY e.id, e.workflow_ref, e.workflow_name, w.id, w.name
      ORDER BY total_tokens DESC LIMIT ?
    `, [limit])
    const cost = await this.costGroupedBy(["execution_id"])
    return rows.map(r => {
      const c = cost.get(r.execution_id)
      return {
        execution_id: r.execution_id, workflow_ref: r.workflow_ref, workflow_name: r.workflow_name,
        workspace_id: r.workspace_id, workspace_name: r.workspace_name, total_tokens: num(r.total_tokens),
        input_tokens: num(r.input_tokens), output_tokens: num(r.output_tokens),
        cache_read_tokens: num(r.cache_read_tokens), cache_creation_tokens: num(r.cache_creation_tokens),
        total_cost_usd: c?.usd ?? null, cost_complete: c?.complete ? 1 : 0,
      }
    })
  }

  async getExecutionModelBreakdown(executionId: string): Promise<Array<{
    model: string; input_tokens: number; output_tokens: number;
    cache_read_tokens: number; cache_creation_tokens: number;
    model_cost_usd: number | null; cost_complete: number
  }>> {
    // B4：ORDER BY 里的裸别名在 PG 会解析到输入列（ntu.input_tokens 未分组 → 报错），
    // 改写成聚合函数表达式本体 —— 排序语义与旧逐字节等价。
    const rows = await this.q<{
      model: string; input_tokens: string | number; output_tokens: string | number;
      cache_read_tokens: string | number; cache_creation_tokens: string | number
    }>(`
      SELECT ntu.model,
        SUM(ntu.input_tokens) AS input_tokens, SUM(ntu.output_tokens) AS output_tokens,
        SUM(ntu.cache_read_tokens) AS cache_read_tokens,
        SUM(ntu.cache_creation_tokens) AS cache_creation_tokens
      FROM node_token_usages ntu
      JOIN node_executions ne ON ntu.node_execution_id = ne.id
      WHERE ne.execution_id = ?
      GROUP BY ntu.model
      ORDER BY SUM(ntu.input_tokens) + SUM(ntu.output_tokens) + SUM(ntu.cache_read_tokens) + SUM(ntu.cache_creation_tokens) DESC
    `, [executionId])
    const cost = await this.costGroupedBy(["model"], ["l.execution_id = ?"], [executionId])
    return rows.map(r => {
      const c = cost.get(r.model)
      return {
        model: r.model, input_tokens: num(r.input_tokens), output_tokens: num(r.output_tokens),
        cache_read_tokens: num(r.cache_read_tokens), cache_creation_tokens: num(r.cache_creation_tokens),
        model_cost_usd: c?.usd ?? null, cost_complete: c?.complete ? 1 : 0,
      }
    })
  }

  async getModelRanking(limit: number): Promise<Array<{
    model: string; input_tokens: number; output_tokens: number;
    cache_read_tokens: number; cache_creation_tokens: number;
    total_tokens: number; cost_usd: number | null; cost_complete: number
  }>> {
    const rows = await this.q<{
      model: string; input_tokens: string | number; output_tokens: string | number;
      cache_read_tokens: string | number; cache_creation_tokens: string | number; total_tokens: string | number
    }>(`
      SELECT ntu.model,
        SUM(ntu.input_tokens) AS input_tokens, SUM(ntu.output_tokens) AS output_tokens,
        SUM(ntu.cache_read_tokens) AS cache_read_tokens,
        SUM(ntu.cache_creation_tokens) AS cache_creation_tokens,
        ${LEDGER_SQL.sumTokens('ntu.')} AS total_tokens
      FROM node_token_usages ntu
      GROUP BY ntu.model
      ORDER BY total_tokens DESC LIMIT ?
    `, [limit])
    const cost = await this.costGroupedBy(["model"])
    return rows.map(r => {
      const c = cost.get(r.model)
      return {
        model: r.model, input_tokens: num(r.input_tokens), output_tokens: num(r.output_tokens),
        cache_read_tokens: num(r.cache_read_tokens), cache_creation_tokens: num(r.cache_creation_tokens),
        total_tokens: num(r.total_tokens), cost_usd: c?.usd ?? null, cost_complete: c?.complete ? 1 : 0,
      }
    })
  }

  // ── Health & monitoring queries ──────────────────────────────────────
  //
  // 「parent_id = '0'」 here always meant 「count launched instances, not composite
  // arms」. Since task-exec-tree (v44) a v4 round carries a parent (its lineage), so
  // the honest predicate is (parent = '0' OR phase-tagged) — the latch's predicate.

  async getHealthStats(workspaceId: string, days: number): Promise<{
    total: number; success_count: number; failure_count: number
    avg_duration: number | null; total_cost: number | null; cost_complete: boolean
  }> {
    const statsRow = await this.q1<{
      total: string | number; success_count: string | number | null; failure_count: string | number | null; avg_duration: string | number | null
    }>(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as success_count,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failure_count,
        AVG(CASE WHEN duration IS NOT NULL THEN duration END) as avg_duration
      FROM executions
      WHERE workspace_id = ? AND (parent_id = '0' OR phase_index IS NOT NULL)
        AND created_at >= now() - make_interval(days => ?)
    `, [workspaceId, days])

    const costRow = await this.q1<{ total_cost: number | null; cost_complete: number }>(`
      SELECT ${PRICED_AGG.sumCost("q")} as total_cost, ${PRICED_AGG.complete("q")} as cost_complete
      FROM llm_calls_costed q
      JOIN executions e ON e.id = q.execution_id
      WHERE e.workspace_id = ? AND e.created_at >= now() - make_interval(days => ?)
    `, [workspaceId, days])

    return {
      total: num(statsRow?.total),
      success_count: num(statsRow?.success_count),
      failure_count: num(statsRow?.failure_count),
      avg_duration: numOrNull(statsRow?.avg_duration),
      total_cost: numOrNull(costRow?.total_cost),
      cost_complete: costRow?.cost_complete === 1,
    }
  }

  async getDailyTrend(workspaceId: string, days: number): Promise<Array<{ date: string; success_count: number; failed_count: number }>> {
    const rows = await this.q<{ date: string; success_count: string | number | null; failed_count: string | number | null }>(`
      SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') as date,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as success_count,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_count
      FROM executions
      WHERE workspace_id = ? AND (parent_id = '0' OR phase_index IS NOT NULL)
        AND created_at >= now() - make_interval(days => ?)
      GROUP BY date ORDER BY date ASC
    `, [workspaceId, days])
    return rows.map(r => ({ date: r.date, success_count: num(r.success_count), failed_count: num(r.failed_count) }))
  }

  async getActiveAlertCount(workspaceId: string, days: number): Promise<number> {
    const row = await this.q1<{ count: string | number }>(`
      SELECT COUNT(*) as count FROM (
        SELECT 1 FROM executions
        WHERE workspace_id = ? AND (parent_id = '0' OR phase_index IS NOT NULL) AND status = 'failed'
          AND created_at >= now() - make_interval(days => ?)
        GROUP BY workflow_ref
        HAVING COUNT(*) >= 3
      ) t
    `, [workspaceId, days])
    return num(row?.count)
  }

  async getConsecutiveFailureAlerts(workspaceId: string, days: number): Promise<Array<{
    workflow_ref: string; streak_length: number; streak_start: string; streak_end: string
  }>> {
    const rows = await this.q<{
      workflow_ref: string; streak_length: string | number; streak_start: Date | string; streak_end: Date | string
    }>(`
      WITH run_sequences AS (
        SELECT workflow_ref, id, status, created_at,
          ROW_NUMBER() OVER (PARTITION BY workflow_ref ORDER BY created_at)
          - ROW_NUMBER() OVER (PARTITION BY workflow_ref, status ORDER BY created_at) as streak_group
        FROM executions
        WHERE (parent_id = '0' OR phase_index IS NOT NULL) AND workspace_id = ?
          AND created_at >= now() - make_interval(days => ?)
      ),
      streak_counts AS (
        SELECT workflow_ref, status, streak_group,
          COUNT(*) as streak_length, MIN(created_at) as streak_start, MAX(created_at) as streak_end
        FROM run_sequences GROUP BY workflow_ref, status, streak_group
      )
      SELECT workflow_ref, streak_length, streak_start, streak_end FROM streak_counts WHERE status = 'failed' AND streak_length >= 3 ORDER BY streak_length DESC
    `, [workspaceId, days])
    return rows.map(r => ({
      workflow_ref: r.workflow_ref, streak_length: num(r.streak_length),
      streak_start: iso(r.streak_start), streak_end: iso(r.streak_end),
    }))
  }

  async getHighFailureRateAlerts(workspaceId: string, days: number): Promise<Array<{
    node_id: string; node_type: string; workflow_ref: string;
    total_runs: number; failures: number; failure_pct: number; last_failure: string
  }>> {
    // B4：SQLite 允许 SELECT 非分组裸列 ne.node_type（每 node_id 恒定），PG 要求补齐分组键；
    // HAVING 引用聚合函数本体（别名不可用）；ROUND 走 ::numeric（PG 无 round(double,n)）。
    const rows = await this.q<{
      node_id: string; node_type: string; workflow_ref: string;
      total_runs: string | number; failures: string | number; failure_pct: string | number; last_failure: Date | string
    }>(`
      WITH node_health AS (
        SELECT ne.node_id, ne.node_type, e.workflow_ref,
          COUNT(*) as total_runs,
          SUM(CASE WHEN ne.status = 'failed' THEN 1 ELSE 0 END) as failures,
          MAX(ne.completed_at) as last_failure
        FROM node_executions ne JOIN executions e ON ne.execution_id = e.id
        WHERE e.workspace_id = ? AND e.created_at >= now() - make_interval(days => ?)
        GROUP BY ne.node_id, ne.node_type, e.workflow_ref HAVING COUNT(*) >= 3
      )
      SELECT node_id, node_type, workflow_ref, total_runs, failures,
        ROUND((failures::numeric / total_runs) * 100, 1) as failure_pct, last_failure
      FROM node_health WHERE failures > 0 AND failures::numeric / total_runs > 0.5
      ORDER BY failure_pct DESC LIMIT 10
    `, [workspaceId, days])
    return rows.map(r => ({
      node_id: r.node_id, node_type: r.node_type, workflow_ref: r.workflow_ref,
      total_runs: num(r.total_runs), failures: num(r.failures), failure_pct: num(r.failure_pct),
      last_failure: iso(r.last_failure),
    }))
  }

  async getCostSpikeAlerts(workspaceId: string, days: number): Promise<Array<{
    id: string; workflow_ref: string; exec_cost: number | null; created_at: string;
    avg_cost: number; cost_ratio: number
  }>> {
    const rows = await this.q<{
      id: string; workflow_ref: string; exec_cost: number | null; created_at: Date | string;
      avg_cost: number; cost_ratio: string | number
    }>(`
      WITH exec_costs AS (
        SELECT e.id, e.workflow_ref, e.created_at, v.exec_cost
        FROM executions e
        JOIN (
          SELECT q.execution_id, ${PRICED_AGG.sumCost("q")} as exec_cost
          FROM llm_calls_costed q GROUP BY q.execution_id
        ) v ON v.execution_id = e.id
        WHERE e.workspace_id = ? AND e.created_at >= now() - make_interval(days => ?)
      ),
      wf_avg AS (
        SELECT workflow_ref, AVG(exec_cost) as avg_cost FROM exec_costs GROUP BY workflow_ref
      )
      SELECT ec.id, ec.workflow_ref, ec.exec_cost, ec.created_at, wa.avg_cost,
        ROUND((ec.exec_cost / wa.avg_cost)::numeric, 1) as cost_ratio
      FROM exec_costs ec JOIN wf_avg wa ON ec.workflow_ref = wa.workflow_ref
      WHERE ec.exec_cost > wa.avg_cost * 3 ORDER BY cost_ratio DESC LIMIT 10
    `, [workspaceId, days])
    return rows.map(r => ({
      id: r.id, workflow_ref: r.workflow_ref, exec_cost: numOrNull(r.exec_cost),
      created_at: iso(r.created_at), avg_cost: num(r.avg_cost), cost_ratio: num(r.cost_ratio),
    }))
  }

  async getErrorCategories(workspaceId: string, days: number): Promise<Array<{
    error_category: string; count: number; last_seen: string | null; sample_errors: string | null
  }>> {
    // S6：GROUP_CONCAT(x,'|||') → string_agg(x,'|||')（组内拼接顺序两引擎均不保证，
    // 消费方只做样本预览，语义不变）。
    const rows = await this.q<{
      error_category: string; count: string | number; last_seen: Date | string | null; sample_errors: string | null
    }>(`
      SELECT
        CASE
          WHEN exit_code = 124 OR exit_code = 137 THEN 'timeout'
          WHEN exit_code = 130 THEN 'aborted'
          WHEN exit_code = 1 THEN 'script_error'
          WHEN exit_code IS NOT NULL AND exit_code != 0 THEN 'script_error'
          WHEN error LIKE '%timeout%' OR error LIKE '%timed out%' THEN 'timeout'
          WHEN error LIKE '%abort%' OR error LIKE '%signal%' THEN 'aborted'
          WHEN error LIKE '%API%' OR error LIKE '%rate limit%' THEN 'api_error'
          WHEN error LIKE '%permission%' OR error LIKE '%auth%' THEN 'auth_error'
          WHEN error IS NOT NULL THEN 'unknown'
          ELSE 'no_error_info'
        END as error_category,
        COUNT(*) as count, MAX(completed_at) as last_seen,
        string_agg(SUBSTR(COALESCE(error, ''), 1, 200), '|||') as sample_errors
      FROM node_executions
      WHERE status = 'failed'
        AND started_at >= now() - make_interval(days => ?)
        AND execution_id IN (SELECT id FROM executions WHERE workspace_id = ?)
      GROUP BY error_category ORDER BY count DESC
    `, [days, workspaceId])
    return rows.map(r => ({
      error_category: r.error_category, count: num(r.count),
      last_seen: isoOrNull(r.last_seen), sample_errors: r.sample_errors,
    }))
  }

  async getFragilityRanking(workspaceId: string, days: number): Promise<Array<{
    node_id: string; node_type: string; workflow_ref: string;
    total_runs: number; failures: number; avg_duration: number | null;
    last_failure: string | null; fragility_score: number
  }>> {
    const rows = await this.q<{
      node_id: string; node_type: string; workflow_ref: string;
      total_runs: string | number; failures: string | number; avg_duration: string | number | null;
      last_failure: Date | string | null; fragility_score: string | number
    }>(`
      WITH node_health AS (
        SELECT ne.node_id, ne.node_type, e.workflow_ref,
          COUNT(*) as total_runs,
          SUM(CASE WHEN ne.status = 'failed' THEN 1 ELSE 0 END) as failures,
          AVG(ne.duration) as avg_duration, MAX(ne.completed_at) as last_failure
        FROM node_executions ne JOIN executions e ON ne.execution_id = e.id
        WHERE e.created_at >= now() - make_interval(days => ?) AND e.workspace_id = ?
        GROUP BY ne.node_id, ne.node_type, e.workflow_ref
      )
      SELECT node_id, node_type, workflow_ref, total_runs, failures, avg_duration, last_failure,
        ROUND(
          (failures::numeric / total_runs) * 100
          * CASE WHEN total_runs > 10 THEN 1.0 ELSE 0.5 END, 1
        ) as fragility_score
      FROM node_health WHERE failures > 0
      ORDER BY fragility_score DESC LIMIT 20
    `, [days, workspaceId])
    return rows.map(r => ({
      node_id: r.node_id, node_type: r.node_type, workflow_ref: r.workflow_ref,
      total_runs: num(r.total_runs), failures: num(r.failures), avg_duration: numOrNull(r.avg_duration),
      last_failure: isoOrNull(r.last_failure), fragility_score: num(r.fragility_score),
    }))
  }

  async getFailureChains(workspaceId: string, days: number): Promise<Array<{
    failed_node: string; downstream_node: string; downstream_status: string; occurrences: number
  }>> {
    const rows = await this.q<{
      failed_node: string; downstream_node: string; downstream_status: string; occurrences: string | number
    }>(`
      WITH failure_chains AS (
        SELECT ne1.node_id as failed_node, ne2.node_id as downstream_node,
          ne2.status as downstream_status, COUNT(*) as occurrences
        FROM node_executions ne1
        JOIN node_executions ne2 ON ne1.execution_id = ne2.execution_id AND ne2.started_at > ne1.completed_at
        JOIN executions e ON ne1.execution_id = e.id
        WHERE ne1.status = 'failed' AND e.workspace_id = ?
          AND e.created_at >= now() - make_interval(days => ?)
        GROUP BY ne1.node_id, ne2.node_id, ne2.status
      )
      SELECT * FROM failure_chains ORDER BY failed_node, occurrences DESC LIMIT 100
    `, [workspaceId, days])
    return rows.map(r => ({
      failed_node: r.failed_node, downstream_node: r.downstream_node,
      downstream_status: r.downstream_status, occurrences: num(r.occurrences),
    }))
  }

  async getDurationAnomalies(workspaceId: string, days: number): Promise<Array<{
    execution_id: string; node_id: string; current_duration: number;
    mean_duration: number; stddev_duration: number; z_score: number; severity: string
  }>> {
    const rows = await this.q<{
      execution_id: string; node_id: string; current_duration: number | string;
      mean_duration: string | number; stddev_duration: string | number; z_score: string | number; severity: string
    }>(`
      WITH node_stats AS (
        SELECT node_id, AVG(duration) as mean_duration,
          SQRT((AVG(duration * duration) - AVG(duration) * AVG(duration)) * CAST(COUNT(*) AS DOUBLE PRECISION) / CAST(COUNT(*) - 1 AS DOUBLE PRECISION)) as stddev_duration,
          COUNT(*) as sample_count
        FROM node_executions
        WHERE status = 'completed' AND duration IS NOT NULL
          AND started_at >= now() - make_interval(days => ?)
          AND execution_id IN (SELECT id FROM executions WHERE workspace_id = ?)
        GROUP BY node_id HAVING COUNT(*) >= 10
      )
      SELECT ne.execution_id, ne.node_id, ne.duration as current_duration,
        ns.mean_duration, ns.stddev_duration,
        ROUND(((ne.duration - ns.mean_duration) / ns.stddev_duration)::numeric, 1) as z_score,
        CASE WHEN (ne.duration - ns.mean_duration) / ns.stddev_duration > 3 THEN 'critical' ELSE 'warning' END as severity
      FROM node_executions ne
      JOIN node_stats ns ON ne.node_id = ns.node_id
      WHERE ne.status = 'completed' AND ns.stddev_duration > 0
        AND (ne.duration - ns.mean_duration) / ns.stddev_duration > 2
        AND ne.started_at >= now() - make_interval(days => ?)
        AND ne.execution_id IN (SELECT id FROM executions WHERE workspace_id = ?)
      ORDER BY z_score DESC LIMIT 50
    `, [days, workspaceId, days, workspaceId])
    return rows.map(r => ({
      execution_id: r.execution_id, node_id: r.node_id, current_duration: num(r.current_duration),
      mean_duration: num(r.mean_duration), stddev_duration: num(r.stddev_duration),
      z_score: num(r.z_score), severity: r.severity,
    }))
  }

  async getCostAnomalies(workspaceId: string, days: number): Promise<Array<{
    id: string; workflow_ref: string; exec_cost: number | null; avg_cost: number;
    cost_ratio: number; severity: string
  }>> {
    const rows = await this.q<{
      id: string; workflow_ref: string; exec_cost: number | null;
      avg_cost: number; cost_ratio: string | number; severity: string
    }>(`
      WITH exec_costs AS (
        SELECT e.id, e.workflow_ref, e.created_at, v.exec_cost
        FROM executions e
        JOIN (
          SELECT q.execution_id, ${PRICED_AGG.sumCost("q")} as exec_cost
          FROM llm_calls_costed q GROUP BY q.execution_id
        ) v ON v.execution_id = e.id
        WHERE e.workspace_id = ? AND e.created_at >= now() - make_interval(days => ?)
      ),
      wf_avg AS (
        SELECT workflow_ref, AVG(exec_cost) as avg_cost, MAX(exec_cost) as max_cost
        FROM exec_costs GROUP BY workflow_ref HAVING COUNT(*) >= 5
      )
      SELECT ec.id, ec.workflow_ref, ec.exec_cost, wa.avg_cost,
        ROUND((ec.exec_cost / wa.avg_cost)::numeric, 1) as cost_ratio,
        CASE WHEN ec.exec_cost > wa.avg_cost * 5 THEN 'critical' WHEN ec.exec_cost > wa.avg_cost * 3 THEN 'warning' ELSE 'normal' END as severity
      FROM exec_costs ec JOIN wf_avg wa ON ec.workflow_ref = wa.workflow_ref
      WHERE ec.exec_cost > wa.avg_cost * 2 ORDER BY cost_ratio DESC LIMIT 20
    `, [workspaceId, days])
    return rows.map(r => ({
      id: r.id, workflow_ref: r.workflow_ref, exec_cost: numOrNull(r.exec_cost),
      avg_cost: num(r.avg_cost), cost_ratio: num(r.cost_ratio), severity: r.severity,
    }))
  }

  async getCostTrend(workspaceId: string, days: number): Promise<Array<{ date: string; total_cost: number | null; exec_count: number }>> {
    const rows = await this.q<{ date: string; total_cost: number | null; exec_count: string | number }>(`
      SELECT to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') as date,
        SUM(v.exec_cost) as total_cost,
        COUNT(DISTINCT e.id) as exec_count
      FROM executions e
      LEFT JOIN (
        SELECT q.execution_id, ${PRICED_AGG.sumCost("q")} as exec_cost
        FROM llm_calls_costed q GROUP BY q.execution_id
      ) v ON v.execution_id = e.id
      WHERE e.workspace_id = ? AND (e.parent_id = '0' OR e.phase_index IS NOT NULL)
        AND e.created_at >= now() - make_interval(days => ?)
      GROUP BY date ORDER BY date ASC
    `, [workspaceId, days])
    return rows.map(r => ({ date: r.date, total_cost: numOrNull(r.total_cost), exec_count: num(r.exec_count) }))
  }

  async getTokenDistribution(workspaceId: string, days: number): Promise<Array<{
    model: string; total_input: number; total_output: number;
    total_cost: number | null; cache_hit_rate: number | null
  }>> {
    const rows = await this.q<{ model: string; total_input: string | number; total_output: string | number; cache_hit_rate: number | null }>(`
      SELECT ntu.model,
        SUM(ntu.input_tokens) as total_input, SUM(ntu.output_tokens) as total_output,
        ${LEDGER_SQL.cacheHitRate('ntu.')} as cache_hit_rate
      FROM node_token_usages ntu
      JOIN node_executions ne ON ntu.node_execution_id = ne.id
      JOIN executions e ON ne.execution_id = e.id
      WHERE e.workspace_id = ? AND e.created_at >= now() - make_interval(days => ?)
      GROUP BY ntu.model
    `, [workspaceId, days])
    const cost = await this.costGroupedBy(["model"], [`l.execution_id IN (SELECT id FROM executions WHERE workspace_id = ? AND created_at >= now() - make_interval(days => ?))`], [workspaceId, days])
    return rows
      .map(r => ({
        model: r.model, total_input: num(r.total_input), total_output: num(r.total_output),
        total_cost: cost.get(r.model)?.usd ?? null, cache_hit_rate: numOrNull(r.cache_hit_rate),
      }))
      .sort((a, b) => (b.total_cost ?? -1) - (a.total_cost ?? -1))
  }

  async getCostByWorkflow(workspaceId: string, days: number): Promise<Array<{
    workflow_ref: string; total_cost: number | null; exec_count: number; avg_cost: number | null
  }>> {
    const rows = await this.q<{
      workflow_ref: string; total_cost: number | null; exec_count: string | number; avg_cost: number | null
    }>(`
      SELECT e.workflow_ref,
        SUM(v.exec_cost) as total_cost,
        COUNT(DISTINCT e.id) as exec_count,
        SUM(v.exec_cost) / COUNT(DISTINCT e.id) as avg_cost
      FROM executions e
      LEFT JOIN (
        SELECT q.execution_id, ${PRICED_AGG.sumCost("q")} as exec_cost
        FROM llm_calls_costed q GROUP BY q.execution_id
      ) v ON v.execution_id = e.id
      WHERE e.workspace_id = ? AND (e.parent_id = '0' OR e.phase_index IS NOT NULL)
        AND e.created_at >= now() - make_interval(days => ?)
      GROUP BY e.workflow_ref ORDER BY total_cost DESC NULLS LAST
    `, [workspaceId, days])
    return rows.map(r => ({
      workflow_ref: r.workflow_ref, total_cost: numOrNull(r.total_cost),
      exec_count: num(r.exec_count), avg_cost: numOrNull(r.avg_cost),
    }))
  }

  // ── Workspace Token Stats (for archive preview) ──────────────────────

  async getWorkspaceTokenStats(workspaceId: string): Promise<{
    total: { inputTokens: number; outputTokens: number; cost: LedgerCost }
    byModel: Array<{ model: string; inputTokens: number; outputTokens: number; cost: number | null }>
    byWorkflow: Array<{
      workflowRef: string; inputTokens: number; outputTokens: number; cost: LedgerCost
      byModel: Array<{ model: string; inputTokens: number; outputTokens: number; cost: number | null }>
    }>
  }> {
    // NEW-r2：token 源 ntu；cost 源 = llm_calls_costed（workspace 口径），JS 合流。
    const modelRows = await this.q<{ model: string; input_tokens: string | number; output_tokens: string | number }>(`
      SELECT ntu.model,
        SUM(ntu.input_tokens) as input_tokens, SUM(ntu.output_tokens) as output_tokens
      FROM node_token_usages ntu
      JOIN node_executions ne ON ntu.node_execution_id = ne.id
      JOIN executions e ON ne.execution_id = e.id
      WHERE e.workspace_id = ?
      GROUP BY ntu.model
    `, [workspaceId])
    const modelCost = await this.costGroupedBy(["model"], ["l.workspace_id = ?"], [workspaceId])
    const costedModelRows = modelRows.map(r => ({
      model: r.model, inputTokens: num(r.input_tokens), outputTokens: num(r.output_tokens),
      cost: modelCost.get(r.model)?.usd ?? null,
    }))
    const byModel = costedModelRows.slice().sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1))

    const total = {
      inputTokens: costedModelRows.reduce((a, r) => a + r.inputTokens, 0),
      outputTokens: costedModelRows.reduce((a, r) => a + r.outputTokens, 0),
      cost: costSummary(costedModelRows.map(r => r.cost)),
    }

    // Per-workflow with model breakdown
    const wfRows = await this.q<{ workflow_ref: string; model: string; input_tokens: string | number; output_tokens: string | number }>(`
      SELECT e.workflow_ref, ntu.model,
        SUM(ntu.input_tokens) as input_tokens, SUM(ntu.output_tokens) as output_tokens
      FROM node_token_usages ntu
      JOIN node_executions ne ON ntu.node_execution_id = ne.id
      JOIN executions e ON ne.execution_id = e.id
      WHERE e.workspace_id = ?
      GROUP BY e.workflow_ref, ntu.model ORDER BY e.workflow_ref
    `, [workspaceId])
    const wmCost = await this.costGroupedBy(["workflow_ref", "model"], ["l.workspace_id = ?"], [workspaceId])

    const wfMap = new Map<string, { inputTokens: number; outputTokens: number; costs: Array<number | null>; byModel: Array<{ model: string; inputTokens: number; outputTokens: number; cost: number | null }> }>()
    for (const r of wfRows) {
      let wf = wfMap.get(r.workflow_ref)
      if (!wf) { wf = { inputTokens: 0, outputTokens: 0, costs: [], byModel: [] }; wfMap.set(r.workflow_ref, wf) }
      const cost = wmCost.get(`${r.workflow_ref}|${r.model}`)?.usd ?? null
      wf.inputTokens += num(r.input_tokens)
      wf.outputTokens += num(r.output_tokens)
      wf.costs.push(cost)
      wf.byModel.push({ model: r.model, inputTokens: num(r.input_tokens), outputTokens: num(r.output_tokens), cost })
    }
    const byWorkflow = Array.from(wfMap.entries()).map(([workflowRef, stats]) => ({
      workflowRef,
      inputTokens: stats.inputTokens,
      outputTokens: stats.outputTokens,
      cost: costSummary(stats.costs),
      byModel: stats.byModel.slice().sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1)),
    }))

    return { total, byModel, byWorkflow }
  }

  async getNodeTokenStats(workspaceId: string): Promise<Array<{
    workflowRef: string; nodeId: string; nodeName: string; nodeType: string
    inputTokens: number; outputTokens: number; cost: LedgerCost
    byModel: Array<{ model: string; inputTokens: number; outputTokens: number; cost: number | null }>
  }>> {
    // B4：SELECT 非分组裸列 ne.node_type 在 PG 需补进 GROUP BY（每 (workflow_ref,node_id)
    // 下 node_type 恒定，分组语义不变）。
    const rows = await this.q<{
      workflow_ref: string; node_id: string; node_type: string
      model: string; input_tokens: string | number; output_tokens: string | number
    }>(`
      SELECT e.workflow_ref, ne.node_id,
        ne.node_type,
        ntu.model,
        SUM(ntu.input_tokens) as input_tokens, SUM(ntu.output_tokens) as output_tokens
      FROM node_token_usages ntu
      JOIN node_executions ne ON ntu.node_execution_id = ne.id
      JOIN executions e ON ne.execution_id = e.id
      WHERE e.workspace_id = ?
      GROUP BY e.workflow_ref, ne.node_id, ne.node_type, ntu.model
      ORDER BY e.workflow_ref
    `, [workspaceId])
    const wnmCost = await this.costGroupedBy(["workflow_ref", "node_id", "model"], ["l.workspace_id = ?"], [workspaceId])

    const nodeMap = new Map<string, {
      workflowRef: string; nodeId: string; nodeName: string; nodeType: string
      inputTokens: number; outputTokens: number; costs: Array<number | null>
      byModel: Array<{ model: string; inputTokens: number; outputTokens: number; cost: number | null }>
    }>()

    for (const r of rows) {
      const key = `${r.workflow_ref}:${r.node_id}`
      let node = nodeMap.get(key)
      if (!node) {
        node = { workflowRef: r.workflow_ref, nodeId: r.node_id, nodeName: r.node_id, nodeType: r.node_type, inputTokens: 0, outputTokens: 0, costs: [], byModel: [] }
        nodeMap.set(key, node)
      }
      const cost = wnmCost.get(`${r.workflow_ref}|${r.node_id}|${r.model}`)?.usd ?? null
      node.inputTokens += num(r.input_tokens)
      node.outputTokens += num(r.output_tokens)
      node.costs.push(cost)
      node.byModel.push({ model: r.model, inputTokens: num(r.input_tokens), outputTokens: num(r.output_tokens), cost })
    }

    return Array.from(nodeMap.values()).map(n => ({
      workflowRef: n.workflowRef, nodeId: n.nodeId, nodeName: n.nodeName, nodeType: n.nodeType,
      inputTokens: n.inputTokens, outputTokens: n.outputTokens,
      cost: costSummary(n.costs), byModel: n.byModel.slice().sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1)),
    }))
  }

  // ── LLM call analysis (for suggestion-engine) ────────────────────────

  async findLlmCallStatsByNode(workspaceId: string, workflowRef: string): Promise<Array<{
    node_id: string; avg_out: number; calls: number; tool_ratio: number
  }>> {
    const rows = await this.q<{ node_id: string; avg_out: string | number; calls: string | number; tool_ratio: number }>(`
      SELECT node_id, AVG(output_tokens) as avg_out,
             COUNT(*) as calls,
             CAST(SUM(CASE WHEN stop_reason = 'tool_use' THEN 1 ELSE 0 END) AS DOUBLE PRECISION) / COUNT(*) as tool_ratio
      FROM llm_calls WHERE workspace_id = ? AND workflow_ref = ?
      GROUP BY node_id
    `, [workspaceId, workflowRef])
    return rows.map(r => ({ node_id: r.node_id, avg_out: num(r.avg_out), calls: num(r.calls), tool_ratio: num(r.tool_ratio) }))
  }

  async findThinkingOutputRatio(workspaceId: string, workflowRef: string): Promise<Array<{
    node_id: string; thinking_total: number; output_total: number
  }>> {
    const rows = await this.q<{ node_id: string; thinking_total: string | number; output_total: string | number }>(`
      SELECT node_id,
             SUM(cache_read_tokens + cache_creation_tokens) as thinking_total,
             SUM(output_tokens) as output_total
      FROM llm_calls WHERE workspace_id = ? AND workflow_ref = ?
      GROUP BY node_id HAVING SUM(output_tokens) > 0
    `, [workspaceId, workflowRef])
    return rows.map(r => ({ node_id: r.node_id, thinking_total: num(r.thinking_total), output_total: num(r.output_total) }))
  }

  async findOutputOverproduction(workspaceId: string, workflowRef: string): Promise<Array<{
    node_id: string; avg_out: number; calls: number
  }>> {
    const rows = await this.q<{ node_id: string; avg_out: string | number; calls: string | number }>(`
      SELECT node_id, AVG(output_tokens) as avg_out, COUNT(*) as calls
      FROM llm_calls WHERE workspace_id = ? AND workflow_ref = ?
      GROUP BY node_id
    `, [workspaceId, workflowRef])
    return rows.map(r => ({ node_id: r.node_id, avg_out: num(r.avg_out), calls: num(r.calls) }))
  }

  // ── Analytics cost queries ─────────────────────────────────────────
  // NEW-r2：源 = llm_calls_costed 视图（cost_usd 为查询时按窗口匹配的派生列）。

  async totalCostByWorkspaceSince(workspaceId: string, tsCutoff: number): Promise<number | null> {
    const row = await this.q1<{ total: number | null }>(
      `SELECT ${LEDGER_SQL.sumCost('')} as total FROM llm_calls_costed WHERE workspace_id = ? AND timestamp >= ?`,
      [workspaceId, tsCutoff],
    )
    return numOrNull(row?.total)
  }

  async costByModelSince(workspaceId: string, tsCutoff: number): Promise<Array<Record<string, unknown>>> {
    const rows = await this.q<{
      model: string | null; calls: string | number; total_cost: number | null
      input_tokens: string | number; output_tokens: string | number
      cache_read: string | number; cache_create: string | number
    }>(`
      SELECT model, COUNT(*) as calls, ${LEDGER_SQL.sumCost('')} as total_cost,
             SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens,
             SUM(cache_read_tokens) as cache_read, SUM(cache_creation_tokens) as cache_create
      FROM llm_calls_costed WHERE workspace_id = ? AND timestamp >= ?
      GROUP BY model ORDER BY total_cost DESC NULLS LAST
    `, [workspaceId, tsCutoff])
    return rows.map(r => ({
      model: r.model, calls: num(r.calls), total_cost: numOrNull(r.total_cost),
      input_tokens: num(r.input_tokens), output_tokens: num(r.output_tokens),
      cache_read: num(r.cache_read), cache_create: num(r.cache_create),
    }))
  }

  async costByWorkflowSince(workspaceId: string, tsCutoff: number): Promise<Array<Record<string, unknown>>> {
    const rows = await this.q<{ workflow_ref: string | null; executions: string | number; total_cost: number | null }>(`
      SELECT workflow_ref, COUNT(DISTINCT execution_id) as executions,
             ${LEDGER_SQL.sumCost('')} as total_cost
      FROM llm_calls_costed WHERE workspace_id = ? AND timestamp >= ?
      GROUP BY workflow_ref ORDER BY total_cost DESC NULLS LAST
    `, [workspaceId, tsCutoff])
    return rows.map(r => ({ workflow_ref: r.workflow_ref, executions: num(r.executions), total_cost: numOrNull(r.total_cost) }))
  }

  async dailyCostSince(workspaceId: string, tsCutoff: number): Promise<Array<Record<string, unknown>>> {
    // DATE(epoch_ms/1000,'unixepoch') → PG 同口径 UTC 日界（SQLite 该式即 UTC）。
    const rows = await this.q<{ date: string; total_cost: number | null; calls: string | number }>(`
      SELECT to_char(to_timestamp(timestamp / 1000) AT TIME ZONE 'UTC', 'YYYY-MM-DD') as date,
             ${LEDGER_SQL.sumCost('')} as total_cost, COUNT(*) as calls
      FROM llm_calls_costed WHERE workspace_id = ? AND timestamp >= ?
      GROUP BY date ORDER BY date ASC
    `, [workspaceId, tsCutoff])
    return rows.map(r => ({ date: r.date, total_cost: numOrNull(r.total_cost), calls: num(r.calls) }))
  }

  async findLlmCallsByWorkflowSince(workspaceId: string, workflowRef: string, tsCutoff: number): Promise<Array<Record<string, unknown>>> {
    const rows = await this.q<LlmCallCostedPgRow>(
      "SELECT * FROM llm_calls_costed WHERE workspace_id = ? AND workflow_ref = ? AND timestamp >= ?",
      [workspaceId, workflowRef, tsCutoff],
    )
    return rows.map(r => ({ ...fromLlmCall(r) }))
  }
}
