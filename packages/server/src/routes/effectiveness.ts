import { Hono } from "hono"
import type { LedgerReport } from "../services/knowledge/effectiveness-ledger"

/**
 * effectiveness 记账触发面路由（P4 票06 AC4 手动通道）——挂 `/api/knowledge/effectiveness`：
 *
 *   POST /parse   同步「解析至最新」（增量游标推进后返回 LedgerReport）。
 *                 夜巡自动面走 scheduler 作业 parseLedger 腿，同一服务入口（findings
 *                 POST /patrol 同款双触发制式）。
 *
 * 契约纪律：报告形状先定、后续票只换值不换形（knowledge-read.ts 注同律）。错误面
 * {error:{code,message}} 稳定码 EFFECTIVENESS_PARSE_FAILED/500；真错文本只进服务日志
 * （validators.errorResponse 防泄漏同律）。**无 GET 读端点**（票06 零新页面零新观测面，
 * 账目经 knowledge_effectiveness/effectiveness_cursors 表可查；健康条消费属票08）。
 */

export interface EffectivenessRoutesApi {
  parse: () => Promise<LedgerReport>
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

  return routes
}
