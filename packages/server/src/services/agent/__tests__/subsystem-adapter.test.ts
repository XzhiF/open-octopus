import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import path from 'path'
import os from 'os'

// Isolated temp directory for this test suite
const MOCK_AGENT_DIR = vi.hoisted(() => {
  const p = require('path') as typeof import('path')
  const o = require('os') as typeof import('os')
  return p.join(o.tmpdir(), `octopus-test-subsystem-${process.pid}`)
})

vi.mock('../paths', async () => {
  const p = require('path') as typeof import('path')
  const actual = await vi.importActual<typeof import('../paths')>('../paths')
  return {
    ...actual,
    getAgentDir: () => MOCK_AGENT_DIR,
    getAgentSkillsDir: () => p.join(MOCK_AGENT_DIR, 'skills'),
    getAgentMemoryDir: () => p.join(MOCK_AGENT_DIR, 'memory'),
    getClonesDir: () => p.join(MOCK_AGENT_DIR, 'clones'),
    getCloneDir: (name: string) => p.join(MOCK_AGENT_DIR, 'clones', name),
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

// Mock evolution-service to avoid DB dependency
const mockSearchExperiences = vi.fn()
vi.mock('../evolution-service', () => ({
  getEvolutionService: () => ({
    searchExperiences: mockSearchExperiences,
  }),
}))

import { SubsystemAdapter } from '../subsystem-adapter'
import fs from 'fs'

describe('SubsystemAdapter — Dual Store Cleanup', () => {
  const testOrg = 'test-subsystem-org'

  beforeEach(() => {
    fs.mkdirSync(MOCK_AGENT_DIR, { recursive: true })
    mockSearchExperiences.mockReset()
  })

  afterEach(() => {
    fs.rmSync(MOCK_AGENT_DIR, { recursive: true, force: true })
  })

  // ── AC-1: legacy file-based write method removed ──────────────────

  it('does not have a legacy file-based write method', () => {
    const adapter = new SubsystemAdapter(testOrg)
    const methodName = 'write' + 'Experience'
    expect((adapter as unknown as Record<string, unknown>)[methodName]).toBeUndefined()
  })

  // ── AC-2: searchExperiences delegates to EvolutionDAO ─────────────

  it('searchExperiences delegates to EvolutionService.searchExperiences', () => {
    mockSearchExperiences.mockReturnValue([
      { id: 1, skill_name: 'skill-a', content: 'timeout error', scope: 'agent', scope_ref: null, pattern_tags: '[]', outcome: null },
      { id: 2, skill_name: 'skill-b', content: 'timeout handling', scope: 'agent', scope_ref: null, pattern_tags: '[]', outcome: null },
    ])

    const adapter = new SubsystemAdapter(testOrg)
    const results = adapter.searchExperiences('timeout', 5)

    expect(mockSearchExperiences).toHaveBeenCalledWith('timeout', undefined, 5)
    expect(results).toHaveLength(2)
    expect(results[0].name).toBe('skill-a')
    expect(results[0].content).toBe('timeout error')
    expect(results[1].name).toBe('skill-b')
  })

  it('searchExperiences returns empty array when EvolutionService throws', () => {
    mockSearchExperiences.mockImplementation(() => { throw new Error('DB error') })

    const adapter = new SubsystemAdapter(testOrg)
    const results = adapter.searchExperiences('anything')

    expect(results).toEqual([])
  })

  it('searchExperiences returns empty array when no results', () => {
    mockSearchExperiences.mockReturnValue([])

    const adapter = new SubsystemAdapter(testOrg)
    const results = adapter.searchExperiences('nonexistent')

    expect(results).toEqual([])
  })

  // ── AC-5: no file-based experience operations ────────────────────

  it('does not have updateExperienceIndex method', () => {
    const adapter = new SubsystemAdapter(testOrg)
    expect((adapter as unknown as Record<string, unknown>).updateExperienceIndex).toBeUndefined()
  })

  it('does not import getExperiencesDir', async () => {
    // Verify the module source does not reference getExperiencesDir
    const adapterSource = await import('fs').then(fs =>
      fs.promises.readFile(
        path.join(process.cwd(), 'src/services/agent/subsystem-adapter.ts'),
        'utf-8',
      ),
    )
    expect(adapterSource).not.toContain('getExperiencesDir')
  })
})
