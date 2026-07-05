import { describe, it, expect } from 'vitest'
import { DependencyResolver } from '../resource/resolver'
import type { ResourceManifest } from '../resource/schema'

function makeManifest(name: string, deps: string[] = []): ResourceManifest {
  return {
    name,
    type: 'skill',
    version: '1.0.0',
    source: { protocol: 'builtin', location: 'core-pack', version: '1.0.0' },
    hash: 'a'.repeat(64),
    dependencies: deps,
    references: [],
  }
}

describe('DependencyResolver', () => {
  it('resolves linear dependencies', () => {
    const resolver = new DependencyResolver()
    resolver.addManifest(makeManifest('a', ['b']))
    resolver.addManifest(makeManifest('b', ['c']))
    resolver.addManifest(makeManifest('c'))

    const order = resolver.resolve(['a'])
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('b'))
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('a'))
  })

  it('resolves diamond dependencies', () => {
    const resolver = new DependencyResolver()
    resolver.addManifest(makeManifest('a', ['b', 'c']))
    resolver.addManifest(makeManifest('b', ['d']))
    resolver.addManifest(makeManifest('c', ['d']))
    resolver.addManifest(makeManifest('d'))

    const order = resolver.resolve(['a'])
    expect(order.indexOf('d')).toBeLessThan(order.indexOf('b'))
    expect(order.indexOf('d')).toBeLessThan(order.indexOf('c'))
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('a'))
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('a'))
  })

  it('detects cycles', () => {
    const resolver = new DependencyResolver()
    resolver.addManifest(makeManifest('a', ['b']))
    resolver.addManifest(makeManifest('b', ['c']))
    resolver.addManifest(makeManifest('c', ['a']))

    expect(() => resolver.resolve(['a'])).toThrow('DEPENDENCY_CYCLE')
  })

  it('handles no dependencies', () => {
    const resolver = new DependencyResolver()
    resolver.addManifest(makeManifest('a'))
    resolver.addManifest(makeManifest('b'))

    const order = resolver.resolve(['a', 'b'])
    expect(order).toContain('a')
    expect(order).toContain('b')
  })
})
