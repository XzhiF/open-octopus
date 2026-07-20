import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { EvolutionConfigService } from '../services/scheduler/evolution-config'

describe('EvolutionConfigService', () => {
  let tmpDir: string
  let service: EvolutionConfigService
  const ORG = 'test-org'

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-config-test-'))
    service = new EvolutionConfigService(tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // ── Evolution Scope ──────────────────────────────────────────────

  it('returns empty array when no config exists', () => {
    expect(service.getEvolutionScope(ORG)).toEqual([])
  })

  it('writes and reads evolution_scope', () => {
    const scopes = ['skill-improvement', 'workflow-optimization', 'new-integrations']
    service.updateEvolutionScope(ORG, scopes)
    expect(service.getEvolutionScope(ORG)).toEqual(scopes)
  })

  it('overwrites evolution_scope on update', () => {
    service.updateEvolutionScope(ORG, ['old-scope'])
    service.updateEvolutionScope(ORG, ['new-scope-1', 'new-scope-2'])
    expect(service.getEvolutionScope(ORG)).toEqual(['new-scope-1', 'new-scope-2'])
  })

  // ── Retire Protected ─────────────────────────────────────────────

  it('returns empty array when no config exists', () => {
    expect(service.getRetireProtected(ORG)).toEqual([])
  })

  it('writes and reads retire_protected', () => {
    const items = ['prd-forge', 'prd-impl', 'core-build']
    service.updateRetireProtected(ORG, items)
    expect(service.getRetireProtected(ORG)).toEqual(items)
  })

  // ── Org Isolation ────────────────────────────────────────────────

  it('isolates config between orgs', () => {
    service.updateEvolutionScope('org-a', ['scope-a'])
    service.updateEvolutionScope('org-b', ['scope-b'])
    expect(service.getEvolutionScope('org-a')).toEqual(['scope-a'])
    expect(service.getEvolutionScope('org-b')).toEqual(['scope-b'])
  })

  // ── Preserves other fields ───────────────────────────────────────

  it('preserves other config fields when updating scope', () => {
    service.updateRetireProtected(ORG, ['protected-1'])
    service.updateEvolutionScope(ORG, ['scope-1'])
    expect(service.getRetireProtected(ORG)).toEqual(['protected-1'])
    expect(service.getEvolutionScope(ORG)).toEqual(['scope-1'])
  })
})
