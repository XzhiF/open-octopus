import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import path from 'path'
import os from 'os'

// Isolated temp directory for this test suite
const MOCK_AGENT_DIR = vi.hoisted(() => {
  const p = require('path') as typeof import('path')
  const o = require('os') as typeof import('os')
  return p.join(o.tmpdir(), `octopus-test-persona-${process.pid}`)
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

import { PersonaService, PersonaTooLongError, PersonaEmptyError } from '../persona-service'
import { getAgentDir } from '../paths'
import fs from 'fs'

describe('PersonaService', () => {
  const testOrg = `test-persona-${Date.now()}`
  const agentDir = getAgentDir()
  let service: PersonaService

  beforeEach(() => {
    service = new PersonaService()
    fs.mkdirSync(agentDir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(MOCK_AGENT_DIR, { recursive: true, force: true })
  })

  it('returns empty when persona.md does not exist', () => {
    const result = service.readPersona(testOrg)
    expect(result.content).toBe('')
    expect(result.token_count).toBe(0)
  })

  it('reads persona.md content', () => {
    const personaPath = path.join(agentDir, 'persona.md')
    fs.writeFileSync(personaPath, '# My Agent Persona\nHelpful assistant', 'utf-8')

    const result = service.readPersona(testOrg)
    expect(result.content).toContain('My Agent Persona')
    expect(result.token_count).toBeGreaterThan(0)
  })

  it('strips YAML frontmatter', () => {
    const personaPath = path.join(agentDir, 'persona.md')
    fs.writeFileSync(personaPath, '---\ntitle: test\n---\n# Real Content', 'utf-8')

    const result = service.readPersona(testOrg)
    expect(result.content).toBe('# Real Content')
    expect(result.content).not.toContain('title: test')
  })

  it('writes persona content', () => {
    const result = service.writePersona(testOrg, 'New persona content')
    expect(result.content).toBe('New persona content')
    expect(result.token_count).toBeGreaterThan(0)

    const fileContent = fs.readFileSync(path.join(agentDir, 'persona.md'), 'utf-8')
    expect(fileContent.trim()).toBe('New persona content')
  })

  it('throws PersonaTooLongError for content exceeding 2000 chars', () => {
    const longContent = 'a'.repeat(2001)
    expect(() => service.writePersona(testOrg, longContent)).toThrow(PersonaTooLongError)
  })

  it('throws PersonaEmptyError for empty content', () => {
    expect(() => service.writePersona(testOrg, '')).toThrow(PersonaEmptyError)
    expect(() => service.writePersona(testOrg, '   ')).toThrow(PersonaEmptyError)
  })
})
