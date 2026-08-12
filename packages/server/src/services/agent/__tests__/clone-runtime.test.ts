import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { CloneRuntime } from '../clone-runtime'
import type { CloneDef } from '@octopus/shared'
import { initDb, closeDb, getDb } from '../../../db/connection'
import { EvolutionDAO } from '../../../db/dao'
import { ContextEnricher } from '../context-enricher'
import type { ExperienceRowV2 } from '../../../db/types'

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

  // ── assembleContextWithExperience (ticket 04) ──────────────────

  describe('assembleContextWithExperience', () => {
    const TEST_ORG = 'test-clone-enricher-org'

    function makeV2Row(overrides: Partial<ExperienceRowV2> = {}): Omit<ExperienceRowV2, 'id'> {
      return {
        skill_name: 'test-skill',
        content: 'test experience content',
        source_session_id: null,
        org: TEST_ORG,
        created_at: '2026-08-10T00:00:00.000Z',
        scope: 'agent',
        scope_ref: null,
        pattern_tags: '["fix_and_retry"]',
        outcome: JSON.stringify({ label: 'success' }),
        source_type: 'session',
        execution_id: null,
        node_id: null,
        ...overrides,
      }
    }

    let dao: EvolutionDAO
    let enricher: ContextEnricher

    beforeEach(() => {
      initDb(':memory:')
      dao = new EvolutionDAO(getDb())
      enricher = new ContextEnricher(dao)
    })

    afterEach(() => {
      closeDb()
    })

    it('appends experience segment after memory when relevant experiences exist', async () => {
      // Arrange: content contains the full query as substring (for LIKE fallback)
      dao.insertExperienceV2(makeV2Row({
        content: 'context: 之前 fixit deployment failure caused by config error',
        scope: 'agent',
      }))

      const cloneDef = createTestCloneDef()
      const runtime = new CloneRuntime(cloneDef, TEST_ORG, undefined, enricher)

      // Act: "之前" triggers search; query "之前 fixit" is a substring of content
      const context = await runtime.assembleContextWithExperience('之前 fixit')

      // Assert: context includes persona AND experience segment
      expect(context).toContain('Test persona for workspace clone')
      expect(context).toContain('相关历史经验')
      expect(context).toContain('config error')
    })

    it('uses scope=agent so only agent + global experiences are visible', async () => {
      // Arrange: each row's content contains the query "之前 scopefix" as substring
      dao.insertExperienceV2(makeV2Row({
        content: '之前 scopefix agent-scope deployment data',
        scope: 'agent',
      }))
      dao.insertExperienceV2(makeV2Row({
        content: '之前 scopefix global-scope deployment practice',
        scope: 'global',
      }))
      dao.insertExperienceV2(makeV2Row({
        content: '之前 scopefix harness-scope deployment intervention',
        scope: 'harness',
      }))

      const cloneDef = createTestCloneDef()
      const runtime = new CloneRuntime(cloneDef, TEST_ORG, undefined, enricher)

      // Act: "之前" triggers search; full query is substring of all 3 rows via LIKE
      const context = await runtime.assembleContextWithExperience('之前 scopefix')

      // Assert: sees agent + global, NOT harness (scope isolation)
      expect(context).toContain('agent-scope')
      expect(context).toContain('global-scope')
      expect(context).not.toContain('harness-scope')
    })

    it('does not add experience segment when no relevant experiences found', async () => {
      // Arrange: no experiences in DB
      const cloneDef = createTestCloneDef()
      const runtime = new CloneRuntime(cloneDef, TEST_ORG, undefined, enricher)

      // Act: message has trigger keyword but no matching data
      const context = await runtime.assembleContextWithExperience('之前部署的经验')

      // Assert: base context is returned without experience segment
      expect(context).toContain('Test persona for workspace clone')
      expect(context).not.toContain('相关历史经验')
    })

    it('does not search when message has no trigger keywords (null segment)', async () => {
      // Arrange: insert experience but message doesn't trigger
      dao.insertExperienceV2(makeV2Row({
        content: 'deployment experience data',
        scope: 'agent',
      }))

      const cloneDef = createTestCloneDef()
      const runtime = new CloneRuntime(cloneDef, TEST_ORG, undefined, enricher)

      // Act: no trigger keyword in message
      const context = await runtime.assembleContextWithExperience('帮我创建一个新文件')

      // Assert: no experience segment (keyword not matched → skipped)
      expect(context).not.toContain('相关历史经验')
    })

    it('uses 800 token budget for experience enrichment', async () => {
      // Arrange: content contains the query as substring
      for (let i = 0; i < 7; i++) {
        dao.insertExperienceV2(makeV2Row({
          content: `之前 budgetfix experience item ${i} with enough content to consume tokens in the 800 token budget calculation process with additional padding text here to make it longer`,
          scope: 'agent',
          created_at: `2026-08-${String(10 - i).padStart(2, '0')}T00:00:00.000Z`,
        }))
      }

      const cloneDef = createTestCloneDef()
      const runtime = new CloneRuntime(cloneDef, TEST_ORG, undefined, enricher)

      // Act: "之前" triggers search; full query is substring of content via LIKE
      const result = await runtime.assembleContextWithExperience('之前 budgetfix')

      // Assert: budget of 800 tokens should truncate results
      expect(result).toContain('Test persona for workspace clone')
      const match = result.match(/相关历史经验 \((\d+)条\)/)
      if (match) {
        const count = parseInt(match[1])
        expect(count).toBeLessThanOrEqual(5) // max 5 from DAO limit
      }
    })

    it('works without enricher (backward compat — no experience injected)', async () => {
      // Arrange: no enricher provided
      const cloneDef = createTestCloneDef()
      const runtime = new CloneRuntime(cloneDef, TEST_ORG)

      // Act: call assembleContextWithExperience — should gracefully skip enrichment
      const context = await runtime.assembleContextWithExperience('之前部署失败是怎么解决的')

      // Assert: base context returned, no experience segment
      expect(context).toContain('Test persona for workspace clone')
      expect(context).not.toContain('相关历史经验')
    })

    it('sync assembleContext still works unchanged (backward compat)', () => {
      // Arrange
      const cloneDef = createTestCloneDef()
      const runtime = new CloneRuntime(cloneDef, 'test-org')

      // Act: sync call without experience
      const context = runtime.assembleContext()

      // Assert: persona is present, no experience segment
      expect(context).toContain('Test persona for workspace clone')
      expect(context).not.toContain('相关历史经验')
    })
  })
})
