// packages/server/src/__tests__/chat-interrupt.test.ts
//
// 2026-10-29 用户：「中断 agent 输出后，被中断的会话全都不见了；这里应该是中断
// 的状态；然后我输入新提示词，让这个会话继续。」
//
// 服务端契约（本文件钉住）：
//   1. POST /sessions/:id/stop 在 partial 落库为「本轮被截断」之后才返回 ——
//      客户端随即重拉实录，不丢内容、不丢中断标记；
//   2. 中断行 metadata.interrupted = true，且不再挂 streaming（否则每次冷加载
//      都被当成 live partial 吃掉）；
//   3. 停止不写兜底文案、不删会话：同一会话的下一条提示词照常继续。
//
// Anti-fake-run: 真 better-sqlite3 + applySchema，Hono app.request，mock provider
// 持续吐字直到被停止（真实停止路径 = 循环里测 isAborted 后 break）。

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { Hono } from "hono"
import { applySchema } from "../db/schema"
import { AgentSessionDAO } from "../db/dao"
import { TokenUsageDAO } from "../db/dao/token-usage-dao"
import { createChatRoutes } from "../routes/agent/chat-routes"
import { initAgentService, isStreamActive } from "../services/agent/agent-service"
import * as providers from "@octopus/providers"

const ORG = "E2E_TEST_chat_interrupt"
const SESSION = "s-int-1"
const ROOT = path.join(os.tmpdir(), `chat-interrupt-${Date.now()}`)
const HOME = path.join(ROOT, "octopus")
const CLAUDE_DIR = path.join(ROOT, "claude")
const AGENT_DIR = path.join(HOME, "agent")

let db: Database.Database
let sessionDAO: AgentSessionDAO
/** 每次 chat 调用消费一个行为：'hang' = 一直吐字直到被停止；'finish' = 正常收尾；
 *  'slow' = 无视 abortSignal 睡 4 秒（模拟收尾慢于 stop 的 3 秒等待窗）。 */
let behaviors: Array<"hang" | "finish" | "slow">

function installProvider() {
  vi.spyOn(providers, "getProvider").mockImplementation((() => ({
    sendQuery: async function* (
      _prompt: string,
      _cwd: string,
      _resume: string | undefined,
      options?: { abortSignal?: AbortSignal },
    ) {
      const mode = behaviors.shift() ?? "finish"
      if (mode === "hang") {
        yield { type: "text_delta", content: "半句输出" }
        // 2026-10-31：停止路径 = abortSignal → provider 收尾（真实 provider 走
        // Query.interrupt() 并吐带用量的 error result）。这里模拟「停止后
        // 生成器结束」；路由会继续消费到结束再收尾。
        while (!options?.abortSignal?.aborted) {
          await new Promise((r) => setTimeout(r, 15))
          if (options?.abortSignal?.aborted) break
          yield { type: "text_delta", content: "…" }
        }
        return
      }
      if (mode === "slow") {
        // 停止后仍要 4 秒才收尾 —— 比 stopChat 的 3 秒等待窗长，复现竞态。
        yield { type: "text_delta", content: "正在构建…" }
        await new Promise((r) => setTimeout(r, 4_000))
        return
      }
      yield { type: "text_delta", content: "好的，继续。" }
      yield { type: "result", content: "好的，继续。", sessionId: "sdk-int-1" }
    },
  })) as never)
}

function app() {
  const a = new Hono()
  a.route("/api/agent", createChatRoutes({
    sessionDAO,
    safetyDAO: { insertSafetyEvent: vi.fn() } as never,
    scheduleConfigDAO: {} as never,
    tokenUsageDao: new TokenUsageDAO(db),
  }))
  return a
}

const HEADERS = { "Content-Type": "application/json", "X-Octopus-Org": ORG }

function chat(message: string) {
  return app().request(`/api/agent/sessions/${SESSION}/chat`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ message }),
  })
}

function stop() {
  return app().request(`/api/agent/sessions/${SESSION}/stop`, {
    method: "POST",
    headers: HEADERS,
  })
}

/** Read SSE frames until the first text delta, then hand control back (stream stays open). */
async function readUntilFirstDelta(res: Response): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let acc = ""
  while (!acc.includes("text_delta")) {
    const { value, done } = await reader.read()
    if (done) break
    acc += decoder.decode(value, { stream: true })
  }
  return reader
}

function assistantRows() {
  return db.prepare(
    "SELECT id, content, metadata FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY created_at ASC",
  ).all(SESSION) as Array<{ id: string; content: string; metadata: string | null }>
}

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
  sessionDAO = new AgentSessionDAO(db)
})

beforeEach(() => {
  fs.mkdirSync(path.join(AGENT_DIR, "memory"), { recursive: true })
  fs.mkdirSync(path.join(AGENT_DIR, "experiences"), { recursive: true })
  fs.mkdirSync(path.join(AGENT_DIR, "skills"), { recursive: true })
  fs.mkdirSync(path.join(CLAUDE_DIR, "projects"), { recursive: true })
  process.env.OCTOPUS_HOME = HOME
  process.env.CLAUDE_CONFIG_DIR = CLAUDE_DIR
  db.prepare("DELETE FROM messages").run()
  db.prepare("DELETE FROM sessions").run()
  db.prepare("DELETE FROM session_prompt_snapshots").run()
  db.prepare("DELETE FROM session_expert_rosters").run()
  db.prepare("DELETE FROM session_role_states").run()
  db.prepare("DELETE FROM llm_calls").run()
  behaviors = []
  installProvider()
  initAgentService(sessionDAO, { insertSafetyEvent: vi.fn() } as never)
  const now = new Date().toISOString()
  sessionDAO.insertSession({
    id: SESSION, title: "T", clone_name: null, session_type: "main",
    created_at: now, updated_at: now,
  })
})

afterEach(() => {
  delete process.env.OCTOPUS_HOME
  delete process.env.CLAUDE_CONFIG_DIR
  vi.restoreAllMocks()
})

afterAll(() => {
  try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch { /* non-fatal */ }
  db.close()
})

describe("main chat — interrupt keeps the session and marks the turn", () => {
  it("stop finalizes the partial as interrupted BEFORE returning (state + content preserved)", async () => {
    behaviors.push("hang")
    const res = await chat("写一篇长文")
    expect(res.status).toBe(200)
    const reader = await readUntilFirstDelta(res)

    const stopped = await stop()
    expect(stopped.status).toBe(200)
    const body = (await stopped.json()) as { success: boolean; partial_content_preserved: boolean }
    expect(body.partial_content_preserved).toBe(true)

    // stop 已返回 ⇒ partial 必须已经落库（不用轮询/不用等下一次请求）。
    const rows = assistantRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].content).toContain("半句输出")
    const meta = JSON.parse(rows[0].metadata ?? "{}") as { interrupted?: boolean; streaming?: boolean }
    expect(meta.interrupted).toBe(true)
    expect(meta.streaming).toBeUndefined()

    // 停止不写兜底文案：只有那一条中断行。
    expect(rows.some((r) => r.content.includes("Claude SDK 未配置"))).toBe(false)

    // 会话本身还在（不删、不软删）。
    const session = db.prepare("SELECT is_deleted FROM sessions WHERE id = ?").get(SESSION) as { is_deleted: number }
    expect(session.is_deleted).toBe(0)

    try { await reader.cancel() } catch { /* already closed */ }
  })

  it("the same session continues with the next prompt", async () => {
    behaviors.push("hang")
    const first = await chat("写一篇长文")
    const reader = await readUntilFirstDelta(first)
    await stop()
    try { await reader.cancel() } catch { /* already closed */ }

    behaviors.push("finish")
    const second = await chat("继续")
    await second.text()

    const rows = assistantRows()
    expect(rows).toHaveLength(2)
    expect(JSON.parse(rows[0].metadata ?? "{}").interrupted).toBe(true)
    expect(rows[1].content).toBe("好的，继续。")
    expect(JSON.parse(rows[1].metadata ?? "{}").interrupted).toBeUndefined()
  })

  // 2026-11-10 用户事故：上一轮还在跑时再发一条 → 两条 SDK 查询并发 resume
  // 同一 provider 会话，后一条只拿到上一轮累计 result 的回放（空正文）——
  // 消息发出去了却没有任何回复。主对话路由现在和克隆路由一样有并发闸，
  // 且闸在读入用户消息之前（被弹回的消息不落转录）。
  it("上一轮仍在生成 → 第二条 chat 409，用户消息不落库", async () => {
    behaviors.push("hang")
    const first = await chat("跑一个长任务")
    expect(first.status).toBe(200)
    const reader = await readUntilFirstDelta(first)

    const second = await chat("起来了吗？")
    expect(second.status).toBe(409)
    const body = (await second.json()) as { error: { code: string } }
    expect(body.error.code).toBe("STREAM_IN_PROGRESS")

    const users = db.prepare(
      "SELECT content FROM messages WHERE session_id = ? AND role = 'user' ORDER BY created_at ASC",
    ).all(SESSION) as Array<{ content: string }>
    expect(users.map((u) => u.content)).toEqual(["跑一个长任务"])

    await stop()
    try { await reader.cancel() } catch { /* already closed */ }
  })

  // stop 的 3 秒等待窗超时 ≠ 回合真的结束：路由还在 finalize（provider drain /
  // quick-edit commit）。此时流必须继续占着注册表 —— 否则客户端 probe 到
  // running=false 就发下一条，又回到并发 resume 的坑（turn 25/turn 27 事故）。
  it("停止等待超时、路由仍在收尾 → 新回合仍 409；真正收尾后才放行", { timeout: 20_000 }, async () => {
    behaviors.push("slow")
    const first = await chat("启动服务")
    expect(first.status).toBe(200)
    const reader = await readUntilFirstDelta(first)

    const stopped = await stop() // 等满 3 秒超时返回；provider 4 秒才收尾
    expect(stopped.status).toBe(200)
    expect(isStreamActive(SESSION)).toBe(true)

    const second = await chat("起来了吗？")
    expect(second.status).toBe(409)
    const users = db.prepare(
      "SELECT content FROM messages WHERE session_id = ? AND role = 'user' ORDER BY created_at ASC",
    ).all(SESSION) as Array<{ content: string }>
    expect(users.map((u) => u.content)).toEqual(["启动服务"])

    // 旧回合收尾（provider 4 秒结束）→ 注册表清空 → 新回合放行
    for (let i = 0; i < 40 && isStreamActive(SESSION); i++) {
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(isStreamActive(SESSION)).toBe(false)

    behaviors.push("finish")
    const third = await chat("现在呢")
    expect(third.status).toBe(200)
    await third.text()

    try { await reader.cancel() } catch { /* already closed */ }
  })
})
