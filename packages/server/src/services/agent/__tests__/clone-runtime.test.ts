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
