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
})
