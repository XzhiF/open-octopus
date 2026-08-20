import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { CloneRuntime } from '../clone-runtime'
import type { CloneDef } from '@octopus/shared'

// ── Test helpers ──────────────────────────────────────────────────

const TEST_DIR = path.join(os.tmpdir(), `clone-runtime-test-${Date.now()}`)

function setOctopusHome(): void {
  process.env.OCTOPUS_HOME = TEST_DIR
}

function createTestCloneDef(overrides?: Partial<CloneDef>): CloneDef {
  return {
    name: 'workspace',
    displayName: '全栈开发助手',
    type: 'built-in',
    persona: 'Test persona for workspace clone',
    skills: [],
    memoryScope: 'shared',
    config: {},
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────

describe('CloneRuntime', () => {
  beforeEach(() => {
    setOctopusHome()
    // Create test directory structure
    fs.mkdirSync(path.join(TEST_DIR, 'agent', 'memory', 'daily'), { recursive: true })
    fs.mkdirSync(path.join(TEST_DIR, 'agent', 'skills'), { recursive: true })
    fs.mkdirSync(path.join(TEST_DIR, 'agent', 'built-in', 'workspace', 'memory', 'daily'), { recursive: true })
    fs.mkdirSync(path.join(TEST_DIR, 'agent', 'built-in', 'scheduler', 'memory'), { recursive: true })
  })

  afterEach(() => {
    delete process.env.OCTOPUS_HOME
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true })
    } catch {
      // Cleanup failure is non-fatal in tests
    }
  })

  describe('assembleContext', () => {
    it('includes clone persona in assembled context', () => {
      const cloneDef = createTestCloneDef()
      const runtime = new CloneRuntime(cloneDef, 'test-org')
      const context = runtime.assembleContext()

      expect(context).toContain('Test persona for workspace clone')
    })

    it('reads built-in clone persona from filesystem', () => {
      const personaPath = path.join(TEST_DIR, 'agent', 'built-in', 'workspace', 'persona.md')
      fs.writeFileSync(personaPath, '# Workspace Clone\n\nYou are the workspace clone.', 'utf-8')

      const cloneDef = createTestCloneDef()
      const runtime = new CloneRuntime(cloneDef, 'test-org')
      const context = runtime.assembleContext()

      expect(context).toContain('You are the workspace clone')
    })

    it('includes shared memory when memoryScope is shared', () => {
      const ltPath = path.join(TEST_DIR, 'agent', 'memory', 'long-term.md')
      fs.writeFileSync(ltPath, '## Experience\n\nTest experience content', 'utf-8')

      const cloneDef = createTestCloneDef({ memoryScope: 'shared' })
      const runtime = new CloneRuntime(cloneDef, 'test-org')
      const context = runtime.assembleContext()

      expect(context).toContain('Test experience content')
    })

    it('excludes shared memory when memoryScope is isolated', () => {
      const ltPath = path.join(TEST_DIR, 'agent', 'memory', 'long-term.md')
      fs.writeFileSync(ltPath, '## Experience\n\nTest experience content', 'utf-8')

      const cloneDef = createTestCloneDef({ memoryScope: 'isolated' })
      const runtime = new CloneRuntime(cloneDef, 'test-org')
      const context = runtime.assembleContext()

      expect(context).not.toContain('Test experience content')
    })

    it('uses inline persona when filesystem persona is missing for user clones', () => {
      const cloneDef = createTestCloneDef({ type: 'user', persona: 'Inline persona text' })
      const runtime = new CloneRuntime(cloneDef, 'test-org')
      const context = runtime.assembleContext()

      expect(context).toContain('Inline persona text')
    })
  })

  describe('readSharedMemory', () => {
    it('reads global long-term memory', () => {
      const ltPath = path.join(TEST_DIR, 'agent', 'memory', 'long-term.md')
      fs.writeFileSync(ltPath, '## Lessons\n\nImportant lesson', 'utf-8')

      const cloneDef = createTestCloneDef({ memoryScope: 'shared' })
      const runtime = new CloneRuntime(cloneDef, 'test-org')
      const memory = runtime.readSharedMemory()

      expect(memory).toContain('Important lesson')
    })

    it('reads today daily memory', () => {
      const today = new Date().toISOString().slice(0, 10)
      const dailyPath = path.join(TEST_DIR, 'agent', 'memory', 'daily', `${today}.md`)
      fs.writeFileSync(dailyPath, '### Today work\n\nDid something', 'utf-8')

      const cloneDef = createTestCloneDef({ memoryScope: 'shared' })
      const runtime = new CloneRuntime(cloneDef, 'test-org')
      const memory = runtime.readSharedMemory()

      expect(memory).toContain('Did something')
    })

    it('returns empty string for isolated scope', () => {
      const cloneDef = createTestCloneDef({ memoryScope: 'isolated' })
      const runtime = new CloneRuntime(cloneDef, 'test-org')
      const memory = runtime.readSharedMemory()

      expect(memory).toBe('')
    })
  })

  describe('writeIsolatedMemory', () => {
    it('writes to clone-specific memory directory', () => {
      const cloneDef = createTestCloneDef()
      const runtime = new CloneRuntime(cloneDef, 'test-org')

      runtime.writeIsolatedMemory('Test memory entry')

      const today = new Date().toISOString().slice(0, 10)
      const memoryPath = path.join(TEST_DIR, 'agent', 'built-in', 'workspace', 'memory', 'daily', `${today}.md`)
      expect(fs.existsSync(memoryPath)).toBe(true)
      expect(fs.readFileSync(memoryPath, 'utf-8')).toContain('Test memory entry')
    })

    it('does not throw when memory directory write fails', () => {
      const cloneDef = createTestCloneDef({ name: 'nonexistent-clone' })
      const runtime = new CloneRuntime(cloneDef, 'test-org')

      // Should not throw
      expect(() => runtime.writeIsolatedMemory('test')).not.toThrow()
    })
  })

  describe('chat', () => {
    it('yields error chunk when provider is unavailable', async () => {
      // Mock getProvider to throw
      const providers = await import('@octopus/providers')
      vi.spyOn(providers, 'getProvider').mockImplementation(() => {
        throw new Error('Provider not configured')
      })

      const cloneDef = createTestCloneDef()
      const runtime = new CloneRuntime(cloneDef, 'test-org')

      const chunks = []
      for await (const chunk of runtime.chat('hello', 'session-1', null, TEST_DIR)) {
        chunks.push(chunk)
      }

      expect(chunks.length).toBeGreaterThan(0)
      expect(chunks[0].type).toBe('error')

      vi.restoreAllMocks()
    })
  })

  // 05 — reverse context msg (SPIKE S1, v2-D7). The notice is concatenated
  // into the provider's systemPrompt.append by sendWithProvider so the
  // task-author agent sees the user's spec override on the next turn.
  describe('chat — specUpdateNotice (05, SPIKE S1)', () => {
    // Shape of the sendQuery options we assert on (systemPrompt.append is
    // where sendWithProvider concatenates the notice — clone-runtime.ts:319).
    type SpyOpts = { systemPrompt: { type: string; preset: string; append: string } }

    it('appends specUpdateNotice to the systemPrompt.append sent to the provider', async () => {
      const providers = await import('@octopus/providers')
      const sendQuerySpy = vi.fn(async function* (
        _prompt: string,
        _cwd: string,
        _resumeSessionId: string | undefined,
        _options?: SpyOpts,
      ): AsyncGenerator<{ type: string; sessionId?: string }> {
        yield { type: 'result', sessionId: 'provider-sess-notice-1' }
      })
      vi.spyOn(providers, 'getProvider').mockImplementation(() => ({
        getType: () => 'claude',
        sendQuery: sendQuerySpy,
      }) as unknown as ReturnType<typeof providers.getProvider>)

      const cloneDef = createTestCloneDef()
      const runtime = new CloneRuntime(cloneDef, 'test-org')

      const NOTICE = '@@spec_updated: goal, skills'
      for await (const _ of runtime.chat('hello', 'session-notice-1', null, TEST_DIR, NOTICE)) {
        // drain — the provider receives the system prompt during iteration
      }

      // sendQuery called once (first attempt with resume=null succeeds)
      expect(sendQuerySpy).toHaveBeenCalledTimes(1)
      const options = sendQuerySpy.mock.calls[0][3]!
      // SPIKE S1: the notice is concatenated into the append string
      expect(options.systemPrompt.append).toContain(NOTICE)
      // The assembled clone context (persona) is still the base of the append
      expect(options.systemPrompt.append).toContain('Test persona for workspace clone')
      // Preset unchanged — we only append, never replace
      expect(options.systemPrompt.preset).toBe('claude_code')

      vi.restoreAllMocks()
    })

    it('does not append anything when specUpdateNotice is omitted (no @@spec_updated leak)', async () => {
      const providers = await import('@octopus/providers')
      const sendQuerySpy = vi.fn(async function* (
        _prompt: string,
        _cwd: string,
        _resumeSessionId: string | undefined,
        _options?: SpyOpts,
      ): AsyncGenerator<{ type: string; sessionId?: string }> {
        yield { type: 'result', sessionId: 'provider-sess-notice-2' }
      })
      vi.spyOn(providers, 'getProvider').mockImplementation(() => ({
        getType: () => 'claude',
        sendQuery: sendQuerySpy,
      }) as unknown as ReturnType<typeof providers.getProvider>)

      const cloneDef = createTestCloneDef()
      const runtime = new CloneRuntime(cloneDef, 'test-org')
      for await (const _ of runtime.chat('hello', 'session-notice-2', null, TEST_DIR)) {
        // drain — no specUpdateNotice passed
      }

      const options = sendQuerySpy.mock.calls[0][3]!
      // No notice → no @@spec_updated token in the system prompt
      expect(options.systemPrompt.append).not.toContain('@@spec_updated')
      // Persona still present (append == assembled context, unmodified)
      expect(options.systemPrompt.append).toContain('Test persona for workspace clone')

      vi.restoreAllMocks()
    })
  })

  // Single-expert consultation: the clone chat route passes resolved SDK
  // subagent defs (experts) via chat()'s `subagents` tail param. sendWithProvider
  // must forward them as the sendQuery `agents` option so the main agent can
  // invoke the expert via its Agent tool for that turn.
  describe('chat — subagents (single-expert consultation)', () => {
    type SpyOpts = {
      systemPrompt: { type: string; preset: string; append: string }
      agents?: Record<string, { description: string; prompt: string; tools?: string[] }>
    }

    it('forwards subagents as the sendQuery agents option (including on resume retry)', async () => {
      const providers = await import('@octopus/providers')
      const sendQuerySpy = vi.fn(async function* (
        _prompt: string,
        _cwd: string,
        _resumeSessionId: string | undefined,
        _options?: SpyOpts,
      ): AsyncGenerator<{ type: string; sessionId?: string }> {
        yield { type: 'result', sessionId: 'provider-sess-subagent-1' }
      })
      vi.spyOn(providers, 'getProvider').mockImplementation(() => ({
        getType: () => 'claude',
        sendQuery: sendQuerySpy,
      }) as unknown as ReturnType<typeof providers.getProvider>)

      const cloneDef = createTestCloneDef()
      const runtime = new CloneRuntime(cloneDef, 'test-org')

      const subagents = {
        'engineering-rapid-prototyper': {
          description: '快速原型',
          prompt: '你是快速原型师…',
          tools: ['Read', 'Grep', 'Glob'],
        },
      }
      for await (const _ of runtime.chat(
        'hello', 'session-subagent-1', null, TEST_DIR, undefined, undefined, undefined, undefined, undefined, subagents,
      )) {
        // drain
      }

      expect(sendQuerySpy).toHaveBeenCalledTimes(1)
      const options = sendQuerySpy.mock.calls[0][3]!
      expect(options.agents).toEqual(subagents)

      vi.restoreAllMocks()
    })

    it('omits the agents option when no subagents are passed', async () => {
      const providers = await import('@octopus/providers')
      const sendQuerySpy = vi.fn(async function* (
        _prompt: string,
        _cwd: string,
        _resumeSessionId: string | undefined,
        _options?: SpyOpts,
      ): AsyncGenerator<{ type: string; sessionId?: string }> {
        yield { type: 'result', sessionId: 'provider-sess-subagent-2' }
      })
      vi.spyOn(providers, 'getProvider').mockImplementation(() => ({
        getType: () => 'claude',
        sendQuery: sendQuerySpy,
      }) as unknown as ReturnType<typeof providers.getProvider>)

      const cloneDef = createTestCloneDef()
      const runtime = new CloneRuntime(cloneDef, 'test-org')
      for await (const _ of runtime.chat('hello', 'session-subagent-2', null, TEST_DIR)) {
        // drain — no subagents passed
      }

      const options = sendQuerySpy.mock.calls[0][3]!
      expect(options.agents).toBeUndefined()

      vi.restoreAllMocks()
    })
  })

  // 07 (SG6, v2-D8/D13): draft-scope authoring_resources[] SKILL.md content
  // is injected into the task-author session's systemPrompt.append via a new
  // `authoringResourcesContent` param on chat(). sendWithProvider appends it
  // ALONGSIDE specUpdateNotice (clone-runtime.ts:346-348 — same concat seam
  // 05's specUpdateNotice uses). Mechanism B (SPIKE S2): assembleContext is
  // fresh per turn, so the latest authoring_resources[] content is re-read
  // every turn by the route (which calls TaskAuthorSessionAugmenter before
  // runtime.chat). For Claude SDK (the provider task-author uses), resume
  // works natively — no fresh-session / DB-history-prepend needed.
  describe('chat — authoringResourcesContent (07, SG6)', () => {
    type SpyOpts = { systemPrompt: { type: string; preset: string; append: string } }

    it('appends authoringResourcesContent to systemPrompt.append (alongside specUpdateNotice)', async () => {
      const providers = await import('@octopus/providers')
      const sendQuerySpy = vi.fn(async function* (
        _prompt: string,
        _cwd: string,
        _resumeSessionId: string | undefined,
        _options?: SpyOpts,
      ): AsyncGenerator<{ type: string; sessionId?: string }> {
        yield { type: 'result', sessionId: 'provider-sess-ar-1' }
      })
      vi.spyOn(providers, 'getProvider').mockImplementation(() => ({
        getType: () => 'claude',
        sendQuery: sendQuerySpy,
      }) as unknown as ReturnType<typeof providers.getProvider>)

      const cloneDef = createTestCloneDef()
      const runtime = new CloneRuntime(cloneDef, 'test-org')
      const AUTHORING = '## Available Skills\n### octo-backend\nBuild the backend.'
      const NOTICE = '@@spec_updated: goal, skills'

      for await (const _ of runtime.chat('hello', 'sess-ar-1', null, TEST_DIR, NOTICE, AUTHORING)) {
        // drain — provider receives the system prompt during iteration
      }

      const options = sendQuerySpy.mock.calls[0][3]!
      // AUTHORING content is in the append string
      expect(options.systemPrompt.append).toContain(AUTHORING)
      // specUpdateNotice is also in the append string (alongside)
      expect(options.systemPrompt.append).toContain(NOTICE)
      // Base persona is still the foundation of the append
      expect(options.systemPrompt.append).toContain('Test persona for workspace clone')
      // Preset unchanged
      expect(options.systemPrompt.preset).toBe('claude_code')

      vi.restoreAllMocks()
    })

    it('appends authoringResourcesContent alone (no specUpdateNotice — undefined hole)', async () => {
      const providers = await import('@octopus/providers')
      const sendQuerySpy = vi.fn(async function* (
        _prompt: string,
        _cwd: string,
        _resumeSessionId: string | undefined,
        _options?: SpyOpts,
      ): AsyncGenerator<{ type: string; sessionId?: string }> {
        yield { type: 'result', sessionId: 'provider-sess-ar-2' }
      })
      vi.spyOn(providers, 'getProvider').mockImplementation(() => ({
        getType: () => 'claude',
        sendQuery: sendQuerySpy,
      }) as unknown as ReturnType<typeof providers.getProvider>)

      const cloneDef = createTestCloneDef()
      const runtime = new CloneRuntime(cloneDef, 'test-org')
      const AUTHORING = '## Available Skills\n### octo-research\nResearch skills.'

      // Pass AUTHORING as 6th arg, no specUpdateNotice (5th arg undefined).
      // The param order (notice before authoringContent) lets the route pass
      // `undefined` for notice when only authoring is pending — verified here.
      for await (const _ of runtime.chat('hello', 'sess-ar-2', null, TEST_DIR, undefined, AUTHORING)) {
        // drain
      }

      const options = sendQuerySpy.mock.calls[0][3]!
      expect(options.systemPrompt.append).toContain(AUTHORING)
      // No notice → no @@spec_updated leak
      expect(options.systemPrompt.append).not.toContain('@@spec_updated')
      // Persona still present
      expect(options.systemPrompt.append).toContain('Test persona for workspace clone')

      vi.restoreAllMocks()
    })

    it('no authoringResourcesContent + no specUpdateNotice → just persona (backward compat)', async () => {
      const providers = await import('@octopus/providers')
      const sendQuerySpy = vi.fn(async function* (
        _prompt: string,
        _cwd: string,
        _resumeSessionId: string | undefined,
        _options?: SpyOpts,
      ): AsyncGenerator<{ type: string; sessionId?: string }> {
        yield { type: 'result', sessionId: 'provider-sess-ar-3' }
      })
      vi.spyOn(providers, 'getProvider').mockImplementation(() => ({
        getType: () => 'claude',
        sendQuery: sendQuerySpy,
      }) as unknown as ReturnType<typeof providers.getProvider>)

      const cloneDef = createTestCloneDef()
      const runtime = new CloneRuntime(cloneDef, 'test-org')
      // Existing call shape (≤5 args) — no authoringContent, no notice
      for await (const _ of runtime.chat('hello', 'sess-ar-3', null, TEST_DIR)) {
        // drain
      }

      const options = sendQuerySpy.mock.calls[0][3]!
      // append == assembled clone context (persona + memory guidance), nothing extra
      expect(options.systemPrompt.append).toContain('Test persona for workspace clone')
      expect(options.systemPrompt.append).not.toContain('## Available Skills')
      expect(options.systemPrompt.append).not.toContain('@@spec_updated')

      vi.restoreAllMocks()
    })
  })

  describe('assembleContext (plugin-based skill discovery)', () => {
    it('does not include skill text in assembled context (ADR-006)', () => {
      // Create shared skill — should NOT appear in assembleContext output
      const sharedSkillDir = path.join(TEST_DIR, 'agent', 'skills', 'octo-agent-memory')
      fs.mkdirSync(sharedSkillDir, { recursive: true })
      fs.writeFileSync(
        path.join(sharedSkillDir, 'SKILL.md'),
        '---\nname: octo-agent-memory\n---\nSearch and manage agent memory layers.',
        'utf-8',
      )

      const cloneDef = createTestCloneDef({ skills: [] })
      const runtime = new CloneRuntime(cloneDef, 'test-org')
      const context = runtime.assembleContext()

      // Skills are discovered by SDK via plugins, not injected as prompt text
      expect(context).not.toContain('octo-agent-memory')
      expect(context).not.toContain('Octopus Platform Skills')
      expect(context).not.toContain('Shared:')
      expect(context).not.toContain('Clone:')
    })
  })

  describe('getPlugins', () => {
    it('returns main plugin and built-in clone plugin', () => {
      const cloneDef = createTestCloneDef({ name: 'workspace', type: 'built-in' })
      const runtime = new CloneRuntime(cloneDef, 'test-org')
      const plugins = runtime.getPlugins()

      expect(plugins).toHaveLength(2)
      expect(plugins[0]).toEqual({ type: 'local', path: path.join(TEST_DIR, 'agent') })
      expect(plugins[1]).toEqual({ type: 'local', path: path.join(TEST_DIR, 'agent', 'built-in', 'workspace') })
    })

    it('returns main plugin and user clone plugin for user clones', () => {
      const cloneDef = createTestCloneDef({ name: 'my-clone', type: 'user' })
      const runtime = new CloneRuntime(cloneDef, 'test-org')
      const plugins = runtime.getPlugins()

      expect(plugins).toHaveLength(2)
      expect(plugins[0]).toEqual({ type: 'local', path: path.join(TEST_DIR, 'agent') })
      expect(plugins[1]).toEqual({ type: 'local', path: path.join(TEST_DIR, 'agent', 'clones', 'my-clone') })
    })

    it('always includes the main agent directory as first plugin', () => {
      const cloneDef = createTestCloneDef({ name: 'scheduler', type: 'built-in' })
      const runtime = new CloneRuntime(cloneDef, 'test-org')
      const plugins = runtime.getPlugins()

      expect(plugins[0].path).toBe(path.join(TEST_DIR, 'agent'))
    })

    // 03 (task-authoring-v3, AC5): getPlugins(taskHomePath?) appends the
    // task home as a THIRD plugin directory when taskHomePath is provided.
    // The SDK scans `{taskHomePath}/skills/` for the per-task materialized
    // skill links (plugin-materializer.ts). Param is tail-appended to
    // preserve existing callers (SW-BP15).
    it('appends taskHomePath as third plugin when provided (AC5)', () => {
      const cloneDef = createTestCloneDef({ name: 'task-author', type: 'built-in' })
      const runtime = new CloneRuntime(cloneDef, 'test-org')
      const taskHome = path.join(TEST_DIR, 'tasks', 't-author-1')

      const plugins = runtime.getPlugins(taskHome)

      expect(plugins).toHaveLength(3)
      // First two unchanged — existing plugin order preserved
      expect(plugins[0]).toEqual({ type: 'local', path: path.join(TEST_DIR, 'agent') })
      expect(plugins[1]).toEqual({ type: 'local', path: path.join(TEST_DIR, 'agent', 'built-in', 'task-author') })
      // Third plugin = taskHomePath (the SDK scans {taskHomePath}/skills/)
      expect(plugins[2]).toEqual({ type: 'local', path: taskHome })
    })

    it('getPlugins(undefined) stays at 2 plugins (backward compat — no arg hole)', () => {
      const cloneDef = createTestCloneDef({ name: 'workspace', type: 'built-in' })
      const runtime = new CloneRuntime(cloneDef, 'test-org')

      const plugins = runtime.getPlugins(undefined)

      expect(plugins).toHaveLength(2)
      expect(plugins[1]).toEqual({ type: 'local', path: path.join(TEST_DIR, 'agent', 'built-in', 'workspace') })
    })

    it('getPlugins("") does not append an empty-string third plugin (falsy guard)', () => {
      const cloneDef = createTestCloneDef({ name: 'workspace', type: 'built-in' })
      const runtime = new CloneRuntime(cloneDef, 'test-org')

      const plugins = runtime.getPlugins('')

      // Empty string is falsy — treated as "no task home" so we don't feed
      // the SDK a bogus plugin path that scans the cwd root.
      expect(plugins).toHaveLength(2)
    })
  })

  // 03 (task-authoring-v3, AC5): chat()/sendWithProvider() thread an optional
  // tail `taskHomePath` arg so the task-author send path can request the third
  // plugin directory. Param is tail-appended (after abortSignal) so all
  // existing callers (clone/index.ts:370 passes 6 args; main-agent-route.ts:239
  // / 763 pass 4 args; tests pass ≤6 args) keep working unchanged (SW-BP15).
  describe('chat — taskHomePath (03, AC5)', () => {
    type SpyOpts = { systemPrompt: { type: string; preset: string; append: string }; plugins: Array<{ type: string; path: string }> }

    it('threads taskHomePath (8th arg) → provider receives 3 plugins (third = taskHomePath)', async () => {
      const providers = await import('@octopus/providers')
      const sendQuerySpy = vi.fn(async function* (
        _prompt: string,
        _cwd: string,
        _resumeSessionId: string | undefined,
        _options?: SpyOpts,
      ): AsyncGenerator<{ type: string; sessionId?: string }> {
        yield { type: 'result', sessionId: 'provider-sess-taskhome-1' }
      })
      vi.spyOn(providers, 'getProvider').mockImplementation(() => ({
        getType: () => 'claude',
        sendQuery: sendQuerySpy,
      }) as unknown as ReturnType<typeof providers.getProvider>)

      const cloneDef = createTestCloneDef()
      const runtime = new CloneRuntime(cloneDef, 'test-org')
      const taskHome = path.join(TEST_DIR, 'tasks', 't-thread-1')

      // 8th arg = taskHomePath. No specUpdateNotice / authoringResources /
      // abortSignal — the param order lets us skip them via `undefined`.
      for await (const _ of runtime.chat('hello', 'sess-th-1', null, TEST_DIR, undefined, undefined, undefined, taskHome)) {
        // drain
      }

      const options = sendQuerySpy.mock.calls[0][3]!
      expect(options.plugins).toHaveLength(3)
      expect(options.plugins[2]).toEqual({ type: 'local', path: taskHome })
      // First two still present (regression: existing plugins untouched)
      expect(options.plugins[0]).toEqual({ type: 'local', path: path.join(TEST_DIR, 'agent') })
      vi.restoreAllMocks()
    })

    it('no taskHomePath (existing ≤7-arg call) → provider receives 2 plugins (regression)', async () => {
      const providers = await import('@octopus/providers')
      const sendQuerySpy = vi.fn(async function* (
        _prompt: string,
        _cwd: string,
        _resumeSessionId: string | undefined,
        _options?: SpyOpts,
      ): AsyncGenerator<{ type: string; sessionId?: string }> {
        yield { type: 'result', sessionId: 'provider-sess-taskhome-2' }
      })
      vi.spyOn(providers, 'getProvider').mockImplementation(() => ({
        getType: () => 'claude',
        sendQuery: sendQuerySpy,
      }) as unknown as ReturnType<typeof providers.getProvider>)

      const cloneDef = createTestCloneDef()
      const runtime = new CloneRuntime(cloneDef, 'test-org')

      // Existing call shape — 4 args (the main-agent-route.ts shape)
      for await (const _ of runtime.chat('hello', 'sess-th-2', null, TEST_DIR)) {
        // drain
      }

      const options = sendQuerySpy.mock.calls[0][3]!
      // AC5: existing callers see no change — still 2 plugins, no third hole
      expect(options.plugins).toHaveLength(2)
      expect(options.plugins[0]).toEqual({ type: 'local', path: path.join(TEST_DIR, 'agent') })
      vi.restoreAllMocks()
    })

    it('taskHomePath alongside specUpdateNotice + authoringResources (full 8-arg call)', async () => {
      const providers = await import('@octopus/providers')
      const sendQuerySpy = vi.fn(async function* (
        _prompt: string,
        _cwd: string,
        _resumeSessionId: string | undefined,
        _options?: SpyOpts,
      ): AsyncGenerator<{ type: string; sessionId?: string }> {
        yield { type: 'result', sessionId: 'provider-sess-taskhome-3' }
      })
      vi.spyOn(providers, 'getProvider').mockImplementation(() => ({
        getType: () => 'claude',
        sendQuery: sendQuerySpy,
      }) as unknown as ReturnType<typeof providers.getProvider>)

      const cloneDef = createTestCloneDef()
      const runtime = new CloneRuntime(cloneDef, 'test-org')
      const NOTICE = '@@spec_updated: goal'
      const AUTHORING = '## Available Skills\n### octo-x\nX body.'
      const taskHome = path.join(TEST_DIR, 'tasks', 't-full-1')

      // All 8 args in order: message, sessionId, providerSessionId, cwd,
      // specUpdateNotice, authoringResourcesContent, abortSignal, taskHomePath.
      for await (const _ of runtime.chat('hello', 'sess-th-3', null, TEST_DIR, NOTICE, AUTHORING, undefined, taskHome)) {
        // drain
      }

      const options = sendQuerySpy.mock.calls[0][3]!
      // 3 plugins (third = taskHomePath)
      expect(options.plugins).toHaveLength(3)
      expect(options.plugins[2]).toEqual({ type: 'local', path: taskHome })
      // Both append segments still present alongside the third plugin
      expect(options.systemPrompt.append).toContain(NOTICE)
      expect(options.systemPrompt.append).toContain(AUTHORING)
      vi.restoreAllMocks()
    })
  })

  describe('getDefaultCwd', () => {
    it('returns built-in clone directory for built-in clones', () => {
      const cloneDef = createTestCloneDef({ name: 'workspace', type: 'built-in' })
      const runtime = new CloneRuntime(cloneDef, 'test-org')

      expect(runtime.getDefaultCwd()).toBe(
        path.join(TEST_DIR, 'agent', 'built-in', 'workspace'),
      )
    })

    it('returns clones directory for user clones', () => {
      const cloneDef = createTestCloneDef({ name: 'my-clone', type: 'user' })
      const runtime = new CloneRuntime(cloneDef, 'test-org')

      expect(runtime.getDefaultCwd()).toBe(
        path.join(TEST_DIR, 'agent', 'clones', 'my-clone'),
      )
    })
  })

  // ── writeIsolatedMemory conflict detection (CMA-07) ──────────────

  describe('writeIsolatedMemory conflict detection', () => {
    it('writes successfully without expectedLastModified', () => {
      const cloneDef = createTestCloneDef({ name: 'conflict-test', type: 'user' })
      const runtime = new CloneRuntime(cloneDef, 'test-org')

      // Should not throw
      expect(() => runtime.writeIsolatedMemory('Test memory entry')).not.toThrow()

      // Verify file exists
      const today = new Date().toISOString().slice(0, 10)
      const filePath = path.join(TEST_DIR, 'agent', 'clones', 'conflict-test', 'memory', 'daily', `${today}.md`)
      expect(fs.existsSync(filePath)).toBe(true)
      expect(fs.readFileSync(filePath, 'utf-8')).toContain('Test memory entry')
    })

    it('throws MEMORY_CONFLICT when expectedLastModified is stale', () => {
      const cloneDef = createTestCloneDef({ name: 'conflict-test2', type: 'user' })
      const runtime = new CloneRuntime(cloneDef, 'test-org')

      // Write initial entry
      runtime.writeIsolatedMemory('Initial entry')

      // Read the file mtime
      const today = new Date().toISOString().slice(0, 10)
      const filePath = path.join(TEST_DIR, 'agent', 'clones', 'conflict-test2', 'memory', 'daily', `${today}.md`)
      const stat = fs.statSync(filePath)
      const currentMtime = stat.mtime.toISOString()

      // Simulate a stale timestamp (1 hour before current)
      const staleMtime = new Date(Date.now() - 3600000).toISOString()

      // Should throw MEMORY_CONFLICT
      try {
        runtime.writeIsolatedMemory('Conflicting entry', staleMtime)
        expect(true).toBe(false) // Should not reach here
      } catch (err) {
        expect((err as { code?: string }).code).toBe('MEMORY_CONFLICT')
      }

      // Verify the stale entry was not written
      const content = fs.readFileSync(filePath, 'utf-8')
      expect(content).not.toContain('Conflicting entry')
    })

    it('succeeds when expectedLastModified is current', () => {
      const cloneDef = createTestCloneDef({ name: 'conflict-test3', type: 'user' })
      const runtime = new CloneRuntime(cloneDef, 'test-org')

      // Write initial entry
      runtime.writeIsolatedMemory('First entry')

      // Read the file mtime
      const today = new Date().toISOString().slice(0, 10)
      const filePath = path.join(TEST_DIR, 'agent', 'clones', 'conflict-test3', 'memory', 'daily', `${today}.md`)
      const stat = fs.statSync(filePath)
      const currentMtime = stat.mtime.toISOString()

      // Write with current mtime should succeed
      expect(() => runtime.writeIsolatedMemory('Second entry', currentMtime)).not.toThrow()

      // Verify both entries exist
      const content = fs.readFileSync(filePath, 'utf-8')
      expect(content).toContain('First entry')
      expect(content).toContain('Second entry')
    })
  })
})
