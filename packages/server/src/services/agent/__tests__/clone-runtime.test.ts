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

  describe('loadSkills (two-tier model)', () => {
    it('scans shared skills from agent/skills directory', () => {
      // Create shared skill
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

      expect(context).toContain('octo-agent-memory')
      expect(context).toContain('Search and manage agent memory layers')
      expect(context).toContain('Shared:')
    })

    it('scans clone-specific skills from built-in clone directory', () => {
      // Create clone skill
      const cloneSkillDir = path.join(TEST_DIR, 'agent', 'built-in', 'scheduler', 'skills', 'octo-scheduler')
      fs.mkdirSync(cloneSkillDir, { recursive: true })
      fs.writeFileSync(
        path.join(cloneSkillDir, 'SKILL.md'),
        '---\nname: octo-scheduler\n---\nOctopus Scheduler API helper.',
        'utf-8',
      )

      const cloneDef = createTestCloneDef({
        name: 'scheduler',
        skills: ['octo-scheduler'],
      })
      const runtime = new CloneRuntime(cloneDef, 'test-org')
      const context = runtime.assembleContext()

      expect(context).toContain('octo-scheduler')
      expect(context).toContain('Octopus Scheduler API helper')
      expect(context).toContain('Clone:')
    })

    it('clone skills override shared skills with same name', () => {
      // Create shared skill
      const sharedSkillDir = path.join(TEST_DIR, 'agent', 'skills', 'octo-scheduler')
      fs.mkdirSync(sharedSkillDir, { recursive: true })
      fs.writeFileSync(
        path.join(sharedSkillDir, 'SKILL.md'),
        '---\nname: octo-scheduler\n---\nShared version of scheduler.',
        'utf-8',
      )

      // Create clone skill (same name)
      const cloneSkillDir = path.join(TEST_DIR, 'agent', 'built-in', 'scheduler', 'skills', 'octo-scheduler')
      fs.mkdirSync(cloneSkillDir, { recursive: true })
      fs.writeFileSync(
        path.join(cloneSkillDir, 'SKILL.md'),
        '---\nname: octo-scheduler\n---\nClone-specific version of scheduler.',
        'utf-8',
      )

      const cloneDef = createTestCloneDef({
        name: 'scheduler',
        skills: ['octo-scheduler'],
      })
      const runtime = new CloneRuntime(cloneDef, 'test-org')
      const context = runtime.assembleContext()

      // Clone version should appear
      expect(context).toContain('Clone-specific version of scheduler')
      // Shared version should NOT appear (clone wins)
      expect(context).not.toContain('Shared version of scheduler')
    })

    it('filters skills by cloneDef.skills whitelist', () => {
      // Create multiple shared skills
      const skill1Dir = path.join(TEST_DIR, 'agent', 'skills', 'octo-alpha')
      fs.mkdirSync(skill1Dir, { recursive: true })
      fs.writeFileSync(path.join(skill1Dir, 'SKILL.md'), '---\n---\nAlpha skill.', 'utf-8')

      const skill2Dir = path.join(TEST_DIR, 'agent', 'skills', 'octo-beta')
      fs.mkdirSync(skill2Dir, { recursive: true })
      fs.writeFileSync(path.join(skill2Dir, 'SKILL.md'), '---\n---\nBeta skill.', 'utf-8')

      // Filter to only alpha
      const cloneDef = createTestCloneDef({ skills: ['octo-alpha'] })
      const runtime = new CloneRuntime(cloneDef, 'test-org')
      const context = runtime.assembleContext()

      expect(context).toContain('octo-alpha')
      expect(context).toContain('Alpha skill')
      expect(context).not.toContain('octo-beta')
      expect(context).not.toContain('Beta skill')
    })

    it('empty skills array includes all found skills (no filtering)', () => {
      // Create multiple shared skills
      const skill1Dir = path.join(TEST_DIR, 'agent', 'skills', 'octo-alpha')
      fs.mkdirSync(skill1Dir, { recursive: true })
      fs.writeFileSync(path.join(skill1Dir, 'SKILL.md'), '---\n---\nAlpha skill.', 'utf-8')

      const skill2Dir = path.join(TEST_DIR, 'agent', 'skills', 'octo-beta')
      fs.mkdirSync(skill2Dir, { recursive: true })
      fs.writeFileSync(path.join(skill2Dir, 'SKILL.md'), '---\n---\nBeta skill.', 'utf-8')

      const cloneDef = createTestCloneDef({ skills: [] })
      const runtime = new CloneRuntime(cloneDef, 'test-org')
      const context = runtime.assembleContext()

      expect(context).toContain('octo-alpha')
      expect(context).toContain('octo-beta')
    })

    it('output includes base directory declaration', () => {
      const sharedSkillDir = path.join(TEST_DIR, 'agent', 'skills', 'octo-test')
      fs.mkdirSync(sharedSkillDir, { recursive: true })
      fs.writeFileSync(path.join(sharedSkillDir, 'SKILL.md'), '---\n---\nTest skill.', 'utf-8')

      const cloneDef = createTestCloneDef({ skills: [] })
      const runtime = new CloneRuntime(cloneDef, 'test-org')
      const context = runtime.assembleContext()

      expect(context).toContain('# Available Skills')
      expect(context).toContain('Read tool')
      expect(context).toContain('{base_directory}/{skill_name}/SKILL.md')
    })

    it('returns empty skills section when no skills found', () => {
      const cloneDef = createTestCloneDef({ skills: [] })
      const runtime = new CloneRuntime(cloneDef, 'test-org')
      const context = runtime.assembleContext()

      // Skills section should not appear at all
      expect(context).not.toContain('# Available Skills')
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
})
