import { describe, it, expect } from 'vitest'
import {
  ResourceManifestSchema, RegistrySchema, LockFileSchema,
  WorkspaceResourceConfigSchema, AuditEntrySchema, TrustEntrySchema, InstallPlanSchema,
} from '../resource/schema/index'

describe('ResourceManifestSchema', () => {
  it('accepts valid skill manifest', () => {
    const result = ResourceManifestSchema.safeParse({
      name: 'brainstorming',
      type: 'skill',
      version: '1.2.0',
      source: { protocol: 'npm', location: 'superpowers-zh', version: '1.2.0' },
      hash: 'a'.repeat(64),
      dependencies: [],
      references: [],
    })
    expect(result.success).toBe(true)
  })

  it('rejects invalid name (uppercase)', () => {
    const result = ResourceManifestSchema.safeParse({
      name: 'BrainStorm', type: 'skill', version: '1.0.0',
      source: { protocol: 'builtin', location: 'core-pack', version: '1.0.0' },
      hash: 'b'.repeat(64), dependencies: [], references: [],
    })
    expect(result.success).toBe(false)
  })

  it('rejects hash shorter than 64 chars', () => {
    const result = ResourceManifestSchema.safeParse({
      name: 'test', type: 'skill', version: '1.0.0',
      source: { protocol: 'local', location: '/tmp', version: '1.0.0' },
      hash: 'abc', dependencies: [], references: [],
    })
    expect(result.success).toBe(false)
  })

  it('validates source install.target regex for source type', () => {
    const result = ResourceManifestSchema.safeParse({
      name: 'utils', type: 'source', version: '1.0.0',
      source: { protocol: 'git', location: 'https://github.com/x/y', version: 'main' },
      hash: 'c'.repeat(64), dependencies: [], references: [],
      install: { target: 'dependencies/utils', post_install: 'npm install' },
    })
    expect(result.success).toBe(true)

    // Path traversal with ../ must be rejected
    const evil = ResourceManifestSchema.safeParse({
      name: 'evil', type: 'source', version: '1.0.0',
      source: { protocol: 'git', location: 'https://github.com/x/y', version: 'main' },
      hash: 'd'.repeat(64), dependencies: [], references: [],
      install: { target: '../../../etc/passwd' },
    })
    expect(evil.success).toBe(false)

    // Dot segments like foo/../bar must also be rejected
    const dotEvil = ResourceManifestSchema.safeParse({
      name: 'dot', type: 'source', version: '1.0.0',
      source: { protocol: 'git', location: 'https://github.com/x/y', version: 'main' },
      hash: 'e'.repeat(64), dependencies: [], references: [],
      install: { target: 'foo/../bar' },
    })
    expect(dotEvil.success).toBe(false)
  })
})

describe('RegistrySchema', () => {
  it('accepts valid registry', () => {
    const result = RegistrySchema.safeParse({
      version: 1,
      entries: {
        'skill:npm:superpowers-zh:brainstorming': {
          manifest: {
            name: 'brainstorming', type: 'skill', version: '1.2.0',
            source: { protocol: 'npm', location: 'superpowers-zh', version: '1.2.0' },
            hash: 'a'.repeat(64), dependencies: [], references: [],
          },
          installedAt: '2026-07-06T00:00:00Z',
        },
      },
    })
    expect(result.success).toBe(true)
  })
})

describe('AuditEntrySchema', () => {
  it('accepts all 14+4 action types', () => {
    const actions = [
      'resource.registered', 'resource.installed', 'resource.uninstalled',
      'resource.updated', 'resource.replaced', 'resource.init_forced',
      'trust.added', 'trust.removed', 'trust.blocked',
      'cache.gc', 'doctor.repaired',
      'security.path_traversal', 'security.agent_forbidden',
      'security.source_blocked', 'security.auth_failed',
    ] as const
    for (const action of actions) {
      const result = AuditEntrySchema.safeParse({
        timestamp: '2026-07-06T00:00:00Z',
        action, resource: 'brainstorming', caller: 'human',
      })
      expect(result.success).toBe(true)
    }
  })
})

describe('TrustEntrySchema', () => {
  it('validates trusted and blocked arrays', () => {
    const result = TrustEntrySchema.safeParse({
      trusted: [{ protocol: 'npm', location: 'superpowers-zh', trusted_at: '2026-07-06T00:00:00Z' }],
      blocked: [{ protocol: 'npm', location: 'evil-pkg', blocked_at: '2026-07-06T00:00:00Z', reason: 'malicious' }],
    })
    expect(result.success).toBe(true)
  })
})

describe('InstallPlanSchema', () => {
  it('validates plan with additions and conflicts', () => {
    const result = InstallPlanSchema.safeParse({
      id: 'plan-001',
      additions: [{ name: 'brainstorming', type: 'skill', version: '1.2.0', source: 'npm:superpowers-zh' }],
      removals: [],
      conflicts: [],
    })
    expect(result.success).toBe(true)
  })
})
