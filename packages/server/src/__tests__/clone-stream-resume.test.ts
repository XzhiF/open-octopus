// packages/server/src/__tests__/clone-stream-resume.test.ts
//
// "关闭不丢失" (stream-resume) — clone chat route behaviors:
//   1. disconnect ≠ stop: closing the SSE consumer must NOT kill the turn;
//      it runs to completion and the assistant row is finalized (this is the
//      explicit design that replaces the old `_aborted` dead-code check —
//      "fixing" the typo to hono's real `aborted` field would regress this).
//   2. Incremental partial persistence: an assistant row with
//      metadata.streaming:true appears DURING the turn (throttled), is
//      finalized (streaming dropped) at turn-end on the SAME row id, and the
//      done event's message_id matches (no duplicate bubble on reopen).
//   3. GET /:name/sessions/:id/running — probe for the reopen path.
//   4. POST chat 409 STREAM_IN_PROGRESS while a turn is active — the
//      concurrent send's user message must NOT be stored.
//   5. Explicit stop → row finalized with interrupted:true.
//   6. Provider throw → partial row finalized (no lingering streaming flag).
//   7. Startup orphan sweep (finalizeOrphanStreamPartials).
//
// Anti-fake-run: real better-sqlite3 + applySchema + real AgentSessionDAO,
// real route + streamSSE via app.request, controllable mocked CloneRuntime
// generator (gate between chunks). Only CloneRuntime + clone-resolver mocked.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { Hono } from "hono"
import { applySchema } from "../db/schema"
import { AgentSessionDAO, SafetyDAO } from "../db/dao"
import { createCloneSessionRoutes } from "../routes/clone"
import { initAgentService } from "../services/agent/agent-service"
import { finalizeOrphanStreamPartials } from "../routes/clone/stream-partials"

// ── Mocks ────────────────────────────────────────────────────────────────

interface Gate { promise: Promise<void>; resolve: () => void }
function makeGate(): Gate {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

const control = vi.hoisted(() => ({
  gates: [] as Array<{ promise: Promise<void>; resolve: () => void }>,
  throwMode: false,
  chatCalls: 0,
}))

vi.mock("../services/agent/clone-runtime", () => ({
  CloneRuntime: class {
    constructor(_cloneDef: unknown, _org: string) {}
    getDefaultCwd(): string { return "/tmp/fake-cwd" }
    async *chat() {
      control.chatCalls += 1
      yield { type: "text_delta", content: "part-1 " }
      // Suspend mid-turn: the test inspects DB state / disconnects / stops,
      // then releases the gate.
      let resolve!: () => void
      const promise = new Promise<void>((r) => { resolve = r })
      control.gates.push({ promise, resolve })
      await promise
      if (control.throwMode) throw new Error("E2E_TD provider exploded")
      yield { type: "text_delta", content: "part-2" }
      yield { type: "result", sessionId: "E2E_TD_provider-sess-1" }
    }
  },
}))

vi.mock("../services/agent/clone-resolver", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/agent/clone-resolver")>()
  return {
    ...real,
    resolveCloneInfo: (name: string) => {
      if (name !== "task-author") return null
      return {
        name, display_name: "Task Author", type: "built-in" as const,
        persona: "# task-author\n\nFake persona for test.",
        skills: [], memory_scope: "shared" as const,
      }
    },
  }
})

// ── Harness ──────────────────────────────────────────────────────────────

const ORG = "e2e-td-resume"

let db: Database.Database
let app: Hono
let sessionDAO: AgentSessionDAO

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)) }

async function waitFor(cond: () => boolean, what: string, timeoutMs = 3000) {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for: ${what}`)
    await sleep(10)
  }
}

function assistantRows(sessionId: string) {
  return db.prepare(
    `SELECT id, content, metadata FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY created_at ASC`,
  ).all(sessionId) as Array<{ id: string; content: string; metadata: string }>
}

function userMsgCount(sessionId: string): number {
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND role = 'user'`,
  ).get(sessionId) as { n: number }).n
}

async function createSession(): Promise<string> {
  const res = await app.request("/api/clones/task-author/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
    body: JSON.stringify({}),
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { id: string }).id
}

function chatRequest(sessionId: string, message: string) {
  return app.request(`/api/clones/task-author/sessions/${sessionId}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
    body: JSON.stringify({ message }),
  })
}

/** Fire a chat and wait until the partial row (streaming:true) is visible. */
async function startChatUntilPartial(sessionId: string, message: string) {
  const p = chatRequest(sessionId, message)
  await waitFor(
    () => assistantRows(sessionId).some((r) => r.metadata?.includes('"streaming":true')),
    "streaming partial row",
  )
  return await p
}

function releaseGate() {
  const g = control.gates[control.gates.length - 1]
  expect(g).toBeDefined()
  g.resolve()
}

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
  sessionDAO = new AgentSessionDAO(db)
  // The stop endpoint goes through the AgentService singleton (stopChat).
  initAgentService(sessionDAO, new SafetyDAO(db))
  app = new Hono()
  app.route("/api/clones", createCloneSessionRoutes({ sessionDAO, partialFlushMs: 0 }))
})

afterAll(() => { db.close() })

beforeEach(() => {
  control.gates = []
  control.throwMode = false
  control.chatCalls = 0
})

// ── 1+2+3: partial persistence, finalize on same row, running probe ─────

describe("stream-resume: partial persistence + finalize + running probe", () => {
  it("mid-turn: streaming partial row visible; turn-end: finalized on SAME row id, done.message_id matches, single row", async () => {
    const sid = await createSession()
    const res = await startChatUntilPartial(sid, "E2E_TD resume turn")

    // Mid-turn state
    const mid = assistantRows(sid)
    expect(mid.length).toBe(1)
    const midMeta = JSON.parse(mid[0].metadata)
    expect(midMeta.streaming).toBe(true)
    expect(mid[0].content).toBe("part-1 ")
    expect(midMeta.interrupted).toBeUndefined()

    const runMid = await app.request(`/api/clones/task-author/sessions/${sid}/running`)
    expect(runMid.status).toBe(200)
    expect(await runMid.json()).toEqual({ running: true, partial: true })

    // Complete the turn (client still connected here)
    releaseGate()
    const sse = await res.text()

    const rows = assistantRows(sid)
    expect(rows.length).toBe(1) // single row — finalize reused the partial id
    expect(rows[0].id).toBe(mid[0].id)
    const finalMeta = JSON.parse(rows[0].metadata)
    expect(finalMeta.streaming).toBeUndefined()
    expect(finalMeta.interrupted).toBeUndefined()
    expect(rows[0].content).toBe("part-1 part-2")
    // done event references the same row id
    const doneData = JSON.parse(
      sse.split("\n").filter((l) => l.startsWith("data: ") && l.includes("message_id"))
        .map((l) => l.slice(6)).pop()!,
    )
    expect(doneData.message_id).toBe(rows[0].id)
    // provider_session_id persisted for resume
    const sess = db.prepare(`SELECT provider_session_id FROM sessions WHERE id = ?`).get(sid) as { provider_session_id: string }
    expect(sess.provider_session_id).toBe("E2E_TD_provider-sess-1")

    const runEnd = await app.request(`/api/clones/task-author/sessions/${sid}/running`)
    expect(await runEnd.json()).toEqual({ running: false, partial: false })
  })

  it("running endpoint: unknown session → 404", async () => {
    const res = await app.request(`/api/clones/task-author/sessions/nope-404/running`)
    expect(res.status).toBe(404)
  })
})

// ── 1: disconnect ≠ stop ──────────────────────────────────────────────────

describe("stream-resume: closing the connection does not stop the turn", () => {
  it("client cancels the SSE body mid-turn → generator still completes, row finalized (no interrupted)", async () => {
    const sid = await createSession()
    const res = await startChatUntilPartial(sid, "E2E_TD disconnect turn")

    // Simulate "关闭弹窗": abort the client side of the stream.
    await res.body?.cancel()

    releaseGate()
    // The handler runs detached — poll until the row is finalized.
    await waitFor(() => {
      const rows = assistantRows(sid)
      return rows.length === 1 && !rows[0].metadata.includes('"streaming"')
    }, "finalized row after disconnect")

    const rows = assistantRows(sid)
    const meta = JSON.parse(rows[0].metadata)
    expect(rows[0].content).toBe("part-1 part-2") // full turn, not a half
    expect(meta.interrupted).toBeUndefined()      // disconnect ≠ stop
    const sess = db.prepare(`SELECT provider_session_id FROM sessions WHERE id = ?`).get(sid) as { provider_session_id: string }
    expect(sess.provider_session_id).toBe("E2E_TD_provider-sess-1")

    const run = await app.request(`/api/clones/task-author/sessions/${sid}/running`)
    expect(((await run.json()) as { running: boolean }).running).toBe(false)
  })
})

// ── 4: 409 concurrency guard ─────────────────────────────────────────────

describe("stream-resume: 409 while a turn is running", () => {
  it("second chat while first is generating → 409 STREAM_IN_PROGRESS, user message NOT stored", async () => {
    const sid = await createSession()
    const res = await startChatUntilPartial(sid, "E2E_TD first turn")
    expect(userMsgCount(sid)).toBe(1)

    const second = await chatRequest(sid, "E2E_TD concurrent resend")
    expect(second.status).toBe(409)
    const body = (await second.json()) as { error: { code: string } }
    expect(body.error.code).toBe("STREAM_IN_PROGRESS")
    // The bounced send left no trace in the transcript
    expect(userMsgCount(sid)).toBe(1)

    releaseGate()
    await res.text()
    expect(control.chatCalls).toBe(1) // the runtime never saw the second turn
  })
})

// ── 5: explicit stop finalizes with interrupted ──────────────────────────

describe("stream-resume: explicit stop", () => {
  it("POST stop mid-turn → row finalized with interrupted:true, streaming dropped", async () => {
    const sid = await createSession()
    const res = await startChatUntilPartial(sid, "E2E_TD stop turn")

    const stop = await app.request(`/api/clones/task-author/sessions/${sid}/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
    })
    expect(stop.status).toBe(200)
    expect(((await stop.json()) as { success: boolean }).success).toBe(true)

    // The route observes `aborted` on the next loop iteration — release the
    // gate so the loop resumes, checks the flag, and breaks.
    releaseGate()
    await res.text()

    const rows = assistantRows(sid)
    expect(rows.length).toBe(1)
    const meta = JSON.parse(rows[0].metadata)
    expect(meta.streaming).toBeUndefined()
    expect(meta.interrupted).toBe(true)

    const run = await app.request(`/api/clones/task-author/sessions/${sid}/running`)
    expect(await run.json()).toEqual({ running: false, partial: false })
  })
})

// ── 6: provider throw finalizes the partial ──────────────────────────────

describe("stream-resume: provider error", () => {
  it("generator throws after partials → row finalized interrupted, no lingering streaming flag", async () => {
    const sid = await createSession()
    control.throwMode = true
    const res = await startChatUntilPartial(sid, "E2E_TD throw turn")

    releaseGate() // generator throws here → route catch finalizes the row
    await res.text()

    const rows = assistantRows(sid)
    expect(rows.length).toBe(1)
    const meta = JSON.parse(rows[0].metadata)
    expect(meta.streaming).toBeUndefined()
    expect(meta.interrupted).toBe(true)
  })
})

// ── 7: startup orphan sweep ──────────────────────────────────────────────

describe("stream-resume: finalizeOrphanStreamPartials (startup sweep)", () => {
  it("valid streaming row → interrupted + non-terminal tools failed; malformed row skipped untouched", () => {
    const now = new Date().toISOString()
    const goodId = "E2E_TD_orphan_good"
    const badId = "E2E_TD_orphan_bad"
    sessionDAO.insertSession({
      id: "E2E_TD_orphan_sess", org: ORG, title: "E2E_TD orphan",
      clone_name: "task-author", session_type: "clone",
      created_at: now, updated_at: now,
    })
    sessionDAO.insertCloneMessage({
      id: goodId, session_id: "E2E_TD_orphan_sess", role: "assistant", type: "text",
      content: "half", created_at: now,
      metadata: JSON.stringify({
        streaming: true,
        tool_calls: [
          { id: "t1", name: "Read", status: "result", result: "ok" },
          { id: "t2", name: "Bash", status: "start" },
        ],
      }),
    })
    // Unparseable but LIKE-matching metadata (contains "streaming":true)
    sessionDAO.insertCloneMessage({
      id: badId, session_id: "E2E_TD_orphan_sess", role: "assistant", type: "text",
      content: "half", created_at: now,
      metadata: `{"streaming":true,"tool_calls":[`,
    })

    const n = finalizeOrphanStreamPartials(sessionDAO)
    expect(n).toBe(1)

    const good = (db.prepare(`SELECT metadata FROM messages WHERE id = ?`).get(goodId) as { metadata: string }).metadata
    const meta = JSON.parse(good)
    expect(meta.streaming).toBeUndefined()
    expect(meta.interrupted).toBe(true)
    expect(meta.tool_calls[0].status).toBe("result")     // terminal untouched
    expect(meta.tool_calls[1].status).toBe("fail")       // non-terminal failed
    expect(meta.tool_calls[1].ended_at).toBeTypeOf("number")

    const bad = (db.prepare(`SELECT metadata FROM messages WHERE id = ?`).get(badId) as { metadata: string }).metadata
    expect(bad).toBe(`{"streaming":true,"tool_calls":[`) // malformed skipped, no throw

    // Idempotent: second sweep finds nothing new to finalize
    expect(finalizeOrphanStreamPartials(sessionDAO)).toBe(0)
  })
})
