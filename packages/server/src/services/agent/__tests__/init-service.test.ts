import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import path from 'path'
import os from 'os'

// Isolated temp directory for this test suite
const MOCK_AGENT_DIR = vi.hoisted(() => {
  const p = require('path') as typeof import('path')
  const o = require('os') as typeof import('os')
  return p.join(o.tmpdir(), `octopus-test-init-${process.pid}`)
})

vi.mock('../paths', async () => {
  const p = require('path') as typeof import('path')
  const actual = await vi.importActual<typeof import('../paths')>('../paths')
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

import { InitService } from '../init-service'
import { getAgentDir } from '../paths'
import fs from 'fs'

describe('InitService', () => {
  const testOrg = `test-init-${Date.now()}`
  const agentDir = getAgentDir()
  let service: InitService

  beforeEach(() => {
    service = new InitService()
  })

  afterEach(() => {
    fs.rmSync(MOCK_AGENT_DIR, { recursive: true, force: true })
  })

  it('creates complete directory tree', () => {
    const result = service.initAgent(testOrg)

    expect(result.dirsCreated.length).toBeGreaterThan(0)
    expect(fs.existsSync(path.join(agentDir, 'memory'))).toBe(true)
    expect(fs.existsSync(path.join(agentDir, 'memory', 'daily'))).toBe(true)
    expect(fs.existsSync(path.join(agentDir, 'memory', 'daily', 'archive'))).toBe(true)
    expect(fs.existsSync(path.join(agentDir, 'clones'))).toBe(true)
    expect(fs.existsSync(path.join(agentDir, 'skills'))).toBe(true)
    expect(fs.existsSync(path.join(agentDir, 'evolution'))).toBe(true)
    expect(fs.existsSync(path.join(agentDir, 'reports'))).toBe(true)
    expect(fs.existsSync(path.join(agentDir, 'debug'))).toBe(true)
  })

  it('creates default persona.md and config.yaml', () => {
    const result = service.initAgent(testOrg)

    expect(result.filesCreated).toContain('persona.md')
    expect(result.filesCreated).toContain('config.yaml')
    expect(result.filesCreated).toContain('memory/long-term.md')

    const persona = fs.readFileSync(path.join(agentDir, 'persona.md'), 'utf-8')
    expect(persona).toContain('Octopus Agent')

    const config = fs.readFileSync(path.join(agentDir, 'config.yaml'), 'utf-8')
    expect(config).toContain('model:')
    expect(config).toContain('opus[1m]')
  })

  it('reports dbInitialized (unified DB handled at server startup)', () => {
    const result = service.initAgent(testOrg)
    expect(result.dbInitialized).toBe(true)
  })

  it('is idempotent — second run does not overwrite', () => {
    service.initAgent(testOrg)

    // Modify persona.md to verify it's not overwritten
    const personaPath = path.join(agentDir, 'persona.md')
    fs.writeFileSync(personaPath, 'custom persona content', 'utf-8')

    const result2 = service.initAgent(testOrg)
    expect(result2.filesSkipped).toContain('persona.md')
    expect(result2.filesSkipped).toContain('config.yaml')

    // Verify persona was not overwritten
    const persona = fs.readFileSync(personaPath, 'utf-8')
    expect(persona).toBe('custom persona content')
  })

  it('isInitialized returns correct status', () => {
    expect(service.isInitialized(testOrg)).toBe(false)
    service.initAgent(testOrg)
    expect(service.isInitialized(testOrg)).toBe(true)
  })
})
