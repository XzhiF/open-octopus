// P1 B1: AgentVersionDAO/AgentVersionService 已 postgres.js/async —— 原 :memory: +
// 手工 DDL fixture 切 PG 随机测试库（applyPgSchema 统一建表；clones.current_version_id
// 已正式进 PG DDL，见 db/pg/schema.sql）。用例语义与条数逐条不变；
// 抛错断言 toThrow → rejects.toThrow（async 化后的同判据形态）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import {
  filesToSnapshot,
  snapshotToFiles,
  AgentVersionService,
} from '../services/agent/agent-version-service'
import { AgentVersionDAO } from '../db/dao/agent-version-dao'
import { describePg, setupPgSchema, type PgFixture } from '../db/pg/__tests__/dao-fixture'

// ── Test helpers ──────────────────────────────────────────────────

const TEST_DIR = path.join(os.tmpdir(), `agent-version-test-${Date.now()}`)

function setOctopusHome(): void {
  process.env.OCTOPUS_HOME = TEST_DIR
}

function createTestClone(name: string): string {
  const cloneDir = path.join(TEST_DIR, 'agent', 'clones', name)
  fs.mkdirSync(cloneDir, { recursive: true })
  fs.mkdirSync(path.join(cloneDir, 'skills'), { recursive: true })

  fs.writeFileSync(
    path.join(cloneDir, 'persona.md'),
    `# ${name}\n\nTest persona for ${name}`,
    'utf-8',
  )

  fs.writeFileSync(
    path.join(cloneDir, 'config.json'),
    JSON.stringify({
      name,
      display_name: `Test ${name}`,
      type: 'user',
      skills: [],
      memoryScope: 'isolated',
    }, null, 2),
    'utf-8',
  )

  // Create a test skill file
  fs.writeFileSync(
    path.join(cloneDir, 'skills', 'test-skill.md'),
    '# Test Skill\n\nTest content',
    'utf-8',
  )

  return cloneDir
}

async function setupTestDb(): Promise<PgFixture> {
  const pg = await setupPgSchema()
  // 旧 fixture 的 test-clone 行等价物（timestamptz 用 now()，jsonb 用字面量）
  await pg.sql.unsafe(`
    INSERT INTO clones (name, org, type, status, persona, skills, workspace_ref, memory_scope, created_at, updated_at)
    VALUES ($1, 'default', 'user', 'active', '', '[]'::jsonb, '{}'::jsonb, 'isolated', now(), now())
  `, ['test-clone'])
  return pg
}

// ── Tests ─────────────────────────────────────────────────────────

describePg('AgentVersionService', () => {
  let pg: PgFixture
  let dao: AgentVersionDAO
  let service: AgentVersionService

  beforeEach(async () => {
    setOctopusHome()
    fs.mkdirSync(path.join(TEST_DIR, 'agent', 'clones'), { recursive: true })
    fs.mkdirSync(path.join(TEST_DIR, 'agent', 'versions'), { recursive: true })
    fs.mkdirSync(path.join(TEST_DIR, 'agent', 'skills'), { recursive: true })

    pg = await setupTestDb()
    dao = new AgentVersionDAO(pg.sql)
    service = new AgentVersionService(dao)
  })

  afterEach(async () => {
    delete process.env.OCTOPUS_HOME
    try {
      await pg.close()
    } catch {
      // Non-fatal
    }
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true })
    } catch {
      // Cleanup failure is non-fatal in tests
    }
  })

  describe('filesToSnapshot', () => {
    it('reads persona, config, and skills from clone directory', () => {
      const cloneDir = createTestClone('test-clone')
      const snapshot = filesToSnapshot(cloneDir)

      expect(snapshot.persona).toContain('test-clone')
      expect(snapshot.config).toHaveProperty('name', 'test-clone')
      expect(snapshot.skills).toContain('test-skill.md')
    })

    it('returns empty defaults for missing files', () => {
      const emptyDir = path.join(TEST_DIR, 'empty-clone')
      fs.mkdirSync(emptyDir, { recursive: true })

      const snapshot = filesToSnapshot(emptyDir)

      expect(snapshot.persona).toBe('')
      expect(snapshot.config).toEqual({})
      expect(snapshot.skills).toEqual([])
    })
  })

  describe('snapshotToFiles', () => {
    it('writes persona, config, and skills to target directory', () => {
      const targetDir = path.join(TEST_DIR, 'snapshot-output')
      const snapshot = {
        persona: '# Test\n\nTest persona',
        config: { name: 'test', type: 'user' },
        skills: [],
      }

      snapshotToFiles(snapshot, targetDir)

      expect(fs.existsSync(path.join(targetDir, 'persona.md'))).toBe(true)
      expect(fs.existsSync(path.join(targetDir, 'config.json'))).toBe(true)
      expect(fs.readFileSync(path.join(targetDir, 'persona.md'), 'utf-8')).toBe('# Test\n\nTest persona')
      expect(JSON.parse(fs.readFileSync(path.join(targetDir, 'config.json'), 'utf-8'))).toEqual({ name: 'test', type: 'user' })
    })
  })

  describe('publish', () => {
    it('creates a version with DB + FS dual write', async () => {
      createTestClone('test-clone')

      const version = await service.publish('test-clone', {
        version: '1.0.0',
        stage: 'stable',
        changelog: 'Initial release',
      })

      expect(version.agent_name).toBe('test-clone')
      expect(version.version).toBe('1.0.0')
      expect(version.major).toBe(1)
      expect(version.minor).toBe(0)
      expect(version.patch).toBe(0)
      expect(version.stage).toBe('stable')
      expect(version.status).toBe('published')

      // Verify FS write
      const versionDir = path.join(TEST_DIR, 'agent', 'versions', 'test-clone', '1.0.0')
      expect(fs.existsSync(versionDir)).toBe(true)
      expect(fs.existsSync(path.join(versionDir, 'persona.md'))).toBe(true)
      expect(fs.existsSync(path.join(versionDir, 'config.json'))).toBe(true)
    })

    it('rejects duplicate version numbers', async () => {
      createTestClone('test-clone')

      await service.publish('test-clone', { version: '1.0.0' })

      await expect(async () => {
        await service.publish('test-clone', { version: '1.0.0' })
      }).rejects.toThrow('already exists')
    })

    it('rejects invalid version format', async () => {
      createTestClone('test-clone')

      await expect(async () => {
        await service.publish('test-clone', { version: 'invalid' })
      }).rejects.toThrow('Invalid version format')
    })

    it('parses Maven-style version with stage qualifier', async () => {
      createTestClone('test-clone')

      const version = await service.publish('test-clone', {
        version: '1.2.0-beta.1',
      })

      expect(version.major).toBe(1)
      expect(version.minor).toBe(2)
      expect(version.patch).toBe(0)
      expect(version.stage).toBe('beta.1')
    })

    it('throws when clone directory does not exist', async () => {
      await expect(async () => {
        await service.publish('nonexistent', { version: '1.0.0' })
      }).rejects.toThrow('not found')
    })
  })

  describe('list', () => {
    it('returns versions for an agent', async () => {
      createTestClone('test-clone')

      await service.publish('test-clone', { version: '1.0.0', changelog: 'v1' })
      await service.publish('test-clone', { version: '1.1.0', changelog: 'v1.1' })

      const result = await service.list('test-clone')

      expect(result.versions).toHaveLength(2)
      expect(result.total).toBe(2)
    })

    it('filters by status', async () => {
      createTestClone('test-clone')

      await service.publish('test-clone', { version: '1.0.0' })
      await service.archive('test-clone', '1.0.0')
      await service.publish('test-clone', { version: '1.1.0' })

      const published = await service.list('test-clone', { status: 'published' })
      expect(published.versions).toHaveLength(1)
      expect(published.versions[0].version).toBe('1.1.0')

      const archived = await service.list('test-clone', { status: 'archived' })
      expect(archived.versions).toHaveLength(1)
      expect(archived.versions[0].version).toBe('1.0.0')
    })
  })

  describe('get', () => {
    it('returns a specific version', async () => {
      createTestClone('test-clone')
      await service.publish('test-clone', { version: '1.0.0', changelog: 'first' })

      const version = await service.get('test-clone', '1.0.0')

      expect(version).not.toBeNull()
      expect(version!.version).toBe('1.0.0')
      expect(version!.changelog).toBe('first')
    })

    it('returns null for nonexistent version', async () => {
      const version = await service.get('test-clone', '9.9.9')
      expect(version).toBeNull()
    })
  })

  describe('diff', () => {
    it('compares two versions', async () => {
      createTestClone('test-clone')
      await service.publish('test-clone', { version: '1.0.0' })

      // Modify clone and publish v2
      const cloneDir = path.join(TEST_DIR, 'agent', 'clones', 'test-clone')
      fs.writeFileSync(
        path.join(cloneDir, 'persona.md'),
        '# Updated persona\n\nNew content',
        'utf-8',
      )
      await service.publish('test-clone', { version: '1.1.0' })

      const diff = await service.diff('test-clone', '1.0.0', '1.1.0')

      expect(diff.persona_diff.from).toContain('test-clone')
      expect(diff.persona_diff.to).toContain('Updated persona')
      expect(diff.skills_diff).toHaveProperty('added')
      expect(diff.skills_diff).toHaveProperty('removed')
      expect(diff.skills_diff).toHaveProperty('unchanged')
    })

    it('throws when version not found', async () => {
      createTestClone('test-clone')
      await service.publish('test-clone', { version: '1.0.0' })

      await expect(async () => {
        await service.diff('test-clone', '1.0.0', '9.9.9')
      }).rejects.toThrow('not found')
    })
  })

  describe('archive', () => {
    it('sets status to archived', async () => {
      createTestClone('test-clone')
      await service.publish('test-clone', { version: '1.0.0' })

      const archived = await service.archive('test-clone', '1.0.0')
      expect(archived.status).toBe('archived')
    })

    it('throws when already archived', async () => {
      createTestClone('test-clone')
      await service.publish('test-clone', { version: '1.0.0' })
      await service.archive('test-clone', '1.0.0')

      await expect(async () => {
        await service.archive('test-clone', '1.0.0')
      }).rejects.toThrow('already archived')
    })
  })

  describe('rollback', () => {
    it('restores clone directory to target version snapshot', async () => {
      createTestClone('test-clone')
      await service.publish('test-clone', { version: '1.0.0', changelog: 'original' })

      // Modify clone
      const cloneDir = path.join(TEST_DIR, 'agent', 'clones', 'test-clone')
      fs.writeFileSync(
        path.join(cloneDir, 'persona.md'),
        '# Modified\n\nChanged persona',
        'utf-8',
      )

      // Rollback to v1.0.0
      const result = await service.rollback('test-clone', '1.0.0')

      expect(result.success).toBe(true)

      // Verify clone directory is restored
      const restoredPersona = fs.readFileSync(
        path.join(cloneDir, 'persona.md'),
        'utf-8',
      )
      expect(restoredPersona).toContain('test-clone')
      expect(restoredPersona).not.toContain('Modified')
    })

    it('throws when target version not found', async () => {
      createTestClone('test-clone')

      await expect(async () => {
        await service.rollback('test-clone', '9.9.9')
      }).rejects.toThrow('not found')
    })

    it('throws when target version is archived', async () => {
      createTestClone('test-clone')
      await service.publish('test-clone', { version: '1.0.0' })
      await service.archive('test-clone', '1.0.0')

      await expect(async () => {
        await service.rollback('test-clone', '1.0.0')
      }).rejects.toThrow('Cannot rollback')
    })
  })
})

describePg('AgentVersionDAO', () => {
  let pg: PgFixture
  let dao: AgentVersionDAO

  beforeEach(async () => {
    pg = await setupTestDb()
    dao = new AgentVersionDAO(pg.sql)
  })

  afterEach(async () => {
    try { await pg.close() } catch { /* non-fatal */ }
  })

  describe('findLatestPublished', () => {
    it('returns the latest published stable version', async () => {
      const now = new Date().toISOString()
      await dao.insert({
        id: 'v1', agent_name: 'test-clone', version: '1.0.0',
        major: 1, minor: 0, patch: 0, stage: 'stable', status: 'published',
        snapshot: '{}', changelog: null, published_at: now, published_by: null, created_at: now,
      })
      await dao.insert({
        id: 'v2', agent_name: 'test-clone', version: '1.1.0',
        major: 1, minor: 1, patch: 0, stage: 'stable', status: 'published',
        snapshot: '{}', changelog: null, published_at: now, published_by: null, created_at: now,
      })

      const latest = await dao.findLatestPublished('test-clone')
      expect(latest).not.toBeNull()
      expect(latest!.version).toBe('1.1.0')
    })

    it('filters by minimum stage', async () => {
      const now = new Date().toISOString()
      await dao.insert({
        id: 'v1', agent_name: 'test-clone', version: '1.0.0-alpha',
        major: 1, minor: 0, patch: 0, stage: 'alpha', status: 'published',
        snapshot: '{}', changelog: null, published_at: now, published_by: null, created_at: now,
      })
      await dao.insert({
        id: 'v2', agent_name: 'test-clone', version: '1.0.0',
        major: 1, minor: 0, patch: 0, stage: 'stable', status: 'published',
        snapshot: '{}', changelog: null, published_at: now, published_by: null, created_at: now,
      })

      const latest = await dao.findLatestPublished('test-clone', 'stable')
      expect(latest).not.toBeNull()
      expect(latest!.stage).toBe('stable')
    })

    it('returns null when no published versions exist', async () => {
      const latest = await dao.findLatestPublished('test-clone')
      expect(latest).toBeNull()
    })
  })
})
