/**
 * PG 连接配置（P1 驱动接线）。
 *
 * 全部从环境变量解析，默认值即 dev 单机 compose 容器（deploy/docker-compose.pg.yml）。
 * 超时纪律（重要，别改到 server 级去）：
 *   - statement_timeout / idle_in_transaction_session_timeout 只在**查询连接级**
 *     （postgres.js `connection` 启动参数 → 会话级）设置；compose 刻意不设
 *     server 级默认 —— 会杀 HNSW 构建（实测 59.9s）与 COPY 数据搬迁这类合法长语句
 *     （见 deploy/docker-compose.pg.yml 注释）。
 *   - 批量作业（embedding 重建 / 数据搬迁）将来用独立小池 + 自己的大超时，
 *     不与在线请求争池（architecture.html §7 连接层）。
 */

export interface PgPoolConfig {
  /** postgres:// URI（必填才视为「PG 已接线」） */
  url: string
  /** 池上限（单用户 + 单机 NVMe 的起点值；耗尽表现为排队而非报错 —— actuator 盯这） */
  poolMax: number
  /** 查询级 statement_timeout（毫秒）；以 PG 裸数字 = ms 传给会话参数 */
  statementTimeoutMs: number
  /** 会话级 idle_in_transaction_session_timeout（毫秒）—— 卡住的 BEGIN 不再攥连接 */
  idleInTransactionTimeoutMs: number
  /** TCP 连接超时（秒，postgres.js connect_timeout 单位） */
  connectTimeoutMs: number
  /** 空闲连接回收（秒，postgres.js idle_timeout 单位） */
  idleTimeoutS: number
  /** pg_stat_activity 里认自己池子的标签 */
  applicationName: string
}

export const PG_DEFAULTS = {
  url: 'postgres://octopus:octopus@127.0.0.1:5432/octopus',
  poolMax: 10,
  statementTimeoutMs: 15_000,
  idleInTransactionTimeoutMs: 60_000,
  connectTimeoutMs: 10_000,
  idleTimeoutS: 60,
  applicationName: 'octopus-server',
} as const

function intFromEnv(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`[pg] ${name} must be a positive number, got ${JSON.stringify(raw)}`)
  }
  return Math.floor(n)
}

export function resolvePgConfig(env: NodeJS.ProcessEnv = process.env): PgPoolConfig {
  return {
    url: env.OCTOPUS_PG_URL?.trim() || PG_DEFAULTS.url,
    poolMax: intFromEnv(env.OCTOPUS_PG_POOL_MAX, PG_DEFAULTS.poolMax, 'OCTOPUS_PG_POOL_MAX'),
    statementTimeoutMs: intFromEnv(env.OCTOPUS_PG_STATEMENT_TIMEOUT_MS, PG_DEFAULTS.statementTimeoutMs, 'OCTOPUS_PG_STATEMENT_TIMEOUT_MS'),
    idleInTransactionTimeoutMs: intFromEnv(env.OCTOPUS_PG_IDLE_IN_TX_TIMEOUT_MS, PG_DEFAULTS.idleInTransactionTimeoutMs, 'OCTOPUS_PG_IDLE_IN_TX_TIMEOUT_MS'),
    connectTimeoutMs: intFromEnv(env.OCTOPUS_PG_CONNECT_TIMEOUT_MS, PG_DEFAULTS.connectTimeoutMs, 'OCTOPUS_PG_CONNECT_TIMEOUT_MS'),
    idleTimeoutS: intFromEnv(env.OCTOPUS_PG_IDLE_TIMEOUT_S, PG_DEFAULTS.idleTimeoutS, 'OCTOPUS_PG_IDLE_TIMEOUT_S'),
    applicationName: env.OCTOPUS_PG_APP_NAME?.trim() || PG_DEFAULTS.applicationName,
  }
}

/** 是否显式接入了 PG（OCTOPUS_PG_URL 存在）。启动接线与 actuator 共用这一判定。 */
export function isPgConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.OCTOPUS_PG_URL?.trim())
}

/** 抹掉 URI 里的密码，供日志 / actuator 展示。 */
export function maskPgUrl(url: string): string {
  try {
    const u = new URL(url)
    if (u.password) u.password = '***'
    return u.toString()
  } catch {
    return '<invalid-url>'
  }
}
