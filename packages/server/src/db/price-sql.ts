/**
 * billing NEW-r2 —— 价格匹配 SQL 的唯一实现（Q7：全 SQL、单规则源）。
 *
 * 语义（spec NEW-r2 纪要）：
 *   - 账本（llm_calls）只记事实：model(规范名) + 四类 token + timestamp。钱不落账本。
 *   - 一切「显示钱」都经过视图 **llm_calls_costed** = llm_calls + 派生列：
 *       cost_usd —— USD 基准费用（CNY 价行按**当前** usd_to_cny 实时折算 —— 规则改 →
 *                   全局重算，与价表同族语义；NULL = unpriced，不焊 0，KD4 保留）
 *       vendor   —— 命中价行的厂商
 *   - 命中匹配：同模型、窗口 [valid_from, valid_to)（NULL 界 = ±∞，本地日界，KD24
 *     同源）；多行命中**至多取一行**（窗口行优先于兜底价、valid_from 大者优先、id 终
 *     保底序）—— 防手改库的重叠把账行复制成多份、聚合静默翻倍（写入侧 overlap
 *     校验是第一道闸，这里是第二道）。
 *
 * 视图 DDL 由本模块生成、schema.ts 每次 applySchema 重建（DROP+CREATE），保证 DDL
 * 与代码同源 —— 除此之外任何地方不得再写价格匹配公式（含 TS）。
 */

/** 汇率的 SQL 侧形态：实时读 billing_setting，非法/缺失回退 7.0（与 SETTING_DEFAULTS 同值）。 */
export const RATE_SQL = `COALESCE((SELECT CASE WHEN CAST(r.value AS REAL) > 0 THEN CAST(r.value AS REAL) END FROM billing_setting r WHERE r.key = 'usd_to_cny'), 7.0)`

/** 命中匹配相关子查询的公共外壳：selectExpr 决定取价格行的哪个字段（组）。 */
function matchSubquery(selectExpr: string, l: string): string {
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

/** 原生币金额（四类 token × 对应单价 / 1M，KD6 单价语义）。 */
export function costNativeExpr(l: string): string {
  return `(p.input_unit_price * ${l}.input_tokens
        + p.output_unit_price * ${l}.output_tokens
        + p.cache_write_unit_price * ${l}.cache_creation_tokens
        + p.cache_read_unit_price * ${l}.cache_read_tokens) / 1000000.0`
}

/** 一行的 USD 基准费用标量（NULL = unpriced）。 */
export function callCostUsdSql(l: string): string {
  const native = costNativeExpr(l)
  return matchSubquery(`CASE WHEN p.currency = 'USD' THEN ${native} ELSE ${native} / ${RATE_SQL} END`, l)
}

/** 一行命中价行的厂商（无命中 → NULL；breakdown=vendor 的分组键）。 */
export function callVendorSql(l: string): string {
  return matchSubquery("p.vendor", l)
}

/**
 * 视图 DDL —— applySchema 每次 DROP+CREATE（幂等且与代码同源）。
 * 列 = llm_calls 全列 + cost_usd + vendor。
 */
export function llmCallsCostedViewSql(): string {
  return `CREATE VIEW llm_calls_costed AS
SELECT l.*, ${callCostUsdSql("l")} AS cost_usd, ${callVendorSql("l")} AS vendor
FROM llm_calls l`
}

/**
 * 「账本行 + 派生费用/厂商」统一底座 = 视图。rawWhere 只作用在原生列（好走索引）；
 * 派生列（cost_usd/vendor/price_status）的筛选由调用方在外层 `q` 上做。
 */
export function pricedCallsSql(
  rawWhere: string[] = [],
  params: unknown[] = [],
): { sql: string; params: unknown[] } {
  const where = rawWhere.length > 0 ? ` WHERE ${rawWhere.join(" AND ")}` : ""
  return {
    sql: `SELECT l.* FROM llm_calls_costed l${where}`,
    params: [...params],
  }
}

/** 派生 price_status（供出参行形状；聚合处直接用 cost_usd IS NOT NULL 同义）。 */
export function priceStatusExpr(q = "q"): string {
  return `CASE WHEN ${q}.cost_usd IS NULL THEN 'unpriced' ELSE 'priced' END`
}

/**
 * 试算（配价页「这笔钱是怎么算出来的」解释器）：把输入拼成一行虚拟账本行，
 * 喂给与视图**同一批** matchSubquery 构造函数 —— 公式零复制。
 */
export function pricePreviewSql(): string {
  return `SELECT q.model, q.timestamp,
                 ${callCostUsdSql("q")} AS cost_usd,
                 ${callVendorSql("q")} AS vendor,
                 ${matchSubquery("p.id", "q")} AS price_id,
                 ${matchSubquery("p.currency", "q")} AS cost_currency,
                 ${matchSubquery(costNativeExpr("q"), "q")} AS cost_native
          FROM (SELECT CAST(@model AS TEXT) AS model, CAST(@timestamp AS INTEGER) AS timestamp,
                       CAST(@inputTokens AS INTEGER) AS input_tokens,
                       CAST(@outputTokens AS INTEGER) AS output_tokens,
                       CAST(@cacheCreationTokens AS INTEGER) AS cache_creation_tokens,
                       CAST(@cacheReadTokens AS INTEGER) AS cache_read_tokens) q`
}

/** 账本费用三态聚合（USD 基准）：全 NULL 组 → NULL 不焊 0（KD4 同源语义）。 */
export const PRICED_AGG = {
  /** SUM(cost) 天然忽略 NULL；全未定价组 → NULL。空组 → NULL。 */
  sumCost: (q = "q") => `SUM(${q}.cost_usd)`,
  /** 已定价行数（COUNT(col) 忽略 NULL）。 */
  countPriced: (q = "q") => `COUNT(${q}.cost_usd)`,
  /** 组内是否全部有价（空组 vacuous true，对齐 LEDGER_SQL.costComplete）。 */
  complete: (q = "q") => `COUNT(*) = COUNT(${q}.cost_usd)`,
} as const
