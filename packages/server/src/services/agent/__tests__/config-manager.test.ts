import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import path from 'path'
import os from 'os'

// Isolated temp directory for this test suite
const MOCK_AGENT_DIR = vi.hoisted(() => {
  const p = require('path') as typeof import('path')
  const o = require('os') as typeof import('os')
  return p.join(o.tmpdir(), `octopus-test-config-${process.pid}`)
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

import { ConfigManager } from '../config-manager'
import { getAgentDir, getAgentConfigPath } from '../paths'
import fs from 'fs'
import yaml from 'js-yaml'

describe('ConfigManager', () => {
  const testOrg = `test-config-${Date.now()}`
  const agentDir = getAgentDir()
  const configPath = getAgentConfigPath()

  let manager: ConfigManager

  beforeEach(() => {
    manager = new ConfigManager()
    fs.mkdirSync(agentDir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(MOCK_AGENT_DIR, { recursive: true, force: true })
  })

  it('returns defaults when config file does not exist', () => {
    const result = manager.loadConfig(testOrg)
    expect(result.config.model).toBe('opus[1m]')
    expect(result.config.timeout).toBe(300)
    expect(result.degraded).toBe(true)
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it('loads valid config.yaml', () => {
    const config = { model: 'sonnet', timeout: 120, max_clones: 3 }
    fs.writeFileSync(configPath, yaml.dump(config), 'utf-8')

    const result = manager.loadConfig(testOrg)
    expect(result.config.model).toBe('sonnet')
    expect(result.config.timeout).toBe(120)
    expect(result.config.max_clones).toBe(3)
    expect(result.degraded).toBe(false)
  })

  it('degrades gracefully on corrupt YAML', () => {
    fs.writeFileSync(configPath, '{ invalid yaml [[', 'utf-8')

    const result = manager.loadConfig(testOrg)
    expect(result.config.model).toBe('opus[1m]')
    expect(result.degraded).toBe(true)
    expect(result.warnings.some(w => w.includes('YAML parse error'))).toBe(true)
  })

  it('updates config and writes to file', () => {
    fs.writeFileSync(configPath, yaml.dump({ model: 'haiku' }), 'utf-8')
    manager.clearCache(testOrg)

    manager.updateConfig(testOrg, { timeout: 600 })
    manager.clearCache(testOrg)

    const result = manager.loadConfig(testOrg)
    expect(result.config.timeout).toBe(600)
    expect(result.config.model).toBe('haiku')
  })
})
