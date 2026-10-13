import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import path from "path"
import os from "os"
import http from "http"
import type { AddressInfo } from "net"
import { ensureKnowledgeSkeleton, RAW_DIRS, WIKI_PAGE_DIRS } from "../global-paths"
import { RawIngestService } from "../raw"

/**
 * S1 缝（spec §Testing Decisions「S1 服务层环级测试」）：raw 层 + 投喂通道 —
 * wiki-compile.test.ts 先例（真 fs + tmpdir，零真 ~/.octopus 写入）。
 * 只断言外部产物：目录骨架 / 落盘文件内容与命名 / front-matter hash+bytes /
 * 指针返回值 / 失败后目录仍空。
 * Expected 值逐字取自 prototype Tab② 目录树（行 243-269 命名 {日期}-{slug}）与
 * 票面/spec（hash 冻结、幂等、零落盘），不取自实现。
 */

/** sha256("hello") — 公开测试向量（独立真相源，非从实现反推）。 */
const SHA256_HELLO = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"

/** 固定时钟：命名断言要逐字含日期（prototype 样例 2026-10-13-karpathy-llm-wiki.md）。 */
const FROZEN_NOW = () => new Date("2026-10-13T08:00:00.000Z")

/**
 * 本地 http server 夹具（tasks-preview.test.ts 的 http.createServer().listen(port) 先例）：
 * URL 抓取走真 fetch，不真联网、不 mock 网络层。
 */
function serveHttp(
  route: string,
  respond: { status?: number; contentType?: string; body: string; delayMs?: number },
): Promise<{ origin: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url !== route) {
        res.writeHead(404, { "content-type": "text/plain" })
        res.end("not found")
        return
      }
      if (respond.delayMs) {
        setTimeout(() => {
          res.writeHead(respond.status ?? 200, { "content-type": respond.contentType ?? "text/html; charset=utf-8" })
          res.end(respond.body)
        }, respond.delayMs)
        return
      }
      res.writeHead(respond.status ?? 200, { "content-type": respond.contentType ?? "text/html; charset=utf-8" })
      res.end(respond.body)
    })
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>(r => server.close(() => r())),
      })
    })
  })
}

describe("raw layer + ingest channel (ticket 02, S1)", () => {
  let tmpDir: string
  let root: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kc-raw-"))
    root = path.join(tmpDir, "knowledge")
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function makeService(): RawIngestService {
    return new RawIngestService({ root, now: FROZEN_NOW })
  }

  describe("三层目录骨架（prototype Tab② 行 243-269）", () => {
    it("creates the knowledge root with raw/{inbox,archives,research} + wiki five-type dirs", () => {
      ensureKnowledgeSkeleton(root)

      expect(RAW_DIRS).toEqual(["inbox", "archives", "research"])
      expect(WIKI_PAGE_DIRS).toEqual(["entities", "concepts", "topics", "sources", "cases"])
      for (const d of ["raw/inbox", "raw/archives", "raw/research",
                       "wiki/entities", "wiki/concepts", "wiki/topics", "wiki/sources", "wiki/cases", "wiki/_retired"]) {
        expect(fs.statSync(path.join(root, d)).isDirectory()).toBe(true)
      }
    })

    it("is idempotent: re-running leaves the tree intact and keeps pre-existing raw files", () => {
      ensureKnowledgeSkeleton(root)
      const sentinel = path.join(root, "raw", "inbox", "2026-10-13-keep-me.md")
      fs.writeFileSync(sentinel, "frozen\n", "utf-8")

      expect(() => ensureKnowledgeSkeleton(root)).not.toThrow()
      ensureKnowledgeSkeleton(root)

      expect(fs.readFileSync(sentinel, "utf-8")).toBe("frozen\n")
      expect(fs.readdirSync(path.join(root, "raw", "inbox"))).toEqual(["2026-10-13-keep-me.md"])
    })
  })

  describe("投喂落盘：命名 / hash / 冻结（票面 AC2·AC3）", () => {
    it("pasted text lands as raw/inbox/{date}-{slug}.md with origin, bytes and hash frozen in front-matter", () => {
      const res = makeService().ingestText({ text: "hello", title: "Karpathy LLM Wiki" })

      // 指针形状（票面：raw 指针含 path/hash/origin/bytes）
      expect(res.raw).toEqual({
        path: "raw/inbox/2026-10-13-karpathy-llm-wiki.md",
        hash: SHA256_HELLO,
        origin: "paste",
        bytes: 5,
      })
      expect(res.deduped).toBe(false)
      expect(res.dir).toBe("inbox")

      // 落盘产物：front-matter 记录 + 正文逐字为源文本
      const written = fs.readFileSync(path.join(root, "raw", "inbox", "2026-10-13-karpathy-llm-wiki.md"), "utf-8")
      expect(written).toContain("origin: \"paste\"")
      expect(written).toContain(`hash: "${SHA256_HELLO}"`)
      expect(written).toContain("bytes: 5")
      expect(written.endsWith("hello")).toBe(true)
    })

    it("two pastes sharing a title but differing in content get -2 suffix, never overwrite", () => {
      const svc = makeService()
      const first = svc.ingestText({ text: "hello", title: "Notes" })
      const second = svc.ingestText({ text: "hello world", title: "Notes" })

      expect(first.raw.path).toBe("raw/inbox/2026-10-13-notes.md")
      expect(second.raw.path).toBe("raw/inbox/2026-10-13-notes-2.md")
      // 落盘文件集合（排序后比集——OS readdir 次序不是外部行为）
      expect(fs.readdirSync(path.join(root, "raw", "inbox")).sort()).toEqual([
        "2026-10-13-notes-2.md",
        "2026-10-13-notes.md",
      ])
    })

    it("re-ingesting identical content is idempotent: existing pointer back, no second file", () => {
      const svc = makeService()
      const first = svc.ingestText({ text: "hello", title: "Karpathy LLM Wiki" })
      const again = svc.ingestText({ text: "hello", title: "Karpathy LLM Wiki" })

      expect(again.deduped).toBe(true)
      expect(again.raw).toEqual(first.raw)
      expect(fs.readdirSync(path.join(root, "raw", "inbox"))).toEqual(["2026-10-13-karpathy-llm-wiki.md"])
      // 幂等不得改写既有不可变源
      expect(fs.readFileSync(path.join(root, "raw", "inbox", "2026-10-13-karpathy-llm-wiki.md"), "utf-8"))
        .toContain(`hash: "${SHA256_HELLO}"`)
    })

    it("empty paste is rejected and writes nothing", () => {
      const svc = makeService()
      expect(() => svc.ingestText({ text: "   \n  " })).toThrow(/INVALID_PARAM/)
      for (const d of RAW_DIRS) {
        expect(fs.readdirSync(path.join(root, "raw", d))).toEqual([])
      }
    })
  })

  describe("URL 抓取转 md（票面 AC2 形态 1）", () => {
    /** 期望产物逐字手算（独立真相源）：html→md 的确切输出 + 其 sha256/字节数。 */
    const EXPECTED_PAYLOAD = "# The LLM Wiki\n\nHello **world** & friends.\n\n- one\n- two\n"
    const EXPECTED_HASH = "d6a5ab28a9d8e7c8b9f7567c54f2869929cc91fb7e3c06b6a8937b72a211c9e8"
    const PAGE_HTML = [
      "<!doctype html><html><head><title>Karpathy LLM Wiki</title>",
      '<script>var leak = "secret-script"</script></head>',
      '<body><h1>The LLM Wiki</h1><p>Hello <strong>world</strong> &amp; friends.</p>',
      "<ul><li>one</li><li>two</li></ul></body></html>",
    ].join("")

    it("fetched page lands in raw/inbox as {date}-{slug}.md, title-driven slug, script stripped", async () => {
      const site = await serveHttp("/llm-wiki.html", { body: PAGE_HTML })
      try {
        const res = await makeService().ingestUrl({ url: `${site.origin}/llm-wiki.html` })

        expect(res.raw).toEqual({
          path: "raw/inbox/2026-10-13-karpathy-llm-wiki.md",
          hash: EXPECTED_HASH,
          origin: `url:${site.origin}/llm-wiki.html`,
          bytes: 56,
        })
        expect(res.title).toBe("Karpathy LLM Wiki")
        expect(res.dir).toBe("inbox")

        // 正文逐字等于期望 md（非"包含"级断言：转换口径唯一化）
        const written = fs.readFileSync(path.join(root, "raw", "inbox", "2026-10-13-karpathy-llm-wiki.md"), "utf-8")
        expect(written.endsWith(EXPECTED_PAYLOAD)).toBe(true)
        expect(written).not.toContain("secret-script")
        expect(written).not.toContain("<script")
        // 冻结记录与产物自洽：front-matter bytes == 正文实际字节数
        expect(written).toContain(`bytes: ${Buffer.byteLength(EXPECTED_PAYLOAD, "utf-8")}`)
      } finally {
        await site.close()
      }
    })

    it("text/markdown body is frozen verbatim (no html conversion)", async () => {
      const site = await serveHttp("/notes.md", { contentType: "text/markdown; charset=utf-8", body: "# Title\n\nbody line\n" })
      try {
        const res = await makeService().ingestUrl({ url: `${site.origin}/notes.md` })
        expect(res.raw.origin).toBe(`url:${site.origin}/notes.md`)
        // 无 <title> ⇒ slug 兜底取末段路径名
        expect(res.raw.path).toBe("raw/inbox/2026-10-13-notes.md")
        expect(res.title).toBe("notes")
        const written = fs.readFileSync(path.join(root, "raw", "inbox", "2026-10-13-notes.md"), "utf-8")
        expect(written.endsWith("# Title\n\nbody line\n")).toBe(true)
      } finally {
        await site.close()
      }
    })
  })

  describe("本地文件复制（票面 AC2 形态 3）", () => {
    it("copies a local text file into raw/inbox with file: origin and stem-derived slug", () => {
      const src = path.join(tmpDir, "arch-notes.txt")
      fs.writeFileSync(src, "Meeting notes\n\n- decision A\n", "utf-8")

      const res = makeService().ingestFile({ path: src })

      expect(res.raw.origin).toBe(`file:${src}`)
      expect(res.raw.path).toBe("raw/inbox/2026-10-13-arch-notes.md")
      expect(res.raw.bytes).toBe(Buffer.byteLength("Meeting notes\n\n- decision A\n", "utf-8"))
      expect(res.title).toBe("arch-notes")
      const written = fs.readFileSync(path.join(root, "raw", "inbox", "2026-10-13-arch-notes.md"), "utf-8")
      // 复制语义：正文逐字等于源文件内容
      expect(written.endsWith("Meeting notes\n\n- decision A\n")).toBe(true)
      // 源文件本体不动
      expect(fs.readFileSync(src, "utf-8")).toBe("Meeting notes\n\n- decision A\n")
    })
  })

  describe("抓取/投喂失败零落盘（票面 AC4：报错且不留半截源）", () => {
    const expectRawEmpty = () => {
      for (const d of RAW_DIRS) {
        expect(fs.readdirSync(path.join(root, "raw", d))).toEqual([])
      }
    }

    it("upstream 404 → FETCH_FAILED, raw 三目录仍空", async () => {
      const site = await serveHttp("/there.html", { body: "<h1>here</h1>" })
      try {
        await expect(makeService().ingestUrl({ url: `${site.origin}/missing.html` }))
          .rejects.toThrow(/FETCH_FAILED.*404/s)
        expectRawEmpty()
      } finally {
        await site.close()
      }
    })

    it("slow upstream past fetchTimeoutMs → FETCH_TIMEOUT, raw 三目录仍空", async () => {
      const site = await serveHttp("/slow.html", { body: "<h1>late</h1>", delayMs: 1500 })
      try {
        const svc = new RawIngestService({ root, now: FROZEN_NOW, fetchTimeoutMs: 300 })
        await expect(svc.ingestUrl({ url: `${site.origin}/slow.html` })).rejects.toThrow(/FETCH_TIMEOUT/)
        expectRawEmpty()
      } finally {
        await site.close()
      }
    })

    it("non-text content-type → UNSUPPORTED_CONTENT, raw 三目录仍空", async () => {
      const site = await serveHttp("/doc.pdf", { contentType: "application/pdf", body: "%PDF-1.4 binary-ish" })
      try {
        await expect(makeService().ingestUrl({ url: `${site.origin}/doc.pdf` }))
          .rejects.toThrow(/UNSUPPORTED_CONTENT/)
        expectRawEmpty()
      } finally {
        await site.close()
      }
    })

    it("html with no readable text → EMPTY_CONTENT, raw 三目录仍空", async () => {
      const site = await serveHttp("/blank.html", { body: "<html><head><title>x</title><script>a()</script></head><body></body></html>" })
      try {
        await expect(makeService().ingestUrl({ url: `${site.origin}/blank.html` }))
          .rejects.toThrow(/EMPTY_CONTENT/)
        expectRawEmpty()
      } finally {
        await site.close()
      }
    })

    it("non-http scheme and malformed url → INVALID_PARAM, raw 三目录仍空", async () => {
      const svc = makeService()
      await expect(svc.ingestUrl({ url: "file:///etc/passwd" })).rejects.toThrow(/INVALID_PARAM/)
      await expect(svc.ingestUrl({ url: "not a url" })).rejects.toThrow(/INVALID_PARAM/)
      expectRawEmpty()
    })

    it("missing local file → NOT_FOUND; binary local file → UNSUPPORTED_CONTENT; both zero writes", () => {
      const svc = makeService()
      expect(() => svc.ingestFile({ path: path.join(tmpDir, "nope.md") })).toThrow(/NOT_FOUND/)

      const bin = path.join(tmpDir, "shot.png")
      fs.writeFileSync(bin, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))
      expect(() => svc.ingestFile({ path: bin })).toThrow(/UNSUPPORTED_CONTENT/)
      expectRawEmpty()
    })

    it("a failure after a success does not touch the already-frozen source", async () => {
      const site = await serveHttp("/there.html", { body: "<h1>here</h1>" })
      try {
        const svc = makeService()
        const ok = await svc.ingestUrl({ url: `${site.origin}/there.html` })
        const before = fs.readFileSync(path.join(root, ok.raw.path), "utf-8")

        await expect(svc.ingestUrl({ url: `${site.origin}/gone.html` })).rejects.toThrow(/FETCH_FAILED/)

        expect(fs.readFileSync(path.join(root, ok.raw.path), "utf-8")).toBe(before)
        expect(fs.readdirSync(path.join(root, "raw", "inbox"))).toEqual(["2026-10-13-there.md"])
      } finally {
        await site.close()
      }
    })
  })
})
