/**
 * MemoryService Unit Tests
 * Tests memory operations: read/write, search, token estimation, conflict detection.
 * Maps to PRD P2.2 (memory CRUD), C3 (search), C4 (work memory).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import path from 'path'
import os from 'os'

// Isolated temp directory for this test suite
const MOCK_AGENT_DIR = vi.hoisted(() => {
  const p = require('path') as typeof import('path')
  const o = require('os') as typeof import('os')
  return p.join(o.tmpdir(), `octopus-test-memory-${process.pid}`)
})

vi.mock('../services/agent/paths', async () => {
  const p = require('path') as typeof import('path')
  const actual = await vi.importActual<typeof import('../services/agent/paths')>('../services/agent/paths')
  return {
    ...actual,
    getAgentDir: () => MOCK_AGENT_DIR,
    getAgentMemoryDir: () => p.join(MOCK_AGENT_DIR, 'memory'),
    getClonesDir: () => p.join(MOCK_AGENT_DIR, 'clones'),
    getCloneDir: (name: string) => p.join(MOCK_AGENT_DIR, 'clones', name),
    getAgentSkillsDir: () => p.join(MOCK_AGENT_DIR, 'skills'),
    getPersonaPath: () => p.join(MOCK_AGENT_DIR, 'persona.md'),
    getAgentConfigPath: () => p.join(MOCK_AGENT_DIR, 'config.yaml'),
    getReportsDir: () => p.join(MOCK_AGENT_DIR, 'reports'),
    getDebugTracesDir: () => p.join(MOCK_AGENT_DIR, 'debug', 'traces'),
    getExperiencesDir: () => p.join(MOCK_AGENT_DIR, 'evolution', 'experiences'),
    getDailyMemoryDir: () => p.join(MOCK_AGENT_DIR, 'memory', 'daily'),
    getLongTermMemoryPath: () => p.join(MOCK_AGENT_DIR, 'memory', 'long-term.md'),
    getNotificationQueueDir: () => p.join(MOCK_AGENT_DIR, 'notification-queue'),
    getOctopusHome: () => p.dirname(MOCK_AGENT_DIR),
  }
})

import fs from 'fs'
import { MemoryService, getMemoryService, initMemoryService } from '../services/agent/memory-service'
import { getAgentMemoryDir } from '../services/agent/paths'
import { initDb, closeDb, getDb } from '../db/connection'
import { AgentSessionDAO } from '../db/dao'

const TEST_ORG = 'test-mem-org'

describe('MemoryService', () => {
  let service: MemoryService
  const memDir = getAgentMemoryDir()

  beforeEach(() => {
    initDb(':memory:')
    service = initMemoryService(new AgentSessionDAO(getDb()))
    // Ensure clean test directory
    if (fs.existsSync(MOCK_AGENT_DIR)) {
      fs.rmSync(MOCK_AGENT_DIR, { recursive: true, force: true })
    }
    fs.mkdirSync(memDir, { recursive: true })
  })

  afterEach(async () => {
    // Cleanup test files — remove the entire mock agent directory
    if (fs.existsSync(MOCK_AGENT_DIR)) {
      fs.rmSync(MOCK_AGENT_DIR, { recursive: true, force: true })
    }
  })

  // ── readMemory ───────────────────────────────────────────────

  describe('readMemory', () => {
    it('returns empty content when file does not exist', () => {
      const result = service.readMemory(TEST_ORG, 'long-term')
      expect(result.content).toBe('')
      expect(result.layer).toBe('long-term')
      expect(result.token_count).toBe(0)
    })

    it('reads existing long-term memory file', () => {
      const longTermDir = path.join(memDir, 'long-term.md')
      fs.writeFileSync(longTermDir, '# Long term memory\nTest content', 'utf-8')

      const result = service.readMemory(TEST_ORG, 'long-term')
      expect(result.content).toContain('Long term memory')
      expect(result.token_count).toBeGreaterThan(0)
      expect(result.last_modified).toBeTruthy()
    })

    it('reads daily memory for today', () => {
      const today = new Date().toISOString().split('T')[0]
      const dailyDir = path.join(memDir, 'daily')
      fs.mkdirSync(dailyDir, { recursive: true })
      fs.writeFileSync(path.join(dailyDir, `${today}.md`), 'Daily test', 'utf-8')

      const result = service.readMemory(TEST_ORG, 'daily')
      expect(result.content).toBe('Daily test')
    })

    it('reads session memory file', () => {
      fs.writeFileSync(path.join(memDir, 'session-memory.md'), 'Session data', 'utf-8')

      const result = service.readMemory(TEST_ORG, 'session')
      expect(result.content).toBe('Session data')
    })
  })

  // ── writeMemory ──────────────────────────────────────────────

  describe('writeMemory', () => {
    it('writes content to long-term memory', () => {
      const result = service.writeMemory(TEST_ORG, 'long-term', 'New memory content')
      expect(result.ok).toBe(true)
      expect(result.token_count).toBeGreaterThan(0)

      const filePath = path.join(memDir, 'long-term.md')
      expect(fs.existsSync(filePath)).toBe(true)
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('New memory content')
    })

    it('creates directory structure if missing', () => {
      if (fs.existsSync(MOCK_AGENT_DIR)) {
        fs.rmSync(MOCK_AGENT_DIR, { recursive: true, force: true })
      }

      const result = service.writeMemory(TEST_ORG, 'long-term', 'Content')
      expect(result.ok).toBe(true)
      expect(fs.existsSync(path.join(memDir, 'long-term.md'))).toBe(true)
    })
  })

  // ── appendDaily ──────────────────────────────────────────────

  describe('appendDaily', () => {
    it('appends timestamped entry to today\'s daily file', () => {
      const result = service.appendDaily(TEST_ORG, 'Test entry')
      expect(result.ok).toBe(true)

      const today = new Date().toISOString().split('T')[0]
      const filePath = path.join(memDir, 'daily', `${today}.md`)
      expect(fs.existsSync(filePath)).toBe(true)

      const content = fs.readFileSync(filePath, 'utf-8')
      expect(content).toContain('Test entry')
    })

    it('appends to existing content', () => {
      service.appendDaily(TEST_ORG, 'First entry')
      service.appendDaily(TEST_ORG, 'Second entry')

      const today = new Date().toISOString().split('T')[0]
      const content = fs.readFileSync(path.join(memDir, 'daily', `${today}.md`), 'utf-8')
      expect(content).toContain('First entry')
      expect(content).toContain('Second entry')
    })
  })

  // ── readRecentWorkMemory ─────────────────────────────────────

  describe('readRecentWorkMemory', () => {
    it('returns empty string when no daily files exist', () => {
      const result = service.readRecentWorkMemory(TEST_ORG, 3)
      expect(result).toBe('')
    })

    it('reads daily files from last N days', () => {
      const dailyDir = path.join(memDir, 'daily')
      fs.mkdirSync(dailyDir, { recursive: true })

      // Create files for recent days
      const today = new Date()
      for (let i = 0; i < 3; i++) {
        const date = new Date(today)
        date.setDate(date.getDate() - i)
        const dateStr = date.toISOString().split('T')[0]
        fs.writeFileSync(path.join(dailyDir, `${dateStr}.md`), `Day ${i} content`, 'utf-8')
      }

      const result = service.readRecentWorkMemory(TEST_ORG, 3)
      expect(result).toContain('Day 0 content')
      expect(result).toContain('Day 1 content')
      expect(result).toContain('Day 2 content')
    })

    it('limits to requested number of days', () => {
      const dailyDir = path.join(memDir, 'daily')
      fs.mkdirSync(dailyDir, { recursive: true })

      const today = new Date()
      for (let i = 0; i < 5; i++) {
        const date = new Date(today)
        date.setDate(date.getDate() - i)
        const dateStr = date.toISOString().split('T')[0]
        fs.writeFileSync(path.join(dailyDir, `${dateStr}.md`), `Day ${i}`, 'utf-8')
      }

      const result = service.readRecentWorkMemory(TEST_ORG, 2)
      expect(result).toContain('Day 0')
      expect(result).toContain('Day 1')
      expect(result).not.toContain('Day 2')
    })
  })

  // ── appendWorkMemory ─────────────────────────────────────────

  describe('appendWorkMemory', () => {
    it('writes structured task entry to daily file', () => {
      const result = service.appendWorkMemory(TEST_ORG, {
        timestamp: '2025-01-15T10:30:00.000Z',
        task: 'Code review',
        result: 'All checks passed',
      })
      expect(result.ok).toBe(true)

      const today = new Date().toISOString().split('T')[0]
      const filePath = path.join(memDir, 'daily', `${today}.md`)
      const content = fs.readFileSync(filePath, 'utf-8')
      expect(content).toContain('Code review')
      expect(content).toContain('All checks passed')
    })
  })

  // ── Singleton ────────────────────────────────────────────────

  describe('singleton', () => {
    it('returns same instance from getMemoryService', () => {
      const a = getMemoryService()
      const b = getMemoryService()
      expect(a).toBe(b)
    })
  })

  // ── refineLongTerm (PRD J5) ─────────────────────────────────

  describe('refineLongTerm', () => {
    it('returns refined=false when no long-term memory exists', () => {
      const result = service.refineLongTerm(TEST_ORG)
      expect(result.refined).toBe(false)
      expect(result.before_tokens).toBe(0)
    })

    it('deduplicates entries and creates backup', () => {
      const longTermPath = path.join(memDir, 'long-term.md')
      const content = `## 人格
- 你是一个智能助手
- 你是一个智能助手
- 偏好中文回复

## 经验教训
- 先检查再执行
- 先检查再执行
- 测试覆盖很重要`
      fs.writeFileSync(longTermPath, content, 'utf-8')

      const result = service.refineLongTerm(TEST_ORG)
      expect(result.refined).toBe(true)
      expect(result.before_tokens).toBeGreaterThan(0)
      expect(result.after_tokens).toBeLessThan(result.before_tokens)
      expect(result.backup_path).toBe(`${longTermPath}.bak`)

      // Verify backup exists
      expect(fs.existsSync(result.backup_path)).toBe(true)
      expect(fs.readFileSync(result.backup_path, 'utf-8')).toBe(content)

      // Verify refined content has no duplicates
      const refined = fs.readFileSync(longTermPath, 'utf-8')
      const lines = refined.split('\n').filter(l => l.trim().startsWith('-'))
      const uniqueLines = [...new Set(lines.map(l => l.trim()))]
      expect(lines.length).toBe(uniqueLines.length)
    })
  })

  // ── checkInactivitySafeMode (PRD H2) ────────────────────────

  describe('checkInactivitySafeMode', () => {
    beforeEach(() => {
      initDb(':memory:')
    })

    afterEach(() => {
      closeDb()
    })

    it('returns should_enable=false when no activity data exists', () => {
      const result = service.checkInactivitySafeMode(TEST_ORG)
      expect(result.should_enable).toBe(false)
      expect(result.last_active).toBeNull()
      expect(result.days_inactive).toBe(0)
    })

    it('detects recent daily memory as active', () => {
      const dailyDir = path.join(memDir, 'daily')
      fs.mkdirSync(dailyDir, { recursive: true })
      const today = new Date().toISOString().split('T')[0]
      fs.writeFileSync(path.join(dailyDir, `${today}.md`), 'Some activity', 'utf-8')

      const result = service.checkInactivitySafeMode(TEST_ORG)
      expect(result.should_enable).toBe(false)
      expect(result.last_active).toBeTruthy()
      expect(result.days_inactive).toBeLessThan(1)
    })

    it('detects old daily memory as inactive', () => {
      const dailyDir = path.join(memDir, 'daily')
      fs.mkdirSync(dailyDir, { recursive: true })
      // Create a file dated 30 days ago
      const oldDate = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0]
      fs.writeFileSync(path.join(dailyDir, `${oldDate}.md`), 'Old activity', 'utf-8')

      const result = service.checkInactivitySafeMode(TEST_ORG)
      expect(result.should_enable).toBe(true)
      expect(result.days_inactive).toBeGreaterThanOrEqual(29)
    })
  })
})
