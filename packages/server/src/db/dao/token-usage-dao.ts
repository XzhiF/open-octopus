import type Database from "better-sqlite3"
import { BaseDAO } from "./base"
import type { NodeTokenUsageRow, LlmCallRow } from "../types"
import { LEDGER_SQL, costSummary, normalizeModelId, type TokenUsage, type LedgerTotals, type LedgerCost, type LedgerRow, type LlmUsageRow, type LlmUsageSummary } from "@octopus/shared"
import { type NodeUsageSource } from "./usage-ledger"
import { pricedCallsSql, PRICED_AGG } from "../price-sql"

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

export class TokenUsageDAO extends BaseDAO {
  constructor(db: Database.Database) { super(db) }

  /**
   * billing NEW-r2：本 DAO 不持算价对象 —— 钱不落账本，一切费用查询经
   * llm_calls_costed 视图（../price-sql 生成的 DDL）按窗口现算。汇率在视图内
   * 实时读 billing_setting（改汇率 → 全局折价重算，与价表同族语义）。
   */

  /**
   * 通用派生费用聚合：对 llm_calls 套价格匹配片段，按 where(原生列条件) 现算全局
   * LedgerCost 三态（全无价 → usd NULL；空集 → complete vacuous true）。
   */
  private derivedCost(where: string[] = [], params: unknown[] = []): LedgerCost {
    const { sql, params: innerParams } = pricedCallsSql(where, params)
    const row = this.stmt(`
      SELECT ${PRICED_AGG.sumCost()} AS usd, ${PRICED_AGG.complete()} AS complete
      FROM (${sql}) q
    `).get(...innerParams) as { usd: number | null; complete: number }
    return { usd: row.usd ?? null, complete: row.complete === 1 }
  }

  /** 单节点费用（NEW-r2：node_end SSE / 节点视图的现算钱，与报表同源）。 */
  costForNodeExecution(nodeExecutionId: string): LedgerCost {
    return this.derivedCost(["l.node_execution_id = ?"], [nodeExecutionId])
  }

  /**
   * NEW-r2: 对 llm_calls_costed 按列分组派生费用（一次扫描；JS 侧与 token 行合流）。
   * key = keyCols 值以 "|" 连接（NULL → "null"）。usd 全未定价→NULL 不焊 0；
   * complete = 组内全部有价（空组 vacuous true，对齐 LEDGER_SQL.costComplete）。
   */
  private costGroupedBy(keyCols: string[], where: string[] = [], params: unknown[] = []): Map<string, { usd: number | null; complete: boolean }> {
    const { sql, params: innerParams } = pricedCallsSql(where, params)
    const cols = keyCols.map(k => `q.${k}`)
    const rows = this.stmt(`
      SELECT ${cols.join(", ")},
             ${PRICED_AGG.sumCost()} AS usd,
             COUNT(*) AS total,
             ${PRICED_AGG.countPriced()} AS priced
      FROM (${sql}) q
      GROUP BY ${cols.join(", ")}
    `).all(...innerParams) as Array<Record<string, unknown> & { usd: number | null; total: number; priced: number }>
    const map = new Map<string, { usd: number | null; complete: boolean }>()
    for (const r of rows) {
      map.set(keyCols.map(k => String(r[k] ?? "null")).join("|"), { usd: r.usd ?? null, complete: r.total === r.priced })
    }
    return map
  }

  // ── node_token_usages ───────────────────────────────────────────

  findByNodeExecution(nodeExecutionId: string): NodeTokenUsageRow[] {
    return this.stmt(
      "SELECT * FROM node_token_usages WHERE node_execution_id = ?"
    ).all(nodeExecutionId) as NodeTokenUsageRow[]
  }

  findByExecution(executionId: string): NodeTokenUsageRow[] {
    return this.stmt(`
      SELECT ntu.* FROM node_token_usages ntu
      JOIN node_executions ne ON ntu.node_execution_id = ne.id
      WHERE ne.execution_id = ?
    `).all(executionId) as NodeTokenUsageRow[]
  }

  findByExecutionPerStep(executionId: string): Array<NodeTokenUsageRow & { node_id: string }> {
    return this.stmt(`
      SELECT ne.node_id, ntu.* FROM node_token_usages ntu
      JOIN node_executions ne ON ntu.node_execution_id = ne.id
      WHERE ne.execution_id = ?
    `).all(executionId) as Array<NodeTokenUsageRow & { node_id: string }>
  }

  /**
   * node_token_usages 唯一写入口（C3 · UsageLedger + billing NEW-r2）。三条旧路径
   * （ExecutionDAO.insertNodeTokenUsage / 本表旧 insert / HarnessDAO.insertHarnessTokenUsage）
   * 收编于此：UPSERT 累加 + source 判别。
   *
   * NEW-r2：cost_usd 快照列已删 —— 本表回归纯 token 账（节点/执行费用的钱从
   * llm_calls 查询时派生，见 derivedCost / 各 ranking）。model 落库前归一化
   * （shared normalizeModelId，与 llm_calls 同一规范名空间）。
   */
  recordNodeUsage(input: {
    id: string
    nodeExecutionId: string
    model: string
    usage: Pick<TokenUsage, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheCreationTokens'>
    /** @deprecated SDK/calibrate 上报价不再作为落库 cost 来源（KD2）；NEW-r2 起本入口彻底无 cost。参数仅为调用方兼容保留。 */
    costUsd?: number | null
    source: NodeUsageSource
    createdAt: string
  }): Database.RunResult {
    const model = normalizeModelId(input.model) ?? input.model
    return this.stmt(`
      INSERT INTO node_token_usages (id, node_execution_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
        cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
        created_at = excluded.created_at
    `).run(
      input.id, input.nodeExecutionId, model,
      input.usage.inputTokens, input.usage.outputTokens,
      input.usage.cacheReadTokens, input.usage.cacheCreationTokens,
      input.source, input.createdAt,
    )
  }

  deleteByNodeExecution(nodeExecutionId: string): Database.RunResult {
    return this.stmt("DELETE FROM node_token_usages WHERE node_execution_id = ?").run(nodeExecutionId)
  }

  deleteByExecution(executionId: string): Database.RunResult {
    return this.stmt(`
      DELETE FROM node_token_usages WHERE node_execution_id IN (
        SELECT id FROM node_executions WHERE execution_id = ?
      )
    `).run(executionId)
  }

  /** 全局费用（NEW-r2：源 = llm_calls 全账本派生 —— 含聊天/压缩行，与报表同源同规则）。 */
  totalCost(): LedgerCost {
    return this.derivedCost()
  }

  // ── llm_calls ───────────────────────────────────────────────────

  /** NEW-r2：读侧统一走派生视图 —— 行上带查询时算好的 cost_usd/vendor。 */
  findLlmCallsByExecution(executionId: string, nodeId?: string): LlmCallCostedRow[] {
    let query = `SELECT * FROM llm_calls_costed WHERE execution_id = ?`
    const params: unknown[] = [executionId]
    if (nodeId) { query += ` AND node_id = ?`; params.push(nodeId) }
    query += ` ORDER BY turn_index, call_index`
    return this.stmt(query).all(...params) as LlmCallCostedRow[]
  }

  /**
   * 会话口径的逐 call 行（v49：聊天角标 / 会话明细）。**不做 message 去重** ——
   * 执行端点的去重是给「并行票共享会话、同一条消息被多个在跑节点各记一行」那个
   * bug 生的（写侧 insertLlmCallBatch 同样显式豁免 execution_id 为空的行）；
   * 聊天行是 recordProviderResultUsage「每 modelUsage 一行」的真实拆分，
   * 按 message_id 去重会把混合模型轮次的第二个模型吞掉。
   */
  findLlmCallsBySession(sessionId: string): LlmCallCostedRow[] {
    return this.stmt(
      `SELECT * FROM llm_calls_costed WHERE session_id = ? ORDER BY timestamp, id`,
    ).all(sessionId) as LlmCallCostedRow[]
  }

  /**
   * 执行级总量 —— token 总量仍以 ntu 为账（运行中逐轮累加，与 steps/REST 终态同源，
   * C3/Q4 的「运行中↔完成跳变根除」结论不变）；NEW-r2 起 **cost 改从 llm_calls
   * 按 execution_id 派生**（与 billing 报表同源，节点完成时随 persist 到位）。
   * totalLlmTurns 仍是明细计数（llm_calls 行），与总量无关。
   */
  aggregateByExecution(executionId: string): {
    usage: TokenUsage
    totals: LedgerTotals
    totalLlmTurns: number
    errorCount: number
  } {
    const row = this.stmt(`
      SELECT
        COALESCE(SUM(ntu.input_tokens), 0) as totalInputTokens,
        COALESCE(SUM(ntu.output_tokens), 0) as totalOutputTokens,
        COALESCE(SUM(ntu.cache_read_tokens), 0) as totalCacheReadTokens,
        COALESCE(SUM(ntu.cache_creation_tokens), 0) as totalCacheCreationTokens,
        ${LEDGER_SQL.sumTokens('ntu.')} as tokens,
        ${LEDGER_SQL.cacheHitRate('ntu.')} as cache_hit_rate
      FROM node_token_usages ntu
      JOIN node_executions ne ON ntu.node_execution_id = ne.id
      WHERE ne.execution_id = ?
    `).get(executionId) as {
      totalInputTokens: number; totalOutputTokens: number
      totalCacheReadTokens: number; totalCacheCreationTokens: number
      tokens: number | null; cache_hit_rate: number | null
    }

    const cost = this.derivedCost(["l.execution_id = ?"], [executionId])

    const turns = this.stmt(
      "SELECT COUNT(*) as n FROM llm_calls WHERE execution_id = ?"
    ).get(executionId) as { n: number }

    const errors = this.stmt(`
      SELECT COUNT(*) as errorCount FROM node_executions
      WHERE execution_id = ? AND status = 'failed'
    `).get(executionId) as { errorCount: number }

    return {
      usage: {
        inputTokens: row.totalInputTokens,
        outputTokens: row.totalOutputTokens,
        cacheReadTokens: row.totalCacheReadTokens,
        cacheCreationTokens: row.totalCacheCreationTokens,
      },
      totals: {
        tokens: row.tokens ?? 0,
        cost,
        cacheHitRate: row.cache_hit_rate,
      },
      totalLlmTurns: turns.n,
      errorCount: errors.errorCount,
    }
  }

  /** 工作区时间窗内的费用（NEW-r2：源 = llm_calls 派生，与报表同一张账）。 */
  costForWorkspaceSince(workspaceId: string, createdSinceIso: string): LedgerCost {
    const sinceMs = Date.parse(createdSinceIso)
    const where = ["l.workspace_id = ?"]
    const params: unknown[] = [workspaceId]
    if (Number.isFinite(sinceMs)) { where.push("l.timestamp >= ?"); params.push(sinceMs) }
    return this.derivedCost(where, params)
  }

  /** 指定执行集合的费用（workflow 打分等跨执行总量，NEW-r2：llm_calls 派生）。 */
  costForExecutions(executionIds: readonly string[]): LedgerCost {
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
  aggregateLlmCallsBy(
    keyCol: 'execution_id' | 'session_id',
    ids: readonly string[],
    extraRawWhere: readonly string[] = [],
  ): Map<string, LlmUsageSummary> {
    const out = new Map<string, LlmUsageSummary>()
    const uniq = [...new Set(ids)].filter((v): v is string => typeof v === 'string' && v.length > 0)
    if (uniq.length === 0) return out
    // 分片避开 SQLite 变量上限；动态占位符数量不走 stmtCache（防缓存被变体灌爆）。
    const CHUNK = 400
    for (let i = 0; i < uniq.length; i += CHUNK) {
      const slice = uniq.slice(i, i + CHUNK)
      const marks = slice.map(() => '?').join(',')
      const { sql, params } = pricedCallsSql([`l.${keyCol} IN (${marks})`, ...extraRawWhere], [...slice])
      const rows = this.db.prepare(`
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
      `).all(...params) as Array<{
        k: string | null; i: number; o: number; cr: number; cc: number
        tokens: number | null; hit: number | null
        usd: number | null; total: number; priced: number; complete: number
      }>
      for (const r of rows) {
        if (r.k == null) continue
        const usage: TokenUsage = {
          inputTokens: r.i, outputTokens: r.o, cacheReadTokens: r.cr, cacheCreationTokens: r.cc,
        }
        out.set(r.k, {
          totalCalls: r.total,
          usage,
          totals: { tokens: r.tokens ?? 0, cost: { usd: r.usd ?? null, complete: r.complete === 1 }, cacheHitRate: r.hit },
        })
      }
    }
    return out
  }

  /** 单节点（node_id 语义）的逐 call 费用行 → LedgerRow（JS 镜像公式消费方，NEW-r2：源 = llm_calls 派生）。 */
  findLedgerRowsByNodeId(executionId: string, nodeId: string): LedgerRow[] {
    const rows = this.stmt(`
      SELECT q.model, q.input_tokens, q.output_tokens,
             q.cache_read_tokens, q.cache_creation_tokens, q.cost_usd
      FROM llm_calls_costed q
      WHERE q.execution_id = ? AND q.node_id = ?
    `).all(executionId, nodeId) as Array<{
      model: string | null; input_tokens: number; output_tokens: number
      cache_read_tokens: number; cache_creation_tokens: number; cost_usd: number | null
    }>
    return rows.map(r => ({
      inputTokens: r.input_tokens, outputTokens: r.output_tokens,
      cacheReadTokens: r.cache_read_tokens, cacheCreationTokens: r.cache_creation_tokens,
      costUsd: r.cost_usd,
    }))
  }

  findLlmCallsByNodeExecution(nodeExecutionId: string): LlmCallCostedRow[] {
    return this.stmt("SELECT * FROM llm_calls_costed WHERE node_execution_id = ?").all(nodeExecutionId) as LlmCallCostedRow[]
  }

  // findLlmCallsByWorkspace —— v48 起零调用方，随快照账一并删除。

  insertLlmCall(row: LlmCallRow): Database.RunResult {
    return this.stmt(`
      INSERT OR IGNORE INTO llm_calls (
        id, node_execution_id, execution_id, turn_index, call_index, message_id,
        model, stop_reason, timestamp, duration_ms, ttft_ms,
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
        org, workspace_id, workflow_ref, node_id, session_id, instance_id, source_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.node_execution_id, row.execution_id, row.turn_index, row.call_index,
      row.message_id, row.model, row.stop_reason, row.timestamp, row.duration_ms,
      row.ttft_ms, row.input_tokens, row.output_tokens, row.cache_read_tokens,
      row.cache_creation_tokens,
      row.org, row.workspace_id, row.workflow_ref, row.node_id, row.session_id, row.instance_id,
      row.source_path ?? null,
    )
  }

  deleteLlmCallsByExecution(executionId: string): Database.RunResult {
    return this.stmt(`
      DELETE FROM llm_calls WHERE node_execution_id IN (
        SELECT id FROM node_executions WHERE execution_id = ?
      )
    `).run(executionId)
  }

  cleanupOlderThan(timestamp: number): Database.RunResult {
    return this.stmt("DELETE FROM llm_calls WHERE timestamp < ?").run(timestamp)
  }

  // ── Batch inserts ────────────────────────────────────────────────────

  insertLlmCallBatch(rows: LlmCallRow[]): void {
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
      // 动态 IN 列表不走 stmtCache（防缓存被占位符变体灌爆）
      const placeholders = ids.map(() => "?").join(",")
      const found = this.db
        .prepare(`SELECT message_id FROM llm_calls WHERE execution_id = ? AND message_id IN (${placeholders})`)
        .all(execId, ...ids) as Array<{ message_id: string }>
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
    const insertStmt = this.stmt(`
      INSERT OR IGNORE INTO llm_calls (
        id, node_execution_id, execution_id, turn_index, call_index, message_id,
        model, stop_reason, timestamp, duration_ms, ttft_ms,
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
        org, workspace_id, workflow_ref, node_id, session_id, instance_id, source_path
      ) VALUES (
        @id, @node_execution_id, @execution_id, @turn_index, @call_index,
        @message_id, @model, @stop_reason, @timestamp, @duration_ms, @ttft_ms,
        @input_tokens, @output_tokens, @cache_read_tokens, @cache_creation_tokens,
        @org, @workspace_id, @workflow_ref, @node_id, @session_id, @instance_id, @source_path
      )
    `)
    this.transaction(() => {
      for (const row of kept) {
        // optional 字段 —— named 绑定缺 key/undefined 会抛，统一补 NULL 兜底
        insertStmt.run({
          ...row,
          source_path: row.source_path ?? null,
        })
      }
    })
  }

  // ── Leaderboard queries ──────────────────────────────────────────────
  // NEW-r2：token 仍以 ntu 为账；cost 全部从 llm_calls_costed 视图派生
  // （costGroupedBy 一次扫描分组，JS 侧合流 —— 返回形状不变）。

  getWorkspaceRanking(limit: number): Array<{
    workspace_id: string; workspace_name: string; total_tokens: number;
    total_cost_usd: number | null; cost_complete: number;
    model: string; input_tokens: number; output_tokens: number;
    cache_read_tokens: number; cache_creation_tokens: number; model_cost_usd: number | null
  }> {
    const wsRows = this.stmt(`
      SELECT w.id AS workspace_id, w.name AS workspace_name,
             ${LEDGER_SQL.sumTokens('ntu.')} AS total_tokens
      FROM node_token_usages ntu
      JOIN node_executions ne ON ntu.node_execution_id = ne.id
      JOIN executions e ON ne.execution_id = e.id
      JOIN workspaces w ON e.workspace_id = w.id
      GROUP BY w.id, w.name
      ORDER BY total_tokens DESC LIMIT ?
    `).all(limit) as Array<{ workspace_id: string; workspace_name: string; total_tokens: number }>
    if (wsRows.length === 0) return []
    const ids = wsRows.map(r => r.workspace_id)
    const marks = ids.map(() => "?").join(",")
    const modelRows = this.stmt(`
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
    `).all(...ids) as Array<{ workspace_id: string; model: string; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number }>
    const wsCost = this.costGroupedBy(["workspace_id"], [`l.workspace_id IN (${marks})`], ids)
    const wmCost = this.costGroupedBy(["workspace_id", "model"], [`l.workspace_id IN (${marks})`], ids)
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
          workspace_id: ws.workspace_id, workspace_name: ws.workspace_name, total_tokens: ws.total_tokens,
          total_cost_usd: c?.usd ?? null, cost_complete: c?.complete ? 1 : 0,
          model: m.model, input_tokens: m.input_tokens, output_tokens: m.output_tokens,
          cache_read_tokens: m.cache_read_tokens, cache_creation_tokens: m.cache_creation_tokens,
          model_cost_usd: mc?.usd ?? null,
        })
      }
    }
    return out
  }

  getExecutionRanking(limit: number): Array<{
    execution_id: string; workflow_ref: string; workflow_name: string | null;
    workspace_id: string; workspace_name: string; total_tokens: number;
    input_tokens: number; output_tokens: number; cache_read_tokens: number;
    cache_creation_tokens: number; total_cost_usd: number | null; cost_complete: number
  }> {
    const rows = this.stmt(`
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
    `).all(limit) as Array<{
      execution_id: string; workflow_ref: string; workflow_name: string | null;
      workspace_id: string; workspace_name: string; total_tokens: number;
      input_tokens: number; output_tokens: number; cache_read_tokens: number;
      cache_creation_tokens: number
    }>
    const cost = this.costGroupedBy(["execution_id"])
    return rows.map(r => {
      const c = cost.get(r.execution_id)
      return { ...r, total_cost_usd: c?.usd ?? null, cost_complete: c?.complete ? 1 : 0 }
    })
  }

  getExecutionModelBreakdown(executionId: string): Array<{
    model: string; input_tokens: number; output_tokens: number;
    cache_read_tokens: number; cache_creation_tokens: number;
    model_cost_usd: number | null; cost_complete: number
  }> {
    const rows = this.stmt(`
      SELECT ntu.model,
        SUM(ntu.input_tokens) AS input_tokens, SUM(ntu.output_tokens) AS output_tokens,
        SUM(ntu.cache_read_tokens) AS cache_read_tokens,
        SUM(ntu.cache_creation_tokens) AS cache_creation_tokens
      FROM node_token_usages ntu
      JOIN node_executions ne ON ntu.node_execution_id = ne.id
      WHERE ne.execution_id = ?
      GROUP BY ntu.model
      ORDER BY input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens DESC
    `).all(executionId) as Array<{
      model: string; input_tokens: number; output_tokens: number;
      cache_read_tokens: number; cache_creation_tokens: number
    }>
    const cost = this.costGroupedBy(["model"], ["l.execution_id = ?"], [executionId])
    return rows.map(r => {
      const c = cost.get(r.model)
      return { ...r, model_cost_usd: c?.usd ?? null, cost_complete: c?.complete ? 1 : 0 }
    })
  }

  getModelRanking(limit: number): Array<{
    model: string; input_tokens: number; output_tokens: number;
    cache_read_tokens: number; cache_creation_tokens: number;
    total_tokens: number; cost_usd: number | null; cost_complete: number
  }> {
    const rows = this.stmt(`
      SELECT ntu.model,
        SUM(ntu.input_tokens) AS input_tokens, SUM(ntu.output_tokens) AS output_tokens,
        SUM(ntu.cache_read_tokens) AS cache_read_tokens,
        SUM(ntu.cache_creation_tokens) AS cache_creation_tokens,
        ${LEDGER_SQL.sumTokens('ntu.')} AS total_tokens
      FROM node_token_usages ntu
      GROUP BY ntu.model
      ORDER BY total_tokens DESC LIMIT ?
    `).all(limit) as Array<{
      model: string; input_tokens: number; output_tokens: number;
      cache_read_tokens: number; cache_creation_tokens: number; total_tokens: number
    }>
    const cost = this.costGroupedBy(["model"])
    return rows.map(r => {
      const c = cost.get(r.model)
      return { ...r, cost_usd: c?.usd ?? null, cost_complete: c?.complete ? 1 : 0 }
    })
  }

  // ── Health & monitoring queries ──────────────────────────────────────
  //
  // 「parent_id = '0'」 here always meant 「count launched instances, not composite
  // arms」. Since task-exec-tree (v44) a v4 round carries a parent (its lineage), so
  // the honest predicate is (parent = '0' OR phase-tagged) — the latch's predicate.

  getHealthStats(workspaceId: string, days: number): { total: number; success_count: number; failure_count: number; avg_duration: number | null; total_cost: number | null; cost_complete: boolean } {
    const statsRow = this.stmt(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as success_count,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failure_count,
        AVG(CASE WHEN duration IS NOT NULL THEN duration END) as avg_duration
      FROM executions
      WHERE workspace_id = ? AND (parent_id = '0' OR phase_index IS NOT NULL)
        AND created_at >= datetime('now', '-' || ? || ' days')
    `).get(workspaceId, days) as { total: number; success_count: number; failure_count: number; avg_duration: number | null }

    const costRow = this.stmt(`
      SELECT ${PRICED_AGG.sumCost("q")} as total_cost, ${PRICED_AGG.complete("q")} as cost_complete
      FROM llm_calls_costed q
      JOIN executions e ON e.id = q.execution_id
      WHERE e.workspace_id = ? AND e.created_at >= datetime('now', '-' || ? || ' days')
    `).get(workspaceId, days) as { total_cost: number | null; cost_complete: number }

    return { ...statsRow, total_cost: costRow.total_cost, cost_complete: costRow.cost_complete === 1 }
  }

  getDailyTrend(workspaceId: string, days: number): Array<{ date: string; success_count: number; failed_count: number }> {
    return this.stmt(`
      SELECT DATE(created_at) as date,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as success_count,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_count
      FROM executions
      WHERE workspace_id = ? AND (parent_id = '0' OR phase_index IS NOT NULL)
        AND created_at >= datetime('now', '-' || ? || ' days')
      GROUP BY DATE(created_at) ORDER BY date ASC
    `).all(workspaceId, days) as Array<{ date: string; success_count: number; failed_count: number }>
  }

  getActiveAlertCount(workspaceId: string, days: number): number {
    const row = this.stmt(`
      SELECT COUNT(*) as count FROM (
        SELECT 1 FROM executions
        WHERE workspace_id = ? AND (parent_id = '0' OR phase_index IS NOT NULL) AND status = 'failed'
          AND created_at >= datetime('now', '-' || ? || ' days')
        GROUP BY workflow_ref
        HAVING COUNT(*) >= 3
      )
    `).get(workspaceId, days) as { count: number }
    return row.count
  }

  getConsecutiveFailureAlerts(workspaceId: string, days: number): Array<{
    workflow_ref: string; streak_length: number; streak_start: string; streak_end: string
  }> {
    return this.stmt(`
      WITH run_sequences AS (
        SELECT workflow_ref, id, status, created_at,
          ROW_NUMBER() OVER (PARTITION BY workflow_ref ORDER BY created_at)
          - ROW_NUMBER() OVER (PARTITION BY workflow_ref, status ORDER BY created_at) as streak_group
        FROM executions
        WHERE (parent_id = '0' OR phase_index IS NOT NULL) AND workspace_id = ?
          AND created_at >= datetime('now', '-' || ? || ' days')
      ),
      streak_counts AS (
        SELECT workflow_ref, status, streak_group,
          COUNT(*) as streak_length, MIN(created_at) as streak_start, MAX(created_at) as streak_end
        FROM run_sequences GROUP BY workflow_ref, status, streak_group
      )
      SELECT * FROM streak_counts WHERE status = 'failed' AND streak_length >= 3 ORDER BY streak_length DESC
    `).all(workspaceId, days) as Array<{
      workflow_ref: string; streak_length: number; streak_start: string; streak_end: string
    }>
  }

  getHighFailureRateAlerts(workspaceId: string, days: number): Array<{
    node_id: string; node_type: string; workflow_ref: string;
    total_runs: number; failures: number; failure_pct: number; last_failure: string
  }> {
    return this.stmt(`
      WITH node_health AS (
        SELECT ne.node_id, ne.node_type, e.workflow_ref,
          COUNT(*) as total_runs,
          SUM(CASE WHEN ne.status = 'failed' THEN 1 ELSE 0 END) as failures,
          MAX(ne.completed_at) as last_failure
        FROM node_executions ne JOIN executions e ON ne.execution_id = e.id
        WHERE e.workspace_id = ? AND e.created_at >= datetime('now', '-' || ? || ' days')
        GROUP BY ne.node_id, e.workflow_ref HAVING total_runs >= 3
      )
      SELECT *, ROUND(CAST(failures AS REAL) / total_runs * 100, 1) as failure_pct
      FROM node_health WHERE failures > 0 AND CAST(failures AS REAL) / total_runs > 0.5
      ORDER BY failure_pct DESC LIMIT 10
    `).all(workspaceId, days) as Array<{
      node_id: string; node_type: string; workflow_ref: string;
      total_runs: number; failures: number; failure_pct: number; last_failure: string
    }>
  }

  getCostSpikeAlerts(workspaceId: string, days: number): Array<{
    id: string; workflow_ref: string; exec_cost: number | null; created_at: string;
    avg_cost: number; cost_ratio: number
  }> {
    return this.stmt(`
      WITH exec_costs AS (
        SELECT e.id, e.workflow_ref, e.created_at, v.exec_cost
        FROM executions e
        JOIN (
          SELECT q.execution_id, ${PRICED_AGG.sumCost("q")} as exec_cost
          FROM llm_calls_costed q GROUP BY q.execution_id
        ) v ON v.execution_id = e.id
        WHERE e.workspace_id = ? AND e.created_at >= datetime('now', '-' || ? || ' days')
      ),
      wf_avg AS (
        SELECT workflow_ref, AVG(exec_cost) as avg_cost FROM exec_costs GROUP BY workflow_ref
      )
      SELECT ec.id, ec.workflow_ref, ec.exec_cost, ec.created_at, wa.avg_cost,
        ROUND(ec.exec_cost / wa.avg_cost, 1) as cost_ratio
      FROM exec_costs ec JOIN wf_avg wa ON ec.workflow_ref = wa.workflow_ref
      WHERE ec.exec_cost > wa.avg_cost * 3 ORDER BY cost_ratio DESC LIMIT 10
    `).all(workspaceId, days) as Array<{
      id: string; workflow_ref: string; exec_cost: number; created_at: string;
      avg_cost: number; cost_ratio: number
    }>
  }

  getErrorCategories(workspaceId: string, days: number): Array<{
    error_category: string; count: number; last_seen: string | null; sample_errors: string | null
  }> {
    return this.stmt(`
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
        GROUP_CONCAT(SUBSTR(COALESCE(error, ''), 1, 200), '|||') as sample_errors
      FROM node_executions
      WHERE status = 'failed'
        AND started_at >= datetime('now', '-' || ? || ' days')
        AND execution_id IN (SELECT id FROM executions WHERE workspace_id = ?)
      GROUP BY error_category ORDER BY count DESC
    `).all(days, workspaceId) as Array<{
      error_category: string; count: number; last_seen: string | null; sample_errors: string | null
    }>
  }

  getFragilityRanking(workspaceId: string, days: number): Array<{
    node_id: string; node_type: string; workflow_ref: string;
    total_runs: number; failures: number; avg_duration: number | null;
    last_failure: string | null; fragility_score: number
  }> {
    return this.stmt(`
      WITH node_health AS (
        SELECT ne.node_id, ne.node_type, e.workflow_ref,
          COUNT(*) as total_runs,
          SUM(CASE WHEN ne.status = 'failed' THEN 1 ELSE 0 END) as failures,
          AVG(ne.duration) as avg_duration, MAX(ne.completed_at) as last_failure
        FROM node_executions ne JOIN executions e ON ne.execution_id = e.id
        WHERE e.created_at >= datetime('now', '-' || ? || ' days') AND e.workspace_id = ?
        GROUP BY ne.node_id, e.workflow_ref
      )
      SELECT *, ROUND(
        (CAST(failures AS REAL) / total_runs) * 100
        * CASE WHEN total_runs > 10 THEN 1.0 ELSE 0.5 END, 1
      ) as fragility_score
      FROM node_health WHERE failures > 0
      ORDER BY fragility_score DESC LIMIT 20
    `).all(days, workspaceId) as Array<{
      node_id: string; node_type: string; workflow_ref: string;
      total_runs: number; failures: number; avg_duration: number | null;
      last_failure: string | null; fragility_score: number
    }>
  }

  getFailureChains(workspaceId: string, days: number): Array<{
    failed_node: string; downstream_node: string; downstream_status: string; occurrences: number
  }> {
    return this.stmt(`
      WITH failure_chains AS (
        SELECT ne1.node_id as failed_node, ne2.node_id as downstream_node,
          ne2.status as downstream_status, COUNT(*) as occurrences
        FROM node_executions ne1
        JOIN node_executions ne2 ON ne1.execution_id = ne2.execution_id AND ne2.started_at > ne1.completed_at
        JOIN executions e ON ne1.execution_id = e.id
        WHERE ne1.status = 'failed' AND e.workspace_id = ?
          AND e.created_at >= datetime('now', '-' || ? || ' days')
        GROUP BY ne1.node_id, ne2.node_id, ne2.status
      )
      SELECT * FROM failure_chains ORDER BY failed_node, occurrences DESC LIMIT 100
    `).all(workspaceId, days) as Array<{
      failed_node: string; downstream_node: string; downstream_status: string; occurrences: number
    }>
  }

  getDurationAnomalies(workspaceId: string, days: number): Array<{
    execution_id: string; node_id: string; current_duration: number;
    mean_duration: number; stddev_duration: number; z_score: number; severity: string
  }> {
    return this.stmt(`
      WITH node_stats AS (
        SELECT node_id, AVG(duration) as mean_duration,
          SQRT((AVG(duration * duration) - AVG(duration) * AVG(duration)) * CAST(COUNT(*) AS REAL) / (COUNT(*) - 1)) as stddev_duration,
          COUNT(*) as sample_count
        FROM node_executions
        WHERE status = 'completed' AND duration IS NOT NULL
          AND started_at >= datetime('now', '-' || ? || ' days')
          AND execution_id IN (SELECT id FROM executions WHERE workspace_id = ?)
        GROUP BY node_id HAVING sample_count >= 10
      )
      SELECT ne.execution_id, ne.node_id, ne.duration as current_duration,
        ns.mean_duration, ns.stddev_duration,
        ROUND((ne.duration - ns.mean_duration) / ns.stddev_duration, 1) as z_score,
        CASE WHEN (ne.duration - ns.mean_duration) / ns.stddev_duration > 3 THEN 'critical' ELSE 'warning' END as severity
      FROM node_executions ne
      JOIN node_stats ns ON ne.node_id = ns.node_id
      WHERE ne.status = 'completed' AND ns.stddev_duration > 0
        AND (ne.duration - ns.mean_duration) / ns.stddev_duration > 2
        AND ne.started_at >= datetime('now', '-' || ? || ' days')
        AND ne.execution_id IN (SELECT id FROM executions WHERE workspace_id = ?)
      ORDER BY z_score DESC LIMIT 50
    `).all(days, workspaceId, days, workspaceId) as Array<{
      execution_id: string; node_id: string; current_duration: number;
      mean_duration: number; stddev_duration: number; z_score: number; severity: string
    }>
  }

  getCostAnomalies(workspaceId: string, days: number): Array<{
    id: string; workflow_ref: string; exec_cost: number | null; avg_cost: number;
    cost_ratio: number; severity: string
  }> {
    return this.stmt(`
      WITH exec_costs AS (
        SELECT e.id, e.workflow_ref, e.created_at, v.exec_cost
        FROM executions e
        JOIN (
          SELECT q.execution_id, ${PRICED_AGG.sumCost("q")} as exec_cost
          FROM llm_calls_costed q GROUP BY q.execution_id
        ) v ON v.execution_id = e.id
        WHERE e.workspace_id = ? AND e.created_at >= datetime('now', '-' || ? || ' days')
      ),
      wf_avg AS (
        SELECT workflow_ref, AVG(exec_cost) as avg_cost, MAX(exec_cost) as max_cost
        FROM exec_costs GROUP BY workflow_ref HAVING COUNT(*) >= 5
      )
      SELECT ec.id, ec.workflow_ref, ec.exec_cost, ec.created_at, wa.avg_cost,
        ROUND(ec.exec_cost / wa.avg_cost, 1) as cost_ratio,
        CASE WHEN ec.exec_cost > wa.avg_cost * 5 THEN 'critical' WHEN ec.exec_cost > wa.avg_cost * 3 THEN 'warning' ELSE 'normal' END as severity
      FROM exec_costs ec JOIN wf_avg wa ON ec.workflow_ref = wa.workflow_ref
      WHERE ec.exec_cost > wa.avg_cost * 2 ORDER BY cost_ratio DESC LIMIT 20
    `).all(workspaceId, days) as Array<{
      id: string; workflow_ref: string; exec_cost: number; avg_cost: number;
      cost_ratio: number; severity: string
    }>
  }

  getCostTrend(workspaceId: string, days: number): Array<{ date: string; total_cost: number | null; exec_count: number }> {
    return this.stmt(`
      SELECT DATE(e.created_at) as date,
        SUM(v.exec_cost) as total_cost,
        COUNT(DISTINCT e.id) as exec_count
      FROM executions e
      LEFT JOIN (
        SELECT q.execution_id, ${PRICED_AGG.sumCost("q")} as exec_cost
        FROM llm_calls_costed q GROUP BY q.execution_id
      ) v ON v.execution_id = e.id
      WHERE e.workspace_id = ? AND (e.parent_id = '0' OR e.phase_index IS NOT NULL)
        AND e.created_at >= datetime('now', '-' || ? || ' days')
      GROUP BY DATE(e.created_at) ORDER BY date ASC
    `).all(workspaceId, days) as Array<{ date: string; total_cost: number | null; exec_count: number }>
  }

  getTokenDistribution(workspaceId: string, days: number): Array<{
    model: string; total_input: number; total_output: number;
    total_cost: number | null; cache_hit_rate: number | null
  }> {
    const rows = this.stmt(`
      SELECT ntu.model,
        SUM(ntu.input_tokens) as total_input, SUM(ntu.output_tokens) as total_output,
        ${LEDGER_SQL.cacheHitRate('ntu.')} as cache_hit_rate
      FROM node_token_usages ntu
      JOIN node_executions ne ON ntu.node_execution_id = ne.id
      JOIN executions e ON ne.execution_id = e.id
      WHERE e.workspace_id = ? AND e.created_at >= datetime('now', '-' || ? || ' days')
      GROUP BY ntu.model
    `).all(workspaceId, days) as Array<{ model: string; total_input: number; total_output: number; cache_hit_rate: number | null }>
    const cost = this.costGroupedBy(["model"], [`l.execution_id IN (SELECT id FROM executions WHERE workspace_id = ? AND created_at >= datetime('now', '-' || ? || ' days'))`], [workspaceId, days])
    return rows
      .map(r => ({ ...r, total_cost: cost.get(r.model)?.usd ?? null }))
      .sort((a, b) => (b.total_cost ?? -1) - (a.total_cost ?? -1))
  }

  getCostByWorkflow(workspaceId: string, days: number): Array<{
    workflow_ref: string; total_cost: number | null; exec_count: number; avg_cost: number | null
  }> {
    return this.stmt(`
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
        AND e.created_at >= datetime('now', '-' || ? || ' days')
      GROUP BY e.workflow_ref ORDER BY total_cost DESC
    `).all(workspaceId, days) as Array<{
      workflow_ref: string; total_cost: number | null; exec_count: number; avg_cost: number | null
    }>
  }

  // ── Workspace Token Stats (for archive preview) ──────────────────────

  getWorkspaceTokenStats(workspaceId: string): {
    total: { inputTokens: number; outputTokens: number; cost: LedgerCost }
    byModel: Array<{ model: string; inputTokens: number; outputTokens: number; cost: number | null }>
    byWorkflow: Array<{
      workflowRef: string; inputTokens: number; outputTokens: number; cost: LedgerCost
      byModel: Array<{ model: string; inputTokens: number; outputTokens: number; cost: number | null }>
    }>
  } {
    // NEW-r2：token 源 ntu；cost 源 = llm_calls_costed（workspace 口径），JS 合流。
    const modelRows = this.stmt(`
      SELECT ntu.model,
        SUM(ntu.input_tokens) as input_tokens, SUM(ntu.output_tokens) as output_tokens
      FROM node_token_usages ntu
      JOIN node_executions ne ON ntu.node_execution_id = ne.id
      JOIN executions e ON ne.execution_id = e.id
      WHERE e.workspace_id = ?
      GROUP BY ntu.model
    `).all(workspaceId) as Array<{ model: string; input_tokens: number; output_tokens: number }>
    const modelCost = this.costGroupedBy(["model"], ["l.workspace_id = ?"], [workspaceId])
    const costedModelRows = modelRows.map(r => ({
      model: r.model, inputTokens: r.input_tokens, outputTokens: r.output_tokens,
      cost: modelCost.get(r.model)?.usd ?? null,
    }))
    const byModel = costedModelRows.slice().sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1))

    const total = {
      inputTokens: modelRows.reduce((a, r) => a + r.input_tokens, 0),
      outputTokens: modelRows.reduce((a, r) => a + r.output_tokens, 0),
      cost: costSummary(costedModelRows.map(r => r.cost)),
    }

    // Per-workflow with model breakdown
    const wfRows = this.stmt(`
      SELECT e.workflow_ref, ntu.model,
        SUM(ntu.input_tokens) as input_tokens, SUM(ntu.output_tokens) as output_tokens
      FROM node_token_usages ntu
      JOIN node_executions ne ON ntu.node_execution_id = ne.id
      JOIN executions e ON ne.execution_id = e.id
      WHERE e.workspace_id = ?
      GROUP BY e.workflow_ref, ntu.model ORDER BY e.workflow_ref
    `).all(workspaceId) as Array<{ workflow_ref: string; model: string; input_tokens: number; output_tokens: number }>
    const wmCost = this.costGroupedBy(["workflow_ref", "model"], ["l.workspace_id = ?"], [workspaceId])

    const wfMap = new Map<string, { inputTokens: number; outputTokens: number; costs: Array<number | null>; byModel: Array<{ model: string; inputTokens: number; outputTokens: number; cost: number | null }> }>()
    for (const r of wfRows) {
      let wf = wfMap.get(r.workflow_ref)
      if (!wf) { wf = { inputTokens: 0, outputTokens: 0, costs: [], byModel: [] }; wfMap.set(r.workflow_ref, wf) }
      const cost = wmCost.get(`${r.workflow_ref}|${r.model}`)?.usd ?? null
      wf.inputTokens += r.input_tokens
      wf.outputTokens += r.output_tokens
      wf.costs.push(cost)
      wf.byModel.push({ model: r.model, inputTokens: r.input_tokens, outputTokens: r.output_tokens, cost })
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

  getNodeTokenStats(workspaceId: string): Array<{
    workflowRef: string; nodeId: string; nodeName: string; nodeType: string
    inputTokens: number; outputTokens: number; cost: LedgerCost
    byModel: Array<{ model: string; inputTokens: number; outputTokens: number; cost: number | null }>
  }> {
    const rows = this.stmt(`
      SELECT e.workflow_ref, ne.node_id,
        ne.node_type,
        ntu.model,
        SUM(ntu.input_tokens) as input_tokens, SUM(ntu.output_tokens) as output_tokens
      FROM node_token_usages ntu
      JOIN node_executions ne ON ntu.node_execution_id = ne.id
      JOIN executions e ON ne.execution_id = e.id
      WHERE e.workspace_id = ?
      GROUP BY e.workflow_ref, ne.node_id, ntu.model
      ORDER BY e.workflow_ref
    `).all(workspaceId) as Array<{
      workflow_ref: string; node_id: string; node_type: string
      model: string; input_tokens: number; output_tokens: number
    }>
    const wnmCost = this.costGroupedBy(["workflow_ref", "node_id", "model"], ["l.workspace_id = ?"], [workspaceId])

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
      node.inputTokens += r.input_tokens
      node.outputTokens += r.output_tokens
      node.costs.push(cost)
      node.byModel.push({ model: r.model, inputTokens: r.input_tokens, outputTokens: r.output_tokens, cost })
    }

    return Array.from(nodeMap.values()).map(n => ({
      workflowRef: n.workflowRef, nodeId: n.nodeId, nodeName: n.nodeName, nodeType: n.nodeType,
      inputTokens: n.inputTokens, outputTokens: n.outputTokens,
      cost: costSummary(n.costs), byModel: n.byModel.slice().sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1)),
    }))
  }

  // ── LLM call analysis (for suggestion-engine) ────────────────────────

  findLlmCallStatsByNode(workspaceId: string, workflowRef: string): Array<{
    node_id: string; avg_out: number; calls: number; tool_ratio: number
  }> {
    return this.stmt(`
      SELECT node_id, AVG(output_tokens) as avg_out,
             COUNT(*) as calls,
             CAST(SUM(CASE WHEN stop_reason = 'tool_use' THEN 1 ELSE 0 END) AS REAL) / COUNT(*) as tool_ratio
      FROM llm_calls WHERE workspace_id = ? AND workflow_ref = ?
      GROUP BY node_id
    `).all(workspaceId, workflowRef) as Array<{ node_id: string; avg_out: number; calls: number; tool_ratio: number }>
  }

  findThinkingOutputRatio(workspaceId: string, workflowRef: string): Array<{
    node_id: string; thinking_total: number; output_total: number
  }> {
    return this.stmt(`
      SELECT node_id,
             SUM(cache_read_tokens + cache_creation_tokens) as thinking_total,
             SUM(output_tokens) as output_total
      FROM llm_calls WHERE workspace_id = ? AND workflow_ref = ?
      GROUP BY node_id HAVING output_total > 0
    `).all(workspaceId, workflowRef) as Array<{ node_id: string; thinking_total: number; output_total: number }>
  }

  findOutputOverproduction(workspaceId: string, workflowRef: string): Array<{
    node_id: string; avg_out: number; calls: number
  }> {
    return this.stmt(`
      SELECT node_id, AVG(output_tokens) as avg_out, COUNT(*) as calls
      FROM llm_calls WHERE workspace_id = ? AND workflow_ref = ?
      GROUP BY node_id
    `).all(workspaceId, workflowRef) as Array<{ node_id: string; avg_out: number; calls: number }>
  }

  // ── Analytics cost queries ─────────────────────────────────────────
  // NEW-r2：源 = llm_calls_costed 视图（cost_usd 为查询时按窗口匹配的派生列）。

  totalCostByWorkspaceSince(workspaceId: string, tsCutoff: number): number | null {
    const row = this.stmt(
      `SELECT ${LEDGER_SQL.sumCost('')} as total FROM llm_calls_costed WHERE workspace_id = ? AND timestamp >= ?`
    ).get(workspaceId, tsCutoff) as { total: number | null }
    return row.total
  }

  costByModelSince(workspaceId: string, tsCutoff: number): Array<Record<string, unknown>> {
    return this.stmt(`
      SELECT model, COUNT(*) as calls, ${LEDGER_SQL.sumCost('')} as total_cost,
             SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens,
             SUM(cache_read_tokens) as cache_read, SUM(cache_creation_tokens) as cache_create
      FROM llm_calls_costed WHERE workspace_id = ? AND timestamp >= ?
      GROUP BY model ORDER BY total_cost DESC
    `).all(workspaceId, tsCutoff) as Array<Record<string, unknown>>
  }

  costByWorkflowSince(workspaceId: string, tsCutoff: number): Array<Record<string, unknown>> {
    return this.stmt(`
      SELECT workflow_ref, COUNT(DISTINCT execution_id) as executions,
             ${LEDGER_SQL.sumCost('')} as total_cost
      FROM llm_calls_costed WHERE workspace_id = ? AND timestamp >= ?
      GROUP BY workflow_ref ORDER BY total_cost DESC
    `).all(workspaceId, tsCutoff) as Array<Record<string, unknown>>
  }

  dailyCostSince(workspaceId: string, tsCutoff: number): Array<Record<string, unknown>> {
    return this.stmt(`
      SELECT DATE(timestamp / 1000, 'unixepoch') as date,
             ${LEDGER_SQL.sumCost('')} as total_cost, COUNT(*) as calls
      FROM llm_calls_costed WHERE workspace_id = ? AND timestamp >= ?
      GROUP BY date ORDER BY date ASC
    `).all(workspaceId, tsCutoff) as Array<Record<string, unknown>>
  }

  findLlmCallsByWorkflowSince(workspaceId: string, workflowRef: string, tsCutoff: number): Array<Record<string, unknown>> {
    return this.stmt(
      "SELECT * FROM llm_calls_costed WHERE workspace_id = ? AND workflow_ref = ? AND timestamp >= ?"
    ).all(workspaceId, workflowRef, tsCutoff) as Array<Record<string, unknown>>
  }
}
