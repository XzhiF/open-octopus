import { Hono } from "hono"
import { IngestError, type RawIngestService, type IngestResult } from "../services/knowledge/raw"
import { errorResponse } from "../services/knowledge/validators"

/**
 * 投喂通道 API（知识中心票02）——`POST /api/knowledge/ingest`。
 *
 * 三形态同端点、按 `mode` 分流（spec §Implementation Decisions「ingest 投喂（url 抓取/上传/粘贴）」）：
 *   { mode: "url",    url, title?, dir? }   抓取转 md 落 raw
 *   { mode: "text",   text, title?, dir? }  粘贴文本落 raw
 *   { mode: "file",   path, title?, dir? }  本地文件复制落 raw
 * 成功 200 回 raw 指针（path/hash/origin/bytes，票05 编译的输入形状）；
 * 失败 `{error:{code,message}}`，码集：INVALID_PARAM 400 / NOT_FOUND 404 /
 * FETCH_TOO_LARGE 413 / UNSUPPORTED_CONTENT 415 / EMPTY_CONTENT 422 /
 * FETCH_FAILED 502 / FETCH_TIMEOUT 504。
 * 注：粘贴形态的请求体另受 index.ts 全局 bodyLimit（1MB）约束，超限由中间件直接 413。
 * 默认零编译语义：落 raw 即返回、不入队（spec「raw 落盘不入队」；编译投递是票05 的显式 opt-in）。
 *
 * 路由工厂签名沿用 wiki-routes 先例：服务构造注入，测试传 tmpdir 根。
 *
 * 票05 追加（向后兼容）：`POST /ingest?compile=true` 投喂成功后立即投递编译任务，
 * 响应多出 `compileTask: { taskId, status }` 字段（不带该参数时形状与票02 逐字一致）。
 * 编译本体是异步任务——状态流转与产物见 `GET /api/knowledge/wiki/compile/task/:id`。
 */

interface IngestRequest {
  mode?: unknown
  url?: unknown
  text?: unknown
  path?: unknown
  title?: unknown
  dir?: unknown
}

/** 编译投递回调（index.ts 注入 CuratorTaskService.submit 的薄包装）。 */
export type CompileTrigger = (rawPath: string) => { taskId: string; status: string }

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)

export function createIngestRoutes(service: RawIngestService, compileTrigger?: CompileTrigger): Hono {
  const routes = new Hono()

  routes.post("/ingest", async (c) => {
    const payload = await c.req.json().catch(() => null)
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return c.json({ error: { code: "INVALID_PARAM", message: "A JSON object body is required" } }, 400)
    }
    const body = payload as IngestRequest
    const common = { title: str(body.title), dir: str(body.dir) }

    try {
      let result: IngestResult
      switch (body.mode) {
        case "url":
          result = await service.ingestUrl({ url: str(body.url) ?? "", ...common })
          break
        case "text":
          result = service.ingestText({ text: str(body.text) ?? "", ...common })
          break
        case "file":
          result = service.ingestFile({ path: str(body.path) ?? "", ...common })
          break
        default:
          return c.json({ error: { code: "INVALID_PARAM", message: 'mode must be one of: "url", "text", "file"' } }, 400)
      }
      return c.json(compileTrigger && c.req.query("compile") === "true"
        ? { ...result, compileTask: compileTrigger(result.raw.path) }
        : result)
    } catch (err) {
      if (err instanceof IngestError) {
        return c.json({ error: { code: err.code, message: err.detail } }, err.status)
      }
      const { body: resp, status } = errorResponse(err, "ingest")
      return c.json(resp, status)
    }
  })

  return routes
}
