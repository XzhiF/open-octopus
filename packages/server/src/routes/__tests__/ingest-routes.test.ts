import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import path from "path"
import os from "os"
import http from "http"
import type { AddressInfo } from "net"
import { RawIngestService, type IngestResult } from "../../services/knowledge/raw"
import { initDb, closeDb } from "../../db/connection"
import { createIngestRoutes } from "../ingest"

/**
 * S2 缝（spec §Testing Decisions「S2 路由契约测试」）：POST /api/knowledge/ingest —
 * wiki-routes.test.ts 先例（路由工厂直调 app.request，零真 server 端口）。
 * URL 抓取用本地 http server（tasks-preview.test.ts 先例），不真联网。
 * 只断言响应形状与状态码 + 落盘产物；错误体沿用 errorResponse 的 `{error:{code,message}}`。
 */

const FROZEN = () => new Date("2026-10-13T08:00:00.000Z")
const PAGE_HTML = '<html><head><title>Karpathy LLM Wiki</title></head><body><h1>The LLM Wiki</h1></body></html>'

function serve(route: string, respond: { status?: number; contentType?: string; body: string; delayMs?: number }): Promise<{ origin: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const ok = req.url === route
      const send = () => {
        res.writeHead(ok ? respond.status ?? 200 : 404, { "content-type": ok ? respond.contentType ?? "text/html; charset=utf-8" : "text/plain" })
        res.end(ok ? respond.body : "not found")
      }
      if (respond.delayMs && ok) setTimeout(send, respond.delayMs)
      else send()
    })
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo
      resolve({ origin: `http://127.0.0.1:${port}`, close: () => new Promise<void>(r => server.close(() => r())) })
    })
  })
}

describe("ingest routes (ticket 02, S2)", () => {
  let tmpDir: string
  let root: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kc-ingest-routes-"))
    root = path.join(tmpDir, "knowledge")
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const svc = (timeoutMs?: number) => new RawIngestService({ root, now: FROZEN, fetchTimeoutMs: timeoutMs })
  const post = (app: ReturnType<typeof createIngestRoutes>, body: unknown) =>
    app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // 字符串直传：JSON.stringify(undefined) 会让 body 变成空串（畸形 JSON 用例要的就是这个）
      body: typeof body === "string" ? body : JSON.stringify(body),
    })

  it("mode=text returns the raw pointer with path/hash/origin/bytes", async () => {
    const res = await post(createIngestRoutes(svc()), { mode: "text", text: "hello", title: "Karpathy LLM Wiki" })
    expect(res.status).toBe(200)
    const data = (await res.json()) as IngestResult
    expect(data).toEqual({
      mode: "text",
      dir: "inbox",
      title: "Karpathy LLM Wiki",
      deduped: false,
      raw: {
        path: "raw/inbox/2026-10-13-karpathy-llm-wiki.md",
        hash: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", // sha256("hello")
        origin: "paste",
        bytes: 5,
      },
    })
  })

  it("mode=url converts and returns the same pointer shape", async () => {
    const site = await serve("/llm-wiki.html", { body: PAGE_HTML })
    try {
      const res = await post(createIngestRoutes(svc()), { url: `${site.origin}/llm-wiki.html`, mode: "url" })
      expect(res.status).toBe(200)
      const data = (await res.json()) as IngestResult
      expect(data.mode).toBe("url")
      expect(data.raw.path).toBe("raw/inbox/2026-10-13-karpathy-llm-wiki.md")
      expect(data.raw.origin).toBe(`url:${site.origin}/llm-wiki.html`)
      expect(data.raw.bytes).toBe(Buffer.byteLength("# The LLM Wiki\n", "utf-8"))
      expect(data.deduped).toBe(false)
    } finally {
      await site.close()
    }
  })

  it("mode=file copies the local file into raw and returns its pointer", async () => {
    const src = path.join(tmpDir, "meeting.txt")
    fs.writeFileSync(src, "notes\n", "utf-8")
    const res = await post(createIngestRoutes(svc()), { mode: "file", path: src })
    expect(res.status).toBe(200)
    const data = (await res.json()) as IngestResult
    expect(data.raw).toEqual({
      path: "raw/inbox/2026-10-13-meeting.md",
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      origin: `file:${src}`,
      bytes: 6,
    })
    expect(data.title).toBe("meeting")
  })

  it("dir=archives routes the same payload into raw/archives", async () => {
    const res = await post(createIngestRoutes(svc()), { mode: "text", text: "hello", title: "R notes", dir: "archives" })
    expect(res.status).toBe(200)
    const data = (await res.json()) as IngestResult
    expect(data.dir).toBe("archives")
    expect(data.raw.path).toBe("raw/archives/2026-10-13-r-notes.md")
  })

  it("re-POSTing identical text is idempotent: deduped=true, still one file", async () => {
    const app = createIngestRoutes(svc())
    const first = (await (await post(app, { mode: "text", text: "hello", title: "Karpathy LLM Wiki" })).json()) as IngestResult
    const second = (await (await post(app, { mode: "text", text: "hello", title: "Karpathy LLM Wiki" })).json()) as IngestResult

    expect(second.deduped).toBe(true)
    expect(second.raw).toEqual(first.raw)
    expect(fs.readdirSync(path.join(root, "raw", "inbox"))).toEqual(["2026-10-13-karpathy-llm-wiki.md"])
  })

  describe("错误码（沿用 errorResponse 的 {error:{code,message}} 形状）", () => {
    it("400 INVALID_PARAM: 缺 mode / 未知 mode / 缺 payload / 坏 dir / 畸形 JSON", async () => {
      const app = createIngestRoutes(svc())
      const cases: unknown[] = [
        { text: "hello" },                       // 缺 mode
        { mode: "ftp", text: "hello" },          // 未知 mode
        { mode: "url" },                         // 缺 url
        { mode: "text", text: "   " },           // 空文本
        { mode: "text", text: "hi", dir: "oops" }, // 非法 dir
        "{ not json",                            // 畸形 JSON
      ]
      for (const body of cases) {
        const res = await post(app, body)
        expect(res.status).toBe(400)
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe("INVALID_PARAM")
      }
      for (const d of ["inbox", "archives", "research"]) {
        expect(fs.readdirSync(path.join(root, "raw", d))).toEqual([])
      }
    })

    it("502 FETCH_FAILED on upstream 404, 415 on non-text, 504 on timeout, 413 on oversize — zero writes each", async () => {
      const notFound = await serve("/here.html", { body: "<h1>here</h1>" })
      const pdfSite = await serve("/doc.pdf", { contentType: "application/pdf", body: "%PDF" })
      const slowSite = await serve("/slow.html", { body: "<h1>late</h1>", delayMs: 1200 })
      const hugeSite = await serve("/huge.txt", { contentType: "text/plain; charset=utf-8", body: "x".repeat(6 * 1024 * 1024) })
      try {
        const app = createIngestRoutes(svc(300))
        const expected: Array<[string, number, string]> = [
          [`${notFound.origin}/gone.html`, 502, "FETCH_FAILED"],
          [`${pdfSite.origin}/doc.pdf`, 415, "UNSUPPORTED_CONTENT"],
          [`${slowSite.origin}/slow.html`, 504, "FETCH_TIMEOUT"],
        ]
        for (const [url, status, code] of expected) {
          const res = await post(app, { mode: "url", url })
          expect(res.status).toBe(status)
          expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code)
        }
        // 超 5MB 上限用例走默认 15s 挂起上限的服务（否则会被 300ms 超时先抢掉，测不到 413）
        const bigRes = await post(createIngestRoutes(svc()), { mode: "url", url: `${hugeSite.origin}/huge.txt` })
        expect(bigRes.status).toBe(413)
        expect(((await bigRes.json()) as { error: { code: string } }).error.code).toBe("FETCH_TOO_LARGE")
        for (const d of ["inbox", "archives", "research"]) {
          expect(fs.readdirSync(path.join(root, "raw", d))).toEqual([])
        }
      } finally {
        await Promise.all([notFound.close(), pdfSite.close(), slowSite.close(), hugeSite.close()])
      }
    })

    it("404 NOT_FOUND on a missing local file", async () => {
      const res = await post(createIngestRoutes(svc()), { mode: "file", path: path.join(tmpDir, "ghost.md") })
      expect(res.status).toBe(404)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("NOT_FOUND")
    })

    it("422 EMPTY_CONTENT when a fetched page yields no text", async () => {
      const site = await serve("/blank.html", { body: "<html><head><title>x</title><script>a()</script></head><body></body></html>" })
      try {
        const res = await post(createIngestRoutes(svc()), { mode: "url", url: `${site.origin}/blank.html` })
        expect(res.status).toBe(422)
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe("EMPTY_CONTENT")
      } finally {
        await site.close()
      }
    })
  })

  // 票面 AC5「路由按既有 /api/knowledge/* 注册」——真 app 挂线检查（serve.test.ts 先例：
  // initDb 后动态 import index.ts，env 必须先于 import 设好，否则服务实例已绑真 ~/.octopus）。
  describe("mounted on the real app", () => {
    it("POST /api/knowledge/ingest is live on the exported Hono app and writes into the env-overridden root", async () => {
      const knowledgeDir = path.join(tmpDir, "knowledge")
      const dbFile = path.join(tmpDir, `ingest-mount-${Date.now()}.db`)
      process.env.OCTOPUS_KNOWLEDGE_DIR = knowledgeDir
      initDb(dbFile)
      try {
        const { default: app } = await import("../../index")
        const res = await app.request("/api/knowledge/ingest", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "text", text: "hello", title: "Mount Check" }),
        })
        expect(res.status).toBe(200)
        const data = (await res.json()) as IngestResult
        // 真 app 用真时钟 ⇒ 日期段按 {YYYY-MM-DD} 形状断言，slug 段逐字
        expect(data.raw.path).toMatch(/^raw\/inbox\/\d{4}-\d{2}-\d{2}-mount-check\.md$/)
        expect(data.raw.hash).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824")
        expect(fs.readdirSync(path.join(knowledgeDir, "raw", "inbox"))).toEqual([
          data.raw.path.split("/").pop(),
        ])
      } finally {
        delete process.env.OCTOPUS_KNOWLEDGE_DIR
        closeDb()
        fs.rmSync(dbFile, { recursive: true, force: true })
      }
    })
  })
})
