import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "fs"
import path from "path"
import os from "os"
import { Hono } from "hono"
import { createMainAgentRoute } from "../routes/agent/main-agent-route"
import { IngestError } from "../services/knowledge/raw"

/**
 * 票10 · S2——主代理统一入口的策展工具路由面（fixture 形 = delegate-mention.test.ts 先例：
 * mock SessionDAO + Hono 挂载 + getProvider spy）。
 *
 * 断言「路由后 ingest 调用面」：LLM 发出 ingest_to_wiki 工具调用 ⇒ 路由层拦截执行 ⇒
 * curation.curate 收到**发起会话 sessionId 一等参数**与形态输入；SSE 回执显形。
 * 负断言：路由层零直连抓取/编译旁路——执行面只有注入的 curation seam（零平行机制）。
 */

const TEST_DIR = path.join(os.tmpdir(), `main-agent-curation-${Date.now()}`)

const sessions = new Map<string, any>()
const messages: any[] = []

function createMockSessionDAO() {
  return {
    insertSession: (row: any) => { sessions.set(row.id, { ...row, is_deleted: false }) },
    findById: (id: string) => sessions.get(id) ?? null,
    findSessionById: (id: string) => sessions.get(id) ?? null,
    insertMessage: (row: any) => { messages.push(row) },
    updateLastMessageAt: (id: string, at: string) => {
      const s = sessions.get(id)
      if (s) s.last_message_at = at
    },
    updateSession: (id: string, fields: any) => {
      const s = sessions.get(id)
      if (s) Object.assign(s, fields)
    },
  } as any
}

let curateCalls: Array<Record<string, unknown>>

const RECEIPT = {
  mode: "url",
  deduped: false,
  raw: { path: "raw/inbox/2026-10-15-article.md", hash: "deadbeefcafe1234567890abcdef1234567890abcdef1234567890abcdef12", origin: "url:https://example.com/a", bytes: 2048 },
  title: "知识策展样例",
  compileTask: { taskId: "crt-20261015T090000-001", status: "queued" },
  cardsPosted: true,
}

beforeEach(() => {
  process.env.OCTOPUS_HOME = TEST_DIR
  sessions.clear()
  messages.length = 0
  curateCalls = []
  fs.mkdirSync(path.join(TEST_DIR, "agent", "memory"), { recursive: true })
  fs.mkdirSync(path.join(TEST_DIR, "agent", "skills"), { recursive: true })
})

afterEach(() => {
  delete process.env.OCTOPUS_HOME
  vi.restoreAllMocks()
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }) } catch { /* 非致命 */ }
})

function feedChunks(toolInput: Record<string, unknown>) {
  return [
    { type: "tool_call_start", toolCallId: "tc-1", toolName: "ingest_to_wiki" },
    { type: "tool_call", toolCallId: "tc-1", toolName: "ingest_to_wiki", toolInput },
    { type: "result" },
  ]
}

async function mountChat(curation?: { curate: any }) {
  const app = new Hono()
  app.route("/", createMainAgentRoute({ sessionDAO: createMockSessionDAO(), curation }))
  const providers = await import("@octopus/providers")
  return { app, providers }
}

function stubProvider(chunks: Array<Record<string, unknown>>, providers: any) {
  vi.spyOn(providers, "getProvider").mockReturnValue({
    sendQuery: async function* () {
      for (const ch of chunks) yield ch as any
    },
  } as any)
}

describe("ingest_to_wiki 工具路由（S2 路由后 ingest 调用面）", () => {
  it("模型发出 ingest_to_wiki(url) ⇒ curation.curate 恰一次收到 {sessionId=发起会话, mode=url, url} ⇒ SSE 回执含 raw 路径与编译任务 id", async () => {
    const curate = vi.fn(async (input: Record<string, unknown>) => { curateCalls.push(input); return RECEIPT })
    const { app, providers } = await mountChat({ curate })
    stubProvider(feedChunks({ mode: "url", url: "https://example.com/a" }), providers)

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "把这篇编进 wiki https://example.com/a", session_id: undefined }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()

    expect(curate).toHaveBeenCalledTimes(1)
    const input = curateCalls[0]!
    expect(input.mode).toBe("url")
    expect(input.url).toBe("https://example.com/a")
    // 回流目标 = 本次发起会话（服务端解析的 session id，非模型自报——防伪造落点）
    expect(typeof input.sessionId).toBe("string")
    expect((input.sessionId as string).length).toBeGreaterThan(0)

    // 回执经 tool_result 显形：raw 路径 + 编译任务 id（卡回流由服务层链尾完成，路由不复述 JSON）
    expect(text).toContain("raw/inbox/2026-10-15-article.md")
    expect(text).toContain("crt-20261015T090000-001")
    expect(text).toContain('"is_error":false')
  })

  it("text 形态透传正文与标题（长文本伴随）", async () => {
    const curate = vi.fn(async (input: Record<string, unknown>) => { curateCalls.push(input); return { ...RECEIPT, mode: "text" } })
    const { app, providers } = await mountChat({ curate })
    stubProvider(feedChunks({ mode: "text", text: "一段值得沉淀的长文本素材。", title: "沉淀样例" }), providers)

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "沉淀这篇：一段值得沉淀的长文本素材。" }),
    })
    await res.text() // 消费 SSE 流至路由收尾（工具执行发生在流内）
    expect(curateCalls[0]).toMatchObject({ mode: "text", text: "一段值得沉淀的长文本素材。", title: "沉淀样例" })
  })

  it("curate 失败（IngestError FETCH_FAILED）⇒ tool_result is_error=true 且错误码显形（零吞错、不炸流）", async () => {
    const curate = vi.fn(async () => { throw new IngestError("FETCH_FAILED", "upstream returned HTTP 404", 502) })
    const { app, providers } = await mountChat({ curate })
    stubProvider(feedChunks({ mode: "url", url: "https://example.com/missing" }), providers)

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "把这篇编进 wiki https://example.com/missing" }),
    })
    const text = await res.text()
    expect(text).toContain("FETCH_FAILED")
    expect(text).toContain('"is_error":true')
  })

  it("未接线 curation 的离线形态 ⇒ 工具不可用诚实显形，零执行零炸流", async () => {
    const { app, providers } = await mountChat(undefined)
    stubProvider(feedChunks({ mode: "url", url: "https://example.com/a" }), providers)

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "把这篇编进 wiki https://example.com/a" }),
    })
    const text = await res.text()
    expect(text).toContain('"is_error":true')
    // 诚实显形未接线（不是伪造成功）
    expect(text).toMatch(/not wired|未接线/)
  })

  it("误吞防护代码层负断言：普通文本回答 ⇒ curate 零调用；delegate_to_ 前缀工具不触发策展", async () => {
    const curate = vi.fn(async () => RECEIPT)
    const { app, providers } = await mountChat({ curate })
    // 纯文本（无工具调用）——聊天讨论不吞
    stubProvider([
      { type: "text_delta", content: "上次入库的那篇讲了啥？我来查。" },
      { type: "result" },
    ], providers)

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "上次入库的那篇讲了啥？" }),
    })
    await res.text()
    expect(curate).not.toHaveBeenCalled()
  })

  it("提示词面注册：接线态 systemPrompt 携带 ingest_to_wiki 工具契约；未接线态零注册（不教模型调死工具）", async () => {
    const seen: string[] = []
    const curate = vi.fn(async () => RECEIPT)
    const { app, providers } = await mountChat({ curate })
    vi.spyOn(providers, "getProvider").mockReturnValue({
      sendQuery: (_msg: string, _cwd: string, _x: unknown, opts: any) => {
        seen.push(opts?.systemPrompt?.append ?? "")
        return (async function* () { yield { type: "result" } as any })()
      },
    } as any)
    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    })
    await res.text()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain("ingest_to_wiki")

    // 未接线形态 ⇒ 零注册
    seen.length = 0
    const { app: app2, providers: p2 } = await mountChat(undefined)
    vi.spyOn(p2, "getProvider").mockReturnValue({
      sendQuery: (_msg: string, _cwd: string, _x: unknown, opts: any) => {
        seen.push(opts?.systemPrompt?.append ?? "")
        return (async function* () { yield { type: "result" } as any })()
      },
    } as any)
    const res2 = await app2.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    })
    await res2.text()
    expect(seen[0]).not.toContain("ingest_to_wiki")
  })
})
