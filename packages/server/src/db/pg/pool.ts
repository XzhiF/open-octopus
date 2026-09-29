/**
 * PG 驱动接线 —— postgres.js 连接池（P1 交付物 1）。
 *
 * 设计要点：
 *   - 超时全部在**查询连接级**（postgres.js `connection` 启动参数 → 会话参数），
 *     server 级刻意不设：会杀 HNSW 构建与 COPY 搬迁（compose 注释 + architecture §2）。
 *   - 池占用从两边看：服务端真相（pg_stat_activity 按 application_name 归组，
 *     采样器自身排除）+ 应用层计数（in-flight = 已发出未落地的查询数）。
 *   - 队列深度 postgres.js 不暴露内部等待队列（不碰私有符号），这里用两个
 *     可观测量组合出诚实近似：queued ≈ max(0, inflight − active服务端连接)。
 *     查询都经 handle.sql（带计数 Proxy）发起时该值准确；DAO 异步票接完后
 *     可再谈精确排队。
 */
import Postgres from 'postgres'
import { type PgPoolConfig, resolvePgConfig, maskPgUrl } from './config'

/** postgres.js 客户端类型（不泄漏到包外的别名）。 */
export type PgClient = ReturnType<typeof Postgres>

export interface PgQueryMetrics {
  started: number
  settled: number
  failed: number
}

export interface PgPoolHandle {
  config: PgPoolConfig
  /** 池实例 —— 已包查询计数 Proxy，await 即可，其余用法不变。 */
  sql: PgClient
  metrics: PgQueryMetrics
}

export interface PgPoolStats {
  initialized: boolean
  url: string
  application_name: string
  pool_max: number
  configured: {
    statement_timeout_ms: number
    idle_in_transaction_session_timeout_ms: number
    connect_timeout_ms: number
    idle_timeout_s: number
  }
  /** 未接线时给出原因（'OCTOPUS_PG_URL not set' / 初始化异常）。 */
  reason?: string
  connections?: {
    total: number          // 不含采样查询自身所在连接
    active: number
    idle: number
    idle_in_transaction: number
  }
  session?: {              // SHOW 出来的实际生效值 —— 验证查询级超时真的落到了连接
    statement_timeout: string
    idle_in_transaction_session_timeout: string
  }
  app?: {
    inflight: number
    queued_estimate: number
    queries_started: number
    queries_settled: number
    queries_failed: number
  }
}

let current: PgPoolHandle | null = null

/** 纯构造函数（不预热连接）—— 测试 harness 用它建一次性客户端。 */
export function createPgPool(config: PgPoolConfig = resolvePgConfig()): PgPoolHandle {
  const metrics: PgQueryMetrics = { started: 0, settled: 0, failed: 0 }
  const raw = Postgres(config.url, {
    max: config.poolMax,
    idle_timeout: config.idleTimeoutS,
    connect_timeout: Math.max(1, Math.ceil(config.connectTimeoutMs / 1000)),
    // 查询连接级（会话）参数 —— 「查询级超时」的落点，见文件头。
    connection: {
      statement_timeout: config.statementTimeoutMs,
      idle_in_transaction_session_timeout: config.idleInTransactionTimeoutMs,
      application_name: config.applicationName,
    },
    onnotice: () => { /* NOTICE 噪声不进 stdout（DROP IF EXISTS 之类） */ },
  })
  const sql = instrument(raw, metrics)
  return { config, sql, metrics }
}

/** tagged template 计数包装：只劫持 `then`，其余成员原样透传。 */
function instrument(sql: PgClient, m: PgQueryMetrics): PgClient {
  const wrapped = ((strings: unknown, ...args: unknown[]) => {
    m.started++
    const result = (sql as never as (...a: unknown[]) => Promise<unknown>)(strings, ...args)
    return track(result, m)
  }) as unknown as PgClient
  return new Proxy(wrapped, {
    get(_t, prop) {
      if (prop === 'unsafe') {
        return (query: string, params?: unknown[], names?: unknown[]) => {
          m.started++
          return track((sql as { unsafe: (q: string, p?: unknown[], n?: unknown[]) => Promise<unknown> }).unsafe(query, params, names), m)
        }
      }
      const value = Reflect.get(sql as object, prop)
      if (prop === 'end' || prop === 'close' || typeof value !== 'function') return value
      return (value as (...a: unknown[]) => unknown).bind(sql)
    },
  }) as PgClient
}

/**
 * 在 postgres.js 的 Query 对象上就地遮蔽 `then`：
 * await/`.then` 路径计入 settled/failed，而 `.stream`/`.execute` 等 Query 原生
 * 成员原样保留（返回新 Promise 会把它们吃掉 —— DAO 大结果集要用 stream）。
 */
function track<T>(query: PromiseLike<T>, m: PgQueryMetrics): PromiseLike<T> {
  const q = query as PromiseLike<T> & { then?: PromiseLike<T>['then']; __pgCounted?: boolean }
  if (q.__pgCounted || typeof q.then !== 'function') return query
  q.__pgCounted = true
  const origThen = q.then.bind(q)
  q.then = ((onOk?: (v: T) => unknown, onErr?: (e: unknown) => unknown) =>
    origThen(
      (v) => { m.settled++; return onOk ? (onOk(v) as T) : (v as unknown as T) },
      (e) => {
        m.failed++
        m.settled++
        // 调用方的 rejection 处理器必须被转交 —— 吞掉它 = 把 .catch/.rejects 的
        // 错误重新变成 unhandled rejection。
        if (onErr) return onErr(e)
        throw e
      },
    ) as PromiseLike<T>) as PromiseLike<T>['then']
  return q
}

/**
 * 启动接线用：建池 + 预热（select 1）+ 注册为全局当前池。
 * 失败时销毁池并抛出 —— 调用方（server bootstrap）捕获并降级为告警，
 * 绝不因 PG 不可用而阻止平台以 SQLite 现状启动（本票阶段）。
 */
export async function initPgPool(config?: PgPoolConfig): Promise<PgPoolHandle> {
  if (current) return current
  const handle = createPgPool(config)
  try {
    await handle.sql`SELECT 1`
  } catch (err) {
    await handle.sql.end({ timeout: 5 }).catch(() => { /* 池没连上，end 再抛不掩盖原始错误 */ })
    throw err
  }
  current = handle
  return handle
}

export function getPgPool(): PgPoolHandle | null {
  return current
}

/** 测试 harness 注入点：把自己的一次性池注册为当前池（测完置 null）。 */
export function registerPgPool(handle: PgPoolHandle | null): void {
  current = handle
}

export async function closePgPool(): Promise<void> {
  if (!current) return
  const h = current
  current = null
  await h.sql.end({ timeout: 5 })
}

/**
 * actuator /api/actuator/pg 的数据面。未初始化时只回配置快照 + 原因，
 * 连接/会话/排队三节缺省 —— 调用方据此渲染 status。
 */
export async function getPgPoolStats(): Promise<PgPoolStats> {
  const config = resolvePgConfig()
  const base: PgPoolStats = {
    initialized: false,
    url: maskPgUrl(config.url),
    application_name: config.applicationName,
    pool_max: config.poolMax,
    configured: {
      statement_timeout_ms: config.statementTimeoutMs,
      idle_in_transaction_session_timeout_ms: config.idleInTransactionTimeoutMs,
      connect_timeout_ms: config.connectTimeoutMs,
      idle_timeout_s: config.idleTimeoutS,
    },
    reason: 'OCTOPUS_PG_URL not set — PG pool not wired (platform runs on SQLite)',
  }
  if (!current) return base

  const h = current
  base.reason = undefined
  base.initialized = true
  base.url = maskPgUrl(h.config.url)
  base.application_name = h.config.applicationName
  base.pool_max = h.config.poolMax

  const rows = await h.sql`
    SELECT COALESCE(state, '(no state)') AS state, count(*)::int AS n
    FROM pg_stat_activity
    WHERE application_name = ${h.config.applicationName}
      AND pid <> pg_backend_pid()
    GROUP BY 1`
  const connections: NonNullable<PgPoolStats['connections']> = { total: 0, active: 0, idle: 0, idle_in_transaction: 0 }
  for (const r of rows as unknown as Array<{ state: string; n: number }>) {
    connections.total += r.n
    if (r.state === 'active') connections.active += r.n
    else if (r.state === 'idle') connections.idle += r.n
    else if (r.state === 'idle in transaction') connections.idle_in_transaction += r.n
  }
  base.connections = connections

  base.session = {
    statement_timeout: String((await h.sql`SELECT current_setting('statement_timeout') AS v`)[0].v),
    idle_in_transaction_session_timeout: String((await h.sql`SELECT current_setting('idle_in_transaction_session_timeout') AS v`)[0].v),
  }

  const inflight = Math.max(0, h.metrics.started - h.metrics.settled)
  base.app = {
    inflight,
    queued_estimate: Math.max(0, inflight - connections.active),
    queries_started: h.metrics.started,
    queries_settled: h.metrics.settled,
    queries_failed: h.metrics.failed,
  }
  return base
}
