import { Hono } from "hono"
import type { LedgerReport } from "../services/knowledge/effectiveness-ledger"
import type { EffectivenessSyncResult } from "../services/knowledge/effectiveness-sync"

/**
 * effectiveness 记账触发面路由（P4 票06 AC4 手动通道 + 票07 快照刷页手动通道）——
 * 挂 `/api/knowledge/effectiveness`：
 *
 *   POST /parse   同步「解析至最新」（增量游标推进后返回 LedgerReport）。
 *                 夜巡自动面走 scheduler 作业 parseLedger 腿，同一服务入口（findings
 *                 POST /patrol 同款双触发制式）。
 *   POST /sync    同步「confidence 快照刷页」（票07 EffectivenessSyncResult：
 *                 DB 行级滚动 + v3 页 front-matter 批量收口；夜巡 syncConfidence 腿
 *                 同入口）。未接刷页通道 ⇒ 503 诚实显形。
 *
 * 契约纪律：报告形状先定、后续票只换值不换形（knowledge-read.ts 注同律）。错误面
 * {error:{code,message}} 稳定码 EFFECTIVENESS_PARSE_FAILED/EFFECTIVENESS_SYNC_FAILED/500、
 * EFFECTIVENESS_SYNC_UNAVAILABLE/503；真错文本只进服务日志
 * （validators.errorResponse 防泄漏同律）。**无 GET 读端点**（票06 零新页面零新观测面，
 * 账目经 knowledge_effectiveness/effectiveness_cursors 表可查；健康条消费属票08）。
 */

export interface EffectivenessRoutesApi {
  parse: () => Promise<LedgerReport>
  /** P4 票07：缺省缺席 ⇒ /sync 面 503（不装成功） */
  sync?: () => Promise<EffectivenessSyncResult>
}

export function createEffectivenessRoutes(api: EffectivenessRoutesApi): Hono {
  const routes = new Hono()

  routes.post("/parse", async (c) => {
    try {
      return c.json(await api.parse())
    } catch (err) {
      process.stderr.write(`[knowledge/effectiveness.parse] ${err instanceof Error ? err.message : String(err)}\n`)
      return c.json(
        { error: { code: "EFFECTIVENESS_PARSE_FAILED", message: "记账解析失败（详见服务日志）" } },
        500,
      )
    }
  })

  routes.post("/sync", async (c) => {
    if (!api.sync) {
      return c.json(
        { error: { code: "EFFECTIVENESS_SYNC_UNAVAILABLE", message: "confidence 快照刷页通道未装配（夜巡腿不受影响需装配后启用）" } },
        503,
      )
    }
    try {
      return c.json(await api.sync())
    } catch (err) {
      process.stderr.write(`[knowledge/effectiveness.sync] ${err instanceof Error ? err.message : String(err)}\n`)
      return c.json(
        { error: { code: "EFFECTIVENESS_SYNC_FAILED", message: "confidence 快照刷页失败（详见服务日志）" } },
        500,
      )
    }
  })

  return routes
}
