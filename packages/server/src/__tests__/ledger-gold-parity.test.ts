// packages/server/src/__tests__/ledger-gold-parity.test.ts
//
// P1 B4 票2B-3 —— gold 表逐位相等总验（B4 出口人判项，p1-batch-plan/plan.html P1 判据）。
//
// 钉的是什么：账本三件套（llm_calls_costed 派生视图 / LEDGER_SQL / PRICED_AGG）
// 从 SQLite 旧路径（迁移前生产形态 = git 0468ed49 的 price-sql.ts +
// token-usage-dao.ts SQL 文本，本文件逐字内嵌为基准）平移到 PG 新路径（现
// TokenUsageDAO + 现 price-sql.ts 生成的视图 DDL）后，**同一输入集**上的
// 金额/计数/分组结果必须逐行逐字段 bit-exact（toStrictEqual/Object.is 语义，禁止容差）。
// 唯一数学性例外（见 assertUsdSum 注释）：组级 SUM(double) 因 IEEE-754 加法不满足结合律、
// 两引擎访问次序不同，逐位相等不可能要求 —— 本测试把它压成硬界（|残差|<5e-10 且十进制
// 前 10 位逐位相等，实测个位 ulp 级），并把 bitExact/ulpDiffs/maxUlp 数字打进报告供人判。逐行 cost 标量、全部
// 整数口径、三态布尔、vendor/date 字符串仍是零容差逐位。
//
// 三层对比：
//   ① DDL 改写惰性（双模式全跑，不依赖 PG）：同一 SQLite 引擎上，基线视图文本
//      （CAST AS REAL、裸等式）vs 现视图文本（DOUBLE PRECISION、CASE 1/0）逐位相等。
//   ② 引擎平移（PG 模式）：基线 SQL @ SQLite（旧路径）vs 现 TokenUsageDAO @ PG（新路径），
//      输入集为确定性 LCG 合成数据（USD/CNY/窗口/兜底/无价/零价/边界时刻/零与大 token 全分支）。
//   ③ 真库样本（PG 模式，只读）：真 octopus 库全部 llm_calls 行 + 真实价行/汇率
//      原样回灌两引擎再对拍 —— 真库连接只做 SELECT，绝不写入。
//
// 无 OCTOPUS_PG_TEST_URL 时 ②③ 随 describePg skip（① 照跑），全量用例数不减。
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import Database from "better-sqlite3"
import Postgres from "postgres"
import { applySchema } from "../db/schema"
import { TokenUsageDAO } from "../db/dao/token-usage-dao"
import { LEDGER_SQL, type LlmUsageSummary } from "@octopus/shared"
import { describePg, setupPgSchema, type PgFixture } from "../db/pg/__tests__/dao-fixture"

// ─────────────────────────────────────────────────────────────────────────────
// 基线（迁移前）SQL 文本 —— 逐字取自 git 0468ed49:packages/server/src/db/price-sql.ts
// 与 0468ed49:packages/shared/src/ledger.ts。此后任何生产改写不得回写这里（对拍基准）。
// ─────────────────────────────────────────────────────────────────────────────

/** 0468ed49 RATE_SQL：CAST AS REAL（SQLite 的 REAL 即 f8；现版为 PG f4 坑改 DOUBLE PRECISION）。 */
const BASE_RATE_SQL = `COALESCE((SELECT CASE WHEN CAST(r.value AS REAL) > 0 THEN CAST(r.value AS REAL) END FROM billing_setting r WHERE r.key = 'usd_to_cny'), 7.0)`

/** 0468ed49 matchSubquery —— 与现版逐字同（价格匹配语义未动，只动 CAST 目标/布尔形态）。 */
function baseMatchSubquery(selectExpr: string, l: string): string {
  return `(
    SELECT ${selectExpr} FROM billing_price_config p
    WHERE p.model_id = ${l}.model
      AND (p.valid_from IS NULL OR p.valid_from <= ${l}.timestamp)
      AND (p.valid_to IS NULL OR p.valid_to > ${l}.timestamp)
    ORDER BY (p.valid_from IS NULL AND p.valid_to IS NULL) ASC,
             COALESCE(p.valid_from, -1) DESC,
             p.id ASC
    LIMIT 1
  )`
}
function baseCostNativeExpr(l: string): string {
  return `(p.input_unit_price * ${l}.input_tokens
        + p.output_unit_price * ${l}.output_tokens
        + p.cache_write_unit_price * ${l}.cache_creation_tokens
        + p.cache_read_unit_price * ${l}.cache_read_tokens) / 1000000.0`
}
function baseCallCostUsdSql(l: string): string {
  const native = baseCostNativeExpr(l)
  return baseMatchSubquery(`CASE WHEN p.currency = 'USD' THEN ${native} ELSE ${native} / ${BASE_RATE_SQL} END`, l)
}
/** 0468ed49 llm_calls_costed 视图 DDL。 */
const BASE_VIEW_DDL = `CREATE VIEW llm_calls_costed AS
SELECT l.*, ${baseCallCostUsdSql("l")} AS cost_usd, ${baseMatchSubquery("p.vendor", "l")} AS vendor
FROM llm_calls l`

/** 0468ed49 PRICED_AGG.complete：裸等式（SQLite 出 0/1）。 */
const baseComplete = (q = "q") => `COUNT(*) = COUNT(${q}.cost_usd)`
/** 0468ed49 LEDGER_SQL.cacheHitRate：CAST AS REAL。 */
const baseCacheHitRate = (p = "") =>
  `CASE WHEN SUM(${p}input_tokens + ${p}cache_read_tokens) > 0 ` +
  `THEN CAST(SUM(${p}cache_read_tokens) AS REAL) / SUM(${p}input_tokens + ${p}cache_read_tokens) ` +
  `ELSE NULL END`
// PRICED_AGG.sumCost/countPriced 与 LEDGER_SQL.sumTokens/sumCost：基线与现版逐字同。
const baseSumCost = (q = "q") => `SUM(${q}.cost_usd)`
const baseCountPriced = (q = "q") => `COUNT(${q}.cost_usd)`

/** 0468ed49 derivedCost（旧路径全局派生费用）。 */
function baseDerivedCostSql(where: string[] = []): string {
  const w = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""
  return `
      SELECT ${baseSumCost()} AS usd, ${baseComplete()} AS complete
      FROM (SELECT l.* FROM llm_calls_costed l${w}) q`
}

/** 0468ed49 aggregateLlmCallsBy 语句体（? 占位；keyCol 白名单由调用方保证）。 */
function baseAggregateBySql(keyCol: string, marks: string, extra: readonly string[] = []): string {
  const w = [`l.${keyCol} IN (${marks})`, ...extra].join(" AND ")
  return `
        SELECT q.${keyCol} AS k,
               SUM(q.input_tokens) AS i,
               SUM(q.output_tokens) AS o,
               SUM(q.cache_read_tokens) AS cr,
               SUM(q.cache_creation_tokens) AS cc,
               ${LEDGER_SQL.sumTokens("q.")} AS tokens,
               ${baseCacheHitRate("q.")} AS hit,
               ${baseSumCost("q")} AS usd,
               COUNT(*) AS total,
               ${baseCountPriced("q")} AS priced,
               ${baseComplete("q")} AS complete
        FROM (SELECT l.* FROM llm_calls_costed l WHERE ${w}) q
        GROUP BY q.${keyCol}`
}

// ─────────────────────────────────────────────────────────────────────────────
// 输入集（唯一一份，两个引擎各自原样吃进）
// ─────────────────────────────────────────────────────────────────────────────

interface CallRow {
  id: string; node_execution_id: string | null; execution_id: string | null
  turn_index: number; call_index: number; message_id: string | null
  model: string | null; stop_reason: string | null
  timestamp: number; duration_ms: number; ttft_ms: number | null
  input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number
  org: string | null; workspace_id: string | null; workflow_ref: string | null
  node_id: string | null; session_id: string | null; instance_id: string | null; source_path: string | null
}
interface PriceRow {
  id: string; vendor: string; model_id: string
  input_unit_price: number; output_unit_price: number
  cache_write_unit_price: number; cache_read_unit_price: number
  currency: string; valid_from: number | null; valid_to: number | null
  created_at: string; updated_at: string
}
interface Meta {
  workspaces: Array<{ id: string; name: string; path: string; org: string }>
  executions: Array<{ id: string; workspace_id: string; parent_id: string; workflow_ref: string; workflow_name: string; status: string }>
  nodeExecutions: Array<{ id: string; execution_id: string; node_id: string; node_type: string; status: string; duration: number }>
  ntu: Array<{ id: string; node_execution_id: string; model: string; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number }>
  settings: Array<{ key: string; value: string }>
}

const CALL_COLS = `id, node_execution_id, execution_id, turn_index, call_index, message_id,
        model, stop_reason, timestamp, duration_ms, ttft_ms,
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
        org, workspace_id, workflow_ref, node_id, session_id, instance_id, source_path`
const CALL_PARAMS_PER_ROW = 22
const TS = "2026-01-01T00:00:00.000Z"

function callParams(r: CallRow): unknown[] {
  return [r.id, r.node_execution_id, r.execution_id, r.turn_index, r.call_index, r.message_id,
    r.model, r.stop_reason, r.timestamp, r.duration_ms, r.ttft_ms,
    r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_creation_tokens,
    r.org, r.workspace_id, r.workflow_ref, r.node_id, r.session_id, r.instance_id, r.source_path]
}

/** 确定性 LCG —— gold 可重跑同数据。 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 }
}

const T0 = 1_700_000_000_000
const WIN_FROM = T0 + 10 * 86_400_000
const WIN_TO = T0 + 20 * 86_400_000

function syntheticDataset(): { calls: CallRow[]; prices: PriceRow[]; meta: Meta } {
  const rng = makeRng(0xB40D)
  const prices: PriceRow[] = [
    { id: "p-usd-a", vendor: "anthropic", model_id: "m-usd-a", input_unit_price: 3, output_unit_price: 15, cache_write_unit_price: 3.75, cache_read_unit_price: 0.3, currency: "USD", valid_from: null, valid_to: null, created_at: TS, updated_at: TS },
    { id: "p-cny-b", vendor: "deepseek", model_id: "m-cny-b", input_unit_price: 17.5, output_unit_price: 70, cache_write_unit_price: 26.25, cache_read_unit_price: 3.5, currency: "CNY", valid_from: null, valid_to: null, created_at: TS, updated_at: TS },
    { id: "p-usd-c", vendor: "openai", model_id: "m-win-c", input_unit_price: 2.6, output_unit_price: 13, cache_write_unit_price: 2.6, cache_read_unit_price: 0.65, currency: "USD", valid_from: null, valid_to: null, created_at: TS, updated_at: TS },
    { id: "p-usd-c-hi", vendor: "openai", model_id: "m-win-c", input_unit_price: 6, output_unit_price: 30, cache_write_unit_price: 6, cache_read_unit_price: 1.5, currency: "USD", valid_from: WIN_FROM, valid_to: WIN_TO, created_at: TS, updated_at: TS },
    { id: "p-zero", vendor: "local", model_id: "m-zero", input_unit_price: 0, output_unit_price: 0, cache_write_unit_price: 0, cache_read_unit_price: 0, currency: "USD", valid_from: null, valid_to: null, created_at: TS, updated_at: TS },
    { id: "p-big", vendor: "anthropic", model_id: "m-big", input_unit_price: 0.03571428571428571, output_unit_price: 0.10714285714285714, cache_write_unit_price: 0.044642857142857144, cache_read_unit_price: 0.0035714285714285713, currency: "CNY", valid_from: null, valid_to: null, created_at: TS, updated_at: TS },
  ]
  const models = ["m-usd-a", "m-cny-b", "m-win-c", "m-zero", "m-big", "m-none"] // m-none 无价 → unpriced 分支
  const meta: Meta = {
    workspaces: [
      { id: "ws-1", name: "WS1", path: "/tmp/gold-ws1", org: "gold" },
      { id: "ws-2", name: "WS2", path: "/tmp/gold-ws2", org: "gold" },
    ],
    executions: [
      { id: "e-1", workspace_id: "ws-1", parent_id: "0", workflow_ref: "a.yaml", workflow_name: "A", status: "completed" },
      { id: "e-2", workspace_id: "ws-1", parent_id: "0", workflow_ref: "b.yaml", workflow_name: "B", status: "completed" },
      { id: "e-3", workspace_id: "ws-2", parent_id: "0", workflow_ref: "a.yaml", workflow_name: "A", status: "failed" },
      { id: "e-4", workspace_id: "ws-2", parent_id: "e-1", workflow_ref: "c.yaml", workflow_name: "C", status: "completed" },
    ],
    nodeExecutions: [
      { id: "e-1-n1", execution_id: "e-1", node_id: "n1", node_type: "agent", status: "completed", duration: 1234 },
      { id: "e-2-n1", execution_id: "e-2", node_id: "n1", node_type: "agent", status: "failed", duration: 987 },
      { id: "e-3-n1", execution_id: "e-3", node_id: "n1", node_type: "agent", status: "failed", duration: 5 },
      { id: "e-4-n1", execution_id: "e-4", node_id: "n1", node_type: "agent", status: "completed", duration: 7 },
    ],
    ntu: [
      { id: "ntu-1", node_execution_id: "e-1-n1", model: "m-usd-a", input_tokens: 4200, output_tokens: 780, cache_read_tokens: 15000, cache_creation_tokens: 900 },
      { id: "ntu-2", node_execution_id: "e-2-n1", model: "m-cny-b", input_tokens: 0, output_tokens: 500, cache_read_tokens: 0, cache_creation_tokens: 0 },
      { id: "ntu-3", node_execution_id: "e-1-n1", model: "m-win-c", input_tokens: 77000, output_tokens: 12000, cache_read_tokens: 250000, cache_creation_tokens: 4100 },
    ],
    settings: [
      { key: "usd_to_cny", value: "6.9" },
      { key: "display_currency", value: "USD" },
    ],
  }
  const calls: CallRow[] = []
  let n = 0
  const mk = (over: Partial<CallRow>): CallRow => ({
    id: `c-${String(++n).padStart(5, "0")}`,
    node_execution_id: null, execution_id: null,
    turn_index: 1 + (n % 7), call_index: n % 5, message_id: `msg-${n}`,
    model: models[n % models.length], stop_reason: n % 4 === 0 ? "tool_use" : "end_turn",
    timestamp: T0 + Math.floor(rng() * 30 * 86_400_000), duration_ms: 100 + (n % 900), ttft_ms: n % 3 === 0 ? null : 50 + n,
    input_tokens: Math.floor(rng() * 50_000), output_tokens: Math.floor(rng() * 8_000),
    cache_read_tokens: Math.floor(rng() * 120_000), cache_creation_tokens: Math.floor(rng() * 6_000),
    org: "gold", workspace_id: "ws-1", workflow_ref: "a.yaml",
    node_id: "n1", session_id: null, instance_id: "inst-gold", source_path: "workflow",
    ...over,
  })
  // 执行口径主力行（4 执行共 650 行，覆盖全部模型/token 形态）
  const execPlan: Array<[string, string, string, string, number]> = [
    ["e-1", "ws-1", "a.yaml", "e-1-n1", 200],
    ["e-2", "ws-1", "b.yaml", "e-2-n1", 150],
    ["e-3", "ws-2", "a.yaml", "e-3-n1", 150],
    ["e-4", "ws-2", "c.yaml", "e-4-n1", 150],
  ]
  for (const [ex, ws, wf, ne, cnt] of execPlan) {
    for (let i = 0; i < cnt; i++) calls.push(mk({ execution_id: ex, node_execution_id: ne, workspace_id: ws, workflow_ref: wf }))
  }
  // 窗口边界三行：== valid_from（下界闭）、== valid_to（上界开 → 兜底价）、valid_to-1（窗内高价）
  calls.push(mk({ model: "m-win-c", timestamp: WIN_FROM, execution_id: "e-1", node_execution_id: "e-1-n1", workspace_id: "ws-1", workflow_ref: "a.yaml" }))
  calls.push(mk({ model: "m-win-c", timestamp: WIN_TO, execution_id: "e-1", node_execution_id: "e-1-n1", workspace_id: "ws-1", workflow_ref: "a.yaml" }))
  calls.push(mk({ model: "m-win-c", timestamp: WIN_TO - 1, execution_id: "e-1", node_execution_id: "e-1-n1", workspace_id: "ws-1", workflow_ref: "a.yaml" }))
  // 零 token 有价行（cost=0 属 priced 非 unpriced）与大 token 行
  calls.push(mk({ model: "m-usd-a", input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, execution_id: "e-2", node_execution_id: "e-2-n1", workspace_id: "ws-1", workflow_ref: "b.yaml" }))
  calls.push(mk({ model: "m-big", input_tokens: 900_000, output_tokens: 900_000, cache_read_tokens: 900_000, cache_creation_tokens: 900_000, execution_id: "e-2", node_execution_id: "e-2-n1", workspace_id: "ws-1", workflow_ref: "b.yaml" }))
  // 会话口径行（execution_id NULL —— clone_chat/global_chat 族）
  for (const sid of ["s-1", "s-2", "s-3"]) {
    for (let i = 0; i < 40; i++) {
      calls.push(mk({ session_id: sid, workspace_id: "ws-2", workflow_ref: "agent-gold", node_id: null, source_path: i % 2 ? "clone_chat" : "global_chat", message_id: null }))
    }
  }
  // 归属重叠行（execution 与 session 双非空 —— session 趟 extraRawWhere 让给 execution 趟）
  for (let i = 0; i < 20; i++) {
    calls.push(mk({ execution_id: "e-3", node_execution_id: "e-3-n1", session_id: "s-2", workspace_id: "ws-2", workflow_ref: "a.yaml" }))
  }
  return { calls, prices, meta }
}

// ─────────────────────────────────────────────────────────────────────────────
// 两引擎灌数
// ─────────────────────────────────────────────────────────────────────────────

function seedSqlite(meta: Meta, prices: PriceRow[], calls: CallRow[], baselineView: boolean): Database.Database {
  const db = new Database(":memory:")
  applySchema(db)
  if (baselineView) {
    db.exec("DROP VIEW IF EXISTS llm_calls_costed")
    db.exec(BASE_VIEW_DDL)
  }
  const t = TS
  for (const w of meta.workspaces)
    db.prepare(`INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?,?,?,?,?,?)`).run(w.id, w.name, w.org, w.path, t, t)
  for (const e of meta.executions)
    db.prepare(`INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, started_at, completed_at, org, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(e.id, e.workspace_id, e.parent_id, e.workflow_ref, e.workflow_name, e.status, t, t, "gold", t, t)
  for (const ne of meta.nodeExecutions)
    db.prepare(`INSERT INTO node_executions (id, execution_id, node_id, node_type, status, retry_count, duration, started_at, completed_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(ne.id, ne.execution_id, ne.node_id, ne.node_type, ne.status, 0, ne.duration, t, t)
  for (const u of meta.ntu)
    db.prepare(`INSERT INTO node_token_usages (id, node_execution_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, source, created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(u.id, u.node_execution_id, u.model, u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_creation_tokens, "node", t)
  for (const s of meta.settings)
    db.prepare(`INSERT INTO billing_setting (key, value) VALUES (?,?)`).run(s.key, s.value)
  const pStmt = db.prepare(`INSERT INTO billing_price_config (id, vendor, model_id, input_unit_price, output_unit_price, cache_write_unit_price, cache_read_unit_price, currency, valid_from, valid_to, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
  for (const p of prices) pStmt.run(p.id, p.vendor, p.model_id, p.input_unit_price, p.output_unit_price, p.cache_write_unit_price, p.cache_read_unit_price, p.currency, p.valid_from, p.valid_to, p.created_at, p.updated_at)
  for (let i = 0; i < calls.length; i += 400) {
    const chunk = calls.slice(i, i + 400)
    const marks = chunk.map(() => `(${Array(CALL_PARAMS_PER_ROW).fill("?").join(",")})`).join(",")
    db.prepare(`INSERT INTO llm_calls (${CALL_COLS}) VALUES ${marks}`).run(chunk.flatMap(callParams))
  }
  return db
}

async function seedPg(fx: PgFixture, meta: Meta, prices: PriceRow[], calls: CallRow[]): Promise<void> {
  const t = TS
  const sql = fx.sql
  for (const w of meta.workspaces)
    await sql.unsafe(`INSERT INTO workspaces (id, name, path, org, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6)`, [w.id, w.name, w.path, w.org, t, t])
  for (const e of meta.executions)
    await sql.unsafe(`INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, started_at, completed_at, org, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [e.id, e.workspace_id, e.parent_id, e.workflow_ref, e.workflow_name, e.status, t, t, "gold", t, t])
  for (const ne of meta.nodeExecutions)
    await sql.unsafe(`INSERT INTO node_executions (id, execution_id, node_id, node_type, status, retry_count, duration, started_at, completed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [ne.id, ne.execution_id, ne.node_id, ne.node_type, ne.status, 0, ne.duration, t, t])
  for (const u of meta.ntu)
    await sql.unsafe(`INSERT INTO node_token_usages (id, node_execution_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, source, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [u.id, u.node_execution_id, u.model, u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_creation_tokens, "node", t])
  for (const s of meta.settings)
    await sql.unsafe(`INSERT INTO billing_setting (key, value) VALUES ($1,$2)`, [s.key, s.value])
  for (const p of prices)
    await sql.unsafe(`INSERT INTO billing_price_config (id, vendor, model_id, input_unit_price, output_unit_price, cache_write_unit_price, cache_read_unit_price, currency, valid_from, valid_to, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [p.id, p.vendor, p.model_id, p.input_unit_price, p.output_unit_price, p.cache_write_unit_price, p.cache_read_unit_price, p.currency, p.valid_from, p.valid_to, p.created_at, p.updated_at])
  for (let i = 0; i < calls.length; i += 400) {
    const chunk = calls.slice(i, i + 400)
    const placeholders = chunk.map((_, row) => `(${Array(CALL_PARAMS_PER_ROW).fill(0).map((_, j) => `$${row * CALL_PARAMS_PER_ROW + j + 1}`).join(",")})`).join(",")
    await sql.unsafe(`INSERT INTO llm_calls (${CALL_COLS}) VALUES ${placeholders}`, chunk.flatMap(callParams))
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 归一（bit-exact：数字不做任何舍入，字符串原样）
// ─────────────────────────────────────────────────────────────────────────────

function normGroup(row: Record<string, unknown>) {
  return {
    k: String(row.k), i: Number(row.i), o: Number(row.o), cr: Number(row.cr), cc: Number(row.cc),
    tokens: Number(row.tokens ?? 0), hit: row.hit === null ? null : Number(row.hit),
    usd: row.usd === null ? null : Number(row.usd),
    total: Number(row.total), priced: Number(row.priced), complete: Number(row.complete) === 1,
  }
}
const sortByKey = <T extends { k: string }>(arr: T[]) => arr.slice().sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))

/**
 * USD 组级求和的对拍规则（gold 唯一数学性例外，票2B-3 人判证据）：
 *   - 逐行 cost_usd 标量：两引擎 100% 逐位相等（见 ①，价×token×汇率全是 f8 标量式，无次序自由度）。
 *   - 组级 SUM(double)：IEEE-754 加法**不满足结合律**，SQLite 与 PG 的求和访问次序不同
 *     （探针实测：PG ≡ 插入序左折叠、SQLite ≡ 逆序左折叠），逐位相等在数学上不可能要求，
 *     与 round/::numeric/CAST/汇率序列化无关 —— 非生产 bug。
 *   - 本函数把它压成可判的硬界：|残差| < 5e-10（实测最大 ~1e-15，即个位 ulp 级）且
 *     十进制前 10 位逐位相等；所有统计（sums/bitExact/ulpDiffs/maxAbsDiff）进报告数字。
 */
interface UsdStats { sums: number; bitExact: number; ulpDiffs: number; maxUlp: number; maxAbsDiff: number }
function assertUsdSum(oldV: number | null, newV: number | null, ctx: string, st: UsdStats): void {
  st.sums++
  if (oldV === null || newV === null) {
    expect(oldV === null && newV === null, `NULL 三态两侧不同步: ${ctx}`).toBe(true)
    if (oldV === null && newV === null) st.bitExact++
    return
  }
  if (oldV === newV) { st.bitExact++; return }
  const abs = Math.abs(oldV - newV)
  const ulp = Math.max(Math.abs(oldV), Math.abs(newV)) * Number.EPSILON || Number.MIN_VALUE
  st.ulpDiffs++
  st.maxUlp = Math.max(st.maxUlp, abs / ulp)
  st.maxAbsDiff = Math.max(st.maxAbsDiff, abs)
  expect(abs, `SUM(double) 次序性残差越界（疑似算价真漂移）: ${ctx}`).toBeLessThan(5e-10)
  expect(newV.toFixed(10), `金额十进制第 10 位起漂移: ${ctx}`).toBe(oldV.toFixed(10))
}

// DAO 出参契约不暴露 priced 计数列；usd 走 assertUsdSum 分层规则 —— 严格对比字段清单去掉两者。
const cmpGroup = (g: ReturnType<typeof normGroup>) => ({ k: g.k, i: g.i, o: g.o, cr: g.cr, cc: g.cc, tokens: g.tokens, hit: g.hit, total: g.total, complete: g.complete })

function oldAggregateGroups(db: Database.Database, keyCol: "execution_id" | "session_id", ids: string[], extra: readonly string[] = []) {
  const marks = ids.map(() => "?").join(",")
  const rows = db.prepare(baseAggregateBySql(keyCol, marks, extra)).all(...ids) as Array<Record<string, unknown>>
  return sortByKey(rows.map(normGroup))
}

function newAggregateGroups(map: Map<string, LlmUsageSummary>) {
  return sortByKey([...map.entries()].map(([k, s]) => normGroup({
    k, i: s.usage.inputTokens, o: s.usage.outputTokens, cr: s.usage.cacheReadTokens, cc: s.usage.cacheCreationTokens,
    tokens: s.totals.tokens, hit: s.totals.cacheHitRate, usd: s.totals.cost.usd,
    total: s.totalCalls, priced: 0, complete: s.totals.cost.complete ? 1 : 0,
  })))
}

/** 视图逐行派生列（cost_usd/vendor）—— 两引擎同投影，按 id（BINARY/C 无歧义）排序逐位比。 */
interface RowCost { id: string; cost_usd: number | null; vendor: string | null }
/** 逐位归一：字段清单固定 + 原型归一（postgres.js 行是 null-prototype 对象）。 */
const normRowCost = (r: Record<string, unknown>): RowCost => ({ id: String(r.id), cost_usd: r.cost_usd === null ? null : Number(r.cost_usd), vendor: r.vendor === null ? null : String(r.vendor) })
function rowsCostsSqlite(db: Database.Database): RowCost[] {
  return (db.prepare(`SELECT id, cost_usd, vendor FROM llm_calls_costed ORDER BY id`).all() as Array<Record<string, unknown>>).map(normRowCost)
}
async function rowsCostsPg(fx: PgFixture): Promise<RowCost[]> {
  const rows = await fx.sql.unsafe(`SELECT id, cost_usd, vendor FROM llm_calls_costed ORDER BY id COLLATE "C"`) as unknown as Array<Record<string, unknown>>
  return rows.map(normRowCost)
}

// ─────────────────────────────────────────────────────────────────────────────
// 真库只读样本（postgres://…/octopus 只做 SELECT —— 回灌两随机/内存引擎对拍）
// ─────────────────────────────────────────────────────────────────────────────

interface LiveSample { calls: CallRow[]; prices: PriceRow[]; settings: Array<{ key: string; value: string }> }

async function readLiveSample(): Promise<LiveSample | null> {
  const url = process.env.OCTOPUS_PG_TEST_URL?.trim()
  if (!url) return null
  const admin = Postgres(url, { max: 1 })
  try {
    const raw = await admin.unsafe(`SELECT ${CALL_COLS} FROM llm_calls ORDER BY timestamp, id`) as unknown as Array<Record<string, unknown>>
    if (raw.length === 0) return null
    const rawPrices = await admin.unsafe(`SELECT id, vendor, model_id, input_unit_price, output_unit_price, cache_write_unit_price, cache_read_unit_price, currency, valid_from, valid_to FROM billing_price_config ORDER BY id`) as unknown as Array<Record<string, unknown>>
    const settings = await admin.unsafe(`SELECT key, value FROM billing_setting`) as unknown as Array<{ key: string; value: string }>
    const str = (v: unknown) => (v == null ? null : String(v))
    const numv = (v: unknown) => (v == null ? null : Number(v))
    const calls: CallRow[] = raw.map((r) => ({
      id: String(r.id), node_execution_id: str(r.node_execution_id), execution_id: str(r.execution_id),
      turn_index: Number(r.turn_index), call_index: Number(r.call_index), message_id: str(r.message_id),
      model: str(r.model), stop_reason: str(r.stop_reason),
      timestamp: Number(r.timestamp), duration_ms: Number(r.duration_ms), ttft_ms: numv(r.ttft_ms),
      input_tokens: Number(r.input_tokens), output_tokens: Number(r.output_tokens),
      cache_read_tokens: Number(r.cache_read_tokens), cache_creation_tokens: Number(r.cache_creation_tokens),
      org: str(r.org), workspace_id: str(r.workspace_id), workflow_ref: str(r.workflow_ref),
      node_id: str(r.node_id), session_id: str(r.session_id), instance_id: str(r.instance_id), source_path: str(r.source_path),
    }))
    const prices: PriceRow[] = rawPrices.map((p) => ({
      id: String(p.id), vendor: String(p.vendor), model_id: String(p.model_id),
      input_unit_price: Number(p.input_unit_price), output_unit_price: Number(p.output_unit_price),
      cache_write_unit_price: Number(p.cache_write_unit_price), cache_read_unit_price: Number(p.cache_read_unit_price),
      currency: String(p.currency), valid_from: numv(p.valid_from), valid_to: numv(p.valid_to),
      created_at: TS, updated_at: TS,
    }))
    return { calls, prices, settings }
  } finally {
    await admin.end({ timeout: 5 })
  }
}

/** 真行的归属父表可能已被混合期清删 —— 按行上出现过的归属键造中性 meta（两引擎同款灌入）。 */
function metaForLive(live: LiveSample): Meta {
  const wsIds = [...new Set(live.calls.map((c) => c.workspace_id).filter((v): v is string => !!v))].slice(0, 8)
  const execIds = [...new Set(live.calls.map((c) => c.execution_id).filter((v): v is string => !!v))]
  const execSet = new Set(execIds)
  const neMap = new Map<string, string>()
  for (const c of live.calls) {
    if (!c.node_execution_id) continue
    if (!neMap.has(c.node_execution_id)) neMap.set(c.node_execution_id, c.execution_id ?? "e-live")
  }
  const executions = execIds.map((id) => ({ id, workspace_id: wsIds[0] ?? "ws-live", parent_id: "0", workflow_ref: "live", workflow_name: "live", status: "completed" }))
  if (!execSet.has("e-live")) executions.push({ id: "e-live", workspace_id: wsIds[0] ?? "ws-live", parent_id: "0", workflow_ref: "live", workflow_name: "live", status: "completed" })
  return {
    workspaces: [{ id: "ws-live", name: "WS-LIVE", path: "/tmp/gold-live", org: "gold" }, ...wsIds.map((id) => ({ id, name: id, path: "/tmp/gold-live", org: "gold" }))],
    executions,
    nodeExecutions: [...neMap.entries()].map(([id, ex]) => ({ id, execution_id: ex, node_id: "n", node_type: "agent", status: "completed", duration: 1 })),
    ntu: [],
    settings: live.settings,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// gold 对拍主体
// ─────────────────────────────────────────────────────────────────────────────

async function runGoldParity(label: string, calls: CallRow[], prices: PriceRow[], meta: Meta, fx: PgFixture): Promise<void> {
  const oldDb = seedSqlite(meta, prices, calls, true) // 旧路径：基线视图 + 基线 SQL 文本
  const dao = new TokenUsageDAO(fx.sql)               // 新路径：现 DAO @ PG
  const st: UsdStats = { sums: 0, bitExact: 0, ulpDiffs: 0, maxUlp: 0, maxAbsDiff: 0 }

  // ① 视图逐行 cost/vendor（三件套之「llm_calls_costed」）—— f8 标量式，无次序自由度：严格逐位。
  const oldRows = rowsCostsSqlite(oldDb)
  const newRows = await rowsCostsPg(fx)
  expect(newRows).toStrictEqual(oldRows)

  // ② totalCost（derivedCost 全局聚合）
  const oldTotalRow = oldDb.prepare(baseDerivedCostSql()).get() as { usd: number | null; complete: number }
  const newTotal = await dao.totalCost()
  expect(newTotal.complete).toBe(oldTotalRow.complete === 1)
  assertUsdSum(oldTotalRow.usd ?? null, newTotal.usd, `${label}:totalCost`, st)

  // ③ aggregateLlmCallsBy：execution 趟 + session 趟（含 extraRawWhere 防双计配方；LEDGER_SQL/PRICED_AGG 分组面）
  const execIds = [...new Set(calls.map((c) => c.execution_id).filter((v): v is string => !!v))].sort()
  const sessIds = [...new Set(calls.map((c) => c.session_id).filter((v): v is string => !!v))].sort()
  if (execIds.length) {
    const oldG = oldAggregateGroups(oldDb, "execution_id", execIds)
    const newG = await newAggregateGroupsP(dao, "execution_id", execIds)
    expect(newG.map(cmpGroup)).toStrictEqual(oldG.map(cmpGroup))
    oldG.forEach((g, i) => assertUsdSum(g.usd, newG[i]!.usd, `${label}:agg-exec:${g.k}`, st))
  }
  if (sessIds.length) {
    const extra = ["l.execution_id IS NULL"]
    const oldG = oldAggregateGroups(oldDb, "session_id", sessIds, extra)
    const newG = await newAggregateGroupsP(dao, "session_id", sessIds, extra)
    expect(newG.map(cmpGroup)).toStrictEqual(oldG.map(cmpGroup))
    oldG.forEach((g, i) => assertUsdSum(g.usd, newG[i]!.usd, `${label}:agg-session:${g.k}`, st))
  }

  // ④ 分析面：totalCostByWorkspaceSince / costByModelSince / dailyCostSince / costByWorkflowSince
  for (const ws of meta.workspaces.map((w) => w.id)) {
    const oldTotalWs = (oldDb.prepare(
      `SELECT ${LEDGER_SQL.sumCost("")} as total FROM llm_calls_costed WHERE workspace_id = ? AND timestamp >= ?`
    ).get(ws, 0) as { total: number | null }).total
    const newTotalWs = await dao.totalCostByWorkspaceSince(ws, 0)
    assertUsdSum(oldTotalWs, newTotalWs, `${label}:totalWs:${ws}`, st)

    const norm = (rows: Array<Record<string, unknown>>) => rows
      .map((r) => ({ model: r.model == null ? null : r.model, calls: Number(r.calls), total_cost: r.total_cost === null ? null : Number(r.total_cost), input_tokens: Number(r.input_tokens), output_tokens: Number(r.output_tokens), cache_read: Number(r.cache_read), cache_create: Number(r.cache_create) }))
      .sort((a, b) => String(a.model).localeCompare(String(b.model)))
    const oldByModel = norm(oldDb.prepare(`
      SELECT model, COUNT(*) as calls, ${LEDGER_SQL.sumCost("")} as total_cost,
             SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens,
             SUM(cache_read_tokens) as cache_read, SUM(cache_creation_tokens) as cache_create
      FROM llm_calls_costed WHERE workspace_id = ? AND timestamp >= ?
      GROUP BY model
    `).all(ws, 0) as Array<Record<string, unknown>>)
    const newByModel = norm(await dao.costByModelSince(ws, 0) as Array<Record<string, unknown>>)
    const noUsd = (r: ReturnType<typeof norm>[number]) => ({ model: r.model, calls: r.calls, input_tokens: r.input_tokens, output_tokens: r.output_tokens, cache_read: r.cache_read, cache_create: r.cache_create })
    expect(newByModel.map(noUsd)).toStrictEqual(oldByModel.map(noUsd))
    oldByModel.forEach((r, i) => assertUsdSum(r.total_cost, newByModel[i]!.total_cost, `${label}:byModel:${ws}:${r.model}`, st))

    const oldDaily = (oldDb.prepare(`
      SELECT DATE(timestamp / 1000, 'unixepoch') as date,
             ${LEDGER_SQL.sumCost("")} as total_cost, COUNT(*) as calls
      FROM llm_calls_costed WHERE workspace_id = ? AND timestamp >= ?
      GROUP BY date
    `).all(ws, 0) as Array<{ date: string; total_cost: number | null; calls: number }>)
      .map((r) => ({ date: r.date, total_cost: r.total_cost === null ? null : Number(r.total_cost), calls: Number(r.calls) }))
      .sort((a, b) => a.date.localeCompare(b.date))
    const newDaily = (await dao.dailyCostSince(ws, 0) as Array<Record<string, unknown>>)
      .map((r) => ({ date: String(r.date), total_cost: r.total_cost === null ? null : Number(r.total_cost), calls: Number(r.calls) }))
      .sort((a, b) => a.date.localeCompare(b.date))
    const noDailyUsd = (r: { date: string; calls: number }) => ({ date: r.date, calls: r.calls })
    expect(newDaily.map(noDailyUsd)).toStrictEqual(oldDaily.map(noDailyUsd))
    oldDaily.forEach((r, i) => assertUsdSum(r.total_cost, newDaily[i]!.total_cost, `${label}:daily:${ws}:${r.date}`, st))

    const oldByWf = (oldDb.prepare(`
      SELECT workflow_ref, COUNT(DISTINCT execution_id) as executions,
             ${LEDGER_SQL.sumCost("")} as total_cost
      FROM llm_calls_costed WHERE workspace_id = ? AND timestamp >= ?
      GROUP BY workflow_ref
    `).all(ws, 0) as Array<{ workflow_ref: string | null; executions: number; total_cost: number | null }>)
      .map((r) => ({ workflow_ref: r.workflow_ref, executions: Number(r.executions), total_cost: r.total_cost === null ? null : Number(r.total_cost) }))
      .sort((a, b) => String(a.workflow_ref).localeCompare(String(b.workflow_ref)))
    const newByWf = (await dao.costByWorkflowSince(ws, 0) as Array<Record<string, unknown>>)
      .map((r) => ({ workflow_ref: r.workflow_ref == null ? null : r.workflow_ref, executions: Number(r.executions), total_cost: r.total_cost === null ? null : Number(r.total_cost) }))
      .sort((a, b) => String(a.workflow_ref).localeCompare(String(b.workflow_ref)))
    const noWfUsd = (r: { workflow_ref: string | null; executions: number }) => ({ workflow_ref: r.workflow_ref, executions: r.executions })
    expect(newByWf.map(noWfUsd)).toStrictEqual(oldByWf.map(noWfUsd))
    oldByWf.forEach((r, i) => assertUsdSum(r.total_cost, newByWf[i]!.total_cost, `${label}:byWf:${ws}:${r.workflow_ref}`, st))
  }

  // ⑤ 单节点口径 costForNodeExecution + aggregateByExecution（token 侧 LEDGER_SQL 同场对拍）
  const nodeStmt = oldDb.prepare(baseDerivedCostSql([`l.node_execution_id = ?`]))
  for (const ne of meta.nodeExecutions.slice(0, 10)) {
    const oldNode = nodeStmt.get(ne.id) as { usd: number | null; complete: number }
    const newNode = await dao.costForNodeExecution(ne.id)
    expect(newNode.complete).toBe(oldNode.complete === 1)
    assertUsdSum(oldNode.usd ?? null, newNode.usd, `${label}:node:${ne.id}`, st)
  }
  const execCostStmt = oldDb.prepare(baseDerivedCostSql(["l.execution_id = ?"]))
  const aggStmt = oldDb.prepare(`
      SELECT
        COALESCE(SUM(ntu.input_tokens), 0) as totalInputTokens,
        COALESCE(SUM(ntu.output_tokens), 0) as totalOutputTokens,
        COALESCE(SUM(ntu.cache_read_tokens), 0) as totalCacheReadTokens,
        COALESCE(SUM(ntu.cache_creation_tokens), 0) as totalCacheCreationTokens,
        ${LEDGER_SQL.sumTokens("ntu.")} as tokens,
        ${baseCacheHitRate("ntu.")} as cache_hit_rate
      FROM node_token_usages ntu
      JOIN node_executions ne ON ntu.node_execution_id = ne.id
      WHERE ne.execution_id = ?
  `)
  const turnsStmt = oldDb.prepare("SELECT COUNT(*) as n FROM llm_calls WHERE execution_id = ?")
  const errorsStmt = oldDb.prepare("SELECT COUNT(*) as errorCount FROM node_executions WHERE execution_id = ? AND status = 'failed'")
  for (const ex of meta.executions.slice(0, 10)) {
    const oldAggRow = aggStmt.get(ex.id) as Record<string, number | null>
    const oldCost = execCostStmt.get(ex.id) as { usd: number | null; complete: number }
    const newAgg = await dao.aggregateByExecution(ex.id)
    expect({
      usage: newAgg.usage, tokens: newAgg.totals.tokens, hit: newAgg.totals.cacheHitRate,
      complete: newAgg.totals.cost.complete, turns: newAgg.totalLlmTurns, errors: newAgg.errorCount,
    }).toStrictEqual({
      usage: {
        inputTokens: Number(oldAggRow.totalInputTokens), outputTokens: Number(oldAggRow.totalOutputTokens),
        cacheReadTokens: Number(oldAggRow.totalCacheReadTokens), cacheCreationTokens: Number(oldAggRow.totalCacheCreationTokens),
      },
      tokens: Number(oldAggRow.tokens ?? 0),
      hit: oldAggRow.cache_hit_rate === null ? null : Number(oldAggRow.cache_hit_rate),
      complete: oldCost.complete === 1,
      turns: (turnsStmt.get(ex.id) as { n: number }).n,
      errors: (errorsStmt.get(ex.id) as { errorCount: number }).errorCount,
    })
    assertUsdSum(oldCost.usd ?? null, newAgg.totals.cost.usd, `${label}:aggExec:${ex.id}`, st)
  }

  oldDb.close()
  console.info(`[gold] ${label}: rows=${calls.length} groups=${execIds.length + sessIds.length} `
    + `total_usd=${newTotal.usd === null ? "null" : newTotal.usd.toFixed(15)} complete=${newTotal.complete} `
    + `| usdSums=${st.sums} bitExact=${st.bitExact} ulpDiffs=${st.ulpDiffs} maxUlp=${st.maxUlp.toFixed(2)} maxAbsDiff=${st.maxAbsDiff.toExponential(2)} —— 逐位相等 ✅`)
}

async function newAggregateGroupsP(dao: TokenUsageDAO, keyCol: "execution_id" | "session_id", ids: string[], extra: readonly string[] = []) {
  const map = await dao.aggregateLlmCallsBy(keyCol, ids, extra)
  return newAggregateGroups(map)
}

// ─────────────────────────────────────────────────────────────────────────────
// 用例
// ─────────────────────────────────────────────────────────────────────────────

describe("gold 表 · DDL 改写惰性（同一 SQLite：基线视图 vs 现视图，双模式全跑）", () => {
  const ds = syntheticDataset()
  it("视图逐行 cost_usd/vendor 两版 DDL 逐位相等", () => {
    const cur = seedSqlite(ds.meta, ds.prices, ds.calls, false) // applySchema 建的现视图
    const base = seedSqlite(ds.meta, ds.prices, ds.calls, true) // 基线视图文本
    const a = rowsCostsSqlite(cur)
    const b = rowsCostsSqlite(base)
    expect(a.length).toBeGreaterThan(500)
    expect(a).toStrictEqual(b)
    const ta = cur.prepare(baseDerivedCostSql()).get() as { usd: number | null }
    const tb = base.prepare(baseDerivedCostSql()).get() as { usd: number | null }
    expect(Object.is(ta.usd, tb.usd)).toBe(true)
    cur.close(); base.close()
  })
})

describePg("gold 表 · 账本三件套迁移前后逐位相等（B4 出口人判项）", () => {
  const ds = syntheticDataset()
  let fx: PgFixture
  let fxLive: PgFixture
  let live: LiveSample | null = null

  beforeAll(async () => {
    fx = await setupPgSchema()
    await seedPg(fx, ds.meta, ds.prices, ds.calls)
    fxLive = await setupPgSchema()
    // 真库样本（只读 SELECT）：真实 llm_calls 全量 + 真实价行/汇率 → 回灌两引擎对拍。
    live = await readLiveSample()
    if (live) await seedPg(fxLive, metaForLive(live), live.prices, live.calls)
  })
  afterAll(async () => {
    await fx?.close()
    await fxLive?.close()
  })

  it("合成集（确定性 LCG · 全价种/窗口/三态分支）：旧 SQLite SQL ≡ 新 TokenUsageDAO@PG", async () => {
    await runGoldParity("synthetic", ds.calls, ds.prices, ds.meta, fx)
  })

  it("真库样本（octopus 生产库 llm_calls 全量，只读回灌）：旧 SQLite SQL ≡ 新 TokenUsageDAO@PG", async () => {
    if (!live) { console.info("[gold] live: 真库 llm_calls 为空 —— 跳过（CI 无真数据不判红）"); return }
    await runGoldParity(`live(${live.calls.length})`, live.calls, live.prices, metaForLive(live), fxLive)
  })
})
