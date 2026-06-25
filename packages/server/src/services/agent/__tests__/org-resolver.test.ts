import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { OrgResolver, OrgNotFoundError, OrgValidationError } from '../org-resolver'
import fs from 'fs'
import path from 'path'
import os from 'os'

describe('OrgResolver', () => {
  const testOrg = `test-org-${Date.now()}`
  const orgDir = path.join(os.homedir(), '.octopus', 'orgs', testOrg)
  let resolver: OrgResolver

  beforeEach(() => {
    resolver = new OrgResolver()
    fs.mkdirSync(orgDir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(orgDir, { recursive: true, force: true })
  })

  it('resolves org from CLI flag (highest priority)', () => {
    const org = resolver.resolveOrg({ cliOrg: testOrg, defaultOrg: 'nonexistent' })
    expect(org).toBe(testOrg)
  })

  it('resolves org from header when CLI is missing', () => {
    const org = resolver.resolveOrg({ headerOrg: testOrg })
    expect(org).toBe(testOrg)
  })

  it('throws OrgNotFoundError when org does not exist', () => {
    // Mock cwd to a path outside ~/.octopus so inferOrgFromCwd returns null
    vi.spyOn(process, 'cwd').mockReturnValue('/tmp')
    try {
      expect(() => resolver.resolveOrg({ cliOrg: 'nonexistent-org-xyz' }))
        .toThrow(OrgNotFoundError)
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('falls through priority chain', () => {
    // Mock cwd to a path outside ~/.octopus so inferOrgFromCwd returns null
    vi.spyOn(process, 'cwd').mockReturnValue('/tmp')
    try {
      const org = resolver.resolveOrg({
        cliOrg: undefined,
        headerOrg: undefined,
        envOrg: '',
        defaultOrg: testOrg,
      })
      expect(org).toBe(testOrg)
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('lists available orgs', () => {
    const orgs = resolver.listOrgs()
    expect(orgs).toContain(testOrg)
  })

  // ── Org name validation tests ────────────────────────────────────

  describe('validateOrgName', () => {
    it('accepts valid org names', () => {
      expect(() => resolver.validateOrgName('my-org')).not.toThrow()
      expect(() => resolver.validateOrgName('org_123')).not.toThrow()
      expect(() => resolver.validateOrgName('xzf')).not.toThrow()
      expect(() => resolver.validateOrgName('my.org.name')).not.toThrow()
    })

    it('rejects path traversal attempts', () => {
      expect(() => resolver.validateOrgName('../etc')).toThrow(OrgValidationError)
      expect(() => resolver.validateOrgName('..')).toThrow(OrgValidationError)
      expect(() => resolver.validateOrgName('org/subdir')).toThrow(OrgValidationError)
      expect(() => resolver.validateOrgName('org\\subdir')).toThrow(OrgValidationError)
    })

    it('rejects special characters', () => {
      expect(() => resolver.validateOrgName('org name')).toThrow(OrgValidationError)
      expect(() => resolver.validateOrgName('org@name')).toThrow(OrgValidationError)
      expect(() => resolver.validateOrgName('org;rm -rf')).toThrow(OrgValidationError)
      expect(() => resolver.validateOrgName('')).toThrow(OrgValidationError)
    })

    it('rejects names exceeding max length', () => {
      expect(() => resolver.validateOrgName('a'.repeat(65))).toThrow(OrgValidationError)
    })
  })

  describe('orgExists path containment', () => {
    it('returns false for traversal paths', () => {
      expect(resolver.orgExists('../etc')).toBe(false)
      expect(resolver.orgExists('../../etc/passwd')).toBe(false)
    })

    it('returns true for valid existing org', () => {
      expect(resolver.orgExists(testOrg)).toBe(true)
    })

    it('returns false for valid non-existing org', () => {
      expect(resolver.orgExists('definitely-nonexistent-org-xyz')).toBe(false)
    })
  })
})
