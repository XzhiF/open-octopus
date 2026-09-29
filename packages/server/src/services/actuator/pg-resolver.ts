/**
 * GET /api/actuator/pg — PG 池可观测面（P1 交付物 1 的 actuator 落点）。
 *
 * 照 actuator 目录既有 Resolver 形状（config 快照 + 状态）。数据全部来自
 * db/pg/pool.ts 的 getPgPoolStats()：连接占用看服务端真相（pg_stat_activity
 * 按 application_name 归组），排队深度看应用层计数（in-flight − active）。
 * 未接线时返回 initialized:false + 原因，不报错 —— SQLite 仍是现行唯一真源，
 * PG 池是 opt-in（OCTOPUS_PG_URL）。
 */
import { getPgPoolStats, type PgPoolStats } from '../../db/pg/pool'
import { isPgConfigured } from '../../db/pg/config'

export type PgPoolResponse = PgPoolStats & {
  status: 'ok' | 'disabled' | 'error'
  /** 平台是否已把 PG 当数据面（本票恒 false —— DAO 异步票翻转）。 */
  primary: boolean
}

export class PgResolver {
  async resolve(): Promise<PgPoolResponse> {
    try {
      const stats = await getPgPoolStats()
      const status: PgPoolResponse['status'] = stats.initialized
        ? 'ok'
        : isPgConfigured() ? 'error' : 'disabled'
      return { ...stats, status, primary: false }
    } catch (err) {
      // 采样失败本身就是最值得上报的事实（池连不上 = 单引擎的已定价风险显形）
      const stats = await getPgPoolStats().catch(() => null)
      return {
        initialized: Boolean(stats?.initialized),
        url: stats?.url ?? '',
        application_name: stats?.application_name ?? '',
        pool_max: stats?.pool_max ?? 0,
        configured: stats?.configured ?? {
          statement_timeout_ms: 0,
          idle_in_transaction_session_timeout_ms: 0,
          connect_timeout_ms: 0,
          idle_timeout_s: 0,
        },
        connections: stats?.connections,
        session: stats?.session,
        app: stats?.app,
        status: 'error',
        primary: false,
        reason: err instanceof Error ? err.message : String(err),
      }
    }
  }
}
