import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import {
  resolveCloneInfo,
  listAllClones,
  createUserClone,
  deleteUserClone,
  isValidCloneName,
} from '../services/agent/clone-resolver'

// ── Test helpers ──────────────────────────────────────────────────

const TEST_DIR = path.join(os.tmpdir(), `clone-api-test-${Date.now()}`)

function setOctopusHome(): void {
  process.env.OCTOPUS_HOME = TEST_DIR
}

// ── Tests ─────────────────────────────────────────────────────────

describe('Clone Resolver', () => {
  beforeEach(() => {
    setOctopusHome()
    // Create test directory structure
    fs.mkdirSync(path.join(TEST_DIR, 'agent', 'built-in', 'workspace'), { recursive: true })
    fs.mkdirSync(path.join(TEST_DIR, 'agent', 'built-in', 'scheduler'), { recursive: true })
    fs.mkdirSync(path.join(TEST_DIR, 'agent', 'built-in', 'archive'), { recursive: true })
    fs.mkdirSync(path.join(TEST_DIR, 'agent', 'built-in', 'resource'), { recursive: true })
    fs.mkdirSync(path.join(TEST_DIR, 'agent', 'clones'), { recursive: true })

    // Write config.json for built-in clones
    for (const [name, displayName] of [
      ['workspace', '全栈开发助手'],
      ['scheduler', '定时任务管理'],
      ['archive', '工程分析师'],
      ['resource', '资源操作专家'],
    ]) {
      fs.writeFileSync(
        path.join(TEST_DIR, 'agent', 'built-in', name, 'config.json'),
        JSON.stringify({ name, display_name: displayName, type: 'built-in', skills: [], memoryScope: 'shared' }),
        'utf-8',
      )
      fs.writeFileSync(
        path.join(TEST_DIR, 'agent', 'built-in', name, 'persona.md'),
        `# ${displayName}\n\nTest persona for ${name}`,
        'utf-8',
      )
    }
  })

  afterEach(() => {
    delete process.env.OCTOPUS_HOME
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true })
    } catch {
      // Cleanup failure is non-fatal in tests
    }
  })

  describe('isValidCloneName', () => {
    it('accepts lowercase alphanumeric with hyphens', () => {
      expect(isValidCloneName('my-clone')).toBe(true)
      expect(isValidCloneName('workspace')).toBe(true)
      expect(isValidCloneName('clone123')).toBe(true)
    })

    it('rejects uppercase, spaces, and special chars', () => {
      expect(isValidCloneName('MyClone')).toBe(false)
      expect(isValidCloneName('my clone')).toBe(false)
      expect(isValidCloneName('my_clone')).toBe(false)
      expect(isValidCloneName('')).toBe(false)
    })

    it('rejects names longer than 50 chars', () => {
      expect(isValidCloneName('a'.repeat(51))).toBe(false)
      expect(isValidCloneName('a'.repeat(50))).toBe(true)
    })
  })

  describe('resolveCloneInfo', () => {
    it('resolves built-in clone from filesystem', () => {
      const info = resolveCloneInfo('workspace')
      expect(info).not.toBeNull()
      expect(info!.name).toBe('workspace')
      expect(info!.display_name).toBe('全栈开发助手')
      expect(info!.type).toBe('built-in')
      expect(info!.persona).toContain('Test persona for workspace')
    })

    it('resolves user clone from filesystem', () => {
      // Create a user clone
      const cloneDir = path.join(TEST_DIR, 'agent', 'clones', 'my-clone')
      fs.mkdirSync(cloneDir, { recursive: true })
      fs.writeFileSync(
        path.join(cloneDir, 'config.json'),
        JSON.stringify({ name: 'my-clone', display_name: '我的分身', type: 'user', skills: [], memoryScope: 'isolated' }),
        'utf-8',
      )
      fs.writeFileSync(path.join(cloneDir, 'persona.md'), '# My Clone\n\nCustom persona', 'utf-8')

      const info = resolveCloneInfo('my-clone')
      expect(info).not.toBeNull()
      expect(info!.name).toBe('my-clone')
      expect(info!.display_name).toBe('我的分身')
      expect(info!.type).toBe('user')
    })

    it('returns null for nonexistent clone', () => {
      expect(resolveCloneInfo('nonexistent')).toBeNull()
    })
  })

  describe('listAllClones', () => {
    it('lists built-in clones', () => {
      const clones = listAllClones()
      expect(clones.length).toBeGreaterThanOrEqual(4)
      const names = clones.map(c => c.name)
      expect(names).toContain('workspace')
      expect(names).toContain('scheduler')
      expect(names).toContain('archive')
      expect(names).toContain('resource')
    })

    it('includes user clones', () => {
      // Create a user clone
      createUserClone({
        name: 'test-clone',
        display_name: '测试分身',
        persona: 'Test persona',
      })

      const clones = listAllClones()
      expect(clones.length).toBeGreaterThanOrEqual(5)
      const testClone = clones.find(c => c.name === 'test-clone')
      expect(testClone).toBeDefined()
      expect(testClone!.display_name).toBe('测试分身')
      expect(testClone!.type).toBe('user')
    })
  })

  describe('createUserClone', () => {
    it('creates a user clone with display_name', () => {
      const result = createUserClone({
        name: 'new-clone',
        display_name: '新分身',
        persona: 'You are a helpful assistant',
        skills: ['skill-a'],
        memory_scope: 'isolated',
      })

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.clone.name).toBe('new-clone')
        expect(result.clone.display_name).toBe('新分身')
        expect(result.clone.type).toBe('user')
        expect(result.clone.skills).toEqual(['skill-a'])
      }

      // Verify files exist
      const cloneDir = path.join(TEST_DIR, 'agent', 'clones', 'new-clone')
      expect(fs.existsSync(path.join(cloneDir, 'config.json'))).toBe(true)
      expect(fs.existsSync(path.join(cloneDir, 'persona.md'))).toBe(true)
    })

    it('creates clone without skills (skills optional)', () => {
      const result = createUserClone({
        name: 'no-skill-clone',
        display_name: '无技能分身',
        persona: 'Simple persona',
      })

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.clone.skills).toEqual([])
      }
    })

    it('rejects duplicate clone names', () => {
      createUserClone({ name: 'dup-clone', display_name: 'Dup', persona: 'test' })
      const result = createUserClone({ name: 'dup-clone', display_name: 'Dup2', persona: 'test2' })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('already exists')
      }
    })

    it('rejects built-in clone names', () => {
      const result = createUserClone({ name: 'workspace', display_name: 'Dup', persona: 'test' })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('built-in')
      }
    })

    it('rejects invalid names', () => {
      const result = createUserClone({ name: 'INVALID', display_name: 'Bad', persona: 'test' })
      expect(result.ok).toBe(false)
    })
  })

  describe('deleteUserClone', () => {
    it('deletes a user clone', () => {
      createUserClone({ name: 'del-clone', display_name: 'Del', persona: 'test' })
      const result = deleteUserClone('del-clone')
      expect(result.ok).toBe(true)
      expect(fs.existsSync(path.join(TEST_DIR, 'agent', 'clones', 'del-clone'))).toBe(false)
    })

    it('rejects deletion of built-in clones', () => {
      const result = deleteUserClone('workspace')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.status).toBe(403)
      }
    })

    it('returns 404 for nonexistent clone', () => {
      const result = deleteUserClone('nonexistent')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.status).toBe(404)
      }
    })
  })
})
