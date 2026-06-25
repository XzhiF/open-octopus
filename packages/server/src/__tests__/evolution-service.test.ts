/**
 * EvolutionService Unit Tests
 * Tests change classification, experience recording, reflection, and rollback.
 * Maps to PRD F1 (reflection), F5 (user feedback), F7 (safety classification).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { classifyLevel, EvolutionService, getEvolutionService, initEvolutionService } from '../services/agent/evolution-service'
import { initDb, closeDb, getDb } from '../db/connection'
import { EvolutionDAO } from '../db/dao'

const TEST_ORG = 'test-evo-org'

// Initialize an in-memory DB for tests that query the unified DB
beforeEach(() => {
  initDb(':memory:')
})

afterEach(() => {
  closeDb()
})

describe('classifyLevel', () => {
  // ── Hard safety keywords (PRD F7) ─────────────────────────

  it('forces major for Chinese safety keywords', () => {
    expect(classifyLevel({
      change_type: 'minor',
      summary: '添加权限检查逻辑',
    })).toBe('major')
  })

  it('forces major for English safety keywords', () => {
    expect(classifyLevel({
      change_type: 'minor',
      summary: 'Add permission check',
    })).toBe('major')
  })

  it('forces major for "禁止" keyword', () => {
    expect(classifyLevel({
      change_type: 'minor',
      summary: '禁止执行危险命令',
    })).toBe('major')
  })

  it('forces major for "deny" keyword', () => {
    expect(classifyLevel({
      change_type: 'minor',
      summary: 'Deny unauthorized access',
    })).toBe('major')
  })

  it('forces major for "must" keyword', () => {
    expect(classifyLevel({
      change_type: 'minor',
      summary: 'Must validate all inputs',
    })).toBe('major')
  })

  // ── Rollback and revert ──────────────────────────────────────

  it('forces major for rollback change type', () => {
    expect(classifyLevel({
      change_type: 'rollback',
      summary: 'Reverting a change',
    })).toBe('major')
  })

  it('forces major for revert_builtin change type', () => {
    expect(classifyLevel({
      change_type: 'revert_builtin',
      summary: 'Restore builtin skill',
    })).toBe('major')
  })

  // ── Explicit major ───────────────────────────────────────────

  it('respects explicit major change type', () => {
    expect(classifyLevel({
      change_type: 'major',
      summary: 'A major change',
    })).toBe('major')
  })

  // ── Structural change indicators ─────────────────────────────

  it('classifies breaking changes as major', () => {
    expect(classifyLevel({
      change_type: 'minor',
      summary: 'breaking change to API',
    })).toBe('major')
  })

  it('classifies refactoring as major', () => {
    expect(classifyLevel({
      change_type: 'minor',
      summary: '重构整个模块',
    })).toBe('major')
  })

  it('classifies new skill creation as major', () => {
    expect(classifyLevel({
      change_type: 'minor',
      summary: '新增功能 for deployment pipeline',
    })).toBe('major')
  })

  it('classifies deprecation as major', () => {
    expect(classifyLevel({
      change_type: 'minor',
      summary: 'deprecate old API endpoints',
    })).toBe('major')
  })

  it('classifies architecture changes as major', () => {
    expect(classifyLevel({
      change_type: 'minor',
      summary: 'architecture overhaul of auth system',
    })).toBe('major')
  })

  // ── Large diffs ──────────────────────────────────────────────

  it('classifies large diffs (>5000 chars) as major', () => {
    expect(classifyLevel({
      change_type: 'minor',
      summary: 'Updated some text',
      diff_length: 6000,
    })).toBe('major')
  })

  it('does not classify small diffs as major by length alone', () => {
    expect(classifyLevel({
      change_type: 'minor',
      summary: 'Updated some text',
      diff_length: 100,
    })).toBe('minor')
  })

  // ── Minor changes ────────────────────────────────────────────

  it('classifies simple text updates as minor', () => {
    expect(classifyLevel({
      change_type: 'minor',
      summary: 'Updated wording in step 3',
    })).toBe('minor')
  })

  it('classifies best practice additions as minor', () => {
    expect(classifyLevel({
      change_type: 'minor',
      summary: 'Added a tip about using const',
    })).toBe('minor')
  })

  // ── Safety keyword in diff_content ───────────────────────────

  it('detects safety keywords in diff_content', () => {
    expect(classifyLevel({
      change_type: 'minor',
      summary: 'Updated some content',
      diff_content: 'Added safety check for permissions',
    })).toBe('major')
  })
})

describe('EvolutionService', () => {
  let service: EvolutionService
  beforeEach(() => {
    initDb(':memory:')
    service = initEvolutionService(new EvolutionDAO(getDb()))
  })

  // ── reflect ────────────────────────────────────────────────

  describe('reflect', () => {
    it('detects user correction patterns in feedback', () => {
      const result = service.reflect(TEST_ORG, {
        type: 'user_feedback',
        content: '不要这样做了，以后先检查再执行',
        skill_name: 'octo-agent-orchestrator',
      })
      expect(result.identified).toBe(true)
      expect(result.candidate).toBeDefined()
      expect(result.candidate?.summary).toContain('User feedback correction')
    })

    it('detects English correction patterns', () => {
      const result = service.reflect(TEST_ORG, {
        type: 'user_feedback',
        content: "Don't do that, always check first",
        skill_name: 'test-skill',
      })
      expect(result.identified).toBe(true)
    })

    it('detects "from now on" pattern', () => {
      const result = service.reflect(TEST_ORG, {
        type: 'user_feedback',
        content: 'from now on, validate inputs before processing',
      })
      expect(result.identified).toBe(true)
    })

    it('returns not identified for neutral feedback', () => {
      const result = service.reflect(TEST_ORG, {
        type: 'user_feedback',
        content: 'This looks great, thanks!',
      })
      expect(result.identified).toBe(false)
    })

    it('returns not identified for execution with no patterns', () => {
      const result = service.reflect(TEST_ORG, {
        type: 'execution',
        content: 'Task completed successfully',
        result_summary: 'All good',
      })
      expect(result.identified).toBe(false)
    })

    it('detects improvable execution results', () => {
      const result = service.reflect(TEST_ORG, {
        type: 'execution',
        content: 'Task done',
        skill_name: 'test-skill',
        result_summary: '可以改进的地方：添加更多测试',
      })
      expect(result.identified).toBe(true)
      expect(result.level).toBe('minor')
    })

    it('uses classifyLevel for user feedback level', () => {
      const result = service.reflect(TEST_ORG, {
        type: 'user_feedback',
        content: '不要再跳过权限检查',
        skill_name: 'test-skill',
      })
      // "权限" is a safety keyword → should be major
      expect(result.identified).toBe(true)
      expect(result.level).toBe('major')
    })
  })

  // ── Singleton ────────────────────────────────────────────────

  describe('singleton', () => {
    it('returns same instance from getEvolutionService', () => {
      const a = getEvolutionService()
      const b = getEvolutionService()
      expect(a).toBe(b)
    })
  })
})
