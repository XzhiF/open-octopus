import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AuditLogger } from '../resource/audit'
import { mkdtempSync, rmSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('AuditLogger', () => {
  let dir: string
  let logger: AuditLogger

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'audit-test-'))
    logger = new AuditLogger(dir)
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('appends entries as JSONL', () => {
    logger.append({ action: 'resource.installed', resource: 'brainstorming', caller: 'human' })
    logger.append({ action: 'resource.uninstalled', resource: 'brainstorming', caller: 'human' })
    const content = readFileSync(join(dir, 'audit.jsonl'), 'utf-8')
    const lines = content.trim().split('\n')
    expect(lines.length).toBe(2)
    expect(JSON.parse(lines[0]).action).toBe('resource.installed')
    expect(JSON.parse(lines[1]).action).toBe('resource.uninstalled')
  })

  it('adds timestamp automatically', () => {
    logger.append({ action: 'resource.installed', resource: 'test', caller: 'agent' })
    const content = readFileSync(join(dir, 'audit.jsonl'), 'utf-8')
    const entry = JSON.parse(content.trim())
    expect(entry.timestamp).toBeDefined()
    expect(typeof entry.timestamp).toBe('string')
  })

  it('queries with filters', () => {
    logger.append({ action: 'resource.installed', resource: 'a', caller: 'human' })
    logger.append({ action: 'resource.uninstalled', resource: 'b', caller: 'agent' })
    logger.append({ action: 'resource.installed', resource: 'c', caller: 'human' })

    const installed = logger.query({ action: 'resource.installed' })
    expect(installed.length).toBe(2)

    const humanOnly = logger.query({ caller: 'human' })
    expect(humanOnly.length).toBe(2)

    const limited = logger.query({ limit: 1 })
    expect(limited.length).toBe(1)
  })

  it('returns empty array when no log file exists', () => {
    const freshLogger = new AuditLogger(mkdtempSync(join(tmpdir(), 'fresh-')))
    expect(freshLogger.query()).toEqual([])
  })
})
