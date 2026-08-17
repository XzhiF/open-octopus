import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { SessionCache } from '../../pi/session-cache'
import { createSession, findSession } from '../../pi/pi-sdk-adapter'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

// ═══════════════════════════════════════════════════════════════════
// Real-factory resume tests (ticket 13)
//
// Bug (SPIKE S2): findSession() returned a bare SessionManager (file handle)
// instead of an AgentSession. provider.ts:284 calls session.subscribe(cb)
// and :298 calls session.prompt(...) — both threw TypeError on the resumed
// path because SessionManager has neither method.
//
// These tests use the REAL createSession/findSession (no mocks) so the
// SessionManager-vs-AgentSession type mismatch is caught at test time.
// ═══════════════════════════════════════════════════════════════════

// Unique cwd per test run isolates session files under
// ~/.pi/agent/sessions/--<encoded-cwd>-- (the SDK's default session dir).
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const TEST_CWD = path.join(os.tmpdir(), `octopus-resume-${RUN_ID}`)

beforeAll(async () => {
  fs.mkdirSync(TEST_CWD, { recursive: true })
})

afterAll(async () => {
  // Clean up session files the SDK wrote for TEST_CWD.
  // SessionManager.list is exported from the package root and resolves the
  // default session dir internally, so we don't depend on private helpers.
  const pi = await import('@earendil-works/pi-coding-agent')
  try {
    const sessions = await pi.SessionManager.list(TEST_CWD)
    for (const s of sessions) {
      try { fs.rmSync(s.path, { force: true }) } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  try { fs.rmSync(TEST_CWD, { recursive: true, force: true }) } catch { /* ignore */ }
})

/**
 * Build a minimal valid AssistantMessage (pi-ai Message shape) so we can
 * materialize a session file on disk. The SDK's SessionManager._persist()
 * defers writing the file until an assistant message exists (so abandoned
 * sessions don't litter disk) — a real agent turn would append this via
 * the agent event loop; here we append it directly to simulate turn 1
 * completing, then exercise findSession() for turn 2.
 */
function makeAssistantMessage(text: string): any {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'dashscope',
    model: 'qwen3-max',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  }
}

/**
 * Materialize a session file on disk for the given created session by
 * appending an assistant message directly to its SessionManager. Returns
 * the entry id. Disposes the live session after flushing so turn 2 resumes
 * from a clean state.
 */
async function materializeAndClose(created: { session: any; sessionId: string }, assistantText: string): Promise<void> {
  const session = created.session
  // appendMessage pushes the assistant entry into fileEntries, then _persist
  // sees hasAssistant=true and writes the file (openSync "wx" + writeFileSync).
  session.sessionManager.appendMessage(makeAssistantMessage(assistantText))
  try { session.dispose?.() } catch { /* ignore */ }
}

describe('Session Resume — real factory (ticket 13: findSession → AgentSession, not SessionManager)', () => {
  it('AC1/AC3: findSession returns a usable AgentSession with subscribe/prompt/abort/dispose', async () => {
    // Turn 1: create a REAL session (no mocks).
    const created = await createSession({ cwd: TEST_CWD })
    const sessionId = created.sessionId
    expect(sessionId).toBeTruthy()

    // Materialize the session file (simulate turn 1 completing).
    await materializeAndClose(created, 'turn 1 reply')

    // Turn 2: resume — MUST return an AgentSession, not a bare SessionManager.
    const restored = await findSession(TEST_CWD, sessionId, { cwd: TEST_CWD })
    expect(restored).not.toBeNull()

    const session = restored!.session
    // AC1/AC3: these four methods exist on AgentSession; a bare SessionManager
    // lacks them. provider.ts:284 calls session.subscribe, :298 calls
    // session.prompt — TypeError before fix.
    expect(typeof session.subscribe).toBe('function')
    expect(typeof session.prompt).toBe('function')
    expect(typeof session.abort).toBe('function')
    expect(typeof session.dispose).toBe('function')

    // sessionId preserved from the resumed SessionManager state.
    expect(restored!.sessionId).toBe(sessionId)
    // AgentSession exposes the same session id (state lives in sessionManager).
    expect(session.sessionId).toBe(sessionId)

    try { session.dispose?.() } catch { /* ignore */ }
  })

  it('AC2: 2-turn resume — subscribe/prompt callable without TypeError + history preserved (provider.ts:284/298 bug)', async () => {
    // Turn 1: create + materialize with a distinct assistant reply.
    const created = await createSession({ cwd: TEST_CWD })
    const sessionId = created.sessionId
    const turn1Reply = 'turn 1 reply for AC2 — distinct marker'
    await materializeAndClose(created, turn1Reply)

    // Turn 2: resume via findSession.
    const restored = await findSession(TEST_CWD, sessionId, { cwd: TEST_CWD })
    expect(restored).not.toBeNull()
    const session = restored!.session

    // provider.ts:284 path: PiSdk.subscribeEvents(sr.session, cb) → session.subscribe(cb).
    // Before fix: session is a SessionManager → TypeError: session.subscribe is not a function.
    const unsub = session.subscribe(() => {})
    expect(typeof unsub).toBe('function')
    unsub()

    // provider.ts:298 path: PiSdk.promptSession(sr.session, prompt, opts) → session.prompt(...).
    // Assert method is a real function (we cannot invoke prompt without a configured
    // model/API key, but method existence is what the bug broke).
    expect(typeof session.prompt).toBe('function')

    // History preserved: the resumed AgentSession adopts the SessionManager's
    // buildSessionContext() — agent.state.messages is populated from the persisted
    // turn-1 entries (sdk.js: hasExistingSession → agent.state.messages = existingSession.messages).
    expect(session.sessionId).toBe(sessionId)
    const messages = session.agent?.state?.messages ?? []
    expect(messages.length).toBeGreaterThan(0)
    // The turn-1 assistant reply is present in the resumed message history.
    const turn1Text = messages
      .filter((m: any) => m.role === 'assistant')
      .map((m: any) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join(' ')
    expect(turn1Text).toContain(turn1Reply)

    try { session.dispose?.() } catch { /* ignore */ }
  })

  it('AC1: findSession returns null when session does not exist (provider falls back to fresh session)', async () => {
    const restored = await findSession(TEST_CWD, 'nonexistent-session-id-xyz-12345', { cwd: TEST_CWD })
    expect(restored).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════
// SessionCache behavior (mock factory) — tests caching, not findSession.
// Kept from the original file: TC-038 / TC-039 cover cache-key behavior.
// ═══════════════════════════════════════════════════════════════════

describe('Session Resume (S16, P2-5) — SessionCache behavior', () => {
  it('resumeSessionId creates new cache key (TC-038)', async () => {
    let createCount = 0
    const mockFactory = async (cwd: string, resumeId?: string) => {
      createCount++
      return {
        session: { id: `session-${createCount}`, state: { messages: resumeId ? [{ role: 'user', content: 'previous' }] : [] } },
        sessionId: resumeId ?? `new-${createCount}`,
        modelRegistry: null,
      }
    }
    const cache = new SessionCache(mockFactory)

    const s1 = await cache.getOrCreate('/project')
    expect(s1.session.state.messages).toEqual([])

    const s2 = await cache.getOrCreate('/project', 'prev-session')
    expect(s2.session.state.messages.length).toBeGreaterThan(0)
    expect(createCount).toBe(2)
  })

  it('resumeSessionId not found falls back to new session (TC-039)', async () => {
    const mockFactory = async (cwd: string, resumeId?: string) => {
      return { session: { id: 'fallback-new', state: { messages: [] } }, sessionId: 'fallback-new', modelRegistry: null }
    }
    const cache = new SessionCache(mockFactory)
    const s = await cache.getOrCreate('/project', 'nonexistent-id')
    expect(s.session.id).toBe('fallback-new')
  })
})
